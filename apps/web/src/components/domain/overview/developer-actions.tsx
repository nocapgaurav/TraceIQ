import { ArrowUpRight, GitBranch, MessageSquare, Network, Search, Target } from 'lucide-react';
import Link from 'next/link';

import { OverviewSection } from '@/components/domain/overview/shared';
import { routes } from '@/lib/routes';

/**
 * Section 5 — Developer Actions.
 *
 * Six destinations, each a page that already exists. Nothing here computes anything; it is navigation,
 * grouped so the whole application is reachable from the overview without using the top nav.
 */
interface Action {
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

const ACTIONS: readonly Action[] = [
  {
    title: 'Explore Repository',
    detail: 'Browse packages, files and declarations',
    href: routes.explorer(),
    icon: GitBranch,
  },
  {
    title: 'Architecture',
    detail: 'Dependency graphs, role trees and cycles',
    href: routes.architecture(),
    icon: Network,
  },
  {
    title: 'Repository Search',
    detail: 'Find declarations, files, routes and variables',
    href: routes.search(),
    icon: Search,
  },
  {
    title: 'Impact Analysis',
    detail: 'What a change to one declaration reaches',
    href: routes.impact(),
    icon: Target,
  },
  {
    title: 'Ask TraceIQ',
    detail: 'Ask questions about this repository, grounded and cited',
    href: routes.chat(),
    icon: MessageSquare,
  },
];

export function DeveloperActions() {
  return (
    <OverviewSection id="developer-actions" title="Developer actions" description="Everything else, one click away.">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ACTIONS.map((action) => (
          <li key={action.title} className="min-w-0">
            <Link
              href={action.href}
              className="group flex h-full items-start gap-3 rounded-lg border border-border bg-card p-4 transition-[border-color,background-color] hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <action.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {action.title}
                  <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{action.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </OverviewSection>
  );
}
