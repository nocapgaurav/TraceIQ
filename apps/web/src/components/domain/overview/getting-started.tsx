'use client';

import { Compass, FileCode2, ListOrdered, Package } from 'lucide-react';
import Link from 'next/link';

import { NodePill } from '@/components/domain/node-pill';
import { OverviewSection, Unavailable } from '@/components/domain/overview/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count, pluralise } from '@/lib/format';
import type { RepositoryProfile } from '@/lib/repository-profile';
import { routes } from '@/lib/routes';
import type { HotspotReport, Overview, PackageSummary } from '@/types/api';

/**
 * Section 3 — Getting Started.
 *
 * Four cards answering "where do I start?". Two are measurable and two are judgement, and the split is
 * deliberate: connectivity says which code the repository leans on, but it cannot say what to read first.
 * The judgement cards say so and hand the question to chat, which can at least answer it with citations.
 */
export function GettingStarted({
  overview,
  hotspots,
  profile,
}: {
  readonly overview: Overview;
  readonly hotspots: HotspotReport | undefined;
  readonly profile: RepositoryProfile;
}) {
  // "Core" means depended upon, not large. A package can be the biggest and be a leaf.
  const core = [...overview.packages.entries]
    .filter((entry) => entry.dependents > 0)
    .sort((left, right) => right.dependents - left.dependents || left.name.localeCompare(right.name))
    .slice(0, 5);

  return (
    <OverviewSection
      id="getting-started"
      title="Getting started"
      description="Where to look first, and which of those answers the analysis can actually support."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <StarterCard
          icon={Compass}
          title="Where should I begin?"
          detail="The declarations the rest of the repository depends on most — a defensible reading order by connectivity, not by importance."
        >
          {hotspots === undefined || hotspots.mostReferenced.entries.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {hotspots.mostReferenced.entries.slice(0, 5).map((entry) => (
                <li key={entry.node.id} className="flex items-center gap-2">
                  <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {count(entry.fanIn)} in
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AskLink question="Where should I start reading this repository?" />
        </StarterCard>

        <StarterCard
          icon={Package}
          title="Core modules"
          detail="Packages other packages depend on."
        >
          {core.length === 0 ? (
            <>
              <Unavailable />
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                No package-to-package dependencies were resolved, so no package can be ranked by how much
                depends on it. The largest packages are listed under Repository summary instead.
              </p>
            </>
          ) : (
            <PackageList entries={core} />
          )}
        </StarterCard>

        <StarterCard
          icon={FileCode2}
          title="Most important files"
          detail="Files with the most relationships in or out."
        >
          {hotspots === undefined || hotspots.mostConnectedFiles.entries.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {hotspots.mostConnectedFiles.entries.slice(0, 5).map((entry) => (
                <li key={entry.node.id} className="flex items-center gap-2">
                  <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {count(entry.incomingEdges + entry.outgoingEdges)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </StarterCard>

        <StarterCard
          icon={ListOrdered}
          title="Suggested learning order"
          detail="A path through the repository, in the order it makes sense to read it."
        >
          <Unavailable />
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Ordering a repository for a reader is a judgement about what matters, not a measurement.
            Connectivity can rank code by how much depends on it — visible in the other cards — but that is
            not the same question.
          </p>
          <AskLink question="In what order should I read the packages in this repository?" />
        </StarterCard>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {profile.mainPackages.length === 0
          ? 'No packages were derived, so these lists are empty rather than short.'
          : 'Rankings come from the graph. They say what is connected, never what is good.'}
      </p>
    </OverviewSection>
  );
}

function StarterCard({
  icon: Icon,
  title,
  detail,
  children,
}: {
  readonly icon: React.ComponentType<{ readonly className?: string }>;
  readonly title: string;
  readonly detail: string;
  readonly children: React.ReactNode;
}) {
  return (
    // `min-w-0` matters here and is easy to lose: a grid item defaults to `min-width: auto`, so it refuses
    // to shrink below its content's minimum. These cards hold node pills whose kind label and badges do not
    // shrink, which pushed the whole page 220px wider than a phone viewport.
    <Card className="flex min-w-0 flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle>{title}</CardTitle>
        </div>
        <p className="text-[11px] font-normal leading-relaxed text-muted-foreground">{detail}</p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">{children}</CardContent>
    </Card>
  );
}

function PackageList({ entries }: { readonly entries: readonly PackageSummary[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <li key={entry.name}>
          <Link
            href={routes.package(entry.name)}
            className="flex items-center justify-between gap-2 rounded px-1 py-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate font-mono text-xs">{entry.name}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {pluralise(entry.dependents, 'dependent')}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Hands a question to Repository Chat rather than answering it here. */
function AskLink({ question }: { readonly question: string }) {
  return (
    <Link
      href={routes.chat(question)}
      className="mt-auto inline-flex w-fit items-center gap-1 pt-1 text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Ask TraceIQ this →
    </Link>
  );
}
