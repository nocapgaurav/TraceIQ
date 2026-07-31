'use client';

import { ExternalLink, MessageSquare, Network, Search } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RepositoryIdentity } from '@/lib/repository-identity';
import type { RepositoryProfile } from '@/lib/repository-profile';
import { routes } from '@/lib/routes';

/**
 * The top of the Repository Overview: which repository this is, before any metric.
 *
 * The headline is the repository's real name where one is known. It is known when the repository was
 * analysed from GitHub, because the analysis record carries the `owner/name` — the graph itself does not,
 * since for a cloned repository it stores the temporary workspace directory instead.
 *
 * Where no name is known the heading says so plainly and the page still works; every identity field
 * degrades on its own rather than the block vanishing.
 */
export function OverviewHero({
  profile,
  identity,
}: {
  readonly profile: RepositoryProfile;
  readonly identity: RepositoryIdentity;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-6 sm:p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-primary/[0.07] to-transparent"
      />

      <div className="relative">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-full text-[11px]">
            Overview
          </Badge>
          <Badge variant="secondary" className="rounded-full text-[11px]">
            {profile.shape.value}
          </Badge>
        </div>

        <h1 className="mt-4 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {identity.owner === null ? null : (
            <span className="font-normal text-muted-foreground">{identity.owner} /</span>
          )}
          <span>{identity.name ?? 'Analysed repository'}</span>
        </h1>

        {identity.anonymous ? (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            This graph was scanned from a local path, so no repository name was recorded. Analyse a GitHub
            repository to see its identity here.
          </p>
        ) : null}

        {/* Identity, each value beside the reason it is known. */}
        {identity.fields.length === 0 ? null : (
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            {identity.fields.map((field) => (
              <div key={field.label} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{field.label}</dt>
                <dd className="mt-0.5 text-sm" title={field.evidence}>
                  {field.label === 'GitHub' ? (
                    <a
                      href={field.value}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {field.value.replace('https://', '')}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : (
                    <span className="font-medium">{field.value}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {identity.unknown.length === 0 ? null : (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Not recorded by the analysis: {identity.unknown.join(', ')}.
          </p>
        )}

        <p className="mt-4 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
          {profile.description.value}
        </p>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Derived from static analysis — {profile.description.evidence}. Not a model-written summary.
        </p>

        {/* Compact pills, not cards: the numbers are context for the sentence above, not the point of
            the page. The full metric set lives at the bottom. */}
        <ul className="mt-6 flex flex-wrap gap-2">
          {profile.stack.map((item) => (
            <li key={item.label}>
              <span
                title={item.detail}
                className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium"
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-7 flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link href={routes.chat()}>
              <MessageSquare className="h-3.5 w-3.5" />
              Ask TraceIQ
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={routes.architecture()}>
              <Network className="h-3.5 w-3.5" />
              Architecture
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={routes.search()}>
              <Search className="h-3.5 w-3.5" />
              Search
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
