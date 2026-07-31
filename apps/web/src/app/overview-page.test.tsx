import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOTSPOTS, OVERVIEW } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';
import type { Overview } from '@/types/api';

import OverviewPage from './dashboard/page';

/**
 * The Repository Overview, end to end from `fetch` upwards.
 *
 * `dashboard.test.tsx` still covers the metrics this page inherited from the Dashboard. This file covers
 * what the milestone added: the six new sections, the hand-off to chat, and — most importantly — that a
 * field the analysis cannot fill says so instead of showing something plausible.
 */
const push = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const UNAVAILABLE = 'Available after Repository Intelligence generation.';

let stub: FetchStub | undefined;

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function render(overview: Overview = OVERVIEW): void {
  stub = stubFetch([
    { path: '/overview', data: overview },
    { path: '/hotspots', data: HOTSPOTS },
  ]);

  renderWithQuery(<OverviewPage />);
}

describe('Repository Overview', () => {
  it('leads with what the repository is, not with how many files it has', async () => {
    render();

    const heading = await screen.findByRole('heading', { level: 1 });

    /*
     * The first heading names the repository. With no analysis record — as here — it says "Analysed
     * repository" rather than inventing a name, and the sentence below still describes the shape.
     */
    expect(heading).toHaveTextContent('Analysed repository');
    expect(screen.getByText(/A typescript project of 1 package/i)).toBeInTheDocument();
  });

  it('renders all seven sections, in order', async () => {
    render();

    await screen.findByRole('heading', { level: 1 });

    const sections = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

    expect(sections).toEqual([
      'Analysis summary',
      'Repository summary',
      'Architecture snapshot',
      'Getting started',
      'Ask TraceIQ',
      'Developer actions',
      'Repository metrics',
    ]);
  });

  /**
   * Still the heart of it: a value the analysis cannot produce says so. Purpose remains one of those.
   *
   * The repository *name* is no longer among them — it now comes from the analysis record. With no
   * analysis in the fixture the page says the graph was scanned from a path, which is what happened,
   * rather than showing a placeholder where a name would go.
   */
  it('says a value is unavailable rather than inventing one', async () => {
    render();

    await screen.findByRole('heading', { level: 1 });

    expect(screen.getAllByText(UNAVAILABLE).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/scanned from a local path, so no repository name was recorded/)).toBeInTheDocument();
  });

  it('shows every summary field, whether or not it can be filled', async () => {
    render();

    const summary = within(await screen.findByRole('region', { name: 'Repository summary' }));

    // A field that cannot be answered still appears. Hiding it would hide that the question exists.
    expect(summary.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Purpose',
      'Architecture style',
      'Languages',
      'Frameworks',
      'Main packages',
      'Entry points',
      'Important directories',
    ]);
  });

  it('degrades exactly the fields this payload cannot answer', async () => {
    render();

    const summary = within(await screen.findByRole('region', { name: 'Repository summary' }));
    const rows = summary.getAllByRole('definition');
    const unfilled = summary.getAllByRole('term').filter((_, index) => rows[index]?.textContent?.includes(UNAVAILABLE));

    // Purpose is never derivable. Entry points is not, here: the fixture records no routes and no
    // controllers. Frameworks *is* filled, because the fixture reads one environment variable — which is
    // an outcome of framework extraction, so reporting it is not a guess.
    expect(unfilled.map((term) => term.textContent)).toEqual(['Purpose', 'Entry points']);
    expect(rows[3]?.textContent).toContain('environment configuration (1 variable read)');
  });

  it('fills the fields it can, from the payload', async () => {
    render();

    const summary = within(await screen.findByRole('region', { name: 'Repository summary' }));

    expect(summary.getByText('TypeScript')).toBeInTheDocument();
    expect(summary.getByRole('link', { name: /packages\/core/ })).toHaveAttribute(
      'href',
      '/explorer?package=packages%2Fcore',
    );
  });

  it('shows the architecture snapshot with a way through to the explorer', async () => {
    render();

    const snapshot = within(await screen.findByRole('region', { name: 'Architecture snapshot' }));

    expect(snapshot.getByText('228 nodes')).toBeInTheDocument();
    expect(snapshot.getByRole('link', { name: /Open Architecture Explorer/ })).toHaveAttribute(
      'href',
      '/architecture',
    );
  });

  it('explains why a learning order is not offered, instead of leaving the card blank', async () => {
    render();

    const started = within(await screen.findByRole('region', { name: 'Getting started' }));

    expect(started.getByRole('heading', { name: 'Suggested learning order' })).toBeInTheDocument();
    expect(started.getByText(/judgement about what matters, not a measurement/)).toBeInTheDocument();
  });

  it('links every developer action to a page that exists', async () => {
    render();

    const actions = within(await screen.findByRole('region', { name: 'Developer actions' }));
    const hrefs = actions.getAllByRole('link').map((link) => link.getAttribute('href'));

    // Health is deliberately absent: its page is no longer part of the product.
    expect(hrefs).toEqual(['/explorer', '/architecture', '/search', '/impact', '/chat']);
  });

  it('keeps every metric the Dashboard had, at the foot of the page', async () => {
    render();

    const metrics = within(await screen.findByRole('region', { name: 'Repository metrics' }));

    expect(metrics.getByText('228')).toBeInTheDocument();
    expect(metrics.getByText('Most coupled')).toBeInTheDocument();
    expect(metrics.getByText('Externals by kind')).toBeInTheDocument();
    expect(metrics.getByText('package-boundary-is-derived-from-paths')).toBeInTheDocument();
  });

  describe('Ask TraceIQ', () => {
    it('hands a typed question to the chat page rather than answering it here', async () => {
      const user = userEvent.setup();

      render();

      await screen.findByRole('heading', { level: 1 });
      await user.type(screen.getByRole('textbox', { name: 'Ask about this repository' }), 'What is this?');
      await user.click(screen.getByRole('button', { name: 'Ask' }));

      expect(push).toHaveBeenCalledWith('/chat?q=What%20is%20this%3F');
      expect(stub?.calls.some((call) => call.includes('/chat'))).toBe(false);
    });

    it('offers the five suggested prompts, each opening chat with itself', async () => {
      const user = userEvent.setup();

      render();

      await screen.findByRole('heading', { level: 1 });
      await user.click(screen.getByRole('button', { name: 'Explain the architecture' }));

      expect(push).toHaveBeenCalledWith('/chat?q=Explain%20the%20architecture');

      for (const prompt of [
        'Where should I start?',
        'Explain authentication',
        'How does request flow work?',
        'What is the most important package?',
      ]) {
        expect(screen.getByRole('button', { name: prompt })).toBeInTheDocument();
      }
    });

    it('will not submit an empty question', async () => {
      render();

      await screen.findByRole('heading', { level: 1 });

      expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
      expect(push).not.toHaveBeenCalled();
    });
  });

  describe('when the graph is sparse', () => {
    const EMPTY: Overview = {
      ...OVERVIEW,
      packages: { entries: [], total: 0, truncated: false },
      graph: { ...OVERVIEW.graph, relationshipCounts: {} },
    };

    it('renders every section with empty states rather than failing', async () => {
      render(EMPTY);

      await screen.findByRole('heading', { level: 1 });

      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(7);
      expect(screen.getAllByText('No packages were derived').length).toBeGreaterThan(0);
      expect(screen.getByText('No relationships were resolved')).toBeInTheDocument();
    });

    it('explains why core modules cannot be ranked', async () => {
      render(EMPTY);

      const started = within(await screen.findByRole('region', { name: 'Getting started' }));

      expect(started.getByText(/No package-to-package dependencies were resolved/)).toBeInTheDocument();
    });
  });
});
