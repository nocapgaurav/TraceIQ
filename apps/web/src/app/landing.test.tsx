import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NAV_ITEMS } from '@/components/layout/nav';
import { routes } from '@/lib/routes';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';

import LandingPage from './page';

/**
 * The landing page.
 *
 * Rendered as the real page component with only `fetch` stubbed, in the same style as every other page
 * test here. What it protects is not the wording — copy changes — but the two things that would make the
 * page a liability if they broke: that every advertised feature links somewhere real, and that the
 * primary call to action does not pretend to import a repository.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const VERSION = { version: '1.0.0', scanned: true, databasePath: '/data/graph.db' };

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('Landing page', () => {
  it('leads with the headline and subtitle', () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Understand Any Repository in Minutes' })).toBeInTheDocument();
    expect(
      screen.getByText('AI-powered repository intelligence built on deterministic static analysis.'),
    ).toBeInTheDocument();
  });

  it('offers both calls to action, with the demo pointing at the dashboard', () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    expect(screen.getByRole('button', { name: /Analyze Repository/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Demo' })).toHaveAttribute('href', routes.dashboard());
  });

  it('names the three steps in order', () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    const steps = within(screen.getByRole('region', { name: 'Three steps from repository to answer' }))
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);

    expect(steps).toEqual(['Analyze', 'Understand', 'Ask AI']);
  });

  /**
   * The one that matters. A feature card advertising a capability and linking nowhere is the classic
   * landing-page defect, and it survives a visual review because a dead `<Link>` still looks correct.
   */
  it('links all six feature cards to pages that exist', () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    const features = within(screen.getByRole('region', { name: 'Everything the graph knows, in one place' }));
    // '/' is the landing page itself — where the Repository Analysis card sends a reader to start one.
    const known = new Set<string>([...NAV_ITEMS.map((item) => item.href), '/', '/impact', '/symbol', '/search']);

    const cards = [
      'Repository Summary',
      'Architecture Explorer',
      'Change Impact',
      'Repository Analysis',
      'AI Repository Expert',
      'Semantic Search',
    ];

    expect(features.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(cards);

    for (const card of cards) {
      const href = features.getByRole('heading', { level: 3, name: card }).closest('a')?.getAttribute('href');

      expect(href, card).toBeDefined();
      // A path with no query string, and one the application actually serves.
      expect(known, `${card} → ${String(href)}`).toContain(href?.split('?')[0]);
    }
  });

  it('contrasts generic AI with TraceIQ', () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    const why = within(screen.getByRole('region', { name: 'Grounded in analysis, not in guesswork' }));

    expect(why.getByRole('heading', { level: 3, name: 'Generic AI assistant' })).toBeInTheDocument();
    expect(why.getByRole('heading', { level: 3, name: 'TraceIQ' })).toBeInTheDocument();
  });

  /**
   * Repository import is the next milestone. Until it ships the button must explain itself rather than
   * post to `/scan`, so this asserts both halves: a dialog opens, and no request is made.
   */
  /**
   * This replaces "explains that repository import is not built yet, and posts nothing".
   *
   * That placeholder is what Repository Analysis v1 exists to remove: the button now opens a form that
   * takes a GitHub URL and starts a real analysis. What the original test protected still holds — the
   * landing page starts no work of its own until asked — so that is what is asserted.
   */
  it('opens the analysis dialog, and starts nothing until asked', async () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);
    const user = userEvent.setup();

    renderWithQuery(<LandingPage />);

    await user.click(screen.getByRole('button', { name: /Analyze Repository/ }));

    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Analyze a repository')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'GitHub repository URL' })).toBeInTheDocument();
    // Nothing is submitted by opening the dialog, and an empty URL cannot be submitted at all.
    expect(within(dialog).getByRole('button', { name: /Analyze Repository/ })).toBeDisabled();
    expect(stub.calls.some((call) => call.includes('/analysis'))).toBe(false);
  });

  it('reports whether a graph is loaded, from /version', async () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    expect(await screen.findByText(/A repository graph is loaded/)).toBeInTheDocument();
  });

  /** A landing page must still render when the API is down — it is the first thing a visitor sees. */
  it('renders without the status line when /version fails', async () => {
    stub = stubFetch([{ path: '/version', error: { code: 'unavailable', detail: 'no', hint: 'no' }, status: 503 }]);

    renderWithQuery(<LandingPage />);

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/A repository graph is loaded/)).not.toBeInTheDocument();
    });
  });

  it('requests only /version — the landing page is not a dashboard', async () => {
    stub = stubFetch([{ path: '/version', data: VERSION }]);

    renderWithQuery(<LandingPage />);

    await screen.findByText(/A repository graph is loaded/);

    expect(stub.calls.every((call) => call.includes('/version'))).toBe(true);
  });
});
