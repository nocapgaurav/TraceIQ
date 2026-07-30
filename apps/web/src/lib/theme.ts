import type { Theme } from '@/store/ui-store';

/** Whether a theme setting resolves to dark right now. `system` asks the OS. */
export function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') {
    return true;
  }

  if (theme === 'light') {
    return false;
  }

  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Applies a theme to the document.
 *
 * A class on `<html>` rather than inline styles, because Tailwind's `dark:` variant is configured
 * against that class and every token in `globals.css` is redefined under it — so one toggle restyles
 * the whole tree without a component knowing which theme is active.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.classList.toggle('dark', resolveDark(theme));
  document.documentElement.style.colorScheme = resolveDark(theme) ? 'dark' : 'light';
}
