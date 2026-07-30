import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEARCH } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';

import SearchPage from './search/page';

/**
 * The Search page.
 *
 * Two things are worth guarding: that an empty box makes no request — the API requires a non-empty `q`
 * and would answer 400 — and that filters reach the query string rather than being applied client-side,
 * which would silently disagree with the reported totals.
 */
const params = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => params.current,
}));

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  params.current = new URLSearchParams();
});

describe('Search page', () => {
  it('asks for nothing until something is typed', () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);

    expect(screen.getByText('Type to search')).toBeInTheDocument();
    expect(stub.calls).toEqual([]);
  });

  it('runs the query carried in the URL, with the default match mode stated explicitly', async () => {
    params.current = new URLSearchParams({ q: 'find' });
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);

    await waitFor(() => {
      // The page always sends `match`, rather than relying on the API's default, so the mode shown in
      // the UI and the mode used by the server cannot drift apart.
      expect(stub?.calls[0]).toBe('/api/search?q=find&match=prefix');
    });
  });

  it('groups results and reports each group’s true total', async () => {
    params.current = new URLSearchParams({ q: 'find' });
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);

    expect(await screen.findByText('Declarations')).toBeInTheDocument();
    expect(screen.getByText('(3)')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('4 results · prefix matching')).toBeInTheDocument();
  });

  it('hides a group with no results rather than showing an empty card', async () => {
    params.current = new URLSearchParams({ q: 'find' });
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);
    await screen.findByText('Declarations');

    expect(screen.queryByText('Routes')).not.toBeInTheDocument();
  });

  it('sends the kind filter to the API instead of filtering locally', async () => {
    params.current = new URLSearchParams({ q: 'find' });
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);
    await screen.findByText('Declarations');

    await userEvent.click(screen.getByRole('button', { name: 'Methods' }));

    await waitFor(() => {
      expect(stub?.calls.some((call) => call.includes('kind=Method'))).toBe(true);
    });
  });

  it('sends the match mode to the API', async () => {
    params.current = new URLSearchParams({ q: 'find' });
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);
    await screen.findByText('Declarations');

    await userEvent.click(screen.getByRole('button', { name: 'exact' }));

    await waitFor(() => {
      expect(stub?.calls.some((call) => call.includes('match=exact'))).toBe(true);
    });
  });

  it('marks the active filter with aria-pressed, so it is announced', async () => {
    params.current = new URLSearchParams({ q: 'find' });
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<SearchPage />);

    expect(screen.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Methods' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says nothing matched, and suggests what to change', async () => {
    params.current = new URLSearchParams({ q: 'zzzz' });
    stub = stubFetch([
      {
        path: '/search',
        data: {
          ...SEARCH,
          total: 0,
          declarations: { entries: [], total: 0, truncated: false },
          files: { entries: [], total: 0, truncated: false },
        },
      },
    ]);

    renderWithQuery(<SearchPage />);

    expect(await screen.findByText('Nothing matches “zzzz”')).toBeInTheDocument();
    expect(screen.getByText('Try a shorter prefix.')).toBeInTheDocument();
  });

  it('is a labelled search landmark', () => {
    stub = stubFetch([]);

    renderWithQuery(<SearchPage />);

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByLabelText('Search the repository')).toBeInTheDocument();
  });
});
