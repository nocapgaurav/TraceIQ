'use client';

import { Menu, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { CommandPalette } from '@/components/layout/command-palette';
import { Nav } from '@/components/layout/nav';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button } from '@/components/ui/button';
import { useVersion } from '@/hooks/queries';
import { useUiStore } from '@/store/ui-store';

/**
 * The frame every page sits in.
 *
 * One header, one nav, one palette. A page renders content and nothing else — it never draws chrome, so
 * navigation and the keyboard shortcut behave identically everywhere.
 *
 * Responsive by collapsing rather than reflowing: below `md` the nav becomes a disclosure panel, so the
 * same links are reachable on a phone without a second navigation component to keep in step.
 */
export function AppShell({ children }: { readonly children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const setCommandOpen = useUiStore((state) => state.setCommandOpen);
  const version = useVersion();
  const pathname = usePathname();

  // A route change closes the mobile panel; leaving it open would cover the page just navigated to.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="font-semibold tracking-tight">TraceIQ</span>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">Repository Intelligence</span>
          </Link>

          <div className="ml-2 hidden md:block">
            <Nav />
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCommandOpen(true);
              }}
              className="gap-2 text-muted-foreground"
              aria-keyshortcuts="Meta+K Control+K"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded border border-border px-1 font-mono text-[10px] sm:inline">⌘K</kbd>
            </Button>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              onClick={() => {
                setMenuOpen((current) => !current);
              }}
            >
              {menuOpen ? <X /> : <Menu />}
            </Button>
          </div>
        </div>

        {menuOpen ? (
          <div id="mobile-nav" className="border-t border-border px-3 py-2 md:hidden">
            <Nav
              onNavigate={() => {
                setMenuOpen(false);
              }}
            />
          </div>
        ) : null}
      </header>

      <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        {children}
      </main>

      <footer className="border-t border-border px-4 py-3">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Static analysis only — every value shown exists in the repository graph.</span>
          {version.data === undefined ? null : (
            <span className="font-mono">
              api {version.data.version} · {version.data.scanned ? 'graph loaded' : 'no graph'}
            </span>
          )}
        </div>
      </footer>

      <CommandPalette />
    </div>
  );
}

/** A page heading with an optional subtitle and trailing controls. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle === undefined ? null : (
          <p className="truncate font-mono text-xs text-muted-foreground" title={subtitle}>
            {subtitle}
          </p>
        )}
      </div>
      {children === undefined ? null : <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** A titled block. Used everywhere a page groups related facts. */
export function Section({
  title,
  count: total,
  children,
  className,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {title}
        {total === undefined ? null : <span className="font-normal text-muted-foreground">({total})</span>}
      </h2>
      {children}
    </section>
  );
}
