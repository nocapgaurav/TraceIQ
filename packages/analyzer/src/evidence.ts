import type { AnalyzerContribution } from './types.js';

/**
 * The depth reason a region shows, built from the evidence the analyser actually produced.
 *
 * **A fixed sentence per analyser was not honest enough.** The TypeScript analyser reported
 * "declarations, imports, calls and types are resolved" for every region it covered, whatever it
 * found. Measured against express — 141 CommonJS JavaScript files — the graph held **no imports at
 * all**, and the region still said imports were resolved. Two separate wrongs: the missing support
 * (since fixed) and a capability claiming evidence nobody had produced. The second is the worse of
 * the two, because it is the mechanism a reader is supposed to be able to trust when a page looks
 * thin.
 *
 * So the reason names categories that are present and, explicitly, those that are absent. A
 * JavaScript region legitimately has no type references — JavaScript has no annotations — and saying
 * so is a fact about the language, not a failure. A reader who sees an empty type panel can tell
 * which of the two they are looking at.
 *
 * Still fixed vocabulary: the same repository always produces the same words, and no analyser writes
 * prose. Only *which* clauses appear varies, and it varies with the evidence.
 */
export function evidenceReason(input: {
  /** How the sources were read, e.g. `the TypeScript compiler read these sources`. */
  readonly preamble: string;
  readonly contribution: AnalyzerContribution;
  /**
   * Categories this analyser does not extract at all.
   *
   * The distinction between "we looked and there were none" and "we never look" is the whole
   * business of this module, so an analyser's own gaps must not be reported as the repository's.
   * Python has no export statement and this analyser reads no annotations, so listing exports and
   * type references as *not found* in a Python region would blame the source for a limitation of
   * the tool. Omitted categories appear in neither list.
   */
  readonly omit?: readonly string[];
  /** Appended verbatim when present, for a caveat the evidence cannot express. */
  readonly caveat?: string;
}): string {
  const { contribution } = input;
  const relationships = contribution.resolved.relationships;
  const omitted = new Set(input.omit ?? []);
  const has = (type: string): boolean =>
    relationships.some((relationship) => relationship.type === type);

  const present: string[] = [];
  const absent: string[] = [];

  const record = (label: string, found: boolean): void => {
    if (omitted.has(label)) {
      return;
    }

    (found ? present : absent).push(label);
  };

  record('declarations', contribution.ir.declarations.length > 0);
  record('imports', has('IMPORTS'));
  record('exports', has('EXPORTS'));
  record('calls', contribution.callGraph.calls.length > 0);
  record('type references', has('REFERENCES_TYPE'));
  record('inheritance', has('EXTENDS') || has('IMPLEMENTS'));
  record('routes', contribution.annotations.routes.length > 0);

  const clauses: string[] = [];

  clauses.push(
    present.length === 0
      ? `${input.preamble}, but nothing was recovered from them`
      : `${input.preamble}, so ${list(present)} are available`,
  );

  if (absent.length > 0 && present.length > 0) {
    clauses.push(`no ${list(absent)} were found here`);
  }

  if (input.caveat !== undefined) {
    clauses.push(input.caveat);
  }

  return clauses.join('; ');
}

/** `a`, `a and b`, `a, b and c`. */
function list(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }

  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}
