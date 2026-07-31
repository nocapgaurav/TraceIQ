import { ArrowUpRight, Github, LayoutDashboard, MessageSquare, Network, Search, Target } from 'lucide-react';
import Link from 'next/link';

import { Band, BandHeading, stagger } from '@/components/marketing/landing-section';
import { routes } from '@/lib/routes';

/**
 * The six capabilities, each linking to the page that provides it.
 *
 * Every card is a real destination — a landing page that advertises a feature and then does not go
 * anywhere is a brochure. Icons are the same ones the navigation uses for those pages, so the card and
 * the nav item a visitor lands on are recognisably the same thing.
 */

interface Feature {
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

const FEATURES: readonly Feature[] = [
  {
    title: 'Repository Summary',
    detail:
      'Files, declarations, packages, roles and graph totals at a glance, with the coverage figures that say how complete the analysis is.',
    href: routes.dashboard(),
    icon: LayoutDashboard,
  },
  {
    title: 'Architecture Explorer',
    detail:
      'Package dependency graphs, role trees and cycles, drawn with a layered layout that renders the same picture every time.',
    href: routes.architecture(),
    icon: Network,
  },
  {
    title: 'Change Impact',
    detail:
      'What a change to one declaration could reach. Direct and indirect dependents stay separate, and unresolved edges are reported rather than dropped.',
    href: routes.impact(''),
    icon: Target,
  },
  {
    title: 'Repository Analysis',
    detail:
      'Paste a public GitHub URL. TraceIQ clones it, runs the same static analysis, and opens the result — no configuration, no plugin, no account.',
    href: routes.home(),
    icon: Github,
  },
  {
    title: 'AI Repository Expert',
    detail:
      'Ask in plain language. Every answer cites the graph facts behind it, lists what was left out, and carries a verdict on whether it stayed inside them.',
    href: routes.chat(),
    icon: MessageSquare,
  },
  {
    title: 'Semantic Search',
    detail:
      'Find declarations, files, routes and environment variables across the graph. Matching is exact or by prefix and ordered alphabetically, so results never shuffle between runs.',
    href: routes.search(),
    icon: Search,
  },
];

export function Features() {
  return (
    <Band aria-labelledby="features" className="border-y border-border bg-secondary/30">
      <BandHeading
        id="features"
        eyebrow="Features"
        title="Everything the graph knows, in one place"
        lede="Six views over a single analysis. Each reads the same knowledge graph, so they can never disagree with one another."
      />

      <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <li key={feature.title} className="animate-fade-up" style={stagger(index, 70)}>
            <Link
              href={feature.href}
              className="group flex h-full flex-col rounded-xl border border-border bg-card p-6 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <feature.icon className="h-5 w-5" />
                </span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </div>

              <h3 className="mt-5 font-semibold tracking-tight">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.detail}</p>
            </Link>
          </li>
        ))}
      </ul>
    </Band>
  );
}
