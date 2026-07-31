'use client';

import { ChevronRight, File as FileIcon, Folder } from 'lucide-react';

import { ListingNote } from '@/components/domain/listing-note';
import { EmptyState, QueryState } from '@/components/domain/states';
import { NodePill } from '@/components/domain/node-pill';
import { ScrollArea } from '@/components/ui/scroll-area';
import { usePackage, usePackages } from '@/hooks/queries';
import { count, filePathOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { GraphNode } from '@/types/api';

/**
 * The Explorer's three panes.
 *
 * Each pane is a `listbox` of `option`s with roving `aria-selected`, so a screen reader announces both
 * the choice and that it is current. Keyboard movement is the browser's own: every row is a real button,
 * so `Tab` walks the list and `Enter` selects, with no key handling to reimplement or get wrong.
 */

/**
 * One selectable row.
 *
 * Exported so the Explorer's grouped navigation renders identical rows rather than a second copy of this
 * markup — selection styling and focus behaviour stay defined once.
 */
export function Row({
  selected,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'bg-secondary font-medium text-secondary-foreground' : 'hover:bg-accent',
        )}
      >
        {children}
      </button>
    </li>
  );
}

export function PackageTree({
  selected,
  onSelect,
}: {
  readonly selected: string | null;
  readonly onSelect: (name: string) => void;
}) {
  const packages = usePackages();

  return (
    <QueryState
      query={packages}
      loadingRows={8}
      isEmpty={(data) => data.entries.length === 0}
      empty={<EmptyState title="No packages" detail="Package names are derived from file paths." />}
    >
      {(data) => (
        <>
          <ScrollArea className="flex-1">
            <ul role="listbox" aria-label="Packages" className="p-1">
              {data.entries.map((entry) => (
                <Row key={entry.name} selected={entry.name === selected} onSelect={() => { onSelect(entry.name); }}>
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-mono">{entry.name}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">
                    {count(entry.files)}
                  </span>
                </Row>
              ))}
            </ul>
          </ScrollArea>
          <ListingNote listing={data} noun="package" />
        </>
      )}
    </QueryState>
  );
}

export function FileTree({
  packageName,
  selected,
  onSelect,
}: {
  readonly packageName: string | null;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const view = usePackage(packageName);

  if (packageName === null) {
    return <EmptyState title="Choose a package" detail="Its files appear here." />;
  }

  return (
    <QueryState
      query={view}
      loadingRows={8}
      isEmpty={(data) => data.files.entries.length === 0}
      empty={<EmptyState title="No files in this package" />}
    >
      {(data) => (
        <>
          <ScrollArea className="flex-1">
            <ul role="listbox" aria-label={`Files in ${packageName}`} className="p-1">
              {data.files.entries.map((node) => {
                const path = filePathOf(node.id);

                return (
                  <Row key={node.id} selected={path === selected} onSelect={() => { onSelect(path); }}>
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono" title={path}>
                      {/* Only the part below the package: the package name is already the pane above. */}
                      {path.startsWith(`${packageName}/`) ? path.slice(packageName.length + 1) : path}
                    </span>
                    <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  </Row>
                );
              })}
            </ul>
          </ScrollArea>
          <ListingNote listing={data.files} noun="file" />
        </>
      )}
    </QueryState>
  );
}

/** A file's declarations, grouped by kind so a long list stays navigable. */
export function SymbolList({ declarations, groupByKind = true }: { readonly declarations: readonly GraphNode[]; readonly groupByKind?: boolean }) {
  if (declarations.length === 0) {
    return <EmptyState title="No declarations in this file" />;
  }

  if (!groupByKind) {
    return (
      <ul className="p-1">
        {declarations.map((node) => (
          <li key={node.id}>
            <NodePill node={node} showPath={false} />
          </li>
        ))}
      </ul>
    );
  }

  const groups = new Map<string, GraphNode[]>();

  for (const node of declarations) {
    const bucket = groups.get(node.kind);

    if (bucket === undefined) {
      groups.set(node.kind, [node]);
    } else {
      bucket.push(node);
    }
  }

  return (
    <div className="p-1">
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
                  <NodePill node={node} showPath={false} />
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
