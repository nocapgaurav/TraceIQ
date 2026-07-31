'use client';

import { FileCode2 } from 'lucide-react';

import { JsonInspector } from '@/components/domain/json-inspector';
import { ListingNote } from '@/components/domain/listing-note';
import { NodePill } from '@/components/domain/node-pill';
import { fileActions, QuickActions } from '@/components/domain/explorer/quick-actions';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { count, filePathOf } from '@/lib/format';
import type { useFile } from '@/hooks/queries';
import type { GraphNode } from '@/types/api';

/**
 * A file, once one is chosen.
 *
 * Keeps every tab the previous Explorer had — declarations, imports, externals, environment, payload —
 * and adds what was missing: a heading that says which file this is, quick actions, and declarations that
 * open *here* rather than navigating away to the Symbol page. Staying in place is the point: the reader
 * is exploring, and each hop out and back loses their position.
 */
export function FilePanel({
  query,
  path,
  onSelectDeclaration,
}: {
  readonly query: ReturnType<typeof useFile>;
  readonly path: string;
  readonly onSelectDeclaration: (id: string) => void;
}) {
  return (
    <QueryState query={query} loadingRows={6}>
      {(data) => (
        <div className="flex flex-col gap-5 p-5">
          <header>
            <div className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              <Badge variant="outline" className="text-[11px]">
                File
              </Badge>
              <Badge variant="secondary" className="font-mono text-[11px]">
                {data.packageName}
              </Badge>
            </div>
            <h2 className="mt-2 break-all font-mono text-xl font-semibold tracking-tight">{path}</h2>
            <div className="mt-4">
              <QuickActions actions={fileActions(path)} />
            </div>
          </header>

          <StatGrid compact>
            <Stat compact label="Declarations" value={data.statistics.declarations} />
            <Stat compact label="Imports" value={data.statistics.imports} />
            <Stat compact label="Exports" value={data.statistics.exports} />
            <Stat compact label="Fan-in" value={data.statistics.fanIn} detail="files referencing this one" />
            <Stat compact label="Fan-out" value={data.statistics.fanOut} detail="files this one references" />
            <Stat compact label="Routes" value={data.routes.total} />
          </StatGrid>

          <Tabs defaultValue="declarations">
            {/* Counts on the triggers, so a reader can see which tabs hold anything before opening them. */}
            <TabsList>
              <TabsTrigger value="declarations">{`Declarations (${count(data.declarations.total)})`}</TabsTrigger>
              <TabsTrigger value="imports">{`Imports (${count(data.imports.total)})`}</TabsTrigger>
              <TabsTrigger value="exports">{`Exports (${count(data.exports.total)})`}</TabsTrigger>
              <TabsTrigger value="externals">{`Externals (${count(data.externalPackages.total)})`}</TabsTrigger>
              <TabsTrigger value="env">{`Environment (${count(data.environmentVariables.total)})`}</TabsTrigger>
              <TabsTrigger value="payload">Payload</TabsTrigger>
            </TabsList>

            <TabsContent value="declarations">
              <Card className="min-w-0 p-1">
                {data.declarations.entries.length === 0 ? (
                  <EmptyState
                    title="This file declares nothing"
                    detail="It may re-export from elsewhere, or hold only statements. Its imports and exports are on the tabs beside this one."
                  />
                ) : (
                  <DeclarationRows declarations={data.declarations.entries} onSelect={onSelectDeclaration} />
                )}
                <ListingNote listing={data.declarations} noun="declaration" />
              </Card>
            </TabsContent>

            <TabsContent value="imports">
              <Card className="min-w-0 p-1">
                {data.imports.entries.length === 0 ? (
                  <EmptyState
                    title="This file imports nothing"
                    detail="Either it stands alone, or its imports could not be resolved to a target the graph holds — the Payload tab shows exactly what was recorded."
                  />
                ) : (
                  <ul>
                    {data.imports.entries.map((entry) =>
                      entry.target === null ? null : (
                        <li key={entry.edge.id}>
                          <NodePill node={entry.target} />
                        </li>
                      ),
                    )}
                  </ul>
                )}
                <ListingNote listing={data.imports} noun="import" />
              </Card>
            </TabsContent>

            <TabsContent value="exports">
              <Card className="min-w-0 p-1">
                {data.exports.entries.length === 0 ? (
                  <EmptyState
                    title="This file exports nothing"
                    detail="Nothing here is reachable from another module — which is expected for an entry point or a test."
                  />
                ) : (
                  <ul>
                    {data.exports.entries.map((entry) =>
                      entry.target === null ? null : (
                        <li key={entry.edge.id}>
                          <NodePill node={entry.target} />
                        </li>
                      ),
                    )}
                  </ul>
                )}
                <ListingNote listing={data.exports} noun="export" />
              </Card>
            </TabsContent>

            <TabsContent value="externals">
              <Card className="min-w-0 p-1">
                {data.externalPackages.entries.length === 0 ? (
                  <EmptyState
                    title="No external package is imported here"
                    detail="This file depends only on the repository itself."
                  />
                ) : (
                  <ul>
                    {data.externalPackages.entries.map((node) => (
                      <li key={node.id}>
                        <NodePill node={node} />
                      </li>
                    ))}
                  </ul>
                )}
                <ListingNote listing={data.externalPackages} noun="external package" />
              </Card>
            </TabsContent>

            <TabsContent value="env">
              <Card className="min-w-0 p-1">
                {data.environmentVariables.entries.length === 0 ? (
                  <EmptyState
                    title="No environment variable is read in this file"
                    detail="The analysis records a variable where it sees it read through process.env."
                  />
                ) : (
                  <ul>
                    {data.environmentVariables.entries.map((node) => (
                      <li key={node.id}>
                        <NodePill node={node} />
                      </li>
                    ))}
                  </ul>
                )}
                <ListingNote listing={data.environmentVariables} noun="variable" />
              </Card>
            </TabsContent>

            <TabsContent value="payload">
              {/* The file's own path, not its package — the label names the request that produced this. */}
              <JsonInspector value={data} height={360} label={`GET /files/${filePathOf(data.file.id)}`} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </QueryState>
  );
}

/**
 * Declarations, grouped by kind, each opening the declaration panel.
 *
 * Deliberately buttons rather than the `NodePill` links used elsewhere: a link leaves the Explorer for the
 * Symbol page, and the point of this redesign is that a declaration can be read without losing the trail.
 */
function DeclarationRows({
  declarations,
  onSelect,
}: {
  readonly declarations: readonly GraphNode[];
  readonly onSelect: (id: string) => void;
}) {
  const groups = new Map<string, GraphNode[]>();

  for (const node of declarations) {
    groups.set(node.kind, [...(groups.get(node.kind) ?? []), node]);
  }

  return (
    <div>
      {[...groups.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([kind, nodes]) => (
          <div key={kind} className="mb-2">
            <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {kind} ({nodes.length})
            </p>
            <ul>
              {nodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(node.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="truncate font-mono text-xs">{node.name}</span>
                    {node.isExported ? (
                      <Badge variant="outline" className="shrink-0">
                        export
                      </Badge>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
