import { RepositoryAnswerer, type Answer, type ContextSource, type GroundingVerdict, type LanguageModel } from '@traceiq/ai';
import type { ContextRequest } from '@traceiq/context';
import type { NodeId } from '@traceiq/types';

import { CliError } from './errors.js';
import type { Io } from './types.js';

/**
 * `traceiq chat` — an interactive REPL over `RepositoryAnswerer`.
 *
 * **No AI logic here.** This file reads a line, hands it to the answerer, prints what streams back and
 * formats the result. It contains no projection, no prompt, no grounding check and no provider: the model
 * arrives already resolved, exactly as the REST API receives one.
 *
 * `chat` cannot be an ordinary `Command`, because a `Command` returns one string when it finishes and a
 * REPL has to write as it goes and read between writes. It is therefore its own mode, dispatched before
 * the command table.
 */
export interface ChatOptions {
  readonly model: LanguageModel;
  /** Where the subject comes from. Resolved by the caller — this layer never searches. */
  readonly subject: ContextRequest;
  /** ANSI colour. Off for a pipe or when NO_COLOR is set, so redirected output stays plain and diffable. */
  readonly colour: boolean;
  /** Lines the user types. Injected so a test drives the REPL without a terminal. */
  readonly lines: AsyncIterable<string>;
  /**
   * Subscribes to interrupts, returning an unsubscribe. `Ctrl+C` cancels the answer in flight.
   *
   * **Not an `AsyncIterable`.** A stream of interrupts has no end, so the `await` that drained it never
   * settled: the REPL produced its first answer, printed the footer, and then hung forever instead of
   * reading the next line. A subscription can be cancelled synchronously, which is exactly what a
   * per-answer watcher needs.
   */
  readonly onInterrupt?: (handler: () => void) => () => void;
}

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  cyan: '[36m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
} as const;

/** Colour applied only when it was asked for, so one code path produces both forms. */
export function paint(text: string, colour: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[colour]}${text}${ANSI.reset}` : text;
}

/**
 * A verdict, as a word and a colour.
 *
 * The verdict is never omitted and never softened: an ungrounded answer says so on the line after it.
 */
export function renderVerdict(verdict: string, colour: boolean): string {
  const tone = verdict === 'grounded' ? 'green' : verdict === 'ungrounded' ? 'red' : 'yellow';

  return paint(verdict, tone, colour);
}

/** The grounding line shown before an answer begins. */
export function renderGrounding(
  grounding: { kind: string; factCount: number; tier: string; tokens: number; digest: string; omissions: readonly { part: string; kept: number; total: number }[] },
  colour: boolean,
): string {
  const head = `${grounding.factCount} facts · ${grounding.tokens} tokens · tier ${grounding.tier} · ${grounding.digest}`;
  const lines = [paint(head, 'dim', colour)];

  // A cap is never silent, in the terminal as everywhere else.
  for (const omission of grounding.omissions) {
    lines.push(paint(`  ${omission.part}: showing ${omission.kept} of ${omission.total}`, 'yellow', colour));
  }

  return lines.join('\n');
}

/** The citations an answer used, each with the fact it points at and the capability that established it. */
export function renderCitations(
  citations: readonly { factId: string; fact: { subject: string; predicate: string; object: string; provenance: string } }[],
  colour: boolean,
): string {
  if (citations.length === 0) {
    return '';
  }

  return citations
    .map(
      (citation) =>
        `  ${paint(`[${citation.factId}]`, 'cyan', colour)} ${citation.fact.subject} ` +
        `${paint(citation.fact.predicate, 'bold', colour)} ${citation.fact.object} ` +
        `${paint(citation.fact.provenance, 'dim', colour)}`,
    )
    .join('\n');
}

export const CHAT_BANNER = [
  'traceiq chat — answers are grounded in the repository graph and cite the facts they used.',
  'Type a question. /subject to see what is being asked about, /clear to forget the conversation,',
  '/exit or Ctrl+D to leave. Ctrl+C cancels an answer in progress.',
].join('\n');

/**
 * Runs the REPL until the input ends.
 *
 * Conversation history lives here, in memory, for the length of the session — persistence is a later
 * milestone and the AI layer holds only the types. Only questions and answers are replayed; the facts that
 * grounded a prior turn never are, so each turn stands on facts acquired for it.
 */
export async function runChat(source: ContextSource, io: Io, options: ChatOptions): Promise<number> {
  // A `ContextSource` has one method. That is the whole of this mode's access to the repository: it cannot
  // traverse, query, search or reach a capability, and this file imports no graph type to do it with.
  const answerer = new RepositoryAnswerer(source, options.model);
  const description = options.model.describe();

  io.write(`${CHAT_BANNER}\n`);
  io.write(
    `${paint(`model ${description.id} · ${description.contextWindow} token window · subject ${describeSubject(options.subject)}`, 'dim', options.colour)}\n\n`,
  );

  const turns: { question: string; answer: string; verdict: GroundingVerdict }[] = [];
  let subject = options.subject;
  let failures = 0;

  for await (const line of options.lines) {
    const question = line.trim();

    if (question === '') {
      continue;
    }

    if (question === '/exit' || question === '/quit') {
      break;
    }

    if (question === '/clear') {
      turns.length = 0;
      io.write(`${paint('conversation cleared', 'dim', options.colour)}\n\n`);

      continue;
    }

    if (question === '/subject') {
      io.write(`${describeSubject(subject)}\n\n`);

      continue;
    }

    if (question.startsWith('/subject ')) {
      try {
        subject = parseSubjectArgument(question.slice('/subject '.length).trim());
        // A new subject makes prior turns' answers misleading as conversation, so the history is dropped.
        turns.length = 0;
        io.write(`${paint(`subject is now ${describeSubject(subject)}`, 'dim', options.colour)}\n\n`);
      } catch (error) {
        io.writeError(`${error instanceof CliError ? error.render() : String(error)}\n`);
      }

      continue;
    }

    const outcome = await ask(answerer, io, {
      question,
      subject,
      turns,
      colour: options.colour,
      ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
    });

    if (outcome.failed) {
      failures += 1;
    } else {
      turns.push({ question, answer: outcome.text, verdict: outcome.verdict });
    }
  }

  io.write(`${paint('bye', 'dim', options.colour)}\n`);

  // A session that never managed to answer anything exits non-zero, so a script can tell.
  return failures > 0 && turns.length === 0 ? 5 : 0;
}

interface AskInput {
  readonly question: string;
  readonly subject: ContextRequest;
  readonly turns: readonly { question: string; answer: string; verdict: GroundingVerdict }[];
  readonly colour: boolean;
  readonly onInterrupt?: (handler: () => void) => () => void;
}

async function ask(
  answerer: RepositoryAnswerer,
  io: Io,
  input: AskInput,
): Promise<{ readonly failed: boolean; readonly text: string; readonly verdict: GroundingVerdict }> {
  const controller = new AbortController();
  let cancelled = false;

  // Ctrl+C aborts the answer rather than the process: the session survives, which is what makes a REPL
  // usable against a slow local model. Leaving is /exit or Ctrl+D.
  //
  // Subscribed for the length of this answer and released in `finally`. The previous shape — draining an
  // `AsyncIterable` of interrupts — could not be released, because that iterable never ends, so awaiting it
  // hung the REPL after its first answer.
  const unsubscribe = input.onInterrupt?.(() => {
    cancelled = true;
    controller.abort();
  });

  let text = '';
  /*
   * The guard's own verdict, recorded rather than assumed.
   *
   * Conversation memory reads it to decide which earlier questions are still owed an answer, and a
   * session that reported every turn as `unverifiable` would report every question as unanswered. The
   * REPL has the verdict on the `complete` event; nothing but inattention was dropping it.
   */
  let verdict: GroundingVerdict = 'unverifiable';

  try {
    for await (const event of answerer.answer(
      {
        question: input.question,
        subject: input.subject,
        ...(input.turns.length === 0
          ? {}
          : {
              history: {
                turns: input.turns.map((turn, index) => ({
                  id: String(index),
                  question: turn.question,
                  answer: turn.answer,
                  subject: input.subject,
                  citations: [],
                  verdict: turn.verdict,
                  projectionDigest: '',
                  model: '',
                })),
              },
            }),
      },
      controller.signal,
    )) {
      if (event.type === 'status') {
        // Only the wait that is actually long is announced. Prompt evaluation was measured at 45.75
        // tokens per second, so a terminal sitting silent for a minute and a half is the common case
        // rather than a rare one; the other phases are milliseconds and naming them would be noise.
        if (event.phase === 'awaiting-model') {
          io.write(`${paint('waiting for the model to read the facts…', 'dim', input.colour)}\n`);
        }
      } else if (event.type === 'grounding') {
        io.write(`${renderGrounding(event.grounding, input.colour)}\n\n`);
      } else if (event.type === 'delta') {
        // Written as it arrives: a local model takes seconds, and a spinner would say less than the text.
        text += event.text;
        io.write(event.text);
      } else if (event.type === 'restart') {
        /*
         * The answer above has been rejected and is being rewritten.
         *
         * A terminal cannot unprint, so the only honest option is to say so and draw a line. Leaving the
         * rejected prose with no marker would let a reader scroll up and quote an answer the pipeline had
         * already thrown away — which is worse than showing it once with a rule under it.
         */
        text = '';
        io.write(
          `\n\n${paint('— the answer above was rejected and is being rewritten —', 'yellow', input.colour)}\n` +
            event.reasons
              .slice(0, 3)
              .map((reason) => `${paint(`  ${reason}`, 'dim', input.colour)}\n`)
              .join('') +
            '\n',
        );
      } else {
        verdict = event.answer.verdict;
        io.write(`\n\n${renderFooter(event.answer, input.colour)}\n\n`);
      }
    }

    return { failed: false, text, verdict };
  } catch (error) {
    if (cancelled) {
      io.write(`\n${paint('cancelled', 'yellow', input.colour)}\n\n`);

      return { failed: false, text, verdict };
    }

    io.writeError(`\n${renderChatError(error, input.colour)}\n\n`);

    return { failed: true, text, verdict };
  } finally {
    controller.abort();
    unsubscribe?.();
  }
}

function renderFooter(answer: Answer, colour: boolean): string {
  const lines: string[] = [];
  const usage =
    answer.usage.promptTokens === null && answer.usage.outputTokens === null
      ? ''
      : ` · ${answer.usage.promptTokens ?? '?'} prompt / ${answer.usage.outputTokens ?? '?'} output tokens`;

  lines.push(
    `${paint('verdict', 'dim', colour)} ${renderVerdict(answer.verdict, colour)}` +
      paint(` · ${answer.model} · ${answer.stopReason}${usage}`, 'dim', colour),
  );

  if (answer.attempts > 1) {
    // The rewrite is reported whether or not it worked: that the model's first instinct was rejected is
    // information about this answer, and it also explains why it took twice as long to arrive.
    lines.push(
      paint(
        `  rewritten once after verification rejected ${answer.corrections.length} ${
          answer.corrections.length === 1 ? 'claim' : 'claims'
        }`,
        'yellow',
        colour,
      ),
    );
  }

  if (answer.fabricatedIdentifiers.length > 0) {
    lines.push(
      paint(`  invented, and not in the graph: ${answer.fabricatedIdentifiers.join(', ')}`, 'red', colour),
    );
  }

  const citations = renderCitations(answer.citations, colour);

  if (citations !== '') {
    lines.push(citations);
  } else if (answer.verdict === 'unverifiable') {
    lines.push(paint('  no facts were cited, so nothing in this answer could be checked', 'yellow', colour));
  }

  return lines.join('\n');
}

/** An error from the AI layer, rendered with its own code. Nothing is reworded. */
export function renderChatError(error: unknown, colour: boolean): string {
  if (error instanceof CliError) {
    return error.render();
  }

  const withCode = error as { code?: unknown; detail?: unknown; hint?: unknown };

  if (typeof withCode.code === 'string' && typeof withCode.detail === 'string') {
    return [
      `${paint('error:', 'red', colour)} ${withCode.code}`,
      `  ${withCode.detail}`,
      `  ${typeof withCode.hint === 'string' ? withCode.hint : ''}`.trimEnd(),
    ].join('\n');
  }

  return `${paint('error:', 'red', colour)} ${error instanceof Error ? error.message : String(error)}`;
}

/** A subject, in one line, for the banner and `/subject`. */
export function describeSubject(subject: ContextRequest): string {
  switch (subject.kind) {
    case 'symbol':
    case 'impact':
      return `${subject.kind} ${subject.id}`;
    case 'file':
      return `file ${subject.path}`;
    case 'package':
      return `package ${subject.name}`;
    case 'route':
      return `route ${subject.method} ${subject.path}`;
    case 'repository':
      return 'the repository as a whole';
    case 'search':
      return `search ${subject.query.text}`;
  }
}

/**
 * Turns `--subject` into a `ContextRequest`.
 *
 * **This is not search.** An identifier prefix decides the kind, and nothing is looked up: `sym:` is a
 * declaration, `file:` a file, `pkg:` a package. A bare word is refused rather than guessed at, because
 * guessing would be repository search and that belongs to `traceiq search`.
 */
export function parseSubjectArgument(value: string): ContextRequest {
  const trimmed = value.trim();

  if (trimmed === '' || trimmed === 'repository') {
    return { kind: 'repository' };
  }

  if (trimmed.startsWith('impact:')) {
    return { kind: 'impact', id: trimmed.slice('impact:'.length) as NodeId };
  }

  if (trimmed.startsWith('sym:')) {
    return { kind: 'symbol', id: trimmed as NodeId };
  }

  if (trimmed.startsWith('file:')) {
    return { kind: 'file', path: trimmed.slice('file:'.length) };
  }

  if (trimmed.startsWith('pkg:')) {
    return { kind: 'package', name: trimmed.slice('pkg:'.length) };
  }

  const route = /^route:([A-Z]+):(.+)$/.exec(trimmed);

  if (route !== null) {
    return { kind: 'route', method: route[1] ?? '', path: route[2] ?? '' };
  }

  throw new CliError(
    'missing-argument',
    `'${trimmed}' is not a subject`,
    "use repository, sym:<id>, impact:sym:<id>, file:<path>, pkg:<name> or route:<METHOD>:<path> — run 'traceiq search <text>' to find an identifier",
  );
}
