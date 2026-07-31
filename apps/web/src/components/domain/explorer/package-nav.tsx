'use client';

import { ChevronDown, ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';

import { ListingNote } from '@/components/domain/listing-note';
import { EmptyState, QueryState } from '@/components/domain/states';
import { Row } from '@/components/domain/trees';
import { ScrollArea } from '@/components/ui/scroll-area';
import { usePackage, usePackages } from '@/hooks/queries';
import { count, filePathOf, pluralise } from '@/lib/format';
import { groupPackages, initialOpenGroups, type PackageGroup } from '@/lib/package-groups';

/**
 * The Explorer's navigation: packages grouped by directory, expanding into their files.
 *
 * Two things distinguish this from a file browser. It does not show everything at once — groups start
 * closed except the one you are in — and choosing a package expands its files *in place*, so the trail
 * from repository to declaration stays visible instead of being split across disconnected panes.
 *
 * Group labels are directories the repository actually has. `package-groups.ts` explains why they are
 * not "Core", "Infrastructure" and the like.
 *
 * Each group is **one** listbox holding package rows and, beneath the open package, its file rows as
 * siblings. Nesting a second listbox inside an option would not be a valid tree for assistive
 * technology; indentation carries the hierarchy visually, and the labels carry it in the accessible name.
 */
export function PackageNav({
  selectedPackage,
  selectedFile,
  onSelectPackage,
  onSelectFile,
  filter,
}: {
  readonly selectedPackage: string | null;
  readonly selectedFile: string | null;
  readonly onSelectPackage: (name: string) => void;
  readonly onSelectFile: (path: string) => void;
  /** Lower-cased text from the search box. Narrows the tree in place rather than replacing it. */
  readonly filter: string;
}) {
  const packages = usePackages();

  return (
    <QueryState
      query={packages}
      loadingRows={8}
      isEmpty={(data) => data.entries.length === 0}
      empty={
        <div className="p-3">
          <EmptyState
            title="This repository derived no packages"
            detail="A package name is the first two segments of a file path, so a flat repository produces none. Everything else in the Explorer still works — search for a file or a declaration above."
          />
        </div>
      }
    >
      {(data) => {
        const groups = groupPackages(data.entries);
        const matching = groups
          .map((group) => ({
            ...group,
            packages: group.packages.filter((entry) => filter === '' || entry.name.toLowerCase().includes(filter)),
          }))
          .filter((group) => group.packages.length > 0);

        if (matching.length === 0) {
          return (
            <div className="p-3">
              <EmptyState
                title={`No package matches “${filter}”`}
                detail="Package names come from file paths — try a directory such as apps or packages. Files and declarations are searched separately, in the results below the box."
              />
            </div>
          );
        }

        return (
          <>
            <ScrollArea className="flex-1">
              <div className="p-1.5">
                {matching.map((group) => (
                  <Group
                    key={group.name}
                    group={group}
                    allGroups={groups}
                    selectedPackage={selectedPackage}
                    selectedFile={selectedFile}
                    onSelectPackage={onSelectPackage}
                    onSelectFile={onSelectFile}
                    filter={filter}
                  />
                ))}
              </div>
            </ScrollArea>
            <ListingNote listing={data} noun="package" />
          </>
        );
      }}
    </QueryState>
  );
}

function Group({
  group,
  allGroups,
  selectedPackage,
  selectedFile,
  onSelectPackage,
  onSelectFile,
  filter,
}: {
  readonly group: PackageGroup;
  readonly allGroups: readonly PackageGroup[];
  readonly selectedPackage: string | null;
  readonly selectedFile: string | null;
  readonly onSelectPackage: (name: string) => void;
  readonly onSelectFile: (path: string) => void;
  readonly filter: string;
}) {
  const [open, setOpen] = useState(() => initialOpenGroups(allGroups, selectedPackage).has(group.name));

  // Following a link to a package must reveal it, even if its group was closed.
  useEffect(() => {
    if (selectedPackage !== null && group.packages.some((entry) => entry.name === selectedPackage)) {
      setOpen(true);
    }
  }, [group.packages, selectedPackage]);

  // A search is an explicit request to see matches, so every group with one opens.
  const expanded = open || filter !== '';

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={expanded}
        // The visible counts read as "apps1 · 3f" when announced. An explicit name spells them out; it
        // still begins with the directory, so the visible label remains the start of the spoken one.
        aria-label={`${group.name}, ${pluralise(group.packages.length, 'package')}, ${pluralise(group.files, 'file')}`}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="truncate text-xs font-semibold">{group.name}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {count(group.packages.length)} · {count(group.files)}f
        </span>
      </button>

      {expanded ? (
        <ul role="listbox" aria-label={`Packages in ${group.name}`} className="mt-0.5 pl-2">
          {group.packages.map((entry) => (
            <Fragment key={entry.name}>
              <Row
                selected={entry.name === selectedPackage && selectedFile === null}
                onSelect={() => {
                  onSelectPackage(entry.name);
                }}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-mono">
                  {entry.name.includes('/') ? entry.name.slice(entry.name.indexOf('/') + 1) : entry.name}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">
                  {count(entry.files)}
                </span>
              </Row>

              {entry.name === selectedPackage ? (
                <PackageFiles
                  packageName={entry.name}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  filter={filter}
                />
              ) : null}
            </Fragment>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The open package's files, as sibling rows inside the group's listbox.
 *
 * Requested only while a package is open, so browsing group headings costs no requests. Non-row states
 * are wrapped in `<li>` because a `<ul>` may contain nothing else.
 */
function PackageFiles({
  packageName,
  selectedFile,
  onSelectFile,
  filter,
}: {
  readonly packageName: string;
  readonly selectedFile: string | null;
  readonly onSelectFile: (path: string) => void;
  readonly filter: string;
}) {
  const view = usePackage(packageName);

  if (view.isPending) {
    return (
      <li className="px-4 py-1.5 text-[11px] text-muted-foreground" role="presentation">
        Loading files…
      </li>
    );
  }

  if (view.error !== null || view.data === undefined) {
    return (
      <li className="px-4 py-1.5 text-[11px] text-muted-foreground" role="presentation">
        This package’s files could not be loaded.
      </li>
    );
  }

  const paths = view.data.files.entries
    .map((node) => filePathOf(node.id))
    .filter((path) => filter === '' || path.toLowerCase().includes(filter));

  if (paths.length === 0) {
    return (
      <li className="px-4 py-1.5 text-[11px] text-muted-foreground" role="presentation">
        {filter === '' ? 'This package holds no files.' : 'No file here matches the search.'}
      </li>
    );
  }

  return (
    <>
      {paths.map((path) => (
        <Row
          key={path}
          selected={path === selectedFile}
          onSelect={() => {
            onSelectFile(path);
          }}
        >
          <span className="ml-3 border-l border-border pl-2" aria-hidden />
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono" title={path}>
            {path.startsWith(`${packageName}/`) ? path.slice(packageName.length + 1) : path}
          </span>
        </Row>
      ))}
    </>
  );
}
