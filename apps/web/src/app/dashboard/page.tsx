'use client';

import { AnalysisSummary } from '@/components/domain/overview/analysis-summary';
import { ArchitectureSnapshot } from '@/components/domain/overview/architecture-snapshot';
import { AskTraceIq } from '@/components/domain/overview/ask-traceiq';
import { DeveloperActions } from '@/components/domain/overview/developer-actions';
import { GettingStarted } from '@/components/domain/overview/getting-started';
import { OverviewHero } from '@/components/domain/overview/hero';
import { RepositoryMetrics } from '@/components/domain/overview/metrics';
import { RepositorySummary } from '@/components/domain/overview/summary';
import { QueryState } from '@/components/domain/states';
import { useAnalyses, useHotspots, useOverview } from '@/hooks/queries';
import { deriveIdentity, latestAnalysis } from '@/lib/repository-identity';
import { deriveProfile } from '@/lib/repository-profile';

/**
 * The Repository Overview.
 *
 * Answers "what is this repository?" before "how many files are there?". The counts have not gone
 * anywhere — they are the last section rather than the first.
 *
 * **Two requests, the same two the old Dashboard made.** `/architecture` and `/health` would have filled
 * a few more fields, but they are 513 KB and 680 KB against `/overview`'s 5 KB, and an overview that
 * costs a megabyte to open is not an overview. Where a field needs something only those payloads carry
 * it degrades instead — which is also the honest answer, since the value genuinely is not available here.
 *
 * Hotspots are handed down as the query rather than the data: `RepositoryMetrics` renders its own loading
 * state for them, so the top of the page paints as soon as `/overview` lands instead of waiting for the
 * larger request.
 */
export default function RepositoryOverviewPage() {
  const overview = useOverview();
  const hotspots = useHotspots();
  /*
   * Which repository this is.
   *
   * A third request, and the only place the real `owner/name` exists: the graph stores the temporary
   * workspace directory for anything cloned from GitHub. It is small — a handful of job records — and it
   * is what turns "Analysed repository" into "facebook / react".
   */
  const analyses = useAnalyses();

  return (
    <QueryState query={overview} loadingRows={6}>
      {(data) => {
        const profile = deriveProfile(data);
        const identity = deriveIdentity(latestAnalysis(analyses.data?.entries), data);

        return (
          <div className="flex flex-col gap-10 pb-4">
            <OverviewHero profile={profile} identity={identity} />
            <AnalysisSummary overview={data} />
            <RepositorySummary profile={profile} />
            <ArchitectureSnapshot overview={data} profile={profile} />
            <GettingStarted overview={data} hotspots={hotspots.data} profile={profile} />
            <AskTraceIq />
            <DeveloperActions />
            <RepositoryMetrics overview={data} hotspots={hotspots} />
          </div>
        );
      }}
    </QueryState>
  );
}
