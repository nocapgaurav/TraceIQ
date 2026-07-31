'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count, filePathOf } from '@/lib/format';
import type { AffectedNode } from '@/types/api';

/**
 * How far a change would reach: declarations, files and packages.
 *
 * The API answers in declarations. Files and packages are the same answer regrouped — each affected
 * declaration carries the file it was declared in, and a package is that path's first two segments, which
 * is exactly how the API derives package names itself. No second request and no new analysis; this is the
 * returned set, counted three ways.
 *
 * **Scope is stated, not graded.** "12 declarations across 5 files in 2 packages" is a measurement. A
 * label like "medium risk" would be a judgement the graph cannot support, and there is no score anywhere
 * in TraceIQ.
 */
export function ChangeScope({
  direct,
  indirect,
  unknown,
}: {
  readonly direct: readonly AffectedNode[];
  readonly indirect: readonly AffectedNode[];
  readonly unknown: number;
}) {
  const affected = [...direct, ...indirect];
  const files = new Set<string>();
  const packages = new Set<string>();

  for (const entry of affected) {
    /*
     * A `File` node **is** a file, and carries `fileId: null`.
     *
     * Reading `fileId` alone undercounts badly: an impact set is often mostly files — the importers of
     * the target — and every one of them was being skipped. Browser-checked against a real repository,
     * where 42 affected nodes reported as spanning one file.
     */
    const source = entry.node.kind === 'File' ? entry.node.id : entry.node.fileId;

    if (source === null) {
      continue;
    }

    const path = filePathOf(source);

    files.add(path);

    const segments = path.split('/');

    if (segments.length >= 2) {
      packages.add(segments.slice(0, 2).join('/'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change scope</CardTitle>
        <p className="text-[11px] font-normal text-muted-foreground">
          How widely the affected declarations are spread.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          <Figure label="Declarations" value={affected.length} detail="direct and indirect" />
          <Figure label="Files" value={files.size} detail="declaring them" />
          <Figure label="Packages" value={packages.size} detail="containing those files" />
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {affected.length === 0
            ? 'Nothing was recorded as reaching this declaration. That may mean it is genuinely unused, or that the relationships to it could not be resolved — the two are not distinguishable here.'
            : `A change here could reach ${plural(affected.length, 'declaration')} across ${plural(files.size, 'file')} in ${plural(packages.size, 'package')}.`}
          {unknown > 0
            ? ` A further ${plural(unknown, 'call')} could not be bound to a declaration, so this is a lower bound.`
            : ''}
        </p>
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: number;
  readonly detail: string;
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{count(value)}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function plural(value: number, singular: string): string {
  return `${count(value)} ${singular}${value === 1 ? '' : 's'}`;
}
