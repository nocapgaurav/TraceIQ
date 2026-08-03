'use client';

import { AlertTriangle, CheckCircle2, HelpCircle, Info } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { count } from '@/lib/format';
import { linkForNode } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type {
  ChatAnswer,
  ChatCitation,
  ChatDiagnostic,
  ChatGrounding,
  ChatRecovery,
  ChatStatus,
} from '@/types/api';

/**
 * What the reader is being shown, and how it got here.
 *
 * **Never softened and never hidden, and there is no `ungrounded`.** An answer whose claims the facts do
 * not license has had them removed before it reaches this component, so the badge that used to say
 * "ungrounded" beside a page of unsupported prose has nothing left to describe. What replaces it is
 * `limited evidence`: the same honesty, about an answer a reader can actually trust every sentence of.
 *
 * `unverifiable` is still not a pass — it means the answer cited nothing, so there was nothing to check.
 */
const STATUS: Readonly<
  Record<
    ChatStatus,
    {
      readonly label: string;
      readonly detail: string;
      readonly variant: 'default' | 'warning' | 'danger';
      readonly Icon: typeof CheckCircle2;
    }
  >
> = {
  grounded: {
    label: 'Grounded',
    detail: 'every identifier named exists in the graph, and every claim is cited',
    variant: 'default',
    Icon: CheckCircle2,
  },
  'grounded-after-recovery': {
    label: 'Grounded after evidence recovery',
    detail:
      'the first answer made a claim the evidence did not establish; more evidence of that kind was retrieved and the answer verified',
    variant: 'default',
    Icon: CheckCircle2,
  },
  'limited-evidence': {
    label: 'Limited evidence',
    detail: 'statements the repository graph does not establish were removed; what is shown is what it does establish',
    variant: 'warning',
    Icon: AlertTriangle,
  },
  unverifiable: {
    label: 'Unverifiable',
    detail: 'nothing was cited, so nothing in this answer could be checked',
    variant: 'warning',
    Icon: HelpCircle,
  },
};

export function GroundingBadge({ status }: { readonly status: ChatStatus }) {
  const { label, detail, variant, Icon } = STATUS[status];

  return (
    <Badge variant={variant} title={detail} className="gap-1">
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );
}

/**
 * What the model was shown, and what was left out of it.
 *
 * **One collapsed control rather than a summary line plus a warning panel.** The panel it replaces was a
 * full-width amber box headed "These lists were incomplete when the answer was written", listing every
 * capped fact family — and it appeared above *every* answer, because on any repository worth asking about
 * something is always capped. It was the largest, brightest element in a normal conversation, and what it
 * was reporting is a routine property of a bounded budget rather than a problem with the answer. A reader
 * came to ignore it, which is the worst possible state for a warning to be in.
 *
 * Nothing is removed: every figure the panel carried is inside, plus the retrieval detail it never had.
 * What changes is that a normal conversation shows the question, the answer, its status and its citations,
 * and the diagnostics are one click away for the reader who wants them.
 */
export function RetrievalDetails({
  grounding,
  recovery,
}: {
  readonly grounding: ChatGrounding;
  readonly recovery?: ChatRecovery | null;
}) {
  const { promptTokens, omissions } = grounding;

  return (
    <details className="rounded-md border border-border">
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Info className="h-3 w-3" aria-hidden />
        <span className="font-medium">Retrieval details</span>
        <span className="text-muted-foreground/70">
          <span className="tabular-nums">{count(grounding.factCount)}</span> facts ·{' '}
          <span className="tabular-nums">{count(grounding.tokens)}</span> tokens · tier {grounding.tier}
          {grounding.intent === 'overview' ? '' : ` · reading for ${grounding.intent}`}
        </span>
        {/*
          Recovery is mentioned in the summary rather than only inside, because it is the one thing here
          that describes *this* answer rather than the budget: it is why the answer took twice as long.
        */}
        {recovery ? (
          <span className="text-muted-foreground/70">· additional evidence retrieved</span>
        ) : null}
      </summary>

      <div className="flex flex-col gap-2 border-t border-border px-2 py-2 text-[11px] text-muted-foreground">
        <p>
          <span className="tabular-nums">{count(grounding.coreCount)}</span> of the facts are the repository
          core, shown to the model for every question; the rest were selected for this one.
          {promptTokens === null
            ? null
            : ` The whole prompt was ${count(promptTokens.total)} tokens — instructions ${count(
                promptTokens.system + promptTokens.reminder,
              )}, repository core ${count(promptTokens.core)}, selected for this question ${count(
                promptTokens.supplement,
              )}, question ${count(promptTokens.question)}.`}
        </p>

        {recovery ? (
          <p>
            Verification rejected part of the first answer, so the evidence was reselected around{' '}
            <span className="font-mono">{recovery.parts.join(', ')}</span> — {count(recovery.addedFacts)} facts
            the first attempt did not have, for {recovery.addedTokens >= 0 ? '+' : ''}
            {count(recovery.addedTokens)} tokens.
            {recovery.removedStatements > 0
              ? ` ${count(recovery.removedStatements)} statement${
                  recovery.removedStatements === 1 ? '' : 's'
                } the facts still did not establish ${recovery.removedStatements === 1 ? 'was' : 'were'} removed.`
              : ''}
          </p>
        ) : null}

        {omissions.length === 0 ? null : (
          <div>
            <p className="font-medium text-foreground">Capped by the budget — these lists are incomplete</p>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {omissions.map((omission) => (
                <li key={omission.part}>
                  <span className="font-mono">{omission.part}</span>: showing {count(omission.kept)} of{' '}
                  {count(omission.total)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="flex flex-wrap gap-x-3">
          <span className="font-mono" title="identity of the facts that grounded this answer">
            {grounding.digest}
          </span>
          {grounding.subject === null ? null : (
            <span className="truncate font-mono" title={grounding.subject}>
              {grounding.subject}
            </span>
          )}
        </p>
      </div>
    </details>
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
/**
 * Why an answer was not accepted, rather than only what was rejected.
 *
 * **Replaces two bare lists with the reasoning behind them.** The lists said `ModalDialog.js` was a
 * name no fact carried; they could not say that the file's full path was in the facts and the model
 * had used its basename — which was the actual truth, and a bug in the verifier rather than in the
 * answer. A reader looking at a red badge needs to be able to tell those apart without re-deriving the
 * projection by hand.
 */
export function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ChatDiagnostic[] }) {
  const reportable = diagnostics.filter((entry) => entry.kind !== 'no-citations');

  if (reportable.length === 0) {
    return null;
  }

  /*
   * Collapsed, and the heading now says what *happened* rather than what failed.
   *
   * These are statements the pipeline removed, so the reader is not being warned about text in front of
   * them — they are being told why the answer is shorter than it might have been. That is worth one line
   * and a disclosure triangle, not a red panel: an alert about content that is no longer on screen reads
   * as an alert about the content that is.
   */
  return (
    <details className="rounded-md border border-warning/40 bg-warning/5">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <AlertTriangle className="h-3 w-3" aria-hidden />
        {reportable.length} statement{reportable.length === 1 ? '' : 's'} the facts do not establish{' '}
        {reportable.length === 1 ? 'was' : 'were'} removed
      </summary>
      <ul className="flex flex-col gap-1.5 border-t border-warning/40 px-2 py-2">
        {reportable.map((entry) => (
          <li key={`${entry.kind}:${entry.subject}`} className="text-[11px]">
            <span className="font-mono text-foreground">{entry.subject}</span>
            <span className="text-muted-foreground"> — {entry.detail}</span>
            {entry.nearest.length === 0 ? null : (
              <span className="text-muted-foreground">
                {' '}
                Closest the facts did carry:{' '}
                <span className="font-mono">{entry.nearest.join(', ')}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
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
