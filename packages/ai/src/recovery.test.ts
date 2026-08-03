import { describe, expect, it } from 'vitest';

import { RepositoryAnswerer } from './answer.js';
import { recoveryFor } from './recovery.js';
import { checkGrounding } from './grounding.js';
import { finalise } from './finalize.js';
import { project } from './projection.js';
import { recoveryInstruction } from './prompt.js';
import { FakeContextSource } from './testing.js';
import { repositoryContext } from './fixtures.test-helper.js';
import type { AnswerEvent } from './stream.js';
import type { GenerationRequest, LanguageModel, ModelEvent, StopReason } from './model.js';
import { estimatingCounter } from './budget.js';

/**
 * What happens when verification rejects an answer: evidence recovery, then safe finalisation.
 *
 * **The pass this file describes replaced one that rewrote prose, and the distinction is the milestone.**
 * The old corrective pass showed the model its own rejected answer and *the same facts*, then asked for a
 * better one. For a sentence rejected as unsupported that request has two honest outcomes, both bad: say
 * less, or say the same thing in words the guard does not recognise. Both were observed in production, and
 * the UI reported the result as "rewritten once" and still ungrounded — the pipeline telling a user it had
 * tried twice and failed twice for the same reason.
 *
 * The reason was never the model's. A claim is rejected because **no fact of the licensing kind was in the
 * projection**, and whether the graph holds one is a different question from whether the budget reached
 * it. So a rejection is now translated into a retrieval request and the projection is rebuilt.
 *
 * Five properties are load-bearing and each has a test here:
 *
 * 1. **A supported first pass costs nothing extra.** Otherwise the fix for wrong answers made every right
 *    answer twice as slow.
 * 2. **At most one recovery, ever.** Not "usually one" — the loop must be incapable of a third generation.
 * 3. **Recovery is targeted**, and it does not run at all where nothing could be retrieved that would
 *    change the verdict.
 * 4. **The second attempt sees different evidence.** A pass that resent the same facts would be the thing
 *    this replaced.
 * 5. **Unsupported prose is never returned.** If verification still fails, the statements that failed are
 *    removed and the answer says so.
 */

/**
 * A model that answers differently on each call, so a second pass can be observed.
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

/**
 * A rejection **nothing could be retrieved for**, and one that a retrieval could answer.
 *
 * The difference decides whether a second generation runs at all, and having both is what lets the bound
 * be tested from either side. No fact in any projection supports a quality verdict — `presence-as-quality`
 * has an empty licence list by construction — so the first can only be removed. An identifier the facts do
 * not carry may be a real declaration the budget never reached, and the families that carry declarations
 * are somewhere to go and look.
 */
const UNLICENSABLE = 'The repository is well documented and follows best practices [f1].';
const RECOVERABLE = 'The lookup is performed by sym:invented.ts#Nope [f1].';
const SOUND = 'It is organised into packages, the largest of which is `packages/core` [f1].';

describe('a supported answer', () => {
  it('is returned after one generation, with no recovery', async () => {
    const { events, model } = await answer([SOUND]);
    const result = completed(events);

    expect(model.calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.status).toBe('grounded');
    expect(result.recovery).toBeNull();
    expect(result.corrections).toEqual([]);
    expect(events.some((event) => event.type === 'restart')).toBe(false);
    expect(events.some((event) => event.type === 'status' && event.phase === 'recovering')).toBe(false);
  });

  it('does not spend a generation on an answer that merely cited nothing', async () => {
    /*
     * `unverifiable` is not worth a second pass. It means the answer cited nothing, which the reminder
     * already asks for on every attempt — spending a whole generation on a formatting habit would double
     * the latency of every uncited answer for no change in what it claims.
     */
    const { events, model } = await answer(['The repository holds several packages.']);

    expect(model.calls).toBe(1);
    expect(completed(events).status).toBe('unverifiable');
  });
});

describe('a rejection nothing could be retrieved for', () => {
  it('is finalised without spending a second generation on it', async () => {
    /*
     * **The bound this milestone adds, and it is a latency bound as much as a correctness one.** No fact in
     * any projection licenses a quality verdict — `presence-as-quality` has an empty licence list by
     * construction — so a retrieval would fetch nothing that could change the verdict, and the whole
     * generation would be spent establishing that. The sentence is removed instead, in microseconds.
     */
    const { events, model } = await answer([`${UNLICENSABLE} ${SOUND}`]);
    const result = completed(events);

    expect(model.calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.recovery).toBeNull();
    expect(result.status).toBe('limited-evidence');
    expect(result.text).not.toContain('well documented');
    expect(result.text).toContain('packages/core');
  });
});

describe('a rejection evidence could answer', () => {
  it('runs exactly one recovery, and reports what it went back for', async () => {
    const { events, model } = await answer([RECOVERABLE, SOUND]);
    const result = completed(events);

    expect(model.calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.status).toBe('grounded-after-recovery');
    expect(result.text).toBe(SOUND);
    expect(result.recovery?.parts.length).toBeGreaterThan(0);
    expect(result.corrections.length).toBeGreaterThan(0);
  });

  it('tells the consumer to discard the prose it has already streamed', async () => {
    const { events } = await answer([RECOVERABLE, SOUND]);
    const order = events.map((event) => (event.type === 'status' ? `status:${event.phase}` : event.type));

    // The rejected answer was already on the reader's screen. Leaving it there until `complete` arrives
    // would let them finish reading an answer the pipeline had thrown away.
    expect(order).toContain('restart');
    expect(order.indexOf('restart')).toBeLessThan(order.indexOf('status:recovering'));
    expect(order.indexOf('restart')).toBeGreaterThan(order.indexOf('delta'));
  });

  it('names what failed and why, so the reason can be shown rather than only the disappearance', async () => {
    const { events } = await answer([RECOVERABLE, SOUND]);
    const restart = events.find((event) => event.type === 'restart');

    expect(restart?.type === 'restart' && restart.reasons.join(' ')).toContain('sym:invented.ts#Nope');
  });

  it('reprojects for the second attempt rather than resending the first prompt', async () => {
    /*
     * **The property that distinguishes this from the rewrite it replaced.** The old pass sent the same
     * fact block twice and asked for different prose. Whether the *content* changes depends on whether the
     * budget was binding — see the projection suite, which asserts that a recovery request changes the
     * composition on a repository large enough for it to matter — but the pipeline must go back to the
     * graph either way, and the second prompt must carry the instruction that says the evidence was
     * reselected.
     */
    const { events, model } = await answer([RECOVERABLE, SOUND]);
    const grounding = events.filter((event) => event.type === 'grounding');

    expect(grounding.length).toBe(2);
    expect(model.prompts[1]).toContain('Verification rejected part of it');
    expect(model.prompts[1]).toContain('sym:invented.ts#Nope');
  });

  it('does not grow the prompt to do it', async () => {
    /*
     * Recovery buys a different composition, not a bigger one: it is built at the same tier against the
     * same reservation, so what changes is which facts are in the budget rather than how large it is.
     */
    const { events } = await answer([RECOVERABLE, SOUND]);
    const totals = events.flatMap((event) =>
      event.type === 'grounding' && event.grounding.promptTokens !== null ? [event.grounding.promptTokens.total] : [],
    );

    expect(totals.length).toBe(2);
    // The second prompt carries the regeneration instruction as well, so it is allowed to be a little
    // larger — a fifth more would mean the tier had stopped binding.
    expect((totals[1] ?? 0) / (totals[0] ?? 1)).toBeLessThan(1.2);
  });

  it('recovers at most once, however many times the model repeats itself', async () => {
    const { events, model } = await answer([RECOVERABLE, RECOVERABLE, RECOVERABLE]);
    const result = completed(events);

    // Not "usually one": the loop sets its instruction in a branch guarded by the attempt count and has no
    // state in which a third generation is reachable.
    expect(model.calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(events.filter((event) => event.type === 'status' && event.phase === 'recovering').length).toBe(1);
  });
});

describe('when recovery does not settle it', () => {
  it('removes the statements that still have no evidence, rather than returning them', async () => {
    const { events } = await answer([`${RECOVERABLE} ${SOUND}`, `${RECOVERABLE} ${SOUND}`]);
    const result = completed(events);

    /*
     * The point was never to launder a bad answer into a green badge, and it was never to hand a reader a
     * page of prose with a red one either. What is shown verifies; what is not shown is named in the
     * diagnostics.
     */
    expect(result.status).toBe('limited-evidence');
    expect(result.text).not.toContain('sym:invented.ts#Nope');
    expect(result.text).toContain('packages/core');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.recovery?.removedStatements).toBeGreaterThan(0);
  });

  it('keeps the original where the second attempt collapsed into a summary', async () => {
    /*
     * A second attempt has a trivially available way to make zero unsupported claims: say almost nothing.
     * That answer scores perfectly on every check and is worse for a reader than the flawed one it
     * replaced.
     */
    const { events } = await answer([`${RECOVERABLE} ${SOUND} ${SOUND} ${SOUND} ${SOUND}`, 'Not much.']);
    const result = completed(events);

    expect(result.text).not.toBe('Not much.');
    expect(result.text).toContain('packages/core');
  });
});

describe('the recovery request', () => {
  /*
   * Squeezed, because the report a recovery request reads is the one a *bounded* projection produces.
   * On the shared fixture at `standard` nothing is omitted, so every claim is licensed and there is no
   * failure to translate — which is the right behaviour and the wrong fixture for testing the translation.
   */
  const projection = project(repositoryContext(), {
    tier: 'minimal',
    intent: 'architecture',
    reserved: 900,
    coreReserved: 800,
  });

  it('asks for the families that carry the evidence the failed claim needed', () => {
    const report = checkGrounding('Authentication is handled by the middleware layer [f1].', projection);
    const plan = recoveryFor(report);

    // An authentication claim is licensed by access-control middleware or an authentication route — so
    // the families that carry role annotations and routes are what it goes back for.
    expect(plan.parts.length).toBeGreaterThan(0);
    expect(plan.parts).toContain('architecture');
    expect(plan.parts).toContain('routes');
  });

  it('asks for the families that carry identifiers of the kind that was rejected', () => {
    const plan = recoveryFor(checkGrounding(RECOVERABLE, projection));

    // A `sym:` the facts do not carry may be a declaration the budget never reached.
    expect(plan.parts).toContain('architecture');
    expect(plan.parts).toContain('hotspots');
  });

  it('asks for nothing where no fact of any kind could license the claim', () => {
    const report = checkGrounding(UNLICENSABLE, projection);

    // `presence-as-quality` has an empty licence list by construction: nothing this analysis produces is a
    // measurement of documentation, so retrieval cannot help and the pass must not run.
    expect(recoveryFor(report).parts).toEqual([]);
  });

  it('is bounded, however many distinct failures one answer contains', () => {
    const report = checkGrounding(
      [
        'The build begins with `packages/core` and then runs the rest [f1].',
        'Authentication is handled by sym:invented.ts#Guard [f1].',
        'It depends on `left-pad` and on `some-org/some-tool` [f1].',
        'The cache is deployed to production every night [f1].',
      ].join(' '),
      projection,
    );

    expect(recoveryFor(report).parts.length).toBeLessThanOrEqual(6);
  });
});

describe('the regeneration instruction', () => {
  const instruction = recoveryInstruction({
    fabricated: ['sym:invented.ts#Nope'],
    unsupportedTerms: ['express'],
    recovered: true,
    claims: [
      {
        sentence: 'Authentication works through `set_secret.py` [f3].',
        kind: 'secrets-as-authentication',
        detail: 'the facts carry no access-control middleware or an authentication route',
      },
    ],
  });

  it('names the sentence and the reason, rather than asking for more care', () => {
    expect(instruction).toContain('Authentication works through');
    expect(instruction).toContain('access-control middleware');
  });

  it('strips the citations from the quoted sentence, which name a projection that no longer exists', () => {
    // Recovery renumbered every fact. Quoting `[f3]` back at a model that has just been told to cite
    // exactly would put a dead id in front of it.
    expect(instruction).not.toContain('[f3]');
  });

  it('says the evidence changed, which is what makes this a different request', () => {
    expect(instruction).toContain('reselected');
    expect(recoveryInstruction({ fabricated: [], unsupportedTerms: [], recovered: false, claims: [] })).toContain(
      'no further evidence',
    );
  });

  it('forbids both easy ways out — a shorter answer and a softer one', () => {
    expect(instruction).toContain('a hedge is not a correction');
    expect(instruction).toContain('shortening the answer is not a fix');
  });

  it('offers the two supportable ways out, rather than only forbidding one', () => {
    expect(instruction).toContain('state what the facts now in front of you establish');
    expect(instruction).toContain('does not establish it');
  });
});

describe('safe finalisation', () => {
  const projection = project(repositoryContext(), { tier: 'standard' });

  const reduce = (text: string) => finalise(text, checkGrounding(text, projection), projection);

  it('leaves a sound answer exactly as written', () => {
    const result = reduce(SOUND);

    expect(result.reduced).toBe(false);
    expect(result.text).toBe(SOUND);
    expect(result.removedSentences).toBe(0);
  });

  it('removes only the sentence that failed, keeping the rest of the paragraph', () => {
    const result = reduce(`${SOUND} ${UNLICENSABLE} ${SOUND}`);

    expect(result.text).toContain('packages/core');
    expect(result.text).not.toContain('well documented');
    expect(result.removedSentences).toBe(1);
  });

  it('removes a sentence that named an identifier no fact carried', () => {
    const result = reduce(`${SOUND} It also calls sym:invented.ts#Nope [f1].`);

    expect(result.text).not.toContain('sym:invented.ts#Nope');
    expect(result.text).toContain('packages/core');
  });

  it('keeps a sentence whose only fault was a citation that does not resolve, and drops the citation', () => {
    /*
     * A `[f9999]` in a projection of forty facts is a model miscounting, not a false claim. Deleting a true
     * sentence for it would be the over-correction this module is otherwise guarding against.
     */
    const result = reduce('It is organised into packages, the largest of which is `packages/core` [f9999].');

    expect(result.text).toContain('packages/core');
    expect(result.text).not.toContain('f9999');
    expect(result.strippedCitations).toBe(1);
  });

  it('says so plainly when nothing survives, rather than returning an empty answer', () => {
    const result = reduce(UNLICENSABLE);

    expect(result.text).toContain('could not be given from the evidence available');
    expect(result.reduced).toBe(true);
  });

  it('leaves what it returns verifiable, which is the guarantee', () => {
    const result = reduce(`${SOUND} ${UNLICENSABLE} It calls sym:invented.ts#Nope [f1].`);

    expect(result.report.verdict).not.toBe('ungrounded');
    expect(result.report.unsupportedClaims).toEqual([]);
    expect(result.report.fabricatedIdentifiers).toEqual([]);
  });
});
