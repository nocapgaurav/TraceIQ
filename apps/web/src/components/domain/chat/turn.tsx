'use client';

import { AlertCircle, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChatTurn } from '@/store/chat-store';
import type { ChatPhase } from '@/types/api';

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

        {turn.text === '' && turn.status === 'streaming' ? <Progress phase={turn.phase} /> : null}

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

        {turn.error === null ? null : <Failure error={turn.error} />}

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
            {/*
              Reported apart from fabricated identifiers, because the two are not equally damning. An
              invented `sym:` has no defence; a package name the answer volunteered may be a real
              dependency the budget did not reach. The heading says which claim it is making.
            */}
            <Fabrications
              identifiers={turn.answer.unsupportedTerms}
              heading="Named, but no fact shown to the model carried it"
            />
            <Citations citations={turn.answer.citations} />
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * What each stage means, in words a reader is waiting on rather than a slug.
 *
 * **The wait these describe is real and was measured.** Prompt evaluation on the reference stack runs
 * at 45.75 tokens per second, so a 4,000-token prompt is 89 seconds during which the only honest thing
 * to show is what is happening. One spinner reading "Reading the repository…" for a minute and a half
 * is indistinguishable from a dead stream, which is what users were reporting.
 */
const PHASE_LABEL: Readonly<Record<ChatPhase, string>> = {
  'acquiring-context': 'Loading the repository graph…',
  // Ranking and prompt assembly happen inside this step and take single-digit milliseconds between
  // them. They are named in the label rather than given phases of their own: a spinner that flickered
  // through three states in 9 ms would be theatre, and the one stage that is genuinely slow is below.
  projecting: 'Ranking repository facts and building the prompt…',
  're-projecting': 'The prompt was too long — selecting less evidence…',
  'awaiting-model': 'The model is reading the facts…',
  generating: 'Writing the answer…',
  verifying: 'Verifying citations…',
};

function Progress({ phase }: { readonly phase: ChatPhase | null }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {phase === null ? 'Working…' : PHASE_LABEL[phase]}
      {phase === 'awaiting-model' ? (
        // The one stage that is slow enough to need explaining. Saying why beats leaving a reader to
        // decide whether it has hung.
        <span className="text-[11px]">a local model reads the whole prompt before it writes anything</span>
      ) : null}
    </p>
  );
}

/**
 * What went wrong, as a sentence rather than a code.
 *
 * **Never blames the reader for infrastructure.** Every code below is something about the deployment —
 * a model that is not running, a proxy that closed a connection, a prompt that could not be made to
 * fit — and the wording says so. The code is still shown, because it is what a bug report needs, but it
 * is no longer the whole message.
 */
const FAILURE_REASON: Readonly<Record<string, string>> = {
  'ai-not-configured': 'This server was started without a language model, so it cannot answer questions.',
  'provider-unavailable': 'The model provider is not reachable. Nothing is listening where the API expects it.',
  'model-not-found': 'The provider does not hold the model this server was configured with.',
  'model-load-failed': 'The provider could not load the model — usually not enough memory.',
  'generation-timeout': 'The model went quiet before it finished. On a local model this usually means the prompt was too large for the hardware.',
  'generation-aborted': 'The answer was cancelled.',
  'stream-interrupted': 'The connection to the model ended before the answer did.',
  'connection-lost': 'The connection closed before the answer finished. This is a proxy or network timeout rather than anything you did.',
  'provider-protocol-error': 'The provider sent something this client could not read. Its version may be unsupported.',
  'budget-not-satisfiable': 'The question leaves no room for evidence in this model’s context window. A shorter question or a narrower subject will fit.',
  'context-window-exceeded': 'The prompt was rejected as too long even after the evidence was cut back.',
  'subject-not-found': 'The repository graph holds nothing matching that subject.',
  network: 'The browser could not reach the API.',
};

function Failure({ error }: { readonly error: { code: string; detail: string; hint: string } }) {
  const reason = FAILURE_REASON[error.code];

  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        {reason ?? 'The answer failed.'}
      </p>
      {/* The server's own wording, kept verbatim: it names the specific thing that was wrong. */}
      <p className="mt-0.5 text-xs">{error.detail}</p>
      {error.hint === '' ? null : <p className="mt-0.5 text-[11px] text-muted-foreground">{error.hint}</p>}
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{error.code}</p>
    </div>
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
