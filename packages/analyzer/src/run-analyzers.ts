import type { RepositoryInventory } from '@traceiq/scanner';

import type { AnalyzerOutcome, LanguageAnalyzer } from './types.js';

/**
 * Runs every registered analyser, isolating each from the others.
 *
 * **Failure isolation is the entire reason this exists.** A polyglot repository with a TypeScript
 * frontend, a Python service and a Go worker must not lose all three because one parser hit source
 * it could not read. An analyser that throws yields an outcome recording the failure, the scan
 * continues, and the affected region is reported at `universal` depth with the reason saying what
 * happened — which is both honest and still useful.
 *
 * Analysers run in registration order and are independent: none sees another's output. Ordering
 * therefore affects nothing but the order of `outcomes`, which keeps the merged graph deterministic.
 */
export function runAnalyzers(input: {
  readonly analyzers: readonly LanguageAnalyzer[];
  readonly inventory: RepositoryInventory;
}): readonly AnalyzerOutcome[] {
  const outcomes: AnalyzerOutcome[] = [];

  for (const analyzer of input.analyzers) {
    outcomes.push(runOne(analyzer, input.inventory));
  }

  return outcomes;
}

function runOne(analyzer: LanguageAnalyzer, inventory: RepositoryInventory): AnalyzerOutcome {
  try {
    return analyzer.analyze({ inventory });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    return {
      analyzer: analyzer.name,
      languages: analyzer.languages,
      coveredFiles: [],
      depth: 'universal',
      // Named rather than summarised: a reader debugging a thin result needs the actual failure, and
      // burying it behind "analysis unavailable" would make the product look broken for no reason.
      reason: `the ${analyzer.name} analyser failed and this region was left at discovery depth — ${message}`,
      contribution: null,
      failure: message,
    };
  }
}
