import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApiError, NetworkError } from '@/services/api-client';

import { EmptyState, ErrorState, LoadingState, QueryState } from './states';

/**
 * Loading, empty and error, which the milestone requires on every page.
 *
 * The interesting assertions are the accessible ones: a loading region announces itself, and an error is
 * an `alert` carrying the server's own code and hint rather than a message this app invented.
 */
describe('LoadingState', () => {
  it('announces itself as a busy status region', () => {
    render(<LoadingState label="Loading overview" />);

    const status = screen.getByRole('status');

    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Loading overview')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('states the title and the explanation', () => {
    render(<EmptyState title="No packages" detail="Package names come from file paths." />);

    expect(screen.getByText('No packages')).toBeInTheDocument();
    expect(screen.getByText('Package names come from file paths.')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('shows the API code, detail and hint, not an invented message', () => {
    const error = new ApiError({
      code: 'unknown-identifier',
      detail: "the graph holds nothing named 'sym:x.ts#Y'",
      hint: 'use GET /search?q= to find an identifier',
      status: 404,
    });

    render(<ErrorState error={error} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('unknown-identifier')).toBeInTheDocument();
    expect(screen.getByText("the graph holds nothing named 'sym:x.ts#Y'")).toBeInTheDocument();
    expect(screen.getByText('use GET /search?q= to find an identifier')).toBeInTheDocument();
  });

  it('offers a search escape hatch for a 404', () => {
    const error = new ApiError({ code: 'unknown-identifier', detail: 'no', hint: 'search', status: 404 });

    render(<ErrorState error={error} />);

    expect(screen.getByRole('link', { name: 'Search instead' })).toHaveAttribute('href', '/search');
  });

  it('treats a not-scanned repository as a state to fix, not a failed request', () => {
    const error = new ApiError({
      code: 'repository-not-scanned',
      detail: 'no graph has been built',
      hint: 'run traceiq scan <path> first',
      status: 409,
    });

    render(<ErrorState error={error} />);

    expect(screen.getByText('No repository has been scanned')).toBeInTheDocument();
    expect(screen.getByText('traceiq scan <path>')).toBeInTheDocument();
    // Not a 404, so no "search instead" — searching would fail the same way.
    expect(screen.queryByRole('link', { name: 'Search instead' })).not.toBeInTheDocument();
  });

  it('tells the user the API may be down when nothing was reached', () => {
    render(<ErrorState error={new NetworkError(new Error('connect ECONNREFUSED'))} />);

    expect(screen.getByText('check that the TraceIQ API is running')).toBeInTheDocument();
  });

  it('offers a retry only when one was given', () => {
    const error = new ApiError({ code: 'bad-request', detail: 'no', hint: 'fix it', status: 400 });

    const { rerender } = render(<ErrorState error={error} />);

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    rerender(<ErrorState error={error} onRetry={() => {}} />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('QueryState', () => {
  const pending = { data: undefined, error: null, isPending: true };

  it('shows loading before data arrives', () => {
    render(<QueryState query={pending}>{() => <p>content</p>}</QueryState>);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('shows the error branch instead of the data branch', () => {
    const error = new ApiError({ code: 'not-found', detail: 'gone', hint: 'try again', status: 404 });

    render(
      <QueryState query={{ data: undefined, error, isPending: false }}>{() => <p>content</p>}</QueryState>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('prefers the error branch even when stale data is present', () => {
    const error = new ApiError({ code: 'not-found', detail: 'gone', hint: 'try again', status: 404 });

    render(<QueryState query={{ data: { a: 1 }, error, isPending: false }}>{() => <p>content</p>}</QueryState>);

    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('renders the empty branch when the data is empty', () => {
    render(
      <QueryState
        query={{ data: [], error: null, isPending: false }}
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState title="Nothing here" />}
      >
        {() => <p>content</p>}
      </QueryState>,
    );

    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders the data once it exists', () => {
    render(<QueryState query={{ data: { files: 3 }, error: null, isPending: false }}>{(data) => <p>{data.files}</p>}</QueryState>);

    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
