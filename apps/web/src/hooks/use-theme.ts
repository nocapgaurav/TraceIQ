'use client';

import { useEffect } from 'react';

import { applyTheme } from '@/lib/theme';
import { useUiStore, type Theme } from '@/store/ui-store';

/**
 * Keeps the document in step with the stored theme.
 *
 * The OS listener matters for `system`: without it, changing the system appearance while the tab is
 * open would leave the page on the theme it happened to load with.
 */
export function useTheme(): { readonly theme: Theme; setTheme(theme: Theme): void } {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);

  useEffect(() => {
    applyTheme(theme);

    if (theme !== 'system' || typeof window === 'undefined') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      applyTheme('system');
    };

    media.addEventListener('change', onChange);

    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [theme]);

  return { theme, setTheme };
}
