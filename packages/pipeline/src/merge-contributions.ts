import type { AnalyzerContribution } from '@traceiq/analyzer';
import { NO_ANNOTATIONS } from '@traceiq/framework';
import type { RepositoryIR } from '@traceiq/ir';

/**
 * Joins several units' IR into one.
 *
 * Needed before the contributions exist: the declaration index the second pass resolves against is
 * built from every unit's declarations, and it has to be built after the first pass and before the
 * second. Plain concatenation, for the same reason `mergeContributions` is — the units own disjoint
 * files.
 */
export function mergeIr(irs: readonly RepositoryIR[]): RepositoryIR {
  const first = irs[0];

  if (first === undefined) {
    throw new Error('mergeIr needs at least one IR');
  }

  return irs.length === 1
    ? first
    : {
        repository: first.repository,
        files: irs.flatMap((ir) => ir.files),
        declarations: irs.flatMap((ir) => ir.declarations),
        imports: irs.flatMap((ir) => ir.imports),
        exports: irs.flatMap((ir) => ir.exports),
        callSites: irs.flatMap((ir) => ir.callSites),
        memberAccesses: irs.flatMap((ir) => ir.memberAccesses),
      };
}

/**
 * Joins the contributions of several bounded compilations into the one an analyser returns.
 *
 * **Concatenation, not reconciliation.** Every collection joined here is keyed by a file, and the
 * units that produced them own disjoint file sets — that is what `planAnalysisUnits` guarantees and
 * what its tests assert. So there is nothing to merge on and nothing to deduplicate: a declaration
 * appears once because exactly one unit extracted it.
 *
 * The one field that is not a concatenation is `framework`, which is a single name. The first unit
 * to recognise one wins, matching how the Graph Builder already merges annotations across several
 * *analysers* — a repository whose web region is Express and whose worker region is not should
 * report Express rather than nothing.
 *
 * Order follows the unit order, which follows the plan, which is sorted. Two scans of one
 * repository therefore produce byte-identical output, which is what the whole pipeline's
 * determinism rests on.
 */
export function mergeContributions(
  contributions: readonly AnalyzerContribution[],
): AnalyzerContribution {
  const first = contributions[0];

  if (first === undefined) {
    throw new Error('mergeContributions needs at least one contribution');
  }

  if (contributions.length === 1) {
    return first;
  }

  return {
    ir: {
      // Every unit compiled the same repository, so the metadata is the same in all of them.
      repository: first.ir.repository,
      files: contributions.flatMap((entry) => entry.ir.files),
      declarations: contributions.flatMap((entry) => entry.ir.declarations),
      imports: contributions.flatMap((entry) => entry.ir.imports),
      exports: contributions.flatMap((entry) => entry.ir.exports),
      callSites: contributions.flatMap((entry) => entry.ir.callSites),
      memberAccesses: contributions.flatMap((entry) => entry.ir.memberAccesses),
    },
    resolved: {
      repository: first.resolved.repository,
      declarations: contributions.flatMap((entry) => entry.resolved.declarations),
      relationships: contributions.flatMap((entry) => entry.resolved.relationships),
      unresolved: contributions.flatMap((entry) => entry.resolved.unresolved),
    },
    callGraph: {
      calls: contributions.flatMap((entry) => entry.callGraph.calls),
      externalCalls: contributions.flatMap((entry) => entry.callGraph.externalCalls),
      unresolved: contributions.flatMap((entry) => entry.callGraph.unresolved),
    },
    annotations: {
      framework:
        contributions.map((entry) => entry.annotations.framework).find((name) => name != null) ??
        NO_ANNOTATIONS.framework,
      roles: contributions.flatMap((entry) => entry.annotations.roles),
      routes: contributions.flatMap((entry) => entry.annotations.routes),
      environmentVariables: contributions.flatMap((entry) => entry.annotations.environmentVariables),
      clientCalls: contributions.flatMap((entry) => entry.annotations.clientCalls),
    },
  };
}
