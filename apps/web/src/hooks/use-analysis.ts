'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, NetworkError } from '@/services/api-client';
import { analysisService } from '@/services/analysis-service';
import type { AnalysisJob } from '@/types/api';

/**
 * One repository analysis, followed to completion.
 *
 * The page renders; this owns the submission and the polling. Polling rather than a stream: the payload
 * is a handful of stage rows a second, the server already returns the whole job on every read, and a
 * poll survives a dropped connection without a reconnect protocol. The chat endpoints stream because
 * tokens arrive continuously — stages do not.
 */
export interface UseAnalysis {
  readonly job: AnalysisJob | null;
  /** A submission that never reached the server — a bad URL is reported by the job, not here. */
  readonly submitError: { readonly detail: string; readonly hint: string } | null;
  readonly busy: boolean;
  analyze(url: string): Promise<void>;
  reset(): void;
}

const POLL_MS = 700;

export function useAnalysis(options: { readonly onSucceeded?: (job: AnalysisJob) => void } = {}): UseAnalysis {
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [submitError, setSubmitError] = useState<UseAnalysis['submitError']>(null);
  const [busy, setBusy] = useState(false);

  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  // Held in a ref so the polling loop always calls the current callback without restarting the loop.
  const onSucceeded = useRef(options.onSucceeded);

  onSucceeded.current = options.onSucceeded;

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Leaving the page must stop the polling. The analysis itself continues on the server, which is the
  // point of a job — coming back and following it again is a `GET`.
  useEffect(() => {
    cancelled.current = false;

    return () => {
      cancelled.current = true;
      stop();
    };
  }, [stop]);

  const poll = useCallback(
    (id: string): void => {
      timer.current = setTimeout(() => {
        void (async () => {
          if (cancelled.current) {
            return;
          }

          try {
            const next = await analysisService.get(id);

            if (cancelled.current) {
              return;
            }

            setJob(next);

            if (next.status === 'succeeded' || next.status === 'failed') {
              setBusy(false);

              if (next.status === 'succeeded') {
                /*
                 * The graph has been replaced, so every cached repository answer is about the previous
                 * repository. Clearing rather than invalidating: `staleTime: Infinity` marks these queries
                 * as never going stale on their own, which is true of one immutable graph and false the
                 * moment a new one is written. Removing the entries is what makes the Overview show the
                 * repository just analysed without a reload.
                 */
                client.clear();
                onSucceeded.current?.(next);
              }

              return;
            }

            poll(id);
          } catch (cause) {
            // A poll that fails is not an analysis that failed — the server may simply have blipped.
            // Keep following unless it told us the job is gone.
            if (cause instanceof ApiError && cause.isNotFound) {
              setBusy(false);
              setSubmitError({
                detail: 'The analysis is no longer being tracked.',
                hint: 'Analyses are held in memory and do not survive an API restart. Start a new one.',
              });

              return;
            }

            poll(id);
          }
        })();
      }, POLL_MS);
    },
    [client],
  );

  const analyze = useCallback(
    async (url: string): Promise<void> => {
      if (busy) {
        return;
      }

      stop();
      setSubmitError(null);
      setBusy(true);

      try {
        const started = await analysisService.start(url);

        setJob(started.job);

        // Either way there is a job to follow: a refused submission hands back the one already running.
        if (started.job.status === 'succeeded' || started.job.status === 'failed') {
          setBusy(false);

          if (started.job.status === 'succeeded') {
            client.clear();
            onSucceeded.current?.(started.job);
          }

          return;
        }

        poll(started.job.id);
      } catch (cause) {
        setBusy(false);
        setSubmitError(
          cause instanceof ApiError
            ? { detail: cause.detail, hint: cause.hint }
            : {
                detail: cause instanceof NetworkError ? 'The TraceIQ API could not be reached.' : 'The analysis could not be started.',
                hint: 'Check that the API is running, then try again.',
              },
        );
      }
    },
    [busy, client, poll, stop],
  );

  const reset = useCallback(() => {
    stop();
    setJob(null);
    setSubmitError(null);
    setBusy(false);
  }, [stop]);

  return { job, submitError, busy, analyze, reset };
}
