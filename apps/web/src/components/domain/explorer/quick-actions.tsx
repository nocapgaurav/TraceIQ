'use client';

import { MessageSquare, Network, Search, Target } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';

/**
 * The actions offered on a file or a declaration.
 *
 * Defined once so the two panels cannot drift apart, and so an action that is unavailable for a subject
 * says why rather than silently disappearing — a missing button reads as an oversight, a disabled one
 * with a reason reads as a boundary.
 */
export interface QuickAction {
  readonly label: string;
  readonly href: string | null;
  /** Present when `href` is null: why this action cannot be taken for this subject. */
  readonly unavailable?: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

export function QuickActions({ actions }: { readonly actions: readonly QuickAction[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) =>
        action.href === null ? (
          <Button
            key={action.label}
            size="sm"
            variant="outline"
            disabled
            title={action.unavailable}
            aria-label={`${action.label} — ${action.unavailable ?? 'unavailable'}`}
          >
            <action.icon className="h-3.5 w-3.5" />
            {action.label}
          </Button>
        ) : (
          <Button key={action.label} size="sm" variant="outline" asChild>
            <Link href={action.href}>
              <action.icon className="h-3.5 w-3.5" />
              {action.label}
            </Link>
          </Button>
        ),
      )}
    </div>
  );
}

/**
 * Actions for one declaration. Every one is available: a `sym:` identifier is what Impact, Search and
 * Chat all accept.
 */
export function declarationActions(id: string, name: string): readonly QuickAction[] {
  return [
    { label: 'Impact', href: routes.impact(id), icon: Target },
    { label: 'Search', href: routes.search(name), icon: Search },
    { label: 'Ask TraceIQ', href: routes.chat(`What does ${name} do, and what depends on it?`, id), icon: MessageSquare },
    { label: 'Architecture', href: routes.architecture(), icon: Network },
  ];
}

/**
 * Actions for one file.
 *
 * **Impact carries no file link, and that is not an omission.** `GET /impact/{id}` accepts only a `sym:`
 * declaration identifier — a `file:` one is rejected as naming no declaration — so impact for a whole
 * file is not a question the API answers. The button states that instead of pretending, and the
 * declarations listed on the same panel each lead to their own impact.
 */
export function fileActions(path: string): readonly QuickAction[] {
  return [
    {
      label: 'Impact',
      href: null,
      unavailable: 'impact is analysed per declaration; choose one from the list below',
      icon: Target,
    },
    { label: 'Ask TraceIQ', href: routes.chat(`What is ${path} responsible for?`, `file:${path}`), icon: MessageSquare },
    { label: 'Architecture', href: routes.architecture(), icon: Network },
  ];
}

/** Actions for one package. */
export function packageActions(name: string): readonly QuickAction[] {
  return [
    { label: 'Ask TraceIQ', href: routes.chat(`What is the ${name} package for?`, `pkg:${name}`), icon: MessageSquare },
    { label: 'Architecture', href: routes.architecture(), icon: Network },
    { label: 'Search', href: routes.search(name), icon: Search },
  ];
}
