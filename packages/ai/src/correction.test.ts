import { describe, expect, it } from 'vitest';

import { RepositoryAnswerer } from './answer.js';
import { correctionFor } from './prompt.js';
import { FakeContextSource } from './testing.js';
import { repositoryContext } from './fixtures.test-helper.js';
import type { AnswerEvent } from './stream.js';
import type { GenerationRequest, LanguageModel, ModelEvent, StopReason } from './model.js';
import { estimatingCounter } from './budget.js';

/**
 * The corrective pass: what happens when verification rejects an answer.
 *
 * **Before this, an unsupported claim was shown to the reader with a red badge beside it.** The guard was
 * right and the product still displayed the sentence — which is the worst of both, because a reader who
 * skims past a badge has read a fabrication that the system already knew was one. The pipeline now spends
 * one more generation to try to fix it.
 *
 * Three properties are load-bearing and each has a test here:
 *
 * 1. **A supported first pass costs nothing extra.** Otherwise the fix for wrong answers has made every
 *    right answer twice as slow.
 * 2. **At most one correction, ever.** Not "usually one" — the loop must be incapable of a third
 *    generation, because an agent loop over a slow local model is minutes of silence.
 * 3. **A failed correction stays visibly uncertain.** The point is not to launder a bad answer into a
 *    green badge.
 */

/**
 * A model that answers differently on each call, so a corrective pass can be observed.
 *
 * Deliberately not `ScriptedModel`, which repeats one text: the whole question here is what happens on the
 * *second* call, and a stub that could not differ could not express it.
 */
class SequenceModel implements LanguageModel {
  readonly prompts: string[] = [];
  readonly tokens = estimatingCounter;

  readonly #answers: readonly string[];
  #call = 0;

  constructor(answers: readonly string[]) {
    this.#answers = answers;
  }

  get calls(): number {
    return this.#call;
  }

  describe() {
    return {
      id: 'sequence',
      contextWindow: 16_384,
      maxOutputTokens: 2048,
      capabilities: new Set(['system-prompt'] as const),
    };
  }

  async *generate(request: GenerationRequest): AsyncIterable<ModelEvent> {
    const text = this.#answers[Math.min(this.#call, this.#answers.length - 1)] ?? '';

    this.#call += 1;
    this.prompts.push(request.messages.map((message) => message.content).join('\n'));

    yield { type: 'delta', text };
    yield {
      type: 'end',
      stopReason: 'complete' as StopReason,
      usage: { promptTokens: 100, outputTokens: 20 },
    };
  }
}

async function answer(answers: readonly string[]): Promise<{
  readonly events: readonly AnswerEvent[];
  readonly model: SequenceModel;
}> {
  const model = new SequenceModel(answers);
  const answerer = new RepositoryAnswerer(new FakeContextSource(repositoryContext()), model);
  const events: AnswerEvent[] = [];

  for await (const event of answerer.answer({ question: 'Explain the architecture.', subject: { kind: 'repository' } })) {
    events.push(event);
  }

  return { events, model };
}

const completed = (events: readonly AnswerEvent[]) => {
  const last = events.at(-1);

  if (last?.type !== 'complete') {
    throw new Error('the stream did not complete');
  }

  return last.answer;
};

/** A sentence with a real subject and a verb the facts do not license. See `entailment.ts`. */
const UNSUPPORTED = 'The repository is well documented and follows best practices [f1].';
const SOUND = 'It is organised into packages, the largest of which is `packages/core` [f1].';

describe('a supported answer', () => {
  it('is returned after one generation, with no correction', async () => {
    const { events, model } = await answer([SOUND]);
    const result = completed(events);

    expect(model.calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.corrections).toEqual([]);
    expect(events.some((event) => event.type === 'restart')).toBe(false);
    expect(events.some((event) => event.type === 'status' && event.phase === 'correcting')).toBe(false);
  });

  it('does not spend a generation on an answer that merely cited nothing', async () => {
    /*
     * `unverifiable` is not worth a rewrite. It means the answer cited nothing, which the reminder already
     * asks for on every attempt — spending a whole second generation on a formatting habit would double the
     * latency of every uncited answer for no change in what it claims.
     */
    const { events, model } = await answer(['The repository holds several packages.']);

    expect(model.calls).toBe(1);
    expect(completed(events).verdict).toBe('unverifiable');
  });
});

describe('an unsupported answer', () => {
  it('is corrected once, and the corrected answer is what the reader receives', async () => {
    const { events, model } = await answer([UNSUPPORTED, SOUND]);
    const result = completed(events);

    expect(model.calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.text).toBe(SOUND);
    expect(result.verdict).toBe('grounded');
    expect(result.corrections.length).toBeGreaterThan(0);
  });

  it('tells the consumer to discard the prose it has already streamed', async () => {
    const { events } = await answer([UNSUPPORTED, SOUND]);
    const order = events.map((event) => (event.type === 'status' ? `status:${event.phase}` : event.type));

    // The rejected answer was already on the reader's screen. Leaving it there until `complete` arrives
    // would let them finish reading an answer the pipeline had thrown away.
    expect(order).toContain('restart');
    expect(order.indexOf('restart')).toBeLessThan(order.indexOf('status:correcting'));
    expect(order.indexOf('restart')).toBeGreaterThan(order.indexOf('delta'));
  });

  it('names what failed and why, so the reason can be shown rather than only the disappearance', async () => {
    const { events } = await answer([UNSUPPORTED, SOUND]);
    const restart = events.find((event) => event.type === 'restart');

    expect(restart?.type === 'restart' && restart.reasons.join(' ')).toContain('presence-as-quality');
  });

  it('reuses the same evidence, so the rewrite is not a smaller projection', async () => {
    const { model } = await answer([UNSUPPORTED, SOUND]);
    const [first, second] = model.prompts;

    // Byte-identical up to the correction: the corrective prompt is the original plus one instruction, which
    // is what lets a provider reuse the whole evaluated prefix rather than re-reading the facts.
    expect(second).toContain(first?.slice(0, 2000) ?? '');
    expect(second).toContain('Verification rejected part of it');
    expect(second).toContain(UNSUPPORTED);
  });

  it('corrects at most once, however many times the model repeats itself', async () => {
    const { events, model } = await answer([UNSUPPORTED, UNSUPPORTED, UNSUPPORTED]);
    const result = completed(events);

    // Not "usually one": the loop sets its correction in a branch guarded by the attempt count and has no
    // state in which a third generation is reachable.
    expect(model.calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(events.filter((event) => event.type === 'restart').length).toBe(1);
  });

  it('stays visibly uncertain when the correction fails', async () => {
    const { events } = await answer([UNSUPPORTED, UNSUPPORTED]);
    const result = completed(events);

    // The point was never to launder a bad answer into a green badge.
    expect(result.verdict).toBe('ungrounded');
    expect(result.unsupportedTerms.length + result.diagnostics.length).toBeGreaterThan(0);
    expect(result.corrections.length).toBeGreaterThan(0);
  });

  it('keeps the original where the rewrite collapsed into a summary', async () => {
    /*
     * A rewrite has a trivially available way to make zero unsupported claims: say almost nothing. That
     * answer scores perfectly on every check and is worse for a reader than the flawed one it replaced.
     */
    const { events } = await answer([`${UNSUPPORTED} ${SOUND} ${SOUND} ${SOUND} ${SOUND}`, 'Not much.']);
    const result = completed(events);

    expect(result.text).not.toBe('Not much.');
    expect(result.text).toContain('packages/core');
  });

  it('prefers the rewrite where it makes fewer unsupported claims, even if some remain', async () => {
    const worse = `${UNSUPPORTED} It also has high quality test coverage [f1]. ${SOUND} ${SOUND}`;
    const better = `${UNSUPPORTED} ${SOUND} ${SOUND} ${SOUND}`;
    const result = completed((await answer([worse, better])).events);

    expect(result.verdict).toBe('ungrounded');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.text).toBe(better);
  });
});

describe('the correction instruction', () => {
  const instruction = correctionFor({
    answer: 'Authentication works through `set_secret.py` [f3].',
    fabricated: ['sym:invented.ts#Nope'],
    unsupportedTerms: ['express'],
    unknownCitations: ['f99'],
    claims: [
      {
        sentence: 'Authentication works through `set_secret.py` [f3].',
        kind: 'secrets-as-authentication',
        detail: 'the facts carry no access-control middleware or an authentication route',
      },
    ],
  });

  it('names the sentence, the transformation and the reason, rather than asking for more care', () => {
    expect(instruction).toContain('Authentication works through');
    expect(instruction).toContain('secrets-as-authentication');
    expect(instruction).toContain('access-control middleware');
  });

  it('lists every category of failure the guard adjudicates', () => {
    expect(instruction).toContain('sym:invented.ts#Nope');
    expect(instruction).toContain('express');
    expect(instruction).toContain('f99');
  });

  it('forbids the easy way out, which is a shorter answer', () => {
    /*
     * An instruction to "be more careful" produces a shorter, vaguer answer that fails differently. The
     * first version of this asked for a rewrite "avoiding unsupported inference" and got four sentences of
     * hedged summary in place of a page of correct explanation.
     */
    expect(instruction).toContain('the same length');
    expect(instruction).toContain('shortening it is not a correction');
  });

  it('offers the two supportable ways out, rather than only forbidding one', () => {
    expect(instruction).toContain('state what the');
    expect(instruction).toContain('could not be determined');
  });
});
