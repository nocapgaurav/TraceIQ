import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIND, SYMBOL_VIEW } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';

import SymbolPage from './symbol/page';

/**
 * The Symbol page.
 *
 * The cases that matter are the awkward ones: an identifier arriving through the query string with a `#`
 * in it, an unresolved callee the graph could not name, and the impact figures being counts rather than
 * the full analysis.
 */
const params = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({
  usePathname: () => '/symbol',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => params.current,
}));

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  params.current = new URLSearchParams();
});

function withId(id: string): void {
  params.current = new URLSearchParams({ id });
}

describe('Symbol page', () => {
  it('prompts for a declaration when none is chosen', () => {
    stub = stubFetch([]);

    renderWithQuery(<SymbolPage />);

    expect(screen.getByText('No declaration chosen')).toBeInTheDocument();
    // No request should be made for an absent identifier.
    expect(stub.calls).toEqual([]);
  });

  it('requests the declaration with the hash percent-encoded', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);
    await screen.findByText('Method');

    expect(stub.calls[0]).toBe(`/api/symbol/${FIND.replace('#', '%23')}`);
    expect(stub.calls[0]).not.toContain('#');
  });

  it('shows the kind, package and health flags', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);

    expect(await screen.findByText('packages/core')).toBeInTheDocument();
    expect(screen.getByText('in a cycle')).toBeInTheDocument();
    expect(screen.queryByText('isolated')).not.toBeInTheDocument();
  });

  it('shows the inferred role with its evidence as a title', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);

    expect(await screen.findByTitle('class name ends with Service')).toHaveTextContent('Service');
  });

  it('shows impact as counts and links to the full analysis', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);

    expect(await screen.findByRole('link', { name: 'Impact analysis' })).toHaveAttribute(
      'href',
      `/impact?id=${encodeURIComponent(FIND)}`,
    );
  });

  it('keeps an unresolved callee visible with its reason', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);
    await screen.findByText('Method');

    await userEvent.click(screen.getByRole('tab', { name: /Callees/ }));

    expect(screen.getByText('target not in graph')).toBeInTheDocument();
  });

  it('lists the unresolved references the explanation reported', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);

    expect(await screen.findByText('helper()')).toBeInTheDocument();
    expect(screen.getByText('root-not-bound')).toBeInTheDocument();
  });

  it('shows the explanation limitations', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);

    expect(await screen.findByText(/partial-call-coverage/)).toBeInTheDocument();
  });

  it('shows the API error verbatim for an identifier the graph does not hold', async () => {
    withId('sym:nowhere.ts#Absent');
    stub = stubFetch([
      {
        path: '/symbol/',
        status: 404,
        error: {
          code: 'unknown-identifier',
          detail: "the graph holds nothing named 'sym:nowhere.ts#Absent'",
          hint: 'use GET /search?q= to find an identifier',
        },
      },
    ]);

    renderWithQuery(<SymbolPage />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('unknown-identifier')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search instead' })).toBeInTheDocument();
  });

  it('moves between tabs with the keyboard', async () => {
    withId(FIND);
    stub = stubFetch([{ path: '/symbol/', data: SYMBOL_VIEW }]);

    renderWithQuery(<SymbolPage />);
    await screen.findByText('Method');

    const references = screen.getByRole('tab', { name: /References/ });

    references.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: /Callers/ })).toHaveFocus();
  });
});
