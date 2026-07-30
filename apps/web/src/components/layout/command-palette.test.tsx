import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIND, SEARCH } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';
import { DEFAULT_PANEL_SIZES, useUiStore } from '@/store/ui-store';

import { CommandPalette } from './command-palette';

/**
 * The command palette — the reason the whole app is usable without a pointer.
 *
 * The palette is where keyboard navigation actually lives, so these tests drive it the way a keyboard
 * user would: shortcut, arrows, Enter, Escape. Nothing is clicked except where a click is the subject.
 */
const push = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

let stub: FetchStub | undefined;

beforeEach(() => {
  push.mockClear();
  useUiStore.setState({
    theme: 'system',
    explorerPackage: null,
    explorerFile: null,
    panelSizes: DEFAULT_PANEL_SIZES,
    commandOpen: true,
  });
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('CommandPalette', () => {
  it('lists every section before anything is typed', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);

    const list = await screen.findByRole('listbox', { name: 'Results' });

    expect(within(list).getAllByRole('option')).toHaveLength(6);
    expect(within(list).getByText('Dashboard')).toBeInTheDocument();
  });

  it('focuses the input on open, so typing works immediately', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);

    expect(await screen.findByLabelText('Search declarations, files, routes')).toHaveFocus();
  });

  it('marks exactly one option as selected', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
  });

  it('moves the selection with the arrow keys', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    await userEvent.keyboard('{ArrowDown}');

    expect(screen.getAllByRole('option', { selected: true })[0]).toHaveTextContent('Explorer');

    await userEvent.keyboard('{ArrowUp}');

    expect(screen.getAllByRole('option', { selected: true })[0]).toHaveTextContent('Dashboard');
  });

  it('wraps from the last option back to the first', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    await userEvent.keyboard('{ArrowUp}');

    expect(screen.getAllByRole('option', { selected: true })[0]).toHaveTextContent('Search');
  });

  it('navigates on Enter and closes', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(push).toHaveBeenCalledWith('/explorer');
    expect(useUiStore.getState().commandOpen).toBe(false);
  });

  it('filters sections by what was typed', async () => {
    stub = stubFetch([{ path: '/search', data: { ...SEARCH, total: 0, declarations: { entries: [], total: 0, truncated: false }, files: { entries: [], total: 0, truncated: false } } }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    await userEvent.type(screen.getByLabelText('Search declarations, files, routes'), 'heal');

    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('searches the repository and links a result with the hash encoded', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    await userEvent.type(screen.getByLabelText('Search declarations, files, routes'), 'find');

    const option = await screen.findByText(FIND);

    expect(option).toBeInTheDocument();

    await userEvent.click(option);

    expect(push).toHaveBeenCalledWith(`/symbol?id=${encodeURIComponent(FIND)}`);
  });

  it('closes on Escape', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);
    await screen.findByRole('listbox', { name: 'Results' });

    await userEvent.keyboard('{Escape}');

    expect(useUiStore.getState().commandOpen).toBe(false);
  });

  it('describes how to drive it, for a screen reader', async () => {
    stub = stubFetch([{ path: '/search', data: SEARCH }]);

    renderWithQuery(<CommandPalette />);

    expect(await screen.findByText(/Use the arrow keys to choose a result and Enter to open it/)).toBeInTheDocument();
  });
});
