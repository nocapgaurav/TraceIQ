'use client';

import { ArrowRight, Boxes, GitBranch } from 'lucide-react';
import Link from 'next/link';

import { OverviewSection } from '@/components/domain/overview/shared';
import { EmptyState } from '@/components/domain/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count, pluralise } from '@/lib/format';
import type { RepositoryProfile } from '@/lib/repository-profile';
import { routes } from '@/lib/routes';
import type { Overview } from '@/types/api';

/**
 * Section 2 — Architecture Snapshot.
 *
 * The main modules and how they relate, at a glance, with a way through to the full explorer. Both halves
 * degrade independently: a repository whose package dependencies were never resolved still has modules
 * worth listing, and saying so is better than an empty section.
 */
export function ArchitectureSnapshot({
  overview,
  profile,
}: {
  readonly overview: Overview;
  readonly profile: RepositoryProfile;
}) {
  const { architecture, graph } = overview;
  const relationships = Object.entries(graph.relationshipCounts)
    .filter(([, total]) => total > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  // The bar widths are relative to the largest count, so it is read once here rather than indexed inside
  // the map — where an empty list would make `relationships[0]` undefined.
  const largest = relationships[0]?.[1] ?? 0;

  return (
    <OverviewSection
      id="architecture-snapshot"
      title="Architecture snapshot"
      description="The largest modules, and the relationships the analysis resolved between them."
      action={
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.architecture()}>
            Open Architecture Explorer
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex min-w-0 flex-col">
          <CardHeader className="flex-row items-center gap-2">
            <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle>Main modules</CardTitle>
          </CardHeader>
          <CardContent className="flex-1">
            {profile.mainPackages.length === 0 ? (
              <EmptyState
                title="No packages were derived"
                detail="Package names come from the first two path segments of a file."
              />
            ) : (
              <ul className="flex flex-col">
                {profile.mainPackages.map((entry) => (
                  <li key={entry.name} className="border-b border-border last:border-b-0">
                    <Link
                      href={routes.package(entry.name)}
                      className="group flex items-center justify-between gap-3 py-2 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate font-mono text-xs">{entry.name}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {pluralise(entry.files, 'file')} · {count(entry.declarations)} decls
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-w-0 flex-col">
          <CardHeader className="flex-row items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle>Relationships</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Figure label="Dependency graph" nodes={architecture.dependencyGraph.nodes} edges={architecture.dependencyGraph.edges} />
              <Figure label="Call graph" nodes={architecture.callGraph.nodes} edges={architecture.callGraph.edges} />
            </div>

            {relationships.length === 0 ? (
              <EmptyState title="No relationships were resolved" />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {relationships.slice(0, 6).map(([type, total]) => (
                  <li key={type} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{type}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <span
                        className="block h-full rounded-full bg-primary/60"
                        style={{ width: `${largest === 0 ? 0 : Math.round((total / largest) * 100)}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums">{count(total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </OverviewSection>
  );
}

function Figure({
  label,
  nodes,
  edges,
}: {
  readonly label: string;
  readonly nodes: number;
  readonly edges: number;
}) {
  return (
    // The figure and its unit are one text run rather than a number beside a styled `<span>`. Read aloud
    // that is "228 nodes" instead of "228, nodes", and it keeps the count from standing alone as an
    // element whose entire text is a bare number.
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{`${count(nodes)} nodes`}</p>
      <p className="text-sm font-semibold tabular-nums">{`${count(edges)} edges`}</p>
    </div>
  );
}
