import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PANEL_SIZES, useUiStore } from './ui-store';

/**
 * The UI store.
 *
 * Two properties matter. It holds only UI state — a repository fact would be a second copy of something
 * TanStack Query already owns, and the two could disagree. And choosing a package clears the file below
 * it, because that file belongs to the package being left.
 */
beforeEach(() => {
  useUiStore.setState({
    theme: 'system',
    explorerPackage: null,
    explorerFile: null,
    panelSizes: DEFAULT_PANEL_SIZES,
    commandOpen: false,
  });
});

describe('useUiStore', () => {
  it('starts on the system theme, so a first visit follows the OS', () => {
    expect(useUiStore.getState().theme).toBe('system');
  });

  it('records a chosen theme', () => {
    useUiStore.getState().setTheme('dark');

    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('clears the selected file when the package changes', () => {
    useUiStore.getState().selectPackage('packages/core');
    useUiStore.getState().selectFile('packages/core/src/a.ts');

    expect(useUiStore.getState().explorerFile).toBe('packages/core/src/a.ts');

    useUiStore.getState().selectPackage('packages/api');

    expect(useUiStore.getState().explorerPackage).toBe('packages/api');
    expect(useUiStore.getState().explorerFile).toBeNull();
  });

  it('records panel sizes so a layout survives a reload', () => {
    useUiStore.getState().setPanelSizes([10, 20, 70]);

    expect(useUiStore.getState().panelSizes).toEqual([10, 20, 70]);
  });

  it('opens and closes the command palette', () => {
    useUiStore.getState().setCommandOpen(true);

    expect(useUiStore.getState().commandOpen).toBe(true);

    useUiStore.getState().setCommandOpen(false);

    expect(useUiStore.getState().commandOpen).toBe(false);
  });

  it('holds no repository data — only UI state', () => {
    const keys = Object.entries(useUiStore.getState())
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key)
      .sort();

    expect(keys).toEqual(['commandOpen', 'explorerFile', 'explorerPackage', 'panelSizes', 'theme']);
  });
});
