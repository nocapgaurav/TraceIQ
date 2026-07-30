'use client';

import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * The route-level error boundary Next requires as a file.
 *
 * The in-tree `ErrorBoundary` catches most render failures; this one exists for the cases React hands to
 * the router instead, so no failure can leave a blank page.
 */
export default function RouteError({ error, reset }: { readonly error: Error; readonly reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        This page failed
      </div>
      <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
      <Button size="sm" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
