'use client';

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { filePathOf, symbolName } from '@/lib/format';
import { linkForNode } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type { Confidence, GraphNode, NodeKind } from '@/types/api';

/**
 * A node's kind. Colour is a *hint*, never the only signal — the kind is always written out too, so the
 * distinction survives a monochrome display and colour-blind vision.
 */
const KIND_TONE: Readonly<Record<string, string>> = {
  File: 'text-sky-600 dark:text-sky-400',
  Class: 'text-violet-600 dark:text-violet-400',
  Interface: 'text-teal-600 dark:text-teal-400',
  TypeAlias: 'text-teal-600 dark:text-teal-400',
  Enum: 'text-amber-600 dark:text-amber-400',
  EnumMember: 'text-amber-600 dark:text-amber-400',
  Function: 'text-emerald-600 dark:text-emerald-400',
  Method: 'text-emerald-600 dark:text-emerald-400',
  Accessor: 'text-emerald-600 dark:text-emerald-400',
  Constructor: 'text-emerald-600 dark:text-emerald-400',
  Property: 'text-slate-600 dark:text-slate-400',
  Variable: 'text-slate-600 dark:text-slate-400',
  Namespace: 'text-slate-600 dark:text-slate-400',
  Route: 'text-rose-600 dark:text-rose-400',
  EnvironmentVariable: 'text-orange-600 dark:text-orange-400',
  External: 'text-zinc-500 dark:text-zinc-400',
};

export function KindLabel({ kind, className }: { readonly kind: NodeKind | string; readonly className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-[10px] uppercase tracking-wider',
        KIND_TONE[kind] ?? 'text-muted-foreground',
        className,
      )}
    >
      {kind}
    </span>
  );
}

/**
 * Confidence, as the graph's own four-level vocabulary.
 *
 * There is no numeric score anywhere in TraceIQ, so none is shown. `CERTAIN` is left unlabelled: it is
 * the common case, and badging every row would drown the two that matter.
 */
export function ConfidenceBadge({ confidence }: { readonly confidence: Confidence }) {
  if (confidence === 'CERTAIN') {
    return null;
  }

  const variant = confidence === 'AMBIGUOUS' ? 'warning' : confidence === 'INFERRED' ? 'secondary' : 'outline';

  return (
    <Badge variant={variant} title={`confidence: ${confidence}`}>
      {confidence.toLowerCase()}
    </Badge>
  );
}

/** A node as a link, with its kind, where it lives, and whether it is exported. */
export function NodePill({
  node,
  showPath = true,
  className,
}: {
  readonly node: GraphNode;
  readonly showPath?: boolean;
  readonly className?: string;
}) {
  const path = node.kind === 'File' ? null : node.fileId === null ? null : filePathOf(node.fileId);

  return (
    <Link
      href={linkForNode(node.id)}
      className={cn(
        'group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <KindLabel kind={node.kind} className="w-24 shrink-0 text-right" />
      <span className="truncate font-mono text-xs group-hover:underline">
        {node.kind === 'File' ? filePathOf(node.id) : symbolName(node.id)}
      </span>
      {node.isExported ? <Badge variant="outline">export</Badge> : null}
      <ConfidenceBadge confidence={node.confidence} />
      {showPath && path !== null ? (
        <span className="ml-auto hidden truncate pl-3 text-[11px] text-muted-foreground lg:block">{path}</span>
      ) : null}
    </Link>
  );
}

/** A named reference with no node behind it — the API returns `null` where a target is unresolved. */
export function UnresolvedPill({ text, reason }: { readonly text: string; readonly reason: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <KindLabel kind="unresolved" className="w-24 shrink-0 text-right" />
      <span className="truncate font-mono text-xs text-muted-foreground">{text}</span>
      <Badge variant="warning">{reason}</Badge>
    </div>
  );
}
