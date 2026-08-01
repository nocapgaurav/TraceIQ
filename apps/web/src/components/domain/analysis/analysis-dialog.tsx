'use client';

import { AlertCircle, ArrowRight, Github, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { StageList } from '@/components/domain/analysis/stage-list';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAnalysis } from '@/hooks/use-analysis';
import { count } from '@/lib/format';
import { routes } from '@/lib/routes';

/**
 * Repository Analysis: a GitHub URL in, the Repository Overview out.
 *
 * Three states in one dialog — a form, a running analysis, a failure — because they are one continuous
 * act from the reader's point of view. Success is not a fourth state: it navigates.
 *
 * Validation is the server's. The box refuses only what it can refuse without guessing (an empty value),
 * because the URL rules live in `@traceiq/analysis` and a second copy here would drift from them. The
 * cost of a round trip on a bad URL is a few milliseconds, and the message comes back better than one
 * this component could invent.
 */
/**
 * Repositories offered as a starting point.
 *
 * **One per language TraceIQ analyses semantically, and that is the point of the list.** All three
 * used to be TypeScript or JavaScript, which told a reader looking for somewhere to start that those
 * were the languages the product handles — the same TypeScript-only impression the Overview used to
 * give, in the one place a first-time visitor actually looks.
 *
 * Each is small enough to finish while somebody watches, and each reaches `framework` or `semantic`
 * depth, so whichever a reader picks the result is a real analysis rather than a file listing.
 */
const EXAMPLES = [
  'facebook/react',
  'pallets/flask',
  'spring-projects/spring-petclinic',
  'gin-gonic/gin',
] as const;

export function AnalysisDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [url, setUrl] = useState('');

  const analysis = useAnalysis({
    onSucceeded: () => {
      // Straight to the Overview. The hook has already cleared the cached repository answers, so the page
      // it lands on describes the repository just analysed rather than the previous one.
      onOpenChange(false);
      router.push(routes.dashboard());
    },
  });

  // Reopening after a failure should offer a fresh form, not the previous failure.
  useEffect(() => {
    if (!open) {
      analysis.reset();
    }
    // `analysis.reset` is stable; depending on the whole object would reset on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (value: string): void => {
    const trimmed = value.trim();

    if (trimmed === '' || analysis.busy) {
      return;
    }

    void analysis.analyze(trimmed);
  };

  const failure = analysis.job?.status === 'failed' ? analysis.job.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-analysis is allowed: the work continues on the server, which is the point of a job.
        onOpenChange(next);
      }}
    >
      <DialogContent className="p-0">
        <div className="border-b border-border p-5">
          <div className="flex items-center gap-2">
            <Github className="h-4 w-4 text-muted-foreground" aria-hidden />
            <DialogTitle className="text-base font-semibold">Analyze a repository</DialogTitle>
          </div>
          <DialogDescription className="mt-1.5 text-sm text-muted-foreground">
            Paste a public GitHub repository. TraceIQ clones it, analyses it with the same static analysis
            it runs everywhere else, and opens the result.
          </DialogDescription>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              submit(url);
            }}
          >
            <Input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              // Disabled while running: one analysis replaces the whole graph, so a second submission
              // cannot be honoured, and an input that accepts one would imply it could.
              disabled={analysis.busy}
              aria-label="GitHub repository URL"
              placeholder="https://github.com/facebook/react"
              className="h-10 flex-1 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={analysis.busy || url.trim() === ''} className="h-10 px-5">
              {analysis.busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Analyzing
                </>
              ) : (
                <>
                  Analyze Repository
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </form>

          {analysis.job === null && analysis.submitError === null ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>Try:</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setUrl(`https://github.com/${example}`);
                  }}
                  className="rounded-full border border-border px-2 py-0.5 font-mono transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {example}
                </button>
              ))}
            </div>
          ) : null}

          {/* A submission that never reached the server. Distinct from an analysis that ran and failed. */}
          {analysis.submitError === null ? null : (
            <Problem detail={analysis.submitError.detail} hint={analysis.submitError.hint} />
          )}

          {analysis.job === null ? null : (
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              {analysis.job.slug === null ? null : (
                <p className="mb-2 px-2 font-mono text-xs font-medium">{analysis.job.slug}</p>
              )}
              <StageList stages={analysis.job.stages} elapsedMs={analysis.job.elapsedMs} />
            </div>
          )}

          {failure === null ? null : <Problem detail={failure.detail} hint={failure.hint} code={failure.code} />}

          {analysis.job?.workspaceWarning === null || analysis.job?.workspaceWarning === undefined ? null : (
            <p className="text-[11px] text-warning">
              The analysis finished, but its temporary workspace could not be removed:{' '}
              {analysis.job.workspaceWarning}
            </p>
          )}

          {analysis.job?.result === null || analysis.job?.result === undefined ? null : (
            <div className="flex flex-col gap-1">
              <p className="text-[11px] text-muted-foreground">
                {count(analysis.job.result.files)} files, {count(analysis.job.result.declarations)} declarations
                and {count(analysis.job.result.edges)} relationships.
              </p>
              {/* Without this, a Python or Go repository reported its declarations beside zero routes and
                  zero packages with nothing saying what it was written in — which reads as "found
                  nothing" rather than "found a different set of things". */}
              {analysis.job.result.languages.length === 0 ? null : (
                <p className="text-[11px] text-muted-foreground">
                  {analysis.job.result.languages
                    .slice(0, 4)
                    .map((entry) => `${entry.language} (${count(entry.files)})`)
                    .join(', ')}
                  {analysis.job.result.isPolyglot ? ' — polyglot' : ''} · analysed to{' '}
                  {analysis.job.result.depth} depth across {count(analysis.job.result.regions)}{' '}
                  {analysis.job.result.regions === 1 ? 'region' : 'regions'}.
                </p>
              )}
              {analysis.job.result.analyzerFailures.length === 0 ? null : (
                <p className="text-[11px] text-warning">
                  {analysis.job.result.analyzerFailures
                    .map((entry) => `the ${entry.analyzer} analyser failed: ${entry.failure}`)
                    .join('; ')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-4">
          <p className="text-[11px] text-muted-foreground">
            Public repositories only. Nothing is written to the repository, and the clone is deleted
            afterwards.
          </p>
          {analysis.busy ? (
            <p className="shrink-0 text-[11px] text-muted-foreground">You can close this — it keeps running.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A failure, in the API's own words.
 *
 * `detail` and `hint` come from the server, which knows what went wrong; nothing is reworded here. The
 * code is shown because it is the thing worth quoting in a bug report.
 */
function Problem({
  detail,
  hint,
  code,
}: {
  readonly detail: string;
  readonly hint: string;
  readonly code?: string;
}) {
  return (
    <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        {code === undefined ? 'That did not work' : <span className="font-mono text-xs">{code}</span>}
      </div>
      <p className="text-sm">{detail}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
