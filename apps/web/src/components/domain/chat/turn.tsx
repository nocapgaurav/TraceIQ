'use client';

import { AlertCircle, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChatTurn } from '@/store/chat-store';

import {
  AnswerFooter,
  Citations,
  Fabrications,
  GroundingBadge,
  OmissionSummary,
  ProjectionSummary,
} from './grounding';
import { Markdown } from './markdown';

/**
 * One question and its answer.
 *
 * The order on screen is the order the evidence arrives in: the projection summary and its omissions come
 * from the first `grounding` frame, before any prose, so a reader sees what an answer is permitted to rest on
 * before reading it. The verdict and the citations follow the text, because they describe what was written.
 */
export function Turn({ turn }: { readonly turn: ChatTurn }) {
  return (
    <article className="flex flex-col gap-3" aria-busy={turn.status === 'streaming'}>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-lg rounded-br-sm bg-secondary px-3 py-2 text-sm text-secondary-foreground">
          {turn.question}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {turn.grounding === null ? null : (
          <>
            <ProjectionSummary grounding={turn.grounding} />
            <OmissionSummary omissions={turn.grounding.omissions} />
          </>
        )}

        {turn.text === '' && turn.status === 'streaming' ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Reading the repository…
          </p>
        ) : null}

        {turn.text === '' ? null : (
          <div className="rounded-lg border border-border bg-card p-3">
            <Markdown source={turn.text} />
            {turn.status === 'streaming' ? (
              // A caret while tokens are arriving, so a pause reads as "still working" rather than "finished".
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground align-middle" aria-hidden />
            ) : null}
          </div>
        )}

        {turn.status === 'cancelled' ? (
          <p className="text-[11px] text-warning">Stopped. What arrived before you stopped is above.</p>
        ) : null}

        {turn.error === null ? null : (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertCircle className="h-3.5 w-3.5" aria-hidden />
              <span className="font-mono">{turn.error.code}</span>
            </p>
            <p className="mt-0.5 text-xs">{turn.error.detail}</p>
            {turn.error.hint === '' ? null : (
              <p className="mt-0.5 text-[11px] text-muted-foreground">{turn.error.hint}</p>
            )}
          </div>
        )}

        {turn.answer === null ? null : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <GroundingBadge verdict={turn.answer.verdict} />
              {turn.answer.unknownCitations.length > 0 ? (
                <Badge variant="danger" title="cited a fact id that was never shown to the model">
                  {turn.answer.unknownCitations.length} unknown citation
                  {turn.answer.unknownCitations.length === 1 ? '' : 's'}
                </Badge>
              ) : null}
              <AnswerFooter answer={turn.answer} className="ml-auto" />
            </div>

            <Fabrications identifiers={turn.answer.fabricatedIdentifiers} />
            <Citations citations={turn.answer.citations} />
          </div>
        )}
      </div>
    </article>
  );
}

/** The empty conversation. Says what this can answer, rather than sitting blank. */
export function EmptyConversation({ subject }: { readonly subject: string }) {
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center')}>
      <p className="text-sm font-medium">Ask about {subject}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Every answer is grounded in facts assembled from the repository graph, cites the facts it used, and
        says what was left out. No source code is available to the model — only relationships, counts and the
        limitations of the analysis.
      </p>
    </div>
  );
}
