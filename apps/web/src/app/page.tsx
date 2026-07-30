'use client';

import Link from 'next/link';

import { PageHeader, Section } from '@/components/layout/app-shell';
import { CountsChart, RatioBar } from '@/components/domain/charts';
import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { MetricList } from '@/components/domain/metric-list';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useHotspots, useOverview } from '@/hooks/queries';
import { count, percent } from '@/lib/format';
import { routes } from '@/lib/routes';

/**
 * The Dashboard: what this repository is, at a glance.
 *
 * Two requests — `/overview` and `/hotspots` — and every number on the page comes from one of them
 * unchanged. Nothing is computed here beyond picking a tone for a threshold.
 */
export default function DashboardPage() {
  const overview = useOverview();
  const hotspots = useHotspots();

  return (
    <>
      <PageHeader title="Repository overview" subtitle="derived from the repository graph">
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.architecture()}>Architecture</Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.health()}>Health</Link>
        </Button>
      </PageHeader>

      <QueryState query={overview} loadingRows={5}>
        {(data) => (
          <div className="flex flex-col gap-6">
            <StatGrid>
              <Stat label="Files" value={data.repository.files} />
              <Stat label="Declarations" value={data.repository.declarations} />
              <Stat label="Classes" value={data.repository.classes} />
              <Stat label="Interfaces" value={data.repository.interfaces} />
              <Stat label="Functions" value={data.repository.functions} />
              <Stat label="Methods" value={data.repository.methods} />
              <Stat label="Routes" value={data.repository.routes} />
              <Stat label="Env variables" value={data.repository.environmentVariables} />
              <Stat label="External packages" value={data.repository.externalPackages} />
              <Stat label="Graph nodes" value={data.graph.nodes} />
              <Stat label="Graph edges" value={data.graph.edges} />
              <Stat
                label="Unresolved refs"
                value={data.graph.unresolvedReferences}
                tone={data.graph.unresolvedReferences > 0 ? 'warning' : 'default'}
                detail="references the resolver could not bind"
              />
            </StatGrid>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>Health</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <RatioBar
                    label="Call graph coverage"
                    value={data.health.callGraphCoverage}
                    detail="share of call sites bound to a declaration"
                  />
                  <RatioBar
                    label="Reference coverage"
                    value={data.health.referenceCoverage}
                    detail="share of references resolved to a target"
                  />
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Max call depth</p>
                      <p className="text-lg font-semibold tabular-nums">{count(data.health.maxCallDepth)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">In cycles</p>
                      <p className="text-lg font-semibold tabular-nums">{count(data.health.declarationsInCycles)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Isolated</p>
                      <p className="text-lg font-semibold tabular-nums">{count(data.health.isolatedDeclarations)}</p>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" asChild className="mt-1 self-start">
                    <Link href={routes.health()}>Full health report</Link>
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Declarations by kind</CardTitle>
                </CardHeader>
                <CardContent>
                  <CountsChart counts={data.repository.nodesByKind} caption="Nodes by kind" limit={10} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Relationships</CardTitle>
                </CardHeader>
                <CardContent>
                  <CountsChart counts={data.graph.relationshipCounts} caption="Edges by relationship type" limit={10} />
                </CardContent>
              </Card>
            </div>

            <Section title="Roles" count={Object.values(data.architecture.roleCounts).reduce((a, b) => a + b, 0)}>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.architecture.roleCounts).map(([role, total]) => (
                  <Badge key={role} variant={total === 0 ? 'outline' : 'secondary'}>
                    {role}: {count(total)}
                  </Badge>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Roles are annotations on a declaration, not a node kind — a declaration may carry none.
              </p>
            </Section>

            <Section title="Packages" count={data.packages.total}>
              {data.packages.entries.length === 0 ? (
                <EmptyState title="No packages were derived" detail="Package names come from the first two path segments of a file." />
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
                      {data.packages.entries.map((entry) => (
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
                  <ListingNote listing={data.packages} noun="package" />
                </Card>
              )}
            </Section>

            <Section title="Hotspots">
              <QueryState query={hotspots} loadingRows={3}>
                {(report) => (
                  <div className="grid gap-4 md:grid-cols-2">
                    <MetricList
                      title="Most referenced"
                      description="declarations with the largest fan-in"
                      listing={report.mostReferenced}
                    />
                    <MetricList
                      title="Most coupled"
                      description="declarations with the largest fan-in and fan-out combined"
                      listing={report.mostCoupled}
                    />
                  </div>
                )}
              </QueryState>
            </Section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Metrics</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs">
                  <Figure label="Declarations per file" value={data.metrics.averageDeclarationsPerFile.toFixed(2)} />
                  <Figure label="References per declaration" value={data.metrics.averageReferencesPerDeclaration.toFixed(2)} />
                  <Figure label="Graph density" value={data.metrics.graphDensity.toFixed(5)} />
                  <Figure label="Call graph coverage" value={percent(data.metrics.callGraphCoverage)} />
                  <Figure label="Fan-in (max)" value={count(data.metrics.fanIn.max)} />
                  <Figure label="Fan-out (max)" value={count(data.metrics.fanOut.max)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Externals by kind</CardTitle>
                </CardHeader>
                <CardContent>
                  <CountsChart counts={data.repository.externalsByKind} caption="External packages by kind" />
                </CardContent>
              </Card>
            </div>

            <Limitations limitations={data.limitations} title="Overview limitations" />
          </div>
        )}
      </QueryState>
    </>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

