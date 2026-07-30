'use client';

import { Search as SearchIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { PageHeader } from '@/components/layout/app-shell';
import { ListingNote } from '@/components/domain/listing-note';
import { NodePill } from '@/components/domain/node-pill';
import { EmptyState, InlineLoading, LoadingState, QueryState } from '@/components/domain/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/hooks/use-debounced';
import { useSearch } from '@/hooks/queries';
import { count } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { GraphNode, Listing, SearchResults } from '@/types/api';

/**
 * The Search page.
 *
 * Exact and prefix matching only — the API offers nothing else, deliberately: no fuzzy matching, no
 * ranking, no scoring. Results come back in alphabetical order and are rendered in that order, so the
 * same query always produces the same page.
 */
const KINDS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'Class', label: 'Classes' },
  { value: 'Interface', label: 'Interfaces' },
  { value: 'Function', label: 'Functions' },
  { value: 'Method', label: 'Methods' },
  { value: 'TypeAlias', label: 'Type aliases' },
  { value: 'Variable', label: 'Variables' },
  { value: 'Enum', label: 'Enums' },
];

function SearchView() {
  const params = useSearchParams();
  const router = useRouter();

  const initial = params.get('q') ?? '';
  const [text, setText] = useState(initial);
  const [kind, setKind] = useState('');
  const [match, setMatch] = useState<'prefix' | 'exact'>('prefix');

  const debounced = useDebounced(text, 250);
  const query = useSearch({ text: debounced, ...(kind === '' ? {} : { kind }), match });

  return (
    <>
      <PageHeader title="Search" subtitle="exact and prefix matching — no fuzzy search, no ranking" />

      <form
        role="search"
        className="mb-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Keeping the query in the URL makes a result set shareable and survives a reload.
          router.replace(text === '' ? '/search' : `/search?q=${encodeURIComponent(text)}`);
        }}
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              autoFocus
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              placeholder="Declaration, file, route, environment variable or package…"
              aria-label="Search the repository"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex flex-wrap items-center gap-1">
            <legend className="sr-only">Filter by kind</legend>
            {KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={kind === option.value}
                onClick={() => {
                  setKind(option.value);
                }}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  kind === option.value ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {option.label}
              </button>
            ))}
          </fieldset>

          <div className="flex items-center gap-1 border-l border-border pl-3">
            {(['prefix', 'exact'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={match === option}
                onClick={() => {
                  setMatch(option);
                }}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  match === option ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </form>

      {debounced === '' ? (
        <EmptyState
          title="Type to search"
          detail="Matching is exact or by prefix. Press ⌘K anywhere in the app to search without leaving the page."
        />
      ) : query.isFetching && query.data === undefined ? (
        <InlineLoading label={`Searching for “${debounced}”`} />
      ) : (
        <QueryState
          query={query}
          loadingRows={4}
          isEmpty={(data) => data.total === 0}
          empty={
            <EmptyState
              title={`Nothing matches “${debounced}”`}
              detail={match === 'prefix' ? 'Try a shorter prefix.' : 'Exact matching requires the whole name. Try prefix matching.'}
            />
          }
        >
          {(data) => <Results results={data} />}
        </QueryState>
      )}
    </>
  );
}

function Results({ results }: { readonly results: SearchResults }) {
  const groups: readonly { readonly title: string; readonly listing: Listing<GraphNode> }[] = [
    { title: 'Declarations', listing: results.declarations },
    { title: 'Files', listing: results.files },
    { title: 'Routes', listing: results.routes },
    { title: 'Environment variables', listing: results.environmentVariables },
    { title: 'External packages', listing: results.externalPackages },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {count(results.total)} results · {results.match} matching
      </p>

      {groups
        .filter((group) => group.listing.entries.length > 0)
        .map((group) => (
          <Card key={group.title}>
            <CardHeader>
              <CardTitle>
                {group.title} <span className="font-normal text-muted-foreground">({group.listing.total})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-1">
              <ul>
                {group.listing.entries.map((node) => (
                  <li key={node.id}>
                    <NodePill node={node} />
                  </li>
                ))}
              </ul>
              <ListingNote listing={group.listing} noun="result" />
            </CardContent>
          </Card>
        ))}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading search" rows={4} />}>
      <SearchView />
    </Suspense>
  );
}
