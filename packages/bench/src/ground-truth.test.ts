import { describe, expect, it } from 'vitest';

import { GROUND_TRUTH_CASES } from './ground-truth-cases.js';
import { measureGroundTruth } from './ground-truth.js';

/**
 * The ground-truth suite, as a test.
 *
 * **This is the only assertion in the project that checks the analysis is *right* rather than that
 * it is unchanged.** Every other test fixes a behaviour by describing it; these five cases describe
 * a repository and demand the analysis of it be exact. A regression that binds a call to the wrong
 * declaration passes a bind-rate check and fails here.
 *
 * The bar is exact, not a threshold. Each case is small enough that a human enumerated every fact
 * in it, so "94% recall" means a named fact is missing and a named fact is worth fixing or worth
 * writing down as a deliberate limitation — not worth averaging away.
 */
describe('ground truth', () => {
  it('covers every supported language', () => {
    expect(GROUND_TRUTH_CASES.map((entry) => entry.name).sort()).toEqual([
      'go',
      'java',
      'javascript',
      'python',
      'typescript',
    ]);
  });

  it('finds every expected fact and invents none', { timeout: 120_000 }, async () => {
    const reports = await measureGroundTruth();

    for (const report of reports) {
      // Named in the assertion rather than summed, so a failure says which language broke and which
      // facts it lost — the report carries `missing` and `spurious` for exactly this moment.
      expect({
        name: report.name,
        precision: report.overall.precision,
        recall: report.overall.recall,
        missing: report.overall.missing,
        spurious: report.overall.spurious,
      }).toEqual({
        name: report.name,
        precision: 1,
        recall: 1,
        missing: [],
        spurious: [],
      });
    }
  });

  it('claims no confidence a grammar-only analyser cannot earn', { timeout: 120_000 }, async () => {
    const reports = await measureGroundTruth(
      GROUND_TRUTH_CASES.filter((entry) => ['python', 'java'].includes(entry.name)),
    );

    for (const report of reports) {
      // Neither analyser opens a classpath or site-packages, so nothing either produces may claim to
      // be `CERTAIN` about a *reference*. `CERTAIN` here is only ever a declaration edge — DECLARES
      // and an export written as a modifier — which is a reading of the syntax rather than a claim
      // about what another file holds.
      expect(report.byConfidence['AMBIGUOUS'] ?? 0).toBe(0);
      expect(report.byConfidence['INFERRED'] ?? 0).toBeGreaterThan(0);
    }
  });
});
