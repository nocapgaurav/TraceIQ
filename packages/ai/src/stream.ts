import type { Omission } from './facts.js';
import type { PromptBreakdown } from './prompt.js';
import type { Answer } from './answer.js';

/**
 * What answering emits.
 *
 * **`grounding` always arrives before the first `delta`.** A consumer can show what the answer is
 * permitted to be based on — and what was left out — before any prose appears, which is the right order
 * for a grounded tool: the evidence precedes the claim.
 *
 * A failure is thrown, not emitted. An error event is ignorable; a throw from an async iterator is not.
 * A transport that has already sent bytes cannot answer with an error status, so the SSE adapter — a later
 * milestone — translates a throw into a terminal frame. That is a wire concern, not this one.
 */
export type AnswerEvent =
  | { readonly type: 'status'; readonly phase: AnswerPhase }
  | { readonly type: 'grounding'; readonly grounding: GroundingSummary }
  | { readonly type: 'delta'; readonly text: string }
  /**
   * The answer so far is being replaced, and why.
   *
   * **Emitted exactly once per answer at most, immediately before the corrective generation.** The
   * verification stage runs after the first answer has already been streamed, so a consumer that has been
   * rendering deltas is holding prose that is about to be superseded. Telling it to discard is the only
   * honest option: leaving the old text on screen until `complete` arrives would show a reader an answer
   * the pipeline had already rejected, and doing nothing would splice the corrected text onto the end of
   * the original.
   *
   * `reasons` carries the diagnostics that failed, so a consumer can say *what* was wrong rather than
   * flashing the answer away without explanation.
   */
  | { readonly type: 'restart'; readonly reasons: readonly string[] }
  | { readonly type: 'complete'; readonly answer: Answer };

/**
 * Which stage answering has reached.
 *
 * **Emitted because the silence was measured and it is long.** On the reference stack the whole gap
 * between the last preparatory frame and the first token was 89 seconds, all of it prompt evaluation
 * at 45.75 tokens per second, and nothing at all was on the wire for any of it. A user saw one
 * spinner reading "Reading the repository…" for a minute and a half and could not tell a working
 * answer from a dead one — and neither could any proxy in between, which is the other half of why
 * this exists.
 *
 * The vocabulary is closed and matches the pipeline's own stages, so a consumer renders a phase
 * without parsing prose and a new stage cannot appear without a deliberate change here.
 *
 * `re-projecting` is not a stage but a retry: the provider rejected a prompt this layer had estimated
 * as fitting, and the budget is stepping down a tier. Saying so beats a second `projecting` that looks
 * like the first one repeating.
 */
export const ANSWER_PHASES = [
  'acquiring-context',
  'projecting',
  're-projecting',
  'awaiting-model',
  'generating',
  'verifying',
  /**
   * The first answer made a claim its facts do not license, so the evidence is being reselected around the
   * kinds of fact those claims needed, and the answer generated once more.
   *
   * **A named phase because it is the only stage that can double an answer's latency**, and a user watching
   * a spinner for three minutes deserves to know that the second half of the wait is deliberate. It happens
   * at most once per answer — see `RepositoryAnswerer.answer` — so a consumer that sees it twice is looking
   * at a defect.
   */
  'recovering',
  /**
   * Verification has finished and whatever it rejected is being removed.
   *
   * Microseconds, and named anyway: it is the stage that can change the text a consumer has already
   * streamed, so a `restart` arriving after it is explained rather than sudden.
   */
  'finalising',
] as const;

export type AnswerPhase = (typeof ANSWER_PHASES)[number];

/**
 * How the answer was shaped, in the few fields a consumer can act on.
 *
 * Flattened from the profile and the strategy rather than carrying either whole: a UI needs to say
 * "explained as a framework, at subsystem depth", and shipping the evidence arrays behind that would be
 * shipping the projection twice.
 */
export interface AnswerShape {
  /** The repository type the profile derived. `unknown` where the evidence settled nothing. */
  readonly type: string;
  readonly scale: string;
  /** Structural traits, in the profile's own vocabulary. */
  readonly traits: readonly string[];
  /** How much of the repository the answer was permitted to cover. */
  readonly depth: string;
  /** The subsystem the question was narrowed to, or `null` for a repository-wide question. */
  readonly focus: string | null;
  /**
   * What the answer was built to lead with, and what the reader was taken to need.
   *
   * **Reported because "why did it answer like that" is otherwise unanswerable.** Two repositories
   * given the same question now diverge from the first sentence, and this names the decision that
   * made them diverge — `orientation` rather than `components`, and the need line that shaped it.
   */
  readonly lead: string;
  readonly need: string;
  /** How many workflows the answer was told to narrate, and how many components to spend space on. */
  readonly workflows: number;
  readonly components: number;
  /** How much the question was taken to already know. Steers assumption, never depth. */
  readonly audience: string;
  /** How sure the planner was of its reading. `uncertain` means the repository's default shape. */
  readonly confidence: string;
  /**
   * The sections the answer was asked for, in order.
   *
   * **The single most useful field here when an answer reads wrongly.** Prose that wandered is prose
   * that either ignored this list or was given the wrong one, and the two are indistinguishable without
   * it. Titles only — the evidence behind each section is the planner's working, not a consumer's.
   */
  readonly sections: readonly string[];
  /** Concepts the answer was told to leave alone. Empty for a repository-wide question. */
  readonly exclusions: readonly string[];
  /**
   * What the question needed that the graph could not supply.
   *
   * Reported because a hedged answer and an answer about a repository whose analysis came up short look
   * identical from outside. This says which one happened.
   */
  readonly unknowns: readonly string[];
  /** What earlier turns already explained, and this answer was told not to repeat. */
  readonly covered: readonly string[];
  /** How the fact budget was divided, by group. Shares, summing to one. */
  readonly allocation: Readonly<Record<string, number>>;
  /**
   * What the top-level map said the repository is, independent of what its declarations rank.
   *
   * **The field that explains an answer nothing else can.** When a repository of samples is described as
   * a CI tool, the question is whether the planner knew what it was looking at; this says so directly.
   */
  readonly category: string;
  /** Whether the repository holds what the question asked about, and what was looked for. */
  readonly evidence: { readonly verdict: string; readonly concept: string; readonly detail: string };
  /** Semantic roles the question restricted its evidence to. Empty where it asked about the repository. */
  readonly roles: readonly string[];
}

/**
 * The session, described rather than carried.
 *
 * The counts and the names, never the transcript: a consumer that wants the conversation already has
 * it, and what it cannot otherwise see is how much of it reached the prompt.
 */
export interface ConversationSummary {
  readonly turns: number;
  /** Turns present only as the topics they contributed, rather than as their questions. */
  readonly compressed: number;
  /** Topics the session has had explained, oldest first. */
  readonly covered: readonly string[];
  readonly focus: string | null;
  /** Whether this question's subject was carried from the session rather than named by the question. */
  readonly continued: boolean;
  /** Parts of the repository this session has not reached. */
  readonly remaining: readonly string[];
  readonly level: string;
}

/** The projection, described rather than carried: a consumer wants the shape, not thousands of facts. */
export interface GroundingSummary {
  readonly kind: string;
  readonly subject: string | null;
  readonly factCount: number;
  /** How many of those facts are the stable, question-independent core. */
  readonly coreCount: number;
  /** What the question was taken to be about. `overview` when nothing question-specific was asked for. */
  readonly intent: string;
  /**
   * What the repository was taken to be, and how the answer was shaped for it.
   *
   * **Reported for the same reason `promptTokens` is: an adaptation nobody can see is an adaptation
   * nobody can debug.** When two repositories receive visibly different answers, this is the field that
   * says whether that was the profile working or the model improvising — and when an answer is shaped
   * wrongly, it names the rule that shaped it. `null` where no profile could be derived.
   */
  readonly shape: AnswerShape | null;
  /**
   * What the session had established when this answer was planned.
   *
   * **Reported because a compressed conversation is invisible otherwise, and invisible compression is
   * indistinguishable from a model that forgot.** When a follow-up is answered as though it were a new
   * question, this says whether the state had the focus and the answer ignored it, or whether the
   * state never had it. `null` on a first turn.
   */
  readonly conversation: ConversationSummary | null;
  readonly omissions: readonly Omission[];
  readonly tier: string;
  readonly tokens: number;
  /**
   * Where the prompt's tokens went, by section.
   *
   * Reported rather than kept in a benchmark script, because prompt size is the single biggest lever
   * on how long an answer takes — near 50 tokens per second on the reference stack, so every 1,000
   * tokens is about 20 seconds before the first word. An operator looking at a slow answer should be
   * able to see what it was spent on.
   */
  readonly promptTokens: PromptBreakdown | null;
  readonly digest: string;
}

/**
 * Drains a stream into its finished answer.
 *
 * The only non-streaming path, deliberately: were both primitives, providers would maintain two code
 * paths and streaming would become the one nobody exercises. Everything blocking is built from this.
 */
export async function collect(events: AsyncIterable<AnswerEvent>): Promise<Answer> {
  let answer: Answer | null = null;

  for await (const event of events) {
    if (event.type === 'complete') {
      answer = event.answer;
    }
  }

  if (answer === null) {
    // Unreachable through `RepositoryAnswerer`, which always ends with `complete` or throws. Guarding
    // rather than asserting, because a custom stream could break the contract and a null return would
    // then surface far from its cause.
    throw new Error('the answer stream ended without completing');
  }

  return answer;
}

/** Collects the text of a stream, ignoring everything else. Useful for a caller that only wants prose. */
export async function collectText(events: AsyncIterable<AnswerEvent>): Promise<string> {
  const parts: string[] = [];

  for await (const event of events) {
    if (event.type === 'delta') {
      parts.push(event.text);
    }
  }

  return parts.join('');
}
