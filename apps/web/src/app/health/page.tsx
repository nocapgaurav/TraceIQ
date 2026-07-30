'use client';

import { PageHeader, Section } from '@/components/layout/app-shell';
import { BarChart, CountsChart, DistributionRow, RatioBar } from '@/components/domain/charts';
import { JsonInspector } from '@/components/domain/json-inspector';
import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { MetricList } from '@/components/domain/metric-list';
import { NodePill } from '@/components/domain/node-pill';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCycles, useHealth, useHotspots } from '@/hooks/queries';
import { count } from '@/lib/format';
import type { HealthFinding } from '@/types/api';

/**
 * The Health page: metrics, findings, cycles and hotspots.
 *
 * Every finding is the analyser's own fixed code with its own evidence — a metric and a value. Nothing
 * here scores, ranks or recommends: the page states what was measured and leaves the judgement to the
 * reader, which is the same contract the health package holds.
 */
export default function HealthPage() {
  const health = useHealth();
  const cycles = useCycles();
  const hotspots = useHotspots();

  return (
    <>
      <PageHeader title="Repository health" subtitle="measured facts, not opinions" />

      <QueryState query={health} loadingRows={6}>
        {(report) => (
          <div className="flex flex-col gap-6">
            <StatGrid>
              <Stat label="Files" value={report.summary.files} />
              <Stat label="Declarations" value={report.summary.declarations} />
              <Stat label="Graph nodes" value={report.summary.graph.nodes} />
              <Stat label="Graph edges" value={report.summary.graph.edges} />
              <Stat
                label="Unresolved refs"
                value={report.summary.graph.unresolvedReferences}
                tone={report.summary.graph.unresolvedReferences > 0 ? 'warning' : 'default'}
              />
              <Stat label="Findings" value={report.findings.length} tone={report.findings.length > 0 ? 'warning' : 'default'} />
              <Stat
                label="In cycles"
                value={report.callGraphHealth.declarationsInCycles}
                tone={report.callGraphHealth.declarationsInCycles > 0 ? 'warning' : 'default'}
              />
              <Stat label="Isolated" value={report.dependencyHealth.isolated.count} />
              <Stat label="Entry points" value={report.callGraphHealth.entryPoints} />
              <Stat label="Max call depth" value={report.callGraphHealth.maxCallDepth} />
            </StatGrid>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>Coverage</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <RatioBar
                    label="Call graph coverage"
                    value={report.callGraphHealth.coverage}
                    detail={`${count(report.callGraphHealth.callEdges)} bound, ${count(report.callGraphHealth.unresolvedCalls)} unresolved`}
                  />
                  <RatioBar label="Reference coverage" value={report.metrics.referenceCoverage} />
                  <div className="pt-1">
                    <p className="mb-1 text-[11px] text-muted-foreground">unresolved calls by reason</p>
                    <CountsChart counts={report.callGraphHealth.unresolvedByReason} caption="Unresolved calls by reason" />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Call graph clusters</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  <Figure label="Clusters" value={count(report.callGraphHealth.clusters.count)} />
                  <Figure label="Largest cluster" value={count(report.callGraphHealth.clusters.largest)} />
                  <Figure label="Singletons" value={count(report.callGraphHealth.clusters.singletons)} />
                  <Figure label="Recursive declarations" value={count(report.callGraphHealth.recursive.count)} />
                  <Figure label="Declarations in cycles" value={count(report.callGraphHealth.declarationsInCycles)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Connectivity</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  <Figure label="Isolated declarations" value={count(report.dependencyHealth.isolated.count)} />
                  <Figure label="Never referenced" value={count(report.dependencyHealth.withoutIncoming.count)} />
                  <Figure label="Reference nothing" value={count(report.dependencyHealth.withoutOutgoing.count)} />
                  <Figure label="Graph density" value={report.metrics.graphDensity.toFixed(5)} />
                  <Figure
                    label="Avg references per declaration"
                    value={report.metrics.averageReferencesPerDeclaration.toFixed(2)}
                  />
                </CardContent>
              </Card>
            </div>

            <Section title="Distributions">
              <Card>
                <CardContent className="pt-3">
                  <DistributionRow label="Fan-in" distribution={report.metrics.fanIn} />
                  <DistributionRow label="Fan-out" distribution={report.metrics.fanOut} />
                  <DistributionRow label="Declarations per file" distribution={report.metrics.declarationsPerFile} />
                </CardContent>
              </Card>
            </Section>

            <Tabs defaultValue="findings">
              <TabsList className="flex-wrap">
                <TabsTrigger value="findings">Findings ({report.findings.length})</TabsTrigger>
                <TabsTrigger value="cycles">Cycles</TabsTrigger>
                <TabsTrigger value="hotspots">Hotspots</TabsTrigger>
                <TabsTrigger value="routing">Routing</TabsTrigger>
                <TabsTrigger value="environment">Environment</TabsTrigger>
                <TabsTrigger value="payload">Payload</TabsTrigger>
              </TabsList>

              <TabsContent value="findings">
                {report.findings.length === 0 ? (
                  <EmptyState title="No findings" detail="Nothing the analyser looks for was present." />
                ) : (
                  <>
                    <Card className="mb-3">
                      <CardHeader>
                        <CardTitle>By code</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <BarChart
                          caption="Findings by code"
                          data={findingCounts(report.findings).map(([code, total]) => ({
                            label: code,
                            value: total,
                            tone: 'warning' as const,
                          }))}
                        />
                      </CardContent>
                    </Card>
                    <div className="flex flex-col gap-3">
                      {report.findings.map((finding, index) => (
                        <FindingCard key={`${finding.code}:${index}`} finding={finding} />
                      ))}
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="cycles">
                <QueryState query={cycles} loadingRows={4}>
                  {(data) => (
                    <div className="flex flex-col gap-4">
                      <StatGrid>
                        <Stat label="Import cycles" value={data.totals.import ?? 0} tone={(data.totals.import ?? 0) > 0 ? 'warning' : 'default'} />
                        <Stat label="Call cycles" value={data.totals.call ?? 0} tone={(data.totals.call ?? 0) > 0 ? 'warning' : 'default'} />
                        <Stat label="Reference cycles" value={data.totals.reference ?? 0} />
                        <Stat label="Inheritance cycles" value={data.totals.inheritance ?? 0} tone={(data.totals.inheritance ?? 0) > 0 ? 'danger' : 'default'} />
                        <Stat label="Largest cycle" value={data.largest?.nodes.length ?? 0} />
                      </StatGrid>

                      {(['importCycles', 'callCycles', 'referenceCycles', 'inheritanceCycles'] as const).map((key) => {
                        const listing = data[key];

                        if (listing.entries.length === 0) {
                          return null;
                        }

                        return (
                          <Card key={key}>
                            <CardHeader>
                              <CardTitle>
                                {key.replace('Cycles', ' cycles')}{' '}
                                <span className="font-normal text-muted-foreground">({listing.total})</span>
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-2">
                              {listing.entries.map((cycle, index) => (
                                <div key={`${key}:${index}`} className="rounded-md border border-border p-2">
                                  <p className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                                    <Badge variant="outline">{cycle.kind}</Badge>
                                    {cycle.relationshipTypes.join(', ')} · {cycle.nodes.length} nodes
                                  </p>
                                  <ul>
                                    {cycle.nodes.map((node) => (
                                      <li key={node.id}>
                                        <NodePill node={node} />
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                              <ListingNote listing={listing} noun="cycle" />
                            </CardContent>
                          </Card>
                        );
                      })}

                      {Object.values(data.totals).every((total) => total === 0) ? (
                        <EmptyState title="No cycles" detail="No import, call, reference or inheritance cycle was found." />
                      ) : null}

                      <Limitations limitations={data.limitations} title="Cycle detection limitations" />
                    </div>
                  )}
                </QueryState>
              </TabsContent>

              <TabsContent value="hotspots">
                <QueryState query={hotspots} loadingRows={4}>
                  {(data) => (
                    <div className="grid gap-4 md:grid-cols-2">
                      <MetricList
                        title="Most referenced"
                        description="declarations with the largest fan-in"
                        listing={data.mostReferenced}
                      />
                      <MetricList
                        title="Most coupled"
                        description="declarations with the largest fan-in and fan-out combined"
                        listing={data.mostCoupled}
                      />
                      <MetricList title="Largest fan-in" listing={data.largestFanIn} />
                      <MetricList title="Largest fan-out" listing={data.largestFanOut} />
                      <MetricList
                        title="Most connected files"
                        description="files with the most incoming and outgoing edges"
                        listing={data.mostConnectedFiles}
                      />
                      <MetricList
                        title="Most connected declarations"
                        description="declarations with the most incoming and outgoing edges"
                        listing={data.mostConnectedDeclarations}
                      />
                    </div>
                  )}
                </QueryState>
              </TabsContent>

              <TabsContent value="routing">
                {report.routing.routes === 0 ? (
                  <EmptyState
                    title="No routes were detected"
                    detail="Route extraction covers the frameworks the extractor recognises; a repository with no HTTP layer has none."
                  />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle>Routes by method</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <CountsChart counts={report.routing.byMethod} caption="Routes by HTTP method" />
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Routing health</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2 text-xs">
                        <Figure label="Routes" value={count(report.routing.routes)} />
                        <Figure label="Orphan routes" value={count(report.routing.orphanRoutes.length)} />
                        <Figure label="Duplicate registrations" value={count(report.routing.duplicateRegistrations.length)} />
                        <Figure label="Unresolved handlers" value={count(report.routing.unresolvedHandlers)} />
                      </CardContent>
                    </Card>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="environment">
                {report.environment.variables === 0 ? (
                  <EmptyState title="No environment variable is read" />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle>Read ({report.environment.used.length})</CardTitle>
                      </CardHeader>
                      <CardContent className="p-1">
                        <ul>
                          {report.environment.used.map((entry) => (
                            <li key={entry.node.id} className="flex items-center gap-2">
                              <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                              <span className="shrink-0 pr-2 text-[11px] text-muted-foreground">
                                {count(entry.reads)} reads
                              </span>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Never read ({report.environment.neverRead.length})</CardTitle>
                      </CardHeader>
                      <CardContent className="p-1">
                        {report.environment.neverRead.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-muted-foreground">
                            Every recorded variable is read somewhere.
                          </p>
                        ) : (
                          <ul>
                            {report.environment.neverRead.map((entry) => (
                              <li key={entry.node.id}>
                                <NodePill node={entry.node} showPath={false} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="payload">
                <JsonInspector value={report} label="GET /health" height={520} />
              </TabsContent>
            </Tabs>

            <Limitations limitations={report.limitations} title="Health limitations" />
          </div>
        )}
      </QueryState>
    </>
  );
}

/** Findings arrive as a flat list; grouping by code is presentation, and the ordering is deterministic. */
function findingCounts(findings: readonly HealthFinding[]): readonly [string, number][] {
  const counts = new Map<string, number>();

  for (const finding of findings) {
    counts.set(finding.code, (counts.get(finding.code) ?? 0) + finding.nodeCount);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function FindingCard({ finding }: { readonly finding: HealthFinding }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{finding.code}</span>
          <Badge variant="outline">{finding.category}</Badge>
          <Badge variant="warning">
            {finding.evidence.metric} = {count(finding.evidence.value)}
          </Badge>
          <span className="font-normal text-muted-foreground">
            {count(finding.nodeCount)} affected{finding.truncated ? ' (list capped)' : ''}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-1">
        <ScrollArea className="max-h-52">
          <ul>
            {finding.nodes.map((node) => (
              <li key={node.id}>
                <NodePill node={node} />
              </li>
            ))}
          </ul>
        </ScrollArea>
        {finding.truncated ? (
          <p className="px-2 py-1 text-[11px] text-warning">
            showing {count(finding.nodes.length)} of {count(finding.nodeCount)} — the analyser caps this list
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
