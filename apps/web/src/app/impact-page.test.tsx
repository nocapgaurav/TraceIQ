import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIND, IMPACT } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';

import ImpactPage from './impact/page';

/**
 * The Impact page.
 *
 * The rule this page must never break is that DIRECT, INDIRECT and UNKNOWN stay apart — merging them
 * would state something the analysis does not. These tests hold that line.
 *
 * React Flow needs real element measurement, which jsdom does not do, so the canvas is replaced by a
 * marker. The layout itself is asserted directly in `graph-models.test.ts`, where it is a pure function.
 */
const params = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({
  usePathname: () => '/impact',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => params.current,
}));

vi.mock('@/components/domain/graph-canvas', () => ({
  GraphCanvas: ({ layout }: { readonly layout: { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] } }) => (
    <div data-testid="graph">
      {layout.nodes.length} nodes, {layout.edges.length} edges
    </div>
  ),
}));

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  params.current = new URLSearchParams();
});

describe('Impact page', () => {
  /**
   * The empty state used to say "No declaration chosen", which named the reader's omission and explained
   * nothing. It now explains what Impact answers and where to pick a subject, and still asks for nothing
   * from the API.
   */
  it('explains what Impact does when nothing is chosen, and requests nothing', () => {
    stub = stubFetch([]);

    renderWithQuery(<ImpactPage />);

    expect(screen.getByRole('heading', { name: 'What would this change break?' })).toBeInTheDocument();
    // Matched on a run of text that no <strong> splits.
    expect(screen.getByText(/at a time — a class, function/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse the Explorer/ })).toHaveAttribute('href', '/explorer');
    expect(screen.getByRole('link', { name: /Search by name/ })).toHaveAttribute('href', '/search');
    expect(stub.calls).toEqual([]);
  });

  it('reports direct and indirect counts separately', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([{ path: '/impact/', data: IMPACT }, { path: '/dependencies/', data: null }]);

    renderWithQuery(<ImpactPage />);

    const direct = await screen.findByText('Directly affected');
    const indirect = screen.getByText('Indirectly affected');

    expect(direct.parentElement?.textContent).toContain('1');
    expect(indirect.parentElement?.textContent).toContain('1');
  });

  it('reports unknown as its own figure, not folded into either category', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([{ path: '/impact/', data: IMPACT }, { path: '/dependencies/', data: null }]);

    renderWithQuery(<ImpactPage />);

    const unknown = await screen.findByText('Unknown');

    expect(unknown.parentElement?.textContent).toContain('calls that could not be bound');
  });

  it('draws only the nodes and edges the analysis carried', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([{ path: '/impact/', data: IMPACT }, { path: '/dependencies/', data: null }]);

    renderWithQuery(<ImpactPage />);

    // Target plus two affected nodes; two `via` edges.
    expect(await screen.findByTestId('graph')).toHaveTextContent('3 nodes, 2 edges');
  });

  it('labels each affected node with its category, depth and the edge it was reached by', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([{ path: '/impact/', data: IMPACT }, { path: '/dependencies/', data: null }]);

    renderWithQuery(<ImpactPage />);

    expect(await screen.findByText('direct · d1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /^Indirect/ }));

    expect(screen.getByText('indirect · d2')).toBeInTheDocument();
  });

  it('says that callees are depth 1 only, because impact traverses dependents', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([{ path: '/impact/', data: IMPACT }, { path: '/dependencies/', data: null }]);

    renderWithQuery(<ImpactPage />);
    await screen.findByTestId('graph');

    await userEvent.click(screen.getByRole('tab', { name: /Callees/ }));

    expect(screen.getByText(/Callees are reported at depth 1 only/)).toBeInTheDocument();
  });

  it('states that UNKNOWN is not the absence of impact', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([{ path: '/impact/', data: IMPACT }, { path: '/dependencies/', data: null }]);

    renderWithQuery(<ImpactPage />);
    await screen.findByTestId('graph');

    await userEvent.click(screen.getByRole('tab', { name: /Unknown/ }));

    expect(screen.getByText(/UNKNOWN is not the absence of impact/)).toBeInTheDocument();
  });

  it('reports an empty analysis as no dependents rather than as an error', async () => {
    params.current = new URLSearchParams({ id: FIND });
    stub = stubFetch([
      { path: '/impact/', data: { ...IMPACT, directlyAffected: [], indirectlyAffected: [], unknown: [] } },
      { path: '/dependencies/', data: null },
    ]);

    renderWithQuery(<ImpactPage />);

    expect(await screen.findByText('Nothing references this declaration directly')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
