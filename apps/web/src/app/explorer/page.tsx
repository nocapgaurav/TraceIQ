'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { DeclarationPanel } from '@/components/domain/explorer/declaration-panel';
import { ExplorerSearch, normaliseFilter } from '@/components/domain/explorer/explorer-search';
import { FilePanel } from '@/components/domain/explorer/file-panel';
import { PackageNav } from '@/components/domain/explorer/package-nav';
import { PackagePanel } from '@/components/domain/explorer/package-panel';
import { RepositoryTips } from '@/components/domain/explorer/tips';
import { ExplorerWelcome } from '@/components/domain/explorer/welcome';
import { LoadingState } from '@/components/domain/states';
import { Card } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFile, usePackage, useSymbol } from '@/hooks/queries';
import { routes } from '@/lib/routes';
import { DEFAULT_PANEL_SIZES, useUiStore } from '@/store/ui-store';

/**
 * The Explorer: repository → package → file → declaration.
 *
 * Three regions rather than three panes of the same kind. Navigation on the left, the subject in the
 * middle, and what the vocabulary means on the right — so the page answers "where should I go?" before
 * anything is selected, which a bare list of packages never did.
 *
 * Selection lives in the URL, and the URL is the authority: `?package=`, `?file=` and `?symbol=`. That
 * makes every view shareable and survives a reload. The store holds only the pane sizes.
 */
function ExplorerView() {
  const params = useSearchParams();
  const router = useRouter();

  const packageName = params.get('package');
  const filePath = params.get('file');
  const symbolId = params.get('symbol');

  const sizes = useUiStore((state) => state.panelSizes);
  const setSizes = useUiStore((state) => state.setPanelSizes);
  const selectPackage = useUiStore((state) => state.selectPackage);
  const selectFile = useUiStore((state) => state.selectFile);

  const [search, setSearch] = useState('');
  const filter = normaliseFilter(search);

  // The store mirrors the URL so a component that only needs the selection does not have to read params.
  useEffect(() => {
    selectPackage(packageName);
    selectFile(filePath);
  }, [packageName, filePath, selectPackage, selectFile]);

  // Each query is disabled unless its parameter is present, so only the open subject is fetched.
  const pkg = usePackage(filePath === null && symbolId === null ? packageName : null);
  const file = useFile(symbolId === null ? filePath : null);
  const symbol = useSymbol(symbolId);

  const go = (next: {
    readonly package?: string | null;
    readonly file?: string | null;
    readonly symbol?: string | null;
  }): void => {
    router.push(
      routes.explorerAt({
        package: next.package === undefined ? packageName : next.package,
        file: next.file === undefined ? filePath : next.file,
        symbol: next.symbol === undefined ? symbolId : next.symbol,
      }),
    );
  };

  // Choosing a package drops the file and declaration below it; choosing a file drops the declaration.
  // Otherwise the panel would show something that no longer belongs to what is selected.
  const openPackage = (name: string): void => {
    go({ package: name, file: null, symbol: null });
  };

  const openFile = (path: string): void => {
    // A file reached from search may sit outside the open package, so its package comes along with it.
    go({ package: packageOf(path, packageName), file: path, symbol: null });
  };

  const openDeclaration = (id: string): void => {
    go({ symbol: id });
  };

  const nav = (
    <PackageNav
      selectedPackage={packageName}
      selectedFile={filePath}
      onSelectPackage={openPackage}
      onSelectFile={openFile}
      filter={filter}
    />
  );

  const detail =
    symbolId !== null ? (
      <DeclarationPanel query={symbol} id={symbolId} onSelectFile={openFile} />
    ) : filePath !== null ? (
      <FilePanel
        query={file}
        path={filePath}
        onSelectDeclaration={openDeclaration}
        onSelectFile={openFile}
      />
    ) : packageName !== null ? (
      <PackagePanel query={pkg} name={packageName} onSelectFile={openFile} />
    ) : (
      <ExplorerWelcome onSelectPackage={openPackage} />
    );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Repository Navigation</h1>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Explore the repository’s structure through its packages, the modules inside them and the
            declarations they contain — with the relationships the analysis resolved around each one.
          </p>
        </div>

        <div className="max-w-2xl">
          <ExplorerSearch
            value={search}
            onChange={setSearch}
            onSelectFile={openFile}
            onSelectDeclaration={openDeclaration}
          />
        </div>
      </header>

      {/*
        Three panes above `lg`; below it the same three regions stack, because a three-way split is
        unusable on a narrow screen. The regions are built once above and placed into either arrangement,
        so there is one component tree and no duplicated markup.

        Both arrangements are in the DOM and the breakpoint hides one with `display: none`, which also
        removes it from the accessibility tree — so a screen reader sees exactly one. `data-layout` names
        them, because a test renders in jsdom, where no media query applies and both are therefore visible.
      */}
      <div data-layout="wide" className="hidden lg:block">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-[calc(100vh-14rem)] rounded-lg border border-border"
          onLayout={(next) => {
            setSizes(next);
          }}
        >
          <ResizablePanel defaultSize={sizes[0] ?? DEFAULT_PANEL_SIZES[0]} minSize={16}>
            <Pane title="Packages">{nav}</Pane>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={sizes[1] ?? DEFAULT_PANEL_SIZES[1]} minSize={30}>
            <div className="flex h-full min-w-0 flex-col">
              <ScrollArea className="flex-1">{detail}</ScrollArea>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={sizes[2] ?? DEFAULT_PANEL_SIZES[2]} minSize={14}>
            <RepositoryTips />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <div data-layout="narrow" className="flex flex-col gap-4 lg:hidden">
        <Card className="flex h-80 flex-col">
          <Pane title="Packages">{nav}</Pane>
        </Card>
        <Card className="flex min-w-0 flex-col">{detail}</Card>
        <Card className="flex h-96 flex-col">
          <RepositoryTips />
        </Card>
      </div>
    </div>
  );
}

/**
 * Which package a file belongs to.
 *
 * The first two path segments, matching how the API derives package names — so a file opened from search
 * selects its own package rather than leaving whichever one happened to be open. A path with fewer than
 * two segments keeps the current selection, since there is no package name to form.
 */
function packageOf(path: string, current: string | null): string | null {
  const segments = path.split('/');

  return segments.length < 2 ? current : segments.slice(0, 2).join('/');
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
