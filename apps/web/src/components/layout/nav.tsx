'use client';

import { GitBranch, LayoutDashboard, MessageSquare, Network, Search, Target } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

/**
 * The product's vocabulary, in one place.
 *
 * **Health is deliberately absent.** Its analysis still runs and its endpoint still answers — the AI
 * layer and future features read those metrics — but the page measured the graph's own diagnostics
 * rather than anything a reader learns about their repository, so it is no longer part of the product.
 * The route still resolves for anyone holding a link.
 *
 * The labels here are the only names these features have anywhere in the interface: Overview, not
 * Dashboard; Ask TraceIQ, not Chat or AI.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/explorer', label: 'Explorer', icon: GitBranch },
  { href: '/architecture', label: 'Architecture', icon: Network },
  { href: '/impact', label: 'Impact', icon: Target },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/chat', label: 'Ask TraceIQ', icon: MessageSquare },
];

/**
 * `/` matches only itself — the landing page must not light up a nav item from every route — while every
 * other item matches its subtree, so `/symbol/x` keeps Explorer lit.
 */
export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({ onNavigate }: { readonly onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5 md:flex-row md:items-center md:gap-1">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors md:py-1.5',
              active ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
