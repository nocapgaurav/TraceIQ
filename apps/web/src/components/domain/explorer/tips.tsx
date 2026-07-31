'use client';

import { Activity, Boxes, FileCode2, MessageSquare, MousePointerClick, Target } from 'lucide-react';
import Link from 'next/link';

import { ScrollArea } from '@/components/ui/scroll-area';
import { routes } from '@/lib/routes';

/**
 * Repository Tips.
 *
 * The vocabulary a newcomer needs to read anything else on the page. It is static prose deliberately —
 * these explain what TraceIQ's terms *mean*, which does not vary by repository, so deriving them from the
 * graph would be pointless indirection.
 *
 * Nothing here states a fact about the loaded repository; every number on this page lives in a panel that
 * fetched it.
 */
interface Tip {
  readonly title: string;
  readonly body: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
  readonly link?: { readonly label: string; readonly href: string };
}

const TIPS: readonly Tip[] = [
  {
    icon: Boxes,
    title: 'What a package is',
    body: 'Not an npm package — the first two segments of a file path. TraceIQ derives them from the layout on disk, so apps/api and packages/query are packages, and a repository with no nested directories has none.',
  },
  {
    icon: FileCode2,
    title: 'What a declaration is',
    body: 'Anything the code names: a class, interface, function, method, property, type alias, route or environment variable. Sixteen kinds in all. Each carries where it was declared and how confident the analysis is about it.',
  },
  {
    icon: MousePointerClick,
    title: 'How to navigate',
    body: 'Groups on the left are directories. Open one, choose a package, and its files appear beneath it. Choosing a file lists what it declares; choosing a declaration opens its full record. The URL follows you, so any view can be shared.',
  },
  {
    icon: Target,
    title: 'How to use Impact',
    body: 'Impact answers what a change to one declaration could reach. Direct and indirect dependents stay separate, and relationships the analysis could not resolve are reported rather than dropped — so the answer is a floor, never a guess.',
    link: { label: 'Open Impact', href: routes.impact() },
  },
  {
    icon: MessageSquare,
    title: 'How to use Ask TraceIQ',
    body: 'Ask TraceIQ from any panel and the question arrives with that package, file or declaration already set as its subject. Every answer cites the graph facts behind it and carries a verdict saying whether it stayed inside them. The model never sees your source code.',
    link: { label: 'Start a conversation', href: routes.chat() },
  },
  {
    icon: Activity,
    title: 'When something is missing',
    body: 'An empty list usually means the analysis could not resolve that relationship, not that none exists. Counts are lower bounds, and each panel says which caps applied.',
  },
];

export function RepositoryTips() {
  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Repository tips
      </p>
      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-4 p-3">
          {TIPS.map((tip) => (
            <li key={tip.title}>
              <div className="flex items-center gap-2">
                <tip.icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                <h3 className="text-xs font-semibold">{tip.title}</h3>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{tip.body}</p>
              {tip.link === undefined ? null : (
                <Link
                  href={tip.link.href}
                  className="mt-1.5 inline-block text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tip.link.label} →
                </Link>
              )}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}
