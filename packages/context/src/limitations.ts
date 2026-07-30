import type { LimitationCode } from './types.js';

/**
 * Fixed text for each limitation code.
 *
 * A table, not composed strings: the same repository always produces the same words, and a consumer
 * matches on `code` rather than parsing prose. Counts live in `affected`.
 *
 * These are the **composition's** own limitations. A contributing capability's limitations travel with
 * its result — a symbol's on `primary.value.explain.limitations`, the repository's on
 * `health.report.limitations` — and are also merged into this list so a consumer has one place to read
 * every caveat without walking the payload.
 */
export const LIMITATION_DETAIL: Readonly<Record<LimitationCode, string>> = {
  'context-is-a-composition':
    'every value here was produced by a capability below and is carried unchanged; this package selects and arranges, so a caveat belonging to a capability applies to the part it produced',
  'related-nodes-are-not-all-explained':
    'a related node carries a full explanation only where the request kind calls for one; explaining every affected declaration would cost more than the rest of the context together',
  'impact-summary-only':
    'this kind carries impact as counts rather than the whole analysis; request the impact kind for the affected sets, the unknown set and the traversal statistics',
  'repository-health-computed-independently':
    'the repository overview and the health report are produced by separate calls, so the health computation runs twice for this kind; the results agree because the graph is one immutable revision',
  'capped-lists':
    'a list carried from a capability keeps that capability cap and its true total; a cap is never silent',
};
