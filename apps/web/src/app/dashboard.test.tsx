import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOTSPOTS, OVERVIEW } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';

import DashboardPage from './dashboard/page';

/**
 * The Dashboard, end to end from `fetch` upwards.
 *
 * Only `fetch` is stubbed, so this exercises the real client, the real services and the real hooks — an
 * integration test rather than a component test. What it proves is that the page reads the fields the
 * API actually sends, which is the failure a component test with hand-passed props cannot catch.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('Dashboard', () => {
  it('shows a loading state before the payload arrives', () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the repository counts from the payload', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('228')).toBeInTheDocument();
    expect(screen.getByText('12,911')).toBeInTheDocument();
    // 3,148 is both the declaration count and the DECLARES edge count — one per declaration, so the
    // repetition is the data agreeing with itself rather than a duplicated element. It now appears three
    // times rather than two: the Declarations stat, the DECLARES row of the metrics chart, and the
    // DECLARES bar in the Architecture snapshot, which is a new section showing the same fact.
    expect(screen.getAllByText('3,148')).toHaveLength(3);
  });

  it('formats coverage as a percentage', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    // Call graph coverage appears in the health card and again in the metrics card.
    expect(await screen.findAllByText('22.0%')).toHaveLength(2);
    expect(screen.getByText('53.1%')).toBeInTheDocument();
  });

  it('requests overview, hotspots and the analysis record, and nothing else', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);
    await screen.findByText('228');

    await waitFor(() => {
      expect(stub?.calls.some((call) => call.includes('/hotspots'))).toBe(true);
    });

    // `/analysis` is the third: it is the only place the analysed repository's real name exists, because
    // the graph stores the temporary workspace directory for anything cloned from GitHub.
    expect(new Set(stub?.calls)).toEqual(new Set(['/api/overview', '/api/hotspots', '/api/analysis']));
  });

  it('lists packages with links into the explorer', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    const link = await screen.findByRole('link', { name: 'packages/core' });

    expect(link).toHaveAttribute('href', '/explorer?package=packages%2Fcore');
  });

  it('reports the true total where a hotspot list was capped', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/showing 1 of 2,244 entries/)).toBeInTheDocument();
  });

  it('shows the overview limitations rather than hiding them', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('package-boundary-is-derived-from-paths')).toBeInTheDocument();
  });

  it('shows the scan prompt when no repository has been scanned', async () => {
    stub = stubFetch([
      {
        path: '/overview',
        status: 409,
        error: { code: 'repository-not-scanned', detail: 'no graph', hint: 'run traceiq scan <path> first' },
      },
      { path: '/hotspots', data: HOTSPOTS },
    ]);

    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText('No repository has been scanned')).toBeInTheDocument();
  });

  it('shows the API error when the request fails', async () => {
    stub = stubFetch([
      { path: '/overview', status: 500, error: { code: 'bad-request', detail: 'exploded', hint: 'retry' } },
    ]);

    renderWithQuery(<DashboardPage />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('exploded')).toBeInTheDocument();
  });

  /**
   * This replaces "never renders a chat, prompt or markdown affordance".
   *
   * The Repository Overview now carries an Ask TraceIQ box, so the original prohibition no longer holds.
   * What it was really protecting does: **this page must not become a second chat implementation.** The
   * box collects a question and navigates; it renders no answer, no markdown and no conversation, and it
   * calls no chat endpoint. That is the part worth keeping a test on.
   */
  it('offers to ask, but implements no chat of its own', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    const { container } = renderWithQuery(<DashboardPage />);

    await screen.findByText('228');

    expect(screen.getByRole('heading', { name: 'Ask TraceIQ' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask about this repository' })).toBeInTheDocument();

    // No answer surface: no conversation transcript, no markdown, no streaming controls.
    expect(container.textContent ?? '').not.toContain('```');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    // And nothing was posted to the model.
    expect(stub.calls.some((call) => call.includes('/chat'))).toBe(false);
  });
});
