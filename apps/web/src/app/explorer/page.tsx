'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { PageHeader } from '@/components/layout/app-shell';
import { JsonInspector } from '@/components/domain/json-inspector';
import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { NodePill } from '@/components/domain/node-pill';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, LoadingState, QueryState } from '@/components/domain/states';
import { FileTree, PackageTree, SymbolList } from '@/components/domain/trees';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFile, usePackage } from '@/hooks/queries';
import { count, filePathOf } from '@/lib/format';
import { DEFAULT_PANEL_SIZES, useUiStore } from '@/store/ui-store';

/**
 * The Explorer: packages → files → declarations, in three resizable panes.
 *
 * Selection lives in **both** the URL and the store, and each has a distinct job: the URL makes a pane
 * state shareable and survives a reload, while the store remembers the pane *sizes*. The URL is the
 * authority for what is selected, so a pasted link always wins over whatever was last clicked.
 */
function ExplorerView() {
  const params = useSearchParams();
  const router = useRouter();

  const packageName = params.get('package');
  const filePath = params.get('file');

  const sizes = useUiStore((state) => state.panelSizes);
  const setSizes = useUiStore((state) => state.setPanelSizes);
  const selectPackage = useUiStore((state) => state.selectPackage);
  const selectFile = useUiStore((state) => state.selectFile);

  // The store mirrors the URL so a component that only needs the selection does not have to read params.
  useEffect(() => {
    selectPackage(packageName);
    selectFile(filePath);
  }, [packageName, filePath, selectPackage, selectFile]);

  const file = useFile(filePath);
  const pkg = usePackage(filePath === null ? packageName : null);

  const navigate = (next: { readonly package?: string | null; readonly file?: string | null }): void => {
    const query = new URLSearchParams();
    const nextPackage = next.package === undefined ? packageName : next.package;
    const nextFile = next.file === undefined ? filePath : next.file;

    if (nextPackage !== null && nextPackage !== '') {
      query.set('package', nextPackage);
    }

    if (nextFile !== null && nextFile !== '') {
      query.set('file', nextFile);
    }

    const search = query.toString();

    router.push(search === '' ? '/explorer' : `/explorer?${search}`);
  };

  return (
    <>
      <PageHeader
        title="Explorer"
        subtitle={filePath ?? packageName ?? 'browse the repository by package and file'}
      />

      {/*
        Panels below `lg`: a three-pane split is unusable on a narrow screen, so the same three regions
        stack vertically instead. One component tree, two arrangements — no duplicated markup.
      */}
      <div className="hidden lg:block">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-[calc(100vh-11rem)] rounded-lg border border-border"
          onLayout={(next) => {
            setSizes(next);
          }}
        >
          <ResizablePanel defaultSize={sizes[0] ?? DEFAULT_PANEL_SIZES[0]} minSize={14}>
            <Pane title="Packages">
              <PackageTree
                selected={packageName}
                onSelect={(name) => {
                  navigate({ package: name, file: null });
                }}
              />
            </Pane>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={sizes[1] ?? DEFAULT_PANEL_SIZES[1]} minSize={16}>
            <Pane title="Files">
              <FileTree
                packageName={packageName}
                selected={filePath}
                onSelect={(path) => {
                  navigate({ file: path });
                }}
              />
            </Pane>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={sizes[2] ?? DEFAULT_PANEL_SIZES[2]} minSize={20}>
            <Pane title={filePath === null ? 'Package' : 'File'}>
              <ScrollArea className="flex-1">
                {filePath === null ? <PackageDetail query={pkg} name={packageName} /> : <FileDetail query={file} />}
              </ScrollArea>
            </Pane>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <div className="flex flex-col gap-4 lg:hidden">
        <Card className="flex h-72 flex-col">
          <Pane title="Packages">
            <PackageTree
              selected={packageName}
              onSelect={(name) => {
                navigate({ package: name, file: null });
              }}
            />
          </Pane>
        </Card>
        <Card className="flex h-72 flex-col">
          <Pane title="Files">
            <FileTree
              packageName={packageName}
              selected={filePath}
              onSelect={(path) => {
                navigate({ file: path });
              }}
            />
          </Pane>
        </Card>
        <Card className="flex flex-col p-1">
          {filePath === null ? <PackageDetail query={pkg} name={packageName} /> : <FileDetail query={file} />}
        </Card>
      </div>
    </>
  );
}

function Pane({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function PackageDetail({
  query,
  name,
}: {
  readonly query: ReturnType<typeof usePackage>;
  readonly name: string | null;
}) {
  if (name === null) {
    return <EmptyState title="Choose a package" detail="Pick a package on the left to see what it holds." />;
  }

  return (
    <QueryState query={query} loadingRows={6}>
      {(data) => (
        <div className="flex flex-col gap-4 p-3">
          <StatGrid>
            <Stat label="Files" value={data.statistics.files} />
            <Stat label="Declarations" value={data.statistics.declarations} />
            <Stat label="Depends on" value={data.dependencies.total} />
            <Stat label="Depended on by" value={data.dependents.total} />
            <Stat label="Externals" value={data.externalPackages.total} />
          </StatGrid>

          <Card>
            <CardHeader>
              <CardTitle>Declarations by kind</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {Object.entries(data.statistics.declarationsByKind)
                .filter(([, total]) => total > 0)
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
                .map(([kind, total]) => (
                  <Badge key={kind} variant="secondary">
                    {kind}: {count(total)}
                  </Badge>
                ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Roles</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {Object.entries(data.roles).filter(([, nodes]) => nodes.length > 0).length === 0 ? (
                <p className="text-xs text-muted-foreground">No declaration in this package carries a role.</p>
              ) : (
                Object.entries(data.roles)
                  .filter(([, nodes]) => nodes.length > 0)
                  .map(([role, nodes]) => (
                    <div key={role}>
                      <p className="mb-1 text-xs font-medium">
                        {role} <span className="text-muted-foreground">({nodes.length})</span>
                      </p>
                      <ul>
                        {nodes.slice(0, 12).map((node) => (
                          <li key={node.id}>
                            <NodePill node={node} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Depends on</CardTitle>
              </CardHeader>
              <CardContent>
                {data.dependencies.entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing — this package imports no other.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {data.dependencies.entries.map((entry) => (
                      <li key={entry.name} className="flex items-center justify-between font-mono text-xs">
                        <span className="truncate">{entry.name}</span>
                        <span className="tabular-nums text-muted-foreground">{count(entry.edges.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <ListingNote listing={data.dependencies} noun="dependency" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Depended on by</CardTitle>
              </CardHeader>
              <CardContent>
                {data.dependents.entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing imports this package.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {data.dependents.entries.map((entry) => (
                      <li key={entry.name} className="flex items-center justify-between font-mono text-xs">
                        <span className="truncate">{entry.name}</span>
                        <span className="tabular-nums text-muted-foreground">{count(entry.edges.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <ListingNote listing={data.dependents} noun="dependent" />
              </CardContent>
            </Card>
          </div>

          <Limitations limitations={data.limitations} title="Package limitations" />
        </div>
      )}
    </QueryState>
  );
}

function FileDetail({ query }: { readonly query: ReturnType<typeof useFile> }) {
  return (
    <QueryState query={query} loadingRows={6}>
      {(data) => (
        <div className="flex flex-col gap-4 p-3">
          <StatGrid>
            <Stat label="Declarations" value={data.statistics.declarations} />
            <Stat label="Imports" value={data.statistics.imports} />
            <Stat label="Exports" value={data.statistics.exports} />
            <Stat label="Fan-in" value={data.statistics.fanIn} />
            <Stat label="Fan-out" value={data.statistics.fanOut} />
          </StatGrid>

          <Tabs defaultValue="declarations">
            <TabsList>
              <TabsTrigger value="declarations">Declarations</TabsTrigger>
              <TabsTrigger value="imports">Imports</TabsTrigger>
              <TabsTrigger value="externals">Externals</TabsTrigger>
              <TabsTrigger value="env">Environment</TabsTrigger>
              <TabsTrigger value="payload">Payload</TabsTrigger>
            </TabsList>

            <TabsContent value="declarations">
              <Card>
                <SymbolList declarations={data.declarations.entries} />
                <ListingNote listing={data.declarations} noun="declaration" />
              </Card>
            </TabsContent>

            <TabsContent value="imports">
              <Card className="p-1">
                {data.imports.entries.length === 0 ? (
                  <EmptyState title="This file imports nothing" />
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

            <TabsContent value="externals">
              <Card className="p-1">
                {data.externalPackages.entries.length === 0 ? (
                  <EmptyState title="No external package is imported here" />
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
              <Card className="p-1">
                {data.environmentVariables.entries.length === 0 ? (
                  <EmptyState title="No environment variable is read in this file" />
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
 * `useSearchParams` requires a Suspense boundary, because Next may stream the page before the query
 * string is known. Without one the whole route is forced to render dynamically.
 */
export default function ExplorerPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading explorer" rows={6} />}>
      <ExplorerView />
    </Suspense>
  );
}
