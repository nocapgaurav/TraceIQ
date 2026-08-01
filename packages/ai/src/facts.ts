/**
 * The unit of grounding.
 *
 * A `Fact` is a **restatement** of something the repository context already held — one edge, or one field
 * of one node. Nothing here is summarised, inferred, ranked or scored; if a fact is not in the context it
 * cannot become one here.
 *
 * Facts exist because a `RepositoryContext` cannot be put in a prompt. Measured on TraceIQ itself, an
 * `impact` context is 4.2 MB — roughly 1.2 million tokens, nine times a 128k window. A fact is the
 * smallest citable thing a model can be given instead.
 */

/** A citation target. Short on purpose: a model must repeat it exactly, and every token costs. */
export type FactId = string;

/**
 * How a fact relates its subject to its object.
 *
 * A closed vocabulary, so a consumer groups facts without parsing prose. Every value names something a
 * capability already established — the graph's own relationship types, or a property of a node.
 */
export const PREDICATES = [
  // Identity and location
  'is-a',
  'named',
  'declared-in',
  'located-at',
  'exported',
  'in-package',
  'has-role',
  'enclosed-by',
  'encloses',
  // Relationships, as the graph records them
  'calls',
  'called-by',
  'references',
  'referenced-by',
  'references-type',
  'imports',
  'imported-by',
  'reads-env',
  'depends-on',
  'depended-on-by',
  'handles-route',
  'route-middleware',
  // Impact, kept in the analyser's own categories
  'affects-directly',
  'affects-indirectly',
  'affects-route',
  'unresolved',
  // Condition
  'fan-in',
  'fan-out',
  'in-cycle',
  'isolated',
  'recursive',
  'finding',
  // Repository scale
  'metric',
  'contains',
  'cycle-member',
  'hotspot',
  /**
   * What the repository is *organised into*, and where a reader should start.
   *
   * `has-package` names one unit of the repository with its size and how many other units depend on
   * it; `entry-point` names a file or declaration that reaches the most of it. Neither could be
   * expressed by `contains`, which carries counts rather than names — and a count is exactly the
   * thing that cannot answer "what are the main packages".
   */
  'has-package',
  'entry-point',
  // What the analysis could not determine
  'limitation',
  // What the repository is made of, and how deeply each part was read. These three exist so an answer
  // can distinguish an absence that was measured from one that was never looked at, and so a polyglot
  // repository can be described as the several things it is rather than as its analysed part.
  'written-in',
  'is-polyglot',
  'analysis-depth',
  'region-depth',
  /**
   * What the repository is *built with*, and what each part of it *is*.
   *
   * Distinct from `written-in`, which is a language, and from `depends-on`, which is a package a
   * manifest names. `built-with` says a framework is in use and carries the files that prove it, so
   * an answer to "what does this repository do" can start from "a Next.js application talking to a
   * Flask service" rather than from a file count. Without these an answer could name every language
   * in a repository and still not say what any of it was for.
   */
  'built-with',
] as const;

export type Predicate = (typeof PREDICATES)[number];

/** The graph's confidence vocabulary, carried through unchanged. There is no numeric score anywhere. */
export type FactConfidence = 'CERTAIN' | 'RESOLVED' | 'INFERRED' | 'AMBIGUOUS';

export interface Fact {
  readonly id: FactId;
  /** An identifier from the graph, or a bare label for a fact whose subject is the repository. */
  readonly subject: string;
  readonly predicate: Predicate;
  readonly object: string;
  readonly confidence: FactConfidence;
  /** Which capability established this, taken from the context's own provenance. */
  readonly provenance: string;
}

/**
 * What a cap left out.
 *
 * The API's `Listing` carries an exact total beside a shortened list precisely so a cap is never silent.
 * A projection inherits that obligation: an answer built on forty of nine hundred dependents that does
 * not say so is a lie by omission. Omissions reach both the prompt and the caller.
 */
export interface Omission {
  /** The part of the context this came from, e.g. `indirectlyAffected`. */
  readonly part: string;
  readonly kept: number;
  readonly total: number;
}

/**
 * A fact a generated answer referred to, resolved.
 *
 * The whole fact rather than its id, so a consumer — the CLI, the API, the frontend — can display the
 * supporting evidence and its provenance without holding the projection that produced it.
 */
export interface Citation {
  readonly factId: FactId;
  readonly fact: Fact;
}

/** Identity prefixes the graph uses. The grounding guard recognises a fabricated identifier by these. */
export const IDENTIFIER_PREFIXES = ['sym:', 'file:', 'route:', 'env:', 'ext:'] as const;

/**
 * External identity kinds that are **not** an ecosystem dependency.
 *
 * An `ext:` node is any reference that left the repository, and only some of those are things a
 * manifest could declare. The graph spells the difference into the identity itself — `ext:<kind>:<name>`
 * — so the distinction is already recorded and this only has to read it.
 *
 * **A deny list rather than an allow list, and that is the whole design.** The alternative is to
 * enumerate npm, pip, Maven, Gradle, Go modules, Cargo, NuGet, Composer and Bundler here, which means
 * a tenth ecosystem silently disappears from every answer until somebody remembers this file. The
 * things that are *not* packages are a closed, slow-moving set — a language's own builtins, a
 * language's own standard library, and the sentinel for a reference whose target could not be named —
 * so denying those admits every ecosystem, including ones that do not exist yet. That is the single
 * strategy the milestone asked for, and it is one line rather than one line per language.
 *
 * `node` and `stdlib` are both here: Node's library is a standard library that happens to have kept its
 * own kind for identity-stability reasons, and `require('fs')` is no more a dependency of a repository
 * than `import java.util` is.
 */
export const NON_DEPENDENCY_EXTERNAL_KINDS = ['builtin', 'node', 'stdlib', 'outside-analysis'] as const;

/**
 * Whether an external identifier names a real, declarable ecosystem dependency.
 *
 * Two conditions, both necessary. The kind must not be one of the non-dependency kinds above, and the
 * identity must actually carry a **name** — `ext:builtin` and `ext:outside-analysis` are nameless
 * sentinels by construction, and a nameless node put in front of a model is an invitation to invent a
 * name for it.
 *
 * Measured on `facebook/react`, where 740 external nodes divide into 395 `builtin`, 11 `node`, 333
 * `npm` and one `outside-analysis`: without this the first fifteen dependencies a model was shown were
 * fifteen language builtins, because the list is alphabetical by identifier and `ext:builtin:` sorts
 * before `ext:npm:`. Not one real dependency reached the prompt.
 */
export function isEcosystemDependency(identifier: string): boolean {
  if (!identifier.startsWith('ext:')) {
    return false;
  }

  const rest = identifier.slice('ext:'.length);
  const separator = rest.indexOf(':');

  if (separator <= 0 || separator === rest.length - 1) {
    // No kind/name split at all: a bare sentinel such as `ext:outside-analysis`.
    return false;
  }

  const kind = rest.slice(0, separator);

  return !(NON_DEPENDENCY_EXTERNAL_KINDS as readonly string[]).includes(kind);
}

/** The package name inside an ecosystem identity — `ext:npm:react` → `react`. */
export function dependencyNameOf(identifier: string): string | null {
  if (!isEcosystemDependency(identifier)) {
    return null;
  }

  const rest = identifier.slice('ext:'.length);

  return rest.slice(rest.indexOf(':') + 1);
}

/**
 * Matches an identifier anywhere in generated prose.
 *
 * Deliberately greedy about the tail and trimmed afterwards: a model writes `sym:a.ts#B.` at the end of a
 * sentence, and treating the full stop as part of the identifier would report a fabrication that is
 * really punctuation.
 */
export const IDENTIFIER_PATTERN = /\b(?:sym|file|route|env|ext):[^\s,;)\]}'"`]+/g;

/** Strips trailing punctuation a sentence left attached to an identifier. */
export function trimIdentifier(value: string): string {
  return value.replace(/[.,;:!?]+$/, '');
}

/**
 * Matches a citation as the prompt asks for it — `[f12]` — and also the combined form models actually
 * write, `[f8, f10]`.
 *
 * The combined form is not hypothetical: a real 7B model produced `[f8, f10]` on the first live run, and a
 * pattern matching only the single form dropped two of three citations **silently**. Losing evidence an
 * answer really did provide is the worst possible direction for this layer to fail in.
 */
export const CITATION_PATTERN = /\[(f\d+(?:\s*[,-]\s*f?\d+)*)\]/g;

/**
 * Splits one matched citation group into its fact ids.
 *
 * **Three forms, because models write all three and losing one loses real evidence.** `[f8]` is the
 * form the prompt asks for; `[f8, f10]` was added when a 7B model wrote it and two of three citations
 * were silently dropped; `[f8-f12]` is a range, and it cost an answer its whole verdict — the UI
 * showed `unverifiable` beside a paragraph that had plainly cited five facts, because the pattern
 * matched nothing at all.
 *
 * A range is expanded to every id between its ends. That is what the model means by it, and the
 * grounding guard then checks each one against the closed identifier set exactly as it checks a
 * comma-separated list. A descending or absurd range yields its endpoints only, so a malformed
 * citation can never expand into thousands of ids.
 */
export function citationIds(group: string): readonly string[] {
  const ids: string[] = [];

  for (const part of group.split(',')) {
    const trimmed = part.trim();

    if (trimmed === '') {
      continue;
    }

    const range = /^f(\d+)\s*-\s*f?(\d+)$/.exec(trimmed);

    if (range === null) {
      ids.push(trimmed);
      continue;
    }

    const from = Number(range[1]);
    const to = Number(range[2]);

    // Bounded deliberately. `[f1-f9999]` is a model mistake rather than a citation of ten thousand
    // facts, and expanding it would flood the citation list with ids the answer never used.
    if (to < from || to - from > RANGE_LIMIT) {
      ids.push(`f${from}`, `f${to}`);
      continue;
    }

    for (let index = from; index <= to; index += 1) {
      ids.push(`f${index}`);
    }
  }

  return ids;
}

/** How many ids one range may expand to. Above this it is read as a mistake, not a citation. */
const RANGE_LIMIT = 50;

/**
 * A name the answer claims the repository contains, where the claim is checkable.
 *
 * **Grounding beyond identifiers is only honest if the candidate set is unambiguous.** An answer that
 * says "the architecture is layered" makes a claim no closed set can adjudicate, and flagging it would
 * make the guard noise. An answer that says the repository depends on `` `@reduxjs/toolkit` `` or on
 * `org.springframework:spring-core`, or that a package called `packages/react-dom` exists, is naming
 * something the projection either carried or did not — and that is decidable.
 *
 * So two shapes are extracted, both of which a model only writes when it means an artefact:
 *
 * 1. **A backtick span.** Models quote package, framework and file names this way, and prose almost
 *    never ends up inside backticks by accident.
 * 2. **A bare coordinate.** `@scope/name`, `group.id:artifact`, `github.com/owner/repo`,
 *    `some/path/like/this` — shapes that no English sentence produces.
 *
 * A single ordinary word is deliberately *not* a candidate even in backticks: `` `true` `` and
 * `` `null` `` appear in real answers about facts this layer emits, and reporting them would be the
 * "unusably conservative" failure this guard is supposed to avoid.
 */
export const BACKTICK_PATTERN = /`([^`\n]{1,120})`/g;

export const COORDINATE_PATTERN =
  /(?:^|[\s(["'])((?:@[\w.-]+\/[\w.-]+)|(?:[\w.-]+\.[\w-]+\/[\w./-]+)|(?:[\w.]+:[\w.-]+(?::[\w.-]+)?)|(?:[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*))(?=$|[\s,;.)\]"'])/g;

/**
 * Whether a candidate is artefact-shaped enough to be worth adjudicating.
 *
 * A term must look like something a manifest or a filesystem produced: a scope, a path, a coordinate,
 * a dotted namespace, or a hyphenated package name. A bare lowercase word is not, however it was
 * quoted, because the cost of a false accusation is an answer wrongly marked ungrounded.
 */
export function isArtefactShaped(term: string): boolean {
  if (term.length < 3 || term.length > 120 || /\s{2,}/.test(term)) {
    return false;
  }

  // A sentence fragment in backticks is not a name.
  if (term.includes(' ')) {
    return false;
  }

  // The third alternative allows a dotted group before the colon, because that is what a Maven or
  // Gradle coordinate looks like — `org.springframework:spring-core`. Requiring `[\w-]+` there rejected
  // every JVM dependency in the corpus while accepting every npm one, which is exactly the
  // single-ecosystem bias this milestone set out to remove.
  return /[@/]/.test(term) || /^[\w-]+(?:\.[\w-]+){1,}$/.test(term) || /^[\w.-]+:[\w.-]+/.test(term);
}

/** Everything the projection lets an answer name, beyond the graph's own identifiers. */
export function termsOf(values: Iterable<string>): ReadonlySet<string> {
  const terms = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();

    if (trimmed !== '') {
      terms.add(trimmed.toLowerCase());
    }
  }

  return terms;
}

/**
 * What a model is given, and the closed set of what it may name.
 *
 * This is the whole of the repository as far as an answer is concerned. Anything not here is, by
 * construction, not available to be grounded in.
 */
export interface ContextProjection {
  /** Which context kind produced this. */
  readonly kind: string;
  /** The subject, as the graph identifies it. `null` for the repository kind, which has no single one. */
  readonly subject: string | null;
  readonly facts: readonly Fact[];
  /**
   * How many leading facts form the **stable core** — the part that depends on the repository and the
   * budget tier alone, never on the question.
   *
   * The prompt renders these first so the bytes before the question-specific tail are identical between
   * questions, which is what lets the provider reuse its evaluated prefix. Measured: a repeat question
   * reused 4,832 of 4,843 prompt tokens and answered in 19 seconds against 108 cold.
   */
  readonly coreCount: number;
  /** What the question was taken to be about. `overview` when nothing question-specific was asked for. */
  readonly intent: string;
  /** Every identifier the model is permitted to name. The grounding guard's whole basis. */
  readonly identifiers: ReadonlySet<string>;
  /**
   * Every *name* the model is permitted to claim, lowercased.
   *
   * Package names, technology and framework names, dependency package names, region paths and
   * languages — the things an answer about a repository is actually made of, and which carry no `sym:`
   * prefix to check them by. Grounding used to stop at identifiers, so "this repository depends on
   * Express" was unfalsifiable while `sym:src/a.ts#B` was not.
   */
  readonly terms: ReadonlySet<string>;
  readonly omissions: readonly Omission[];
  readonly tier: string;
  /** Prompt tokens the facts cost, by the counter that measured them. */
  readonly tokens: number;
  /** Deterministic identity of these facts: two equal digests would ground an answer identically. */
  readonly digest: string;
}

/**
 * One fact as one line.
 *
 * Line-oriented rather than JSON: JSON spends roughly 40% of its tokens on repeated keys, braces and
 * quotes, and a projection is budget-bound. The shape is fixed so the same facts always render to the
 * same bytes, which is what makes a prompt reproducible.
 *
 * `CERTAIN` is omitted because it is the default and would otherwise repeat on nearly every line; the
 * three that matter are printed. Provenance is included only where it is not the graph builder, for the
 * same reason.
 */
export function factLine(fact: Fact): string {
  const confidence = fact.confidence === 'CERTAIN' ? '' : ` (${fact.confidence})`;

  return `[${fact.id}] ${fact.subject} ${fact.predicate} ${fact.object}${confidence}`;
}
