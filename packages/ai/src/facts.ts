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
  // What the analysis could not determine
  'limitation',
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
export const CITATION_PATTERN = /\[(f\d+(?:\s*,\s*f\d+)*)\]/g;

/** Splits one matched citation group into its fact ids. */
export function citationIds(group: string): readonly string[] {
  return group
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
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
  /** Every identifier the model is permitted to name. The grounding guard's whole basis. */
  readonly identifiers: ReadonlySet<string>;
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
