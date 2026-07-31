'use client';

import Link from 'next/link';

import { CountsChart, RatioBar } from '@/components/domain/charts';
import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { MetricList } from '@/components/domain/metric-list';
import { OverviewSection } from '@/components/domain/overview/shared';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { count, percent } from '@/lib/format';
import { routes } from '@/lib/routes';
import type { HotspotReport, Listing, NodeMetric, Overview } from '@/types/api';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Section 6 — Repository Metrics.
 *
 * Every figure the old Dashboard led with, unchanged in substance and moved to the foot of the page.
 * Nothing was dropped: a number that was worth showing is still worth showing, it is simply no longer the
 * answer to "what is this repository?".
 *
 * Rendered smaller — `compact` stats, one column of charts — because it is reference material now.
 */
export function RepositoryMetrics({
  overview,
  hotspots,
}: {
  readonly overview: Overview;
  readonly hotspots: UseQueryResult<HotspotReport, Error>;
}) {
  return (
    <OverviewSection
      id="repository-metrics"
      title="Repository metrics"
      description="The full measured picture. Counts, coverage, distributions and what the analysis could not resolve."
    >
      <StatGrid compact>
        <Stat compact label="Files" value={overview.repository.files} />
        <Stat compact label="Declarations" value={overview.repository.declarations} />
        <Stat compact label="Classes" value={overview.repository.classes} />
        <Stat compact label="Interfaces" value={overview.repository.interfaces} />
        <Stat compact label="Functions" value={overview.repository.functions} />
        <Stat compact label="Methods" value={overview.repository.methods} />
        <Stat compact label="Routes" value={overview.repository.routes} />
        <Stat compact label="Env variables" value={overview.repository.environmentVariables} />
        <Stat compact label="External packages" value={overview.repository.externalPackages} />
        <Stat compact label="Graph nodes" value={overview.graph.nodes} />
        <Stat compact label="Graph edges" value={overview.graph.edges} />
        <Stat
          compact
          label="Unresolved refs"
          value={overview.graph.unresolvedReferences}
          tone={overview.graph.unresolvedReferences > 0 ? 'warning' : 'default'}
          detail="references the resolver could not bind"
        />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Analysis coverage</CardTitle>
            <p className="text-[11px] font-normal text-muted-foreground">
              How much of the repository the analysis could resolve.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <RatioBar
              label="Call graph coverage"
              value={overview.health.callGraphCoverage}
              detail="share of call sites bound to a declaration"
            />
            <RatioBar
              label="Reference coverage"
              value={overview.health.referenceCoverage}
              detail="share of references resolved to a target"
            />
            <div className="grid grid-cols-3 gap-2 pt-1">
              <Figure label="Max call depth" value={count(overview.health.maxCallDepth)} />
              <Figure label="In cycles" value={count(overview.health.declarationsInCycles)} />
              <Figure label="Isolated" value={count(overview.health.isolatedDeclarations)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Declarations by kind</CardTitle>
          </CardHeader>
          <CardContent>
            <CountsChart counts={overview.repository.nodesByKind} caption="Nodes by kind" limit={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Relationships</CardTitle>
          </CardHeader>
          <CardContent>
            <CountsChart
              counts={overview.graph.relationshipCounts}
              caption="Edges by relationship type"
              limit={10}
            />
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">
          Roles{' '}
          <span className="font-normal text-muted-foreground">
            ({Object.values(overview.architecture.roleCounts).reduce((left, right) => left + right, 0)})
          </span>
        </h3>
        <div className="flex flex-wrap gap-2">
          {Object.entries(overview.architecture.roleCounts).map(([role, total]) => (
            <Badge key={role} variant={total === 0 ? 'outline' : 'secondary'}>
              {role}: {count(total)}
            </Badge>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Roles are annotations on a declaration, not a node kind — a declaration may carry none.
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">
          Packages <span className="font-normal text-muted-foreground">({overview.packages.total})</span>
        </h3>
        {overview.packages.entries.length === 0 ? (
          <EmptyState
            title="No packages were derived"
            detail="Package names come from the first two path segments of a file."
          />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                  <TableHead className="text-right">Declarations</TableHead>
                  <TableHead className="text-right">Depends on</TableHead>
                  <TableHead className="text-right">Depended on by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.packages.entries.map((entry) => (
                  <TableRow key={entry.name}>
                    <TableCell>
                      <Link
                        href={routes.package(entry.name)}
                        className="font-mono text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {entry.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{count(entry.files)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(entry.declarations)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(entry.dependencies)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(entry.dependents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ListingNote listing={overview.packages} noun="package" />
          </Card>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Hotspots</h3>
        <QueryState query={hotspots} loadingRows={3}>
          {(report) => (
            // The wrappers carry `min-w-0` rather than `MetricList` itself: a grid item defaults to
            // `min-width: auto`, and these cards hold node pills with a fixed-width kind label and badges
            // that will not shrink. Constraining here keeps the fix local instead of restyling a component
            // four other pages render.
            <div className="grid gap-4 md:grid-cols-2">
              <div className="min-w-0">
                <MetricList
                  title="Most referenced"
                  description="declarations with the largest fan-in"
                  listing={topOf(report.mostReferenced)}
                  cappedBy="this page"
                />
              </div>
              <div className="min-w-0">
                <MetricList
                  title="Most coupled"
                  description="declarations with the largest fan-in and fan-out combined"
                  listing={topOf(report.mostCoupled)}
                  cappedBy="this page"
                />
              </div>
            </div>
          )}
        </QueryState>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Metrics</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-xs">
            <Figure
              label="Declarations per file"
              value={overview.metrics.averageDeclarationsPerFile.toFixed(2)}
            />
            <Figure
              label="References per declaration"
              value={overview.metrics.averageReferencesPerDeclaration.toFixed(2)}
            />
            <Figure label="Graph density" value={overview.metrics.graphDensity.toFixed(5)} />
            <Figure label="Call graph coverage" value={percent(overview.metrics.callGraphCoverage)} />
            <Figure label="Fan-in (max)" value={count(overview.metrics.fanIn.max)} />
            <Figure label="Fan-out (max)" value={count(overview.metrics.fanOut.max)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Externals by kind</CardTitle>
          </CardHeader>
          <CardContent>
            <CountsChart counts={overview.repository.externalsByKind} caption="External packages by kind" />
          </CardContent>
        </Card>
      </div>

      <Limitations limitations={overview.limitations} title="Overview limitations" />
    </OverviewSection>
  );
}

/**
 * The first few entries of a hotspot list, for display here.
 *
 * The API returns hundreds, which is right for the Health report and wrong for an overview — rendered in
 * full they were most of the page's height. **`total` is preserved and `truncated` is forced on**, so the
 * note below the list still states the exact number left out; the entries shrink, the honesty does not.
 * `cappedBy` at the call site names this page rather than the API as the one doing it.
 */
const HOTSPOT_ROWS = 10;

function topOf(listing: Listing<NodeMetric>): Listing<NodeMetric> {
  if (listing.entries.length <= HOTSPOT_ROWS) {
    return listing;
  }

  return {
    entries: listing.entries.slice(0, HOTSPOT_ROWS),
    total: listing.total,
    truncated: true,
  };
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
