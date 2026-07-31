'use client';

import { ArrowRight, Boxes, FileCode2, MousePointerClick, Target } from 'lucide-react';

import { KindLabel } from '@/components/domain/node-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count } from '@/lib/format';
import { groupPackages } from '@/lib/package-groups';
import { usePackages } from '@/hooks/queries';

/**
 * The centre panel with nothing selected.
 *
 * Not an empty state — a starting point. It says what the Explorer holds, shows the route a reader will
 * take through it, and offers real packages from this repository to start with. An "Nothing selected"
 * placeholder would waste the largest area on the page at the exact moment a newcomer needs direction.
 *
 * Every example is drawn from the loaded graph. Where the graph is empty the guidance stays, because the
 * explanation of what a package is does not depend on there being one.
 */
export function ExplorerWelcome({ onSelectPackage }: { readonly onSelectPackage: (name: string) => void }) {
  const packages = usePackages();
  const groups = packages.data === undefined ? [] : groupPackages(packages.data.entries);
  // The biggest package of each of the first few groups: a spread across the repository rather than the
  // three largest, which in a monorepo are often siblings.
  const suggestions = groups
    .slice(0, 3)
    .map((group) => [...group.packages].sort((left, right) => right.declarations - left.declarations)[0])
    .filter((entry) => entry !== undefined);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Repository Explorer</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Choose a package to inspect. The Explorer walks the repository the way its structure is
          recorded — packages hold files, files hold declarations, and every one of them carries the
          relationships the analysis resolved around it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Step icon={Boxes} step="1" title="Pick a package" detail="Grouped by directory on the left. Counts are files." />
        <Step icon={FileCode2} step="2" title="Open a file" detail="Its declarations, imports and exports, as recorded." />
        <Step icon={Target} step="3" title="Select a declaration" detail="Callers, callees and references — then trace the impact." />
      </div>

      {suggestions.length === 0 ? null : (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <MousePointerClick className="h-4 w-4 text-muted-foreground" aria-hidden />
              <CardTitle>Start here</CardTitle>
            </div>
            <p className="text-[11px] font-normal text-muted-foreground">
              The largest package in each part of this repository.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {suggestions.map((entry) => (
              <button
                key={entry.name}
                type="button"
                onClick={() => {
                  onSelectPackage(entry.name);
                }}
                aria-label={`Open ${entry.name}`}
                className="group flex items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate font-mono text-xs">{entry.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                  {count(entry.files)} files · {count(entry.declarations)} declarations
                  <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What you can find</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            A repository graph records sixteen kinds of declaration. A file panel lists the ones it
            declares, grouped by kind:
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {(['Class', 'Interface', 'Function', 'Method', 'TypeAlias', 'Variable', 'Route', 'EnvironmentVariable'] as const).map(
              (kind) => (
                <KindLabel key={kind} kind={kind} />
              ),
            )}
          </div>
          <p>
            Selecting one shows what calls it, what it calls, and every reference to it — the same facts
            Impact uses to work out what a change would reach.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({
  icon: Icon,
  step,
  title,
  detail,
}: {
  readonly icon: React.ComponentType<{ readonly className?: string }>;
  readonly step: string;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span aria-hidden className="font-mono text-lg font-semibold leading-none text-border">
          {step}
        </span>
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}
