'use client';

import { AlertTriangle } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';

/**
 * Catches a render error so one broken panel does not blank the application.
 *
 * A class component on purpose: `componentDidCatch` has no hook equivalent, and React's error
 * boundary contract is only available this way.
 */
export class ErrorBoundary extends React.Component<
  { readonly children: React.ReactNode; readonly label?: string },
  { readonly error: Error | null }
> {
  constructor(props: { readonly children: React.ReactNode; readonly label?: string }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  override render(): React.ReactNode {
    const { error } = this.state;

    if (error === null) {
      return this.props.children;
    }

    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {this.props.label ?? 'This section failed to render'}
        </div>
        <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            this.setState({ error: null });
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
}
