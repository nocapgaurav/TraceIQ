'use client';

import { Search as SearchIcon, X } from 'lucide-react';
import Link from 'next/link';

import { KindLabel } from '@/components/domain/node-pill';
import { InlineLoading } from '@/components/domain/states';
import { Input } from '@/components/ui/input';
import { useSearch } from '@/hooks/queries';
import { useDebounced } from '@/hooks/use-debounced';
import { count, filePathOf, symbolName } from '@/lib/format';
import { routes } from '@/lib/routes';

/**
 * The Explorer's search, at the top of the page.
 *
 * Two jobs from one box. It narrows the navigation on the left as you type — instant, no request — and it
 * queries `GET /search` for declarations and files, which the sidebar alone cannot reach because only the
 * open package's files are loaded.
 *
 * The results select *within the Explorer* rather than navigating to the Search page: this is a
 * find-your-place control, not a second search page. The full Search page remains one click away for
 * everything else it offers.
 */
export function ExplorerSearch({
  value,
  onChange,
  onSelectFile,
  onSelectDeclaration,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSelectFile: (path: string) => void;
  readonly onSelectDeclaration: (id: string) => void;
}) {
  // Debounced so a query fires on a settled input; the sidebar filter uses `value` directly and stays live.
  const debounced = useDebounced(value.trim());
  const results = useSearch({ text: debounced });

  const declarations = results.data?.declarations.entries ?? [];
  const files = results.data?.files.entries ?? [];
  const total = results.data?.total ?? 0;

  return (
    <div className="relative">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        aria-label="Search files, declarations and packages"
        placeholder="Search files, declarations, packages..."
        className="h-10 pl-9 pr-9"
      />
      {value === '' ? null : (
        <button
          type="button"
          onClick={() => {
            onChange('');
          }}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {debounced === '' ? null : (
        <div className="mt-2 rounded-lg border border-border bg-card">
          {results.isPending ? (
            <div className="px-3">
              <InlineLoading label="Searching the graph" />
            </div>
          ) : results.error !== null ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              The graph could not be searched. The sidebar filter above still works on package names.
            </p>
          ) : total === 0 ? (
            <p className="px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {`Nothing in the graph is named “${debounced}”. Matching is exact or by prefix — never fuzzy — so a partial word from the middle of a name will not match. Try the start of the name.`}
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto p-1">
              <Group label="Declarations" shown={declarations.length} total={results.data?.declarations.total ?? 0}>
                {declarations.slice(0, 6).map((node) => (
                  <ResultRow
                    key={node.id}
                    onSelect={() => {
                      onSelectDeclaration(node.id);
                    }}
                  >
                    <KindLabel kind={node.kind} className="w-20 shrink-0 text-right" />
                    <span className="truncate font-mono text-xs">{symbolName(node.id)}</span>
                    <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-muted-foreground">
                      {filePathOf(node.id)}
                    </span>
                  </ResultRow>
                ))}
              </Group>

              <Group label="Files" shown={files.length} total={results.data?.files.total ?? 0}>
                {files.slice(0, 6).map((node) => (
                  <ResultRow
                    key={node.id}
                    onSelect={() => {
                      onSelectFile(filePathOf(node.id));
                    }}
                  >
                    <KindLabel kind="File" className="w-20 shrink-0 text-right" />
                    <span className="truncate font-mono text-xs">{filePathOf(node.id)}</span>
                  </ResultRow>
                ))}
              </Group>

              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {count(total)} {total === 1 ? 'match' : 'matches'} in the graph.{' '}
                <Link href={routes.search(debounced)} className="text-primary hover:underline">
                  See all on the Search page
                </Link>
                , which also covers routes, environment variables and external packages.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Group({
  label,
  shown,
  total,
  children,
}: {
  readonly label: string;
  readonly shown: number;
  readonly total: number;
  readonly children: React.ReactNode;
}) {
  if (shown === 0) {
    return null;
  }

  return (
    <div className="mb-1">
      <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label} <span className="tabular-nums">({count(total)})</span>
      </p>
      <ul>{children}</ul>
    </div>
  );
}

function ResultRow({ onSelect, children }: { readonly onSelect: () => void; readonly children: React.ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </button>
    </li>
  );
}

/** The sidebar filter and this box must agree on what a query means, so both normalise here. */
export function normaliseFilter(value: string): string {
  return value.trim().toLowerCase();
}
