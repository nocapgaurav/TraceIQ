import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';
import { DEFAULT_PANEL_SIZES, useUiStore } from '@/store/ui-store';

import { AppShell } from './app-shell';
import { NAV_ITEMS, Nav, isActive } from './nav';
import { ThemeToggle } from './theme-toggle';

/**
 * The shell: navigation, the theme control and the keyboard palette.
 *
 * These are the affordances the milestone asks for by name — keyboard navigation, dark mode, responsive
 * layout — so they are tested through the accessible tree rather than by inspecting classes.
 */
const push = vi.fn();
const pathname = { current: '/' };

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

let stub: FetchStub | undefined;

beforeEach(() => {
  pathname.current = '/';
  push.mockClear();
  useUiStore.setState({
    theme: 'system',
    explorerPackage: null,
    explorerFile: null,
    panelSizes: DEFAULT_PANEL_SIZES,
    commandOpen: false,
  });
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('isActive', () => {
  it('matches the dashboard only exactly, so it does not light up everywhere', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/explorer', '/')).toBe(false);
  });

  it('matches a section and its subtree', () => {
    expect(isActive('/explorer', '/explorer')).toBe(true);
    expect(isActive('/explorer/anything', '/explorer')).toBe(true);
    expect(isActive('/health', '/explorer')).toBe(false);
  });
});

describe('Nav', () => {
  it('links every page the milestone specifies', () => {
    renderWithQuery(<Nav />);

    const nav = screen.getByRole('navigation', { name: 'Sections' });

    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.href);
    }
  });

  it('marks the current page with aria-current, so it is announced', () => {
    pathname.current = '/impact';

    renderWithQuery(<Nav />);

    expect(screen.getByRole('link', { name: 'Impact' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Explorer' })).not.toHaveAttribute('aria-current');
  });
});

describe('ThemeToggle', () => {
  it('cycles system → light → dark → system', async () => {
    renderWithQuery(<ThemeToggle />);

    expect(screen.getByLabelText('Theme: follow system')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));
    expect(useUiStore.getState().theme).toBe('light');

    await userEvent.click(screen.getByRole('button'));
    expect(useUiStore.getState().theme).toBe('dark');

    await userEvent.click(screen.getByRole('button'));
    expect(useUiStore.getState().theme).toBe('system');
  });

  it('puts the dark class on the document, which is what every token is defined against', async () => {
    renderWithQuery(<ThemeToggle />);

    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByRole('button'));

    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});

describe('AppShell', () => {
  it('offers a skip link as the first focusable element', async () => {
    stub = stubFetch([{ path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } }]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    await userEvent.tab();

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  });

  it('marks the main landmark the skip link points at', () => {
    stub = stubFetch([{ path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } }]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('reports the API version and whether a graph is loaded', async () => {
    stub = stubFetch([{ path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } }]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText('api 1.0.0 · graph loaded')).toBeInTheDocument();
  });

  it('says no graph is loaded when the API reports none', async () => {
    stub = stubFetch([{ path: '/version', data: { version: '1.0.0', scanned: false, databasePath: '/x.db' } }]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(await screen.findByText('api 1.0.0 · no graph')).toBeInTheDocument();
  });

  it('exposes the mobile navigation as a labelled disclosure', async () => {
    stub = stubFetch([{ path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } }]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    const toggle = screen.getByRole('button', { name: 'Open navigation' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the command palette with the meta shortcut', async () => {
    stub = stubFetch([
      { path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } },
      { path: '/search', data: SEARCH },
    ]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    await userEvent.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(useUiStore.getState().commandOpen).toBe(true);
  });

  it('opens the palette with the control shortcut too, for a non-Mac keyboard', async () => {
    stub = stubFetch([
      { path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } },
      { path: '/search', data: SEARCH },
    ]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    await userEvent.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('states that everything shown comes from the graph', () => {
    stub = stubFetch([{ path: '/version', data: { version: '1.0.0', scanned: true, databasePath: '/x.db' } }]);

    renderWithQuery(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    expect(
      screen.getByText('Static analysis only — every value shown exists in the repository graph.'),
    ).toBeInTheDocument();
  });
});
