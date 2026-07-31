'use client';

import { AlertTriangle, CheckCircle2, HelpCircle, Info } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { count } from '@/lib/format';
import { linkForNode } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type { ChatAnswer, ChatCitation, ChatGrounding, ChatOmission, ChatVerdict } from '@/types/api';

/**
 * Whether an answer stayed inside the facts it was given.
 *
 * Never softened and never hidden. `unverifiable` is not a pass: it means the answer cited nothing, so there
 * was nothing to check it against — a distinction a reader has to be able to see at a glance.
 */
const VERDICT: Readonly<
  Record<ChatVerdict, { readonly label: string; readonly detail: string; readonly variant: 'default' | 'warning' | 'danger'; readonly Icon: typeof CheckCircle2 }>
> = {
  grounded: {
    label: 'grounded',
    detail: 'every identifier named exists in the graph, and at least one fact was cited',
    variant: 'default',
    Icon: CheckCircle2,
  },
  ungrounded: {
    label: 'ungrounded',
    detail: 'the answer named something the repository does not contain',
    variant: 'danger',
    Icon: AlertTriangle,
  },
  unverifiable: {
    label: 'unverifiable',
    detail: 'nothing was cited, so nothing in this answer could be checked',
    variant: 'warning',
    Icon: HelpCircle,
  },
};

export function GroundingBadge({ verdict }: { readonly verdict: ChatVerdict }) {
  const { label, detail, variant, Icon } = VERDICT[verdict];

  return (
    <Badge variant={variant} title={detail} className="gap-1">
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );
}

/**
 * What the model was shown.
 *
 * Rendered from the first `grounding` frame, which arrives before any prose — so a reader sees the evidence
 * an answer is allowed to rest on before reading the answer.
 */
export function ProjectionSummary({ grounding }: { readonly grounding: ChatGrounding }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>
        <span className="tabular-nums">{count(grounding.factCount)}</span> facts
      </span>
      <span>
        <span className="tabular-nums">{count(grounding.tokens)}</span> tokens
      </span>
      <span>tier {grounding.tier}</span>
      <span className="font-mono" title="identity of the facts that grounded this answer">
        {grounding.digest}
      </span>
      {grounding.subject === null ? null : (
        <span className="truncate font-mono" title={grounding.subject}>
          {grounding.subject}
        </span>
      )}
    </div>
  );
}

/**
 * What a cap left out.
 *
 * The API reports `kept` against an exact `total` precisely so a cap is never silent, and an answer built on
 * forty of nine hundred dependents that did not say so would be a lie by omission. Shown in the same tone
 * as every other warning in the app.
 */
export function OmissionSummary({ omissions }: { readonly omissions: readonly ChatOmission[] }) {
  if (omissions.length === 0) {
    return null;
  }

  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
        <Info className="h-3 w-3" aria-hidden />
        These lists were incomplete when the answer was written
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {omissions.map((omission) => (
          <li key={omission.part} className="text-[11px] text-muted-foreground">
            <span className="font-mono">{omission.part}</span>: showing {count(omission.kept)} of{' '}
            {count(omission.total)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The facts an answer referred to.
 *
 * Each citation carries the whole fact and the capability that established it, so the evidence is readable
 * without a second request. An identifier links to the page that explains it.
 */
export function Citations({ citations }: { readonly citations: readonly ChatCitation[] }) {
  if (citations.length === 0) {
    return null;
  }

  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {count(citations.length)} {citations.length === 1 ? 'fact cited' : 'facts cited'}
      </summary>
      <ul className="border-t border-border">
        {citations.map((citation) => (
          <li key={citation.factId} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 px-2 py-1.5 text-[11px]">
            <span className="font-mono text-primary">[{citation.factId}]</span>
            <Identifier value={citation.subject} />
            <span className="font-medium">{citation.predicate}</span>
            <Identifier value={citation.object} />
            {citation.confidence === 'CERTAIN' ? null : (
              <Badge variant="outline">{citation.confidence.toLowerCase()}</Badge>
            )}
            <span className="ml-auto font-mono text-muted-foreground">{citation.provenance}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** An identifier links to its page; anything else is plain text. */
function Identifier({ value }: { readonly value: string }) {
  const bare = value.replace(/ at depth \d+$/, '');
  const isIdentifier = /^(sym|file|route|env|ext):/.test(bare);

  if (!isIdentifier) {
    return <span className="text-muted-foreground">{value}</span>;
  }

  return (
    <Link
      href={linkForNode(bare)}
      className="font-mono hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {bare}
    </Link>
  );
}

/** Identifiers the answer invented. Named explicitly, because this is the failure that destroys trust. */
export function Fabrications({ identifiers }: { readonly identifiers: readonly string[] }) {
  if (identifiers.length === 0) {
    return null;
  }

  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
        <AlertTriangle className="h-3 w-3" aria-hidden />
        Named, but not present in the repository
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {identifiers.map((identifier) => (
          <li key={identifier} className="font-mono text-[11px] text-muted-foreground">
            {identifier}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Which model answered, why it stopped, and what it cost. */
export function AnswerFooter({ answer, className }: { readonly answer: ChatAnswer; readonly className?: string }) {
  const { promptTokens, outputTokens } = answer.usage;

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground', className)}>
      <span className="font-mono">{answer.model}</span>
      <span>{answer.stopReason}</span>
      {promptTokens === null && outputTokens === null ? null : (
        <span className="tabular-nums">
          {promptTokens ?? '?'} prompt / {outputTokens ?? '?'} output tokens
        </span>
      )}
    </div>
  );
}
