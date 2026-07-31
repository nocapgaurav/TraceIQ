'use client';

import { AlertCircle, Check, Circle, Loader2, MinusCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AnalysisStage } from '@/types/api';

/**
 * The stages of a running analysis.
 *
 * **No percentage, and no bar.** The server reports which stage it is on, because that is what it can
 * observe: a clone and a scan give no measurable fraction, and a bar filling at an invented rate would
 * be a lie told smoothly. A row is pending, running, done, failed or skipped — nothing else is claimed.
 *
 * `detail` is shown only once a stage has produced something, so a row never previews an outcome it has
 * not reached.
 */
export function StageList({ stages, elapsedMs }: { readonly stages: readonly AnalysisStage[]; readonly elapsedMs: number }) {
  return (
    <div>
      <ol className="flex flex-col gap-0.5" aria-label="Analysis stages">
        {stages.map((stage) => (
          <li
            key={stage.name}
            className={cn(
              'flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
              stage.status === 'active' ? 'bg-secondary/60' : undefined,
            )}
          >
            <StageIcon status={stage.status} />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block',
                  stage.status === 'pending' || stage.status === 'skipped' ? 'text-muted-foreground' : undefined,
                  stage.status === 'failed' ? 'text-destructive' : undefined,
                  stage.status === 'active' ? 'font-medium' : undefined,
                )}
              >
                {stage.label}
              </span>
              {stage.detail === null ? null : (
                <span className="mt-0.5 block break-words text-[11px] leading-relaxed text-muted-foreground">
                  {stage.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>

      {/* Elapsed, not remaining. How long it has taken is measurable; how long is left is not. */}
      <p className="mt-2 px-2 text-[11px] tabular-nums text-muted-foreground">
        {(elapsedMs / 1000).toFixed(0)}s elapsed
      </p>
    </div>
  );
}

/** Each status gets its own shape as well as its own colour, so the state survives a monochrome display. */
function StageIcon({ status }: { readonly status: AnalysisStage['status'] }) {
  const label = `stage ${status}`;

  if (status === 'done') {
    return <Check aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
  }

  if (status === 'active') {
    return <Loader2 aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
  }

  if (status === 'failed') {
    return <AlertCircle aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  }

  if (status === 'skipped') {
    return <MinusCircle aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />;
  }

  return <Circle aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />;
}
