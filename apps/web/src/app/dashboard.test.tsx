import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOTSPOTS, OVERVIEW } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';

import DashboardPage from './page';

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
    // repetition is the data agreeing with itself rather than a duplicated element.
    expect(screen.getAllByText('3,148')).toHaveLength(2);
  });

  it('formats coverage as a percentage', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);

    // Call graph coverage appears in the health card and again in the metrics card.
    expect(await screen.findAllByText('22.0%')).toHaveLength(2);
    expect(screen.getByText('53.1%')).toBeInTheDocument();
  });

  it('requests overview and hotspots, and nothing else', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    renderWithQuery(<DashboardPage />);
    await screen.findByText('228');

    await waitFor(() => {
      expect(stub?.calls.some((call) => call.includes('/hotspots'))).toBe(true);
    });

    expect(new Set(stub?.calls)).toEqual(new Set(['/api/overview', '/api/hotspots']));
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

  it('never renders a chat, prompt or markdown affordance', async () => {
    stub = stubFetch([{ path: '/overview', data: OVERVIEW }, { path: '/hotspots', data: HOTSPOTS }]);

    const { container } = renderWithQuery(<DashboardPage />);

    await screen.findByText('228');

    const text = container.textContent ?? '';

    for (const forbidden of ['Ask ', 'Chat', 'prompt', 'Prompt', '```']) {
      expect(text).not.toContain(forbidden);
    }

    expect(container.querySelector('textarea')).toBeNull();
  });
});
