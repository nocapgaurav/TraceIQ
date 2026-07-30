'use client';

import { AlertCircle, DatabaseZap, Inbox, Loader2 } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, NetworkError } from '@/services/api-client';

/**
 * The three states every fetched view can be in.
 *
 * Centralised because they must be *consistent*: a user should recognise "nothing here" and "that
 * failed" instantly on any page, and a page author should not be able to forget one.
 */

export function LoadingState({ label = 'Loading', rows = 3 }: { readonly label?: string; readonly rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function InlineLoading({ label = 'Loading' }: { readonly label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Inbox className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {detail === undefined ? null : <p className="max-w-md text-xs text-muted-foreground">{detail}</p>}
      {children}
    </div>
  );
}

/**
 * A failed request.
 *
 * The API answers with a fixed `code`, a `detail` naming what was wrong and a `hint` saying what to do,
 * so this renders the server's own words rather than inventing a message. `repository-not-scanned` is
 * singled out because it is not a mistake — it means the graph has not been built yet, and the fix is a
 * scan, not a different request.
 */
export function ErrorState({ error, onRetry }: { readonly error: Error; readonly onRetry?: () => void }) {
  if (error instanceof ApiError && error.isNotScanned) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 px-6 py-10 text-center">
        <DatabaseZap className="h-5 w-5 text-warning" aria-hidden />
        <p className="text-sm font-medium">No repository has been scanned</p>
        <p className="max-w-md text-xs text-muted-foreground">{error.hint}</p>
        <p className="font-mono text-xs text-muted-foreground">traceiq scan &lt;path&gt;</p>
      </div>
    );
  }

  const detail = error instanceof ApiError ? error.detail : error.message;
  const hint = error instanceof ApiError ? error.hint : error instanceof NetworkError ? 'check that the TraceIQ API is running' : null;
  const code = error instanceof ApiError ? error.code : error.name;

  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertCircle className="h-4 w-4" aria-hidden />
        <span className="font-mono">{code}</span>
      </div>
      <p className="text-sm">{detail}</p>
      {hint === null ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex gap-2">
        {onRetry === undefined ? null : (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
        {error instanceof ApiError && error.isNotFound ? (
          <Button size="sm" variant="outline" asChild>
            <Link href="/search">Search instead</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The loading/error/empty triad in one call.
 *
 * A page passes a query result and a renderer; it cannot render data while loading or skip the error
 * branch, because the type only hands over `data` once it exists.
 */
export function QueryState<T>({
  query,
  children,
  loadingRows,
  empty,
  isEmpty,
}: {
  readonly query: { readonly data: T | undefined; readonly error: Error | null; readonly isPending: boolean; refetch?: () => void };
  readonly children: (data: T) => React.ReactNode;
  readonly loadingRows?: number;
  readonly empty?: React.ReactNode;
  readonly isEmpty?: (data: T) => boolean;
}) {
  if (query.error !== null) {
    return <ErrorState error={query.error} {...(query.refetch === undefined ? {} : { onRetry: query.refetch })} />;
  }

  if (query.isPending || query.data === undefined) {
    return <LoadingState {...(loadingRows === undefined ? {} : { rows: loadingRows })} />;
  }

  if (isEmpty !== undefined && isEmpty(query.data) && empty !== undefined) {
    return <>{empty}</>;
  }

  return <>{children(query.data)}</>;
}
