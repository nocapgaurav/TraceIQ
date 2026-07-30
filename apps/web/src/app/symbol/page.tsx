'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { PageHeader, Section } from '@/components/layout/app-shell';
import { JsonInspector } from '@/components/domain/json-inspector';
import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { ConfidenceBadge, KindLabel, NodePill, UnresolvedPill } from '@/components/domain/node-pill';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, LoadingState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSymbol } from '@/hooks/queries';
import { count, filePathOf, symbolName } from '@/lib/format';
import { routes } from '@/lib/routes';
import type { Callee, GraphNode, Reference } from '@/types/api';

/**
 * The Symbol page: one declaration, explained.
 *
 * A single request to `/symbol/{id}` returns the explanation, its children, an impact summary and its
 * own health — so the whole page is one payload, and nothing on it is stitched together from several
 * calls. The full impact analysis is a separate page, because `/symbol` reports impact as counts only.
 */
function SymbolView() {
  const params = useSearchParams();
  const id = params.get('id');
  const query = useSymbol(id);

  if (id === null || id === '') {
    return (
      <>
        <PageHeader title="Symbol" />
        <EmptyState title="No declaration chosen" detail="Search for a declaration, or pick one in the Explorer.">
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link href={routes.search()}>Search</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href={routes.explorer()}>Explorer</Link>
            </Button>
          </div>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title={symbolName(id)} subtitle={id}>
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.impact(id)}>Impact analysis</Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.file(filePathOf(id))}>Open file</Link>
        </Button>
      </PageHeader>

      <QueryState query={query} loadingRows={6}>
        {(view) => {
          const { explain } = view;

          return (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center gap-2">
                <KindLabel kind={explain.kind} />
                <ConfidenceBadge confidence={explain.confidence} />
                {explain.declaration.node.isExported ? <Badge variant="outline">exported</Badge> : null}
                {view.packageName === null ? null : <Badge variant="secondary">{view.packageName}</Badge>}
                {view.health.isolated ? <Badge variant="warning">isolated</Badge> : null}
                {view.health.inCycle ? <Badge variant="warning">in a cycle</Badge> : null}
                {view.health.recursive ? <Badge variant="warning">recursive</Badge> : null}
                {explain.declaration.roles.map((role) => (
                  <Badge key={role.role} title={role.evidence}>
                    {role.role}
                  </Badge>
                ))}
              </div>

              <StatGrid>
                <Stat label="Fan-in" value={view.health.fanIn} detail="distinct referencing nodes" />
                <Stat label="Fan-out" value={view.health.fanOut} detail="distinct referenced nodes" />
                <Stat label="Incoming calls" value={explain.incomingCalls.length} />
                <Stat label="Outgoing calls" value={explain.outgoingCalls.length} />
                <Stat label="References" value={explain.references.length} />
                <Stat label="Type references" value={explain.typeReferences.length} />
                <Stat label="Directly affected" value={view.impact.directlyAffected} />
                <Stat label="Indirectly affected" value={view.impact.indirectlyAffected} />
                <Stat
                  label="Unknown"
                  value={view.impact.unknown}
                  tone={view.impact.unknown > 0 ? 'warning' : 'default'}
                  detail="calls that could not be bound"
                />
                <Stat label="Max depth" value={view.impact.maxDepth} />
                <Stat label="Routes affected" value={view.impact.routesAffected} />
                <Stat label="Children" value={view.children.total} />
              </StatGrid>

              <div className="grid gap-4 lg:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardTitle>Location</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-xs">
                    <Field label="File">
                      {explain.sourceFile === null ? (
                        <span className="text-muted-foreground">unknown</span>
                      ) : (
                        <Link href={routes.file(explain.sourceFile.path)} className="font-mono hover:underline">
                          {explain.sourceFile.path}
                        </Link>
                      )}
                    </Field>
                    <Field label="Ranges">
                      {explain.locations.length === 0 ? (
                        <span className="text-muted-foreground">none recorded</span>
                      ) : (
                        <span className="font-mono">
                          {explain.locations
                            .map((range) => `${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`)
                            .join(', ')}
                        </span>
                      )}
                    </Field>
                    <Field label="Enclosing">
                      {explain.enclosingDeclaration?.declaration == null ? (
                        <span className="text-muted-foreground">top level</span>
                      ) : (
                        <Link
                          href={routes.symbol(explain.enclosingDeclaration.declaration.id)}
                          className="font-mono hover:underline"
                        >
                          {symbolName(explain.enclosingDeclaration.declaration.id)}
                        </Link>
                      )}
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Provenance</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-xs">
                    <Field label="Producer">
                      <span className="font-mono">{explain.provenance.producer}</span>
                    </Field>
                    <Field label="Evidence">
                      <span className="font-mono">{explain.provenance.evidence}</span>
                    </Field>
                    <Field label="Confidence">
                      <span className="font-mono">{explain.confidence}</span>
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Graph edges</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-2 text-xs">
                    <Field label="Incoming edges">{count(view.health.incomingEdges)}</Field>
                    <Field label="Outgoing edges">{count(view.health.outgoingEdges)}</Field>
                    <Field label="Findings">
                      {view.health.findings.length === 0 ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <span className="font-mono">{view.health.findings.join(', ')}</span>
                      )}
                    </Field>
                  </CardContent>
                </Card>
              </div>

              <Tabs defaultValue="references">
                <TabsList className="flex-wrap">
                  <TabsTrigger value="references">References ({explain.references.length})</TabsTrigger>
                  <TabsTrigger value="callers">Callers ({explain.incomingCalls.length})</TabsTrigger>
                  <TabsTrigger value="callees">Callees ({explain.outgoingCalls.length})</TabsTrigger>
                  <TabsTrigger value="types">Types ({explain.typeReferences.length})</TabsTrigger>
                  <TabsTrigger value="children">Children ({view.children.total})</TabsTrigger>
                  <TabsTrigger value="deps">Dependencies</TabsTrigger>
                  <TabsTrigger value="routes">Routes ({explain.routes.length})</TabsTrigger>
                  <TabsTrigger value="payload">Payload</TabsTrigger>
                </TabsList>

                <TabsContent value="references">
                  <ReferenceList references={explain.references} emptyLabel="Nothing references this declaration" />
                </TabsContent>

                <TabsContent value="callers">
                  <ReferenceList references={explain.incomingCalls} emptyLabel="Nothing calls this declaration" />
                </TabsContent>

                <TabsContent value="callees">
                  <CalleeList callees={explain.outgoingCalls} emptyLabel="This declaration calls nothing" />
                </TabsContent>

                <TabsContent value="types">
                  <ReferenceList references={explain.typeReferences} emptyLabel="No type reference points here" />
                </TabsContent>

                <TabsContent value="children">
                  <Card className="p-1">
                    {view.children.entries.length === 0 ? (
                      <EmptyState title="No nested declarations" />
                    ) : (
                      <ul>
                        {view.children.entries.map((node) => (
                          <li key={node.id}>
                            <NodePill node={node} showPath={false} />
                          </li>
                        ))}
                      </ul>
                    )}
                    <ListingNote listing={view.children} noun="child" />
                  </Card>
                </TabsContent>

                <TabsContent value="deps">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle>External packages</CardTitle>
                      </CardHeader>
                      <CardContent className="p-1">
                        {explain.externalDependencies.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-muted-foreground">None.</p>
                        ) : (
                          <ul>
                            {explain.externalDependencies.map((entry) => (
                              <li key={entry.node.id}>
                                <NodePill node={entry.node} showPath={false} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Environment variables</CardTitle>
                      </CardHeader>
                      <CardContent className="p-1">
                        {explain.environmentVariables.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-muted-foreground">None read here.</p>
                        ) : (
                          <ul>
                            {explain.environmentVariables.map((entry) => (
                              <li key={entry.node.id} className="flex items-center gap-2">
                                <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {count(entry.reads.length)} reads
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>

                <TabsContent value="routes">
                  <Card className="p-1">
                    {explain.routes.length === 0 ? (
                      <EmptyState
                        title="This declaration serves no route"
                        detail="Route detection covers the frameworks the extractor recognises."
                      />
                    ) : (
                      <ul className="flex flex-col gap-1 p-2">
                        {explain.routes.map((entry) => (
                          <li
                            key={`${entry.explanation.route.method}:${entry.explanation.route.path}:${entry.position}`}
                            className="flex items-center gap-2 text-xs"
                          >
                            <Badge variant="secondary">{entry.explanation.route.method}</Badge>
                            <span className="font-mono">{entry.explanation.route.composition.effectivePath}</span>
                            <Badge variant="outline">{entry.position}</Badge>
                            {entry.explanation.route.composition.composed ? null : (
                              <Badge variant="warning" title={entry.explanation.route.composition.note}>
                                prefix not composed
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </TabsContent>

                <TabsContent value="payload">
                  <JsonInspector value={view} label={`GET /symbol/${id}`} />
                </TabsContent>
              </Tabs>

              {explain.unresolved.length === 0 ? null : (
                <Section title="Unresolved" count={explain.unresolved.length}>
                  <Card className="p-1">
                    <ul>
                      {explain.unresolved.map((entry, index) => (
                        <li key={`${entry.scope}:${entry.result.reference.text}:${index}`}>
                          <UnresolvedPill text={entry.result.reference.text} reason={entry.result.reference.reason} />
                        </li>
                      ))}
                    </ul>
                  </Card>
                </Section>
              )}

              <Limitations limitations={explain.limitations} title="Explanation limitations" />
            </div>
          );
        }}
      </QueryState>
    </>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}

/**
 * A list of incoming edges.
 *
 * `source` is `null` where the graph records an edge whose origin it could not name; the row is kept and
 * labelled rather than dropped, because a hidden row would understate how much references this.
 */
function ReferenceList({ references, emptyLabel }: { readonly references: readonly Reference[]; readonly emptyLabel: string }) {
  if (references.length === 0) {
    return (
      <Card>
        <EmptyState title={emptyLabel} />
      </Card>
    );
  }

  return (
    <Card className="p-1">
      <ul>
        {references.map((reference) => (
          <li key={reference.edge.id} className="flex items-center gap-2">
            {reference.source === null ? (
              <UnresolvedPill text={reference.edge.sourceId} reason="source not in graph" />
            ) : (
              <NodePill node={reference.source} className="min-w-0 flex-1" />
            )}
            <EdgeTag type={reference.edge.type} confidence={reference.edge.confidence} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CalleeList({ callees, emptyLabel }: { readonly callees: readonly Callee[]; readonly emptyLabel: string }) {
  if (callees.length === 0) {
    return (
      <Card>
        <EmptyState title={emptyLabel} />
      </Card>
    );
  }

  return (
    <Card className="p-1">
      <ul>
        {callees.map((callee) => (
          <li key={callee.edge.id} className="flex items-center gap-2">
            {callee.target === null ? (
              <UnresolvedPill text={callee.edge.targetId} reason="target not in graph" />
            ) : (
              <NodePill node={callee.target} className="min-w-0 flex-1" />
            )}
            <EdgeTag type={callee.edge.type} confidence={callee.edge.confidence} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EdgeTag({ type, confidence }: { readonly type: string; readonly confidence: GraphNode['confidence'] }) {
  return (
    <span className="flex shrink-0 items-center gap-1 pr-2">
      <span className="font-mono text-[10px] text-muted-foreground">{type}</span>
      <ConfidenceBadge confidence={confidence} />
    </span>
  );
}

export default function SymbolPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading declaration" rows={6} />}>
      <SymbolView />
    </Suspense>
  );
}
