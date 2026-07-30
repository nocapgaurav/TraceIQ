'use client';

import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import type { Theme } from '@/store/ui-store';

const ORDER: readonly Theme[] = ['system', 'light', 'dark'];

const LABEL: Readonly<Record<Theme, string>> = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/** Cycles system → light → dark. One control, so it works the same on a phone and with a keyboard. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={LABEL[theme]}
      title={LABEL[theme]}
      onClick={() => {
        setTheme(next);
      }}
    >
      {theme === 'system' ? <Monitor /> : theme === 'light' ? <Sun /> : <Moon />}
    </Button>
  );
}
