'use client';

import { Folder } from 'lucide-react';

import { Limitations } from '@/components/domain/limitations';
import { ListingNote } from '@/components/domain/listing-note';
import { NodePill } from '@/components/domain/node-pill';
import { packageActions, QuickActions } from '@/components/domain/explorer/quick-actions';
import { Unavailable } from '@/components/domain/overview/shared';
import { Stat, StatGrid } from '@/components/domain/stat';
import { QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count, filePathOf, pluralise } from '@/lib/format';
import { directoriesOf } from '@/lib/package-groups';
import type { usePackage } from '@/hooks/queries';

/**
 * A package, once one is chosen.
 *
 * Everything is from `GET /packages/{name}`. The one field the API cannot supply is a written description
 * of what the package is *for* — that is judgement, not structure — so it degrades rather than being
 * approximated from the package's name.
 */
export function PackagePanel({
  query,
  name,
  onSelectFile,
}: {
  readonly query: ReturnType<typeof usePackage>;
  readonly name: string;
  readonly onSelectFile: (path: string) => void;
}) {
  return (
    <QueryState query={query} loadingRows={6}>
      {(data) => {
        const paths = data.files.entries.map((node) => filePathOf(node.id));
        const directories = directoriesOf(name, paths);
        const roles = Object.entries(data.roles).filter(([, nodes]) => nodes.length > 0);

        return (
          <div className="flex flex-col gap-5 p-5">
            <header>
              <div className="flex items-center gap-2">
                <Folder className="h-4 w-4 text-muted-foreground" aria-hidden />
                <Badge variant="outline" className="text-[11px]">
                  Package
                </Badge>
              </div>
              <h2 className="mt-2 break-all font-mono text-xl font-semibold tracking-tight">{name}</h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Description — <Unavailable />
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Package boundaries are derived from file paths, so the graph records what a package
                <em> contains</em>, never what it is for.
              </p>
              <div className="mt-4">
                <QuickActions actions={packageActions(name)} />
              </div>
            </header>

            <StatGrid compact>
              <Stat compact label="Files" value={data.statistics.files} />
              <Stat compact label="Declarations" value={data.statistics.declarations} />
              <Stat compact label="Depends on" value={data.dependencies.total} />
              <Stat compact label="Depended on by" value={data.dependents.total} />
              <Stat compact label="Externals" value={data.externalPackages.total} />
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

            <div className="grid gap-4 xl:grid-cols-2">
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle>Directories</CardTitle>
                  <p className="text-[11px] font-normal text-muted-foreground">
                    Read back from the file paths in this package.
                  </p>
                </CardHeader>
                <CardContent>
                  {directories.length === 0 ? (
                    <p className="text-xs text-muted-foreground">This package has no files to group.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {directories.map((entry) => (
                        <li key={entry.name} className="flex items-center justify-between gap-3 text-xs">
                          <span className="truncate font-mono">
                            {entry.name === '.' ? `${name}/` : `${name}/${entry.name}/`}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {pluralise(entry.files, 'file')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle>Files</CardTitle>
                </CardHeader>
                <CardContent className="p-1">
                  {paths.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">This package holds no files.</p>
                  ) : (
                    <ul>
                      {paths.slice(0, 12).map((path) => (
                        <li key={path}>
                          <button
                            type="button"
                            onClick={() => {
                              onSelectFile(path);
                            }}
                            className="w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {path.startsWith(`${name}/`) ? path.slice(name.length + 1) : path}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ListingNote
                    listing={
                      paths.length > 12
                        ? { entries: paths.slice(0, 12), total: data.files.total, truncated: true }
                        : data.files
                    }
                    noun="file"
                    {...(paths.length > 12 ? { cappedBy: 'this panel' } : {})}
                  />
                </CardContent>
              </Card>
            </div>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Important declarations</CardTitle>
                <p className="text-[11px] font-normal text-muted-foreground">
                  {roles.length === 0
                    ? 'Ranked by role. The analysis annotated none in this package.'
                    : 'The declarations the analysis annotated with a role.'}
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {roles.length === 0 ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    No declaration here carries a Controller, Service, Repository, Middleware, Model or Test
                    role. Roles are annotations the analysis adds where it recognises a convention — their
                    absence means none was recognised, not that nothing here matters.
                  </p>
                ) : (
                  roles.map(([role, nodes]) => (
                    <div key={role}>
                      <p className="mb-1 text-xs font-medium">
                        {role} <span className="text-muted-foreground">({nodes.length})</span>
                      </p>
                      <ul>
                        {nodes.slice(0, 8).map((node) => (
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
              <Relationships
                title="Packages it depends on"
                empty="Nothing — this package imports no other."
                listing={data.dependencies}
                noun="dependency"
              />
              <Relationships
                title="Packages that depend on it"
                empty="Nothing imports this package."
                listing={data.dependents}
                noun="dependent"
              />
            </div>

            <Limitations limitations={data.limitations} title="Package limitations" />
          </div>
        );
      }}
    </QueryState>
  );
}

function Relationships({
  title,
  empty,
  listing,
  noun,
}: {
  readonly title: string;
  readonly empty: string;
  readonly listing: {
    readonly entries: readonly { readonly name: string; readonly edges: { readonly total: number } }[];
    readonly total: number;
    readonly truncated: boolean;
  };
  readonly noun: string;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {listing.entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {listing.entries.map((entry) => (
              <li key={entry.name} className="flex items-center justify-between gap-3 font-mono text-xs">
                <span className="truncate">{entry.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{count(entry.edges.total)}</span>
              </li>
            ))}
          </ul>
        )}
        <ListingNote listing={listing} noun={noun} />
      </CardContent>
    </Card>
  );
}
