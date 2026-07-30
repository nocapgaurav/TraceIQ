'use client';

import Link from 'next/link';
import { useMemo } from 'react';

import { PageHeader, Section } from '@/components/layout/app-shell';
import { GraphCanvas } from '@/components/domain/graph-canvas';
import { JsonInspector } from '@/components/domain/json-inspector';
import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { KindLabel } from '@/components/domain/node-pill';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, LoadingState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useArchitecture, useCycles } from '@/hooks/queries';
import { count } from '@/lib/format';
import { packageGraph } from '@/lib/graph-models';
import { linkForNode, routes } from '@/lib/routes';

/**
 * The Architecture page: the package dependency graph, plus the three trees behind it.
 *
 * One request to `/architecture` returns all four views — packages, the architecture tree, the package
 * tree, the role tree and the dependency tree — so the graph and the tables are guaranteed to agree.
 */
export default function ArchitecturePage() {
  const architecture = useArchitecture();
  const cycles = useCycles();

  const layout = useMemo(
    () => (architecture.data === undefined ? null : packageGraph(architecture.data)),
    [architecture.data],
  );

  return (
    <>
      <PageHeader title="Architecture" subtitle="packages, roles and dependencies, derived from the graph" />

      <QueryState query={architecture} loadingRows={6}>
        {(data) => (
          <div className="flex flex-col gap-6">
            <StatGrid>
              <Stat label="Packages" value={data.packages.total} />
              <Stat
                label="Declarations"
                value={data.packageTree.entries.reduce((total, entry) => total + entry.declarations, 0)}
              />
              <Stat label="Role groups" value={data.roleTree.total} />
              <Stat
                label="Dependency edges"
                value={data.dependencyTree.entries.reduce(
                  (total, entry) => total + entry.dependsOn.entries.reduce((sum, item) => sum + item.edges, 0),
                  0,
                )}
              />
              <Stat
                label="Import cycles"
                value={cycles.data?.totals.import ?? 0}
                tone={(cycles.data?.totals.import ?? 0) > 0 ? 'warning' : 'default'}
              />
            </StatGrid>

            <Section title="Package dependency graph">
              {layout === null ? (
                <LoadingState rows={4} />
              ) : (
                <GraphCanvas
                  layout={layout}
                  linkFor={(name) => routes.package(name)}
                  height={520}
                  emptyLabel="No package depends on another"
                  noEdgesNote="No package-to-package dependency was recovered, so the packages are drawn unconnected. In a pnpm workspace a sibling import resolves through built output rather than a source file, so the scanner records it as an external package — see cross-package-imports-resolve-outside-analysis below."
                />
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                An arrow points from a package to one it depends on. A column is dependency depth; a dashed
                arrow closes a cycle. Package boundaries come from the first two path segments of a file.
              </p>
            </Section>

            <Tabs defaultValue="packages">
              <TabsList className="flex-wrap">
                <TabsTrigger value="packages">Packages ({data.packages.total})</TabsTrigger>
                <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
                <TabsTrigger value="roles">Roles ({data.roleTree.total})</TabsTrigger>
                <TabsTrigger value="groups">Groups ({data.architectureTree.total})</TabsTrigger>
                <TabsTrigger value="payload">Payload</TabsTrigger>
              </TabsList>

              <TabsContent value="packages">
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
                            <Link href={routes.package(entry.name)} className="font-mono text-xs hover:underline">
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
              </TabsContent>

              <TabsContent value="dependencies">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {data.dependencyTree.entries.map((entry) => (
                    <Card key={entry.name}>
                      <CardHeader>
                        <CardTitle>
                          <Link href={routes.package(entry.name)} className="font-mono hover:underline">
                            {entry.name}
                          </Link>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2 text-xs">
                        <div>
                          <p className="text-[11px] text-muted-foreground">depends on ({entry.dependsOn.total})</p>
                          {entry.dependsOn.entries.length === 0 ? (
                            <p className="text-muted-foreground">nothing</p>
                          ) : (
                            <ul className="mt-0.5">
                              {entry.dependsOn.entries.map((item) => (
                                <li key={item.name} className="flex justify-between font-mono">
                                  <span className="truncate">{item.name}</span>
                                  <span className="tabular-nums text-muted-foreground">{count(item.edges)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">depended on by ({entry.dependedOnBy.total})</p>
                          {entry.dependedOnBy.entries.length === 0 ? (
                            <p className="text-muted-foreground">nothing</p>
                          ) : (
                            <ul className="mt-0.5">
                              {entry.dependedOnBy.entries.map((item) => (
                                <li key={item.name} className="flex justify-between font-mono">
                                  <span className="truncate">{item.name}</span>
                                  <span className="tabular-nums text-muted-foreground">{count(item.edges)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <ListingNote listing={data.dependencyTree} noun="package" />
              </TabsContent>

              <TabsContent value="roles">
                {data.roleTree.entries.length === 0 ? (
                  <EmptyState
                    title="No declaration carries a role"
                    detail="Roles are annotations the framework extractor infers; a repository may have none."
                  />
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {data.roleTree.entries.map((entry) => (
                      <Card key={entry.role}>
                        <CardHeader>
                          <CardTitle>
                            {entry.role} <span className="font-normal text-muted-foreground">({entry.total})</span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ScrollArea className="max-h-64">
                            {entry.packages.entries.map((group) => (
                              <div key={group.name} className="mb-2">
                                <p className="font-mono text-[11px] text-muted-foreground">{group.name}</p>
                                <ul>
                                  {group.declarations.entries.map((ref) => (
                                    <li key={ref.id}>
                                      <Link
                                        href={linkForNode(ref.id)}
                                        className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent"
                                      >
                                        <KindLabel kind={ref.kind} className="w-20 shrink-0 text-right" />
                                        <span className="truncate font-mono text-xs">{ref.name}</span>
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                                <ListingNote listing={group.declarations} noun="declaration" />
                              </div>
                            ))}
                          </ScrollArea>
                          <ListingNote listing={entry.packages} noun="package" />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="groups">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {data.architectureTree.entries.map((group) => (
                    <Card key={`${group.category}:${group.group}`}>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          {group.group}
                          <Badge variant="outline">{group.category}</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ScrollArea className="max-h-56">
                          <ul>
                            {group.entries.entries.map((ref) => (
                              <li key={ref.id}>
                                <Link
                                  href={linkForNode(ref.id)}
                                  className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent"
                                >
                                  <KindLabel kind={ref.kind} className="w-20 shrink-0 text-right" />
                                  <span className="truncate font-mono text-xs">{ref.name}</span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </ScrollArea>
                        <ListingNote listing={group.entries} noun="entry" />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="payload">
                <JsonInspector value={data} label="GET /architecture" />
              </TabsContent>
            </Tabs>

            <Limitations limitations={data.limitations} title="Architecture limitations" />
          </div>
        )}
      </QueryState>
    </>
  );
}
