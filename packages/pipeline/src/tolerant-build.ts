import { rejected, type AnalyzerOutcome } from '@traceiq/analyzer';
import { GraphBuilder, type RepositoryGraph, type UniversalFacts } from '@traceiq/graph';
import type { RepositoryInventory } from '@traceiq/scanner';

import { assessCapabilities } from './capability-assessment.js';

/**
 * Builds the graph, and keeps building if one analyser's facts are refused.
 *
 * **This closes the other half of failure isolation.** `runAnalyzers` already catches an analyser
 * that *throws*, so a parser hitting source it cannot read costs only its own regions. But an
 * analyser that returns successfully and hands back facts the graph rejects — a duplicate
 * identifier, an edge the endpoint matrix forbids — was fatal to the entire scan, because the
 * builder merges every contribution into one graph and validates the result as a whole.
 *
 * That was not theoretical. Measured against real repositories, three of five analysable public
 * repositories died this way, and each took with it the universal layer that needed no analyser at
 * all: the file list, the language distribution, the manifests, the declared dependencies. Losing a
 * Python service's call graph is a degraded answer; losing the fact that the repository contains
 * Python is not an answer.
 *
 * The strategy is deliberately dumb, because a clever one would need to understand every constraint:
 *
 *   1. build with everything;
 *   2. failing that, drop one contributing analyser at a time, in registration order, and keep the
 *      first graph that builds;
 *   3. failing that, drop every contribution and build the universal facts alone;
 *   4. failing *that*, rethrow — the universal layer is broken, which is a defect here rather than
 *      anything a repository did.
 *
 * At most `contributors + 2` attempts, and only ever more than one when something is already wrong.
 * A dropped analyser becomes a `rejected` outcome, so capabilities are reassessed from what actually
 * survived and its regions report `universal` depth with the rejection as the reason. The reader is
 * told; nothing is quietly thinner than it looks.
 */
export function buildTolerantly(input: {
  readonly inventory: RepositoryInventory;
  readonly outcomes: readonly AnalyzerOutcome[];
  readonly universal: (capabilities: UniversalFacts['capabilities']) => UniversalFacts;
}): {
  readonly graph: RepositoryGraph;
  /** The outcomes the graph was actually built from, with refused analysers marked `rejected`. */
  readonly outcomes: readonly AnalyzerOutcome[];
  /** What each dropped analyser's facts failed on, in the order they were dropped. */
  readonly rejections: readonly { readonly analyzer: string; readonly failure: string }[];
} {
  const attempt = (
    outcomes: readonly AnalyzerOutcome[],
  ): RepositoryGraph | { readonly failure: string } => {
    try {
      const capabilities = assessCapabilities({ inventory: input.inventory, outcomes });

      return new GraphBuilder().build({
        universal: input.universal(capabilities),
        analyses: outcomes
          .map((outcome) => outcome.contribution)
          .filter((contribution) => contribution !== null),
      });
    } catch (cause) {
      return { failure: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  const first = attempt(input.outcomes);

  if (!isFailure(first)) {
    return { graph: first, outcomes: input.outcomes, rejections: [] };
  }

  const contributors = input.outcomes.filter((outcome) => outcome.contribution !== null);

  // One bad contribution is overwhelmingly the common case, so try to isolate exactly one before
  // giving up on all of them. Registration order keeps the choice deterministic when two are bad.
  for (const suspect of contributors) {
    const without = input.outcomes.map((outcome) =>
      outcome.analyzer === suspect.analyzer ? rejected(outcome, first.failure) : outcome,
    );
    const retry = attempt(without);

    if (!isFailure(retry)) {
      return {
        graph: retry,
        outcomes: without,
        rejections: [{ analyzer: suspect.analyzer, failure: first.failure }],
      };
    }
  }

  // Several contributions are bad, or they are bad only in combination — two analysers claiming one
  // identifier, say. Everything semantic goes; discovery stays.
  const universalOnly = input.outcomes.map((outcome) =>
    outcome.contribution === null ? outcome : rejected(outcome, first.failure),
  );
  const bare = attempt(universalOnly);

  if (!isFailure(bare)) {
    return {
      graph: bare,
      outcomes: universalOnly,
      rejections: contributors.map((outcome) => ({
        analyzer: outcome.analyzer,
        failure: first.failure,
      })),
    };
  }

  throw new GraphBuildError(bare.failure);
}

/**
 * The universal facts alone could not be built.
 *
 * Nothing a repository contains should be able to cause this — the universal layer is file paths,
 * languages, roles and manifest names — so it means a defect in the Graph Builder rather than input
 * TraceIQ should tolerate. It fails loudly for that reason.
 */
export class GraphBuildError extends Error {
  constructor(failure: string) {
    super(`Cannot build the repository graph from discovery alone: ${failure}`);
    this.name = 'GraphBuildError';
  }
}

function isFailure(value: RepositoryGraph | { readonly failure: string }): value is {
  readonly failure: string;
} {
  return 'failure' in value;
}
