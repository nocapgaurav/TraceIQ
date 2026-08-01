import type { AnalysisOutcome, AnalysisRequest, StageListener } from './repository-analyzer.js';

/**
 * Who actually performs an analysis.
 *
 * **Extracted so that "where the work runs" stops being a property of the registry.** Until now the
 * registry constructed a `RepositoryAnalyzer` and called it directly, which meant a clone, a scan and a
 * graph build all executed on whatever thread was polling the job — in the API's case, the one thread
 * serving every other request. Measured on `facebook/react`: while an analysis ran, `GET /ping` was
 * sampled every 250 ms and **7 samples exceeded 5 seconds, one reaching the 30-second client timeout**,
 * against a median of 4.9 ms when idle. The graph build is synchronous, CPU-bound and long; no amount
 * of care inside it makes an event loop available while it runs.
 *
 * `RepositoryAnalyzer` satisfies this interface structurally, so the in-process path is unchanged and
 * remains what the tests and the CLI use. The API injects a process-backed one instead. Nothing else
 * about a job — its stages, its states, its cancellation — depends on which is in use, which is what
 * makes the two interchangeable rather than two code paths.
 */
export interface AnalysisExecutor {
  analyze(request: AnalysisRequest, onStage?: StageListener): Promise<AnalysisOutcome>;
}
