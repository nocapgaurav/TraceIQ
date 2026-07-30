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

export const DEFAULT_PANEL_SIZES: readonly number[] = [22, 33, 45];

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
    },
  ),
);
