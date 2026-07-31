'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';

import { ChangeScope } from '@/components/domain/impact/change-scope';
import { ImpactOnboarding } from '@/components/domain/impact/onboarding';
import { PageHeader, Section } from '@/components/layout/app-shell';
import { GraphCanvas } from '@/components/domain/graph-canvas';
import { JsonInspector } from '@/components/domain/json-inspector';
import { Limitations } from '@/components/domain/limitations';
import { ConfidenceBadge, NodePill, UnresolvedPill } from '@/components/domain/node-pill';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, LoadingState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDependencies, useImpact } from '@/hooks/queries';
import { count, symbolName } from '@/lib/format';
import { impactGraph } from '@/lib/graph-models';
import { linkForNode, routes } from '@/lib/routes';
import type { AffectedNode } from '@/types/api';

/**
 * The Impact page: what a change to one declaration reaches.
 *
 * **DIRECT and INDIRECT are never merged**, on the page as in the analyser — a direct dependent breaks
 * when the signature changes, an indirect one only might, and collapsing the two would state something
 * the analysis does not. UNKNOWN is shown as its own count for the same reason: it is not zero impact,
 * it is impact that could not be determined.
 */
function ImpactView() {
  const params = useSearchParams();
  const id = params.get('id');
  const impact = useImpact(id);
  const dependencies = useDependencies(id);

  const layout = useMemo(() => (impact.data === undefined ? null : impactGraph(impact.data)), [impact.data]);

  if (id === null || id === '') {
    return (
      <>
        <PageHeader title="Impact" />
        <ImpactOnboarding />
      </>
    );
  }

  return (
    <>
      <PageHeader title={`Impact · ${symbolName(id)}`} subtitle={id}>
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.symbol(id)}>Explain symbol</Link>
        </Button>
      </PageHeader>

      <QueryState query={impact} loadingRows={6}>
        {(analysis) => (
          <div className="flex flex-col gap-6">
            <ChangeScope
              direct={analysis.directlyAffected}
              indirect={analysis.indirectlyAffected}
              unknown={analysis.unknown.length}
            />

            <StatGrid>
              <Stat label="Directly affected" value={analysis.directlyAffected.length} detail="reference the target itself" />
              <Stat
                label="Indirectly affected"
                value={analysis.indirectlyAffected.length}
                detail="reached through another declaration"
              />
              <Stat
                label="Unknown"
                value={analysis.unknown.length}
                tone={analysis.unknown.length > 0 ? 'warning' : 'default'}
                detail="calls that could not be bound"
              />
              <Stat label="Max depth" value={analysis.statistics.maxDepth} />
              <Stat label="Nodes visited" value={analysis.statistics.nodesVisited} />
              <Stat label="Callers" value={analysis.callers.length} />
              <Stat label="Callees" value={analysis.callees.length} detail="depth 1 only" />
              <Stat label="Routes affected" value={analysis.routesAffected.length} />
            </StatGrid>

            <Section title="Dependency graph">
              {layout === null ? (
                <LoadingState rows={4} />
              ) : (
                <GraphCanvas
                  layout={layout}
                  linkFor={(nodeId) => linkForNode(nodeId)}
                  height={440}
                  emptyLabel="Nothing depends on this declaration"
                  noEdgesNote="Nodes were affected but no edge could be drawn between them, which happens when the edge that reached a node points at something outside this picture."
                />
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                A column is a traversal depth. Every arrow is an edge the analyser followed — none is drawn
                that the graph does not hold.
              </p>
            </Section>

            <Tabs defaultValue="direct">
              <TabsList className="flex-wrap">
                <TabsTrigger value="direct">Direct ({analysis.directlyAffected.length})</TabsTrigger>
                <TabsTrigger value="indirect">Indirect ({analysis.indirectlyAffected.length})</TabsTrigger>
                <TabsTrigger value="callers">Callers ({analysis.callers.length})</TabsTrigger>
                <TabsTrigger value="callees">Callees ({analysis.callees.length})</TabsTrigger>
                <TabsTrigger value="routes">Routes ({analysis.routesAffected.length})</TabsTrigger>
                <TabsTrigger value="unknown">Unknown ({analysis.unknown.length})</TabsTrigger>
                <TabsTrigger value="closure">Closure</TabsTrigger>
                <TabsTrigger value="payload">Payload</TabsTrigger>
              </TabsList>

              <TabsContent value="direct">
                <AffectedList
                  affected={analysis.directlyAffected}
                  emptyLabel="Nothing references this declaration directly"
                />
              </TabsContent>

              <TabsContent value="indirect">
                <AffectedList
                  affected={analysis.indirectlyAffected}
                  emptyLabel="Nothing is reached indirectly from this declaration"
                />
              </TabsContent>

              <TabsContent value="callers">
                <Card className="p-1">
                  {analysis.callers.length === 0 ? (
                    <EmptyState title="Nothing calls this declaration" />
                  ) : (
                    <ul>
                      {analysis.callers.map((reference) => (
                        <li key={reference.edge.id} className="flex items-center gap-2">
                          {reference.source === null ? (
                            <UnresolvedPill text={reference.edge.sourceId} reason="source not in graph" />
                          ) : (
                            <NodePill node={reference.source} className="min-w-0 flex-1" />
                          )}
                          <ConfidenceBadge confidence={reference.edge.confidence} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </TabsContent>

              <TabsContent value="callees">
                <Card className="p-1">
                  {analysis.callees.length === 0 ? (
                    <EmptyState title="This declaration calls nothing" />
                  ) : (
                    <ul>
                      {analysis.callees.map((callee) => (
                        <li key={callee.edge.id} className="flex items-center gap-2">
                          {callee.target === null ? (
                            <UnresolvedPill text={callee.edge.targetId} reason="target not in graph" />
                          ) : (
                            <NodePill node={callee.target} className="min-w-0 flex-1" />
                          )}
                          <ConfidenceBadge confidence={callee.edge.confidence} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">
                    Callees are reported at depth 1 only. Impact traverses dependents, not dependencies.
                  </p>
                </Card>
              </TabsContent>

              <TabsContent value="routes">
                <Card className="p-1">
                  {analysis.routesAffected.length === 0 ? (
                    <EmptyState
                      title="No route reaches this declaration"
                      detail="Only routes the framework extractor recognised are considered."
                    />
                  ) : (
                    <ul className="flex flex-col gap-1 p-2">
                      {analysis.routesAffected.map((entry) => (
                        <li key={`${entry.route.method}:${entry.route.path}`} className="flex items-center gap-2 text-xs">
                          <Badge variant="secondary">{entry.route.method}</Badge>
                          <span className="font-mono">{entry.route.composition.effectivePath}</span>
                          <Badge variant="outline">{entry.reaches}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </TabsContent>

              <TabsContent value="unknown">
                <Card className="p-1">
                  {analysis.unknown.length === 0 ? (
                    <EmptyState title="Every relationship was resolved" />
                  ) : (
                    <ul>
                      {analysis.unknown.map((entry, index) => (
                        <li key={`${entry.at}:${entry.result.reference.text}:${index}`}>
                          <UnresolvedPill text={entry.result.reference.text} reason={entry.result.reference.reason} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">
                    UNKNOWN is not the absence of impact — it is impact the graph could not determine.
                  </p>
                </Card>
              </TabsContent>

              <TabsContent value="closure">
                <QueryState query={dependencies} loadingRows={4}>
                  {(navigation) => (
                    <div className="grid gap-4 md:grid-cols-2">
                      <Card>
                        <CardHeader>
                          <CardTitle>Depends on ({navigation.closure.total})</CardTitle>
                        </CardHeader>
                        <CardContent className="p-1">
                          {navigation.closure.entries.length === 0 ? (
                            <p className="px-2 py-3 text-xs text-muted-foreground">Nothing.</p>
                          ) : (
                            <ul>
                              {navigation.closure.entries.slice(0, 40).map((entry) => (
                                <li key={entry.node.id} className="flex items-center gap-2">
                                  <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                                  <span className="shrink-0 pr-2 text-[10px] text-muted-foreground">d{entry.depth}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardTitle>Depended on by ({navigation.reverseClosure.total})</CardTitle>
                        </CardHeader>
                        <CardContent className="p-1">
                          {navigation.reverseClosure.entries.length === 0 ? (
                            <p className="px-2 py-3 text-xs text-muted-foreground">Nothing.</p>
                          ) : (
                            <ul>
                              {navigation.reverseClosure.entries.slice(0, 40).map((entry) => (
                                <li key={entry.node.id} className="flex items-center gap-2">
                                  <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                                  <span className="shrink-0 pr-2 text-[10px] text-muted-foreground">d{entry.depth}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </QueryState>
              </TabsContent>

              <TabsContent value="payload">
                <JsonInspector value={analysis} label={`GET /impact/${id}`} />
              </TabsContent>
            </Tabs>

            <Limitations limitations={analysis.limitations} title="Analysis limitations" />
          </div>
        )}
      </QueryState>
    </>
  );
}

function AffectedList({ affected, emptyLabel }: { readonly affected: readonly AffectedNode[]; readonly emptyLabel: string }) {
  if (affected.length === 0) {
    return (
      <Card>
        <EmptyState title={emptyLabel} />
      </Card>
    );
  }

  return (
    <Card className="p-1">
      <ul>
        {affected.map((entry) => (
          <li key={`${entry.node.id}:${entry.via.id}`} className="flex items-center gap-2">
            <NodePill node={entry.node} className="min-w-0 flex-1" />
            <span className="flex shrink-0 items-center gap-1.5 pr-2">
              <span className="font-mono text-[10px] text-muted-foreground">{entry.via.type}</span>
              <Badge variant={entry.category === 'DIRECT' ? 'warning' : 'secondary'}>
                {entry.category.toLowerCase()} · d{entry.depth}
              </Badge>
              <ConfidenceBadge confidence={entry.via.confidence} />
            </span>
          </li>
        ))}
      </ul>
      <p className="px-2 py-1 text-[11px] text-muted-foreground">
        {count(affected.length)} entries, each reached by the edge named beside it.
      </p>
    </Card>
  );
}

export default function ImpactPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading impact analysis" rows={6} />}>
      <ImpactView />
    </Suspense>
  );
}
