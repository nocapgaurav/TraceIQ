'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

/**
 * UI state only — never repository data.
 *
 * The split is deliberate: anything the server owns lives in TanStack Query, and anything the user's
 * session owns lives here. Nothing fetched is stored twice, so a stale copy cannot exist.
 *
 * `persist` keeps the theme and the explorer's panel sizes across reloads. Selection is *not*
 * persisted — a URL already carries which symbol is open, so persisting it would fight the address bar.
 */
export interface UiState {
  readonly theme: Theme;
  readonly explorerPackage: string | null;
  readonly explorerFile: string | null;
  readonly panelSizes: readonly number[];
  readonly commandOpen: boolean;
  setTheme(theme: Theme): void;
  selectPackage(name: string | null): void;
  selectFile(path: string | null): void;
  setPanelSizes(sizes: readonly number[]): void;
  setCommandOpen(open: boolean): void;
}

/**
 * Explorer pane widths: navigation, the selected subject, tips.
 *
 * The middle pane is the largest because it holds the thing being read. Before the Explorer redesign the
 * three panes were packages, files and detail, and the stored numbers meant something else — see the
 * `migrate` below.
 */
export const DEFAULT_PANEL_SIZES: readonly number[] = [22, 54, 24];

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      explorerPackage: null,
      explorerFile: null,
      panelSizes: DEFAULT_PANEL_SIZES,
      commandOpen: false,

      setTheme: (theme) => {
        set({ theme });
      },

      // Choosing a package clears the file below it: the previous file belongs to the previous package,
      // and leaving it selected would show a file the tree no longer contains.
      selectPackage: (explorerPackage) => {
        set({ explorerPackage, explorerFile: null });
      },

      selectFile: (explorerFile) => {
        set({ explorerFile });
      },

      setPanelSizes: (panelSizes) => {
        set({ panelSizes });
      },

      setCommandOpen: (commandOpen) => {
        set({ commandOpen });
      },
    }),
    {
      name: 'traceiq-ui',
      partialize: (state) => ({ theme: state.theme, panelSizes: state.panelSizes }),
      /**
       * Bumped when the Explorer's third pane became Repository Tips rather than the detail view.
       *
       * A returning reader had `[22, 33, 45]` stored, which under the new layout would hand almost half
       * the width to the tips sidebar and squeeze the subject they came to read. Sizes are a preference,
       * not data, so the safe migration is to drop them and let the new defaults apply. The theme is kept.
       */
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as { theme?: Theme } | undefined;

        return version >= 2 ? persisted : { theme: state?.theme ?? 'system', panelSizes: DEFAULT_PANEL_SIZES };
      },
    },
  ),
);
