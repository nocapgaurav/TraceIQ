'use client';

import { ArrowRight, GitBranch, Search, Target } from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';
import { routes } from '@/lib/routes';

/**
 * Impact, before anything is selected.
 *
 * The page used to say "No declaration chosen", which tells a reader what they have not done and nothing
 * about why they would. This says what the feature answers, what it is careful about, and where to pick a
 * subject — the three things somebody arriving here for the first time needs.
 *
 * No repository data is read: this renders identically whether or not a graph is loaded, because the
 * explanation of what Impact does is not a property of any particular repository.
 */
export function ImpactOnboarding() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 py-4">
      <div>
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-xl font-semibold tracking-tight">What would this change break?</h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Impact analysis works out which parts of the repository a change to one declaration could reach.
          It follows the relationships the analysis resolved — calls, references, imports and type
          references — outwards from whatever you select, and reports what it finds.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-5">
          <div>
            <h3 className="text-sm font-medium">Choose something to analyse</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Impact is computed for one <strong>declaration</strong> at a time — a class, function,
              method, interface or variable. Open a package or file in the Explorer and pick a declaration
              inside it, or search for one by name.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href={routes.explorer()}
              className="group inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              Browse the Explorer
              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
            <Link
              href={routes.search()}
              className="group inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              Search by name
              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h3 className="text-sm font-medium">What you get back</h3>
          <ul className="mt-2 flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
            <li>
              <strong className="text-foreground">Direct and indirect dependents, kept apart.</strong> What
              references the declaration itself, and what reaches it through something else. Merging them
              would hide how far a change actually travels.
            </li>
            <li>
              <strong className="text-foreground">The blast radius in files and packages.</strong> How
              widely the affected declarations are spread, not just how many there are.
            </li>
            <li>
              <strong className="text-foreground">What could not be resolved.</strong> Calls the analysis
              could not bind are reported as unknown rather than dropped — so the answer is a floor, never
              a promise that nothing else is affected.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
