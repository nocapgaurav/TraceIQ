'use client';

import Link from 'next/link';

import { Fact, OverviewSection, Unavailable } from '@/components/domain/overview/shared';
import { Card } from '@/components/ui/card';
import { count, pluralise } from '@/lib/format';
import type { RepositoryProfile } from '@/lib/repository-profile';
import { routes } from '@/lib/routes';

/**
 * Section 1 — Repository Summary.
 *
 * Seven fields, four of which the analysis can fill today. The other three appear anyway, showing what
 * they will hold rather than being hidden: a reader should be able to see the whole shape of the answer,
 * including the parts that are still missing.
 */
export function RepositorySummary({ profile }: { readonly profile: RepositoryProfile }) {
  return (
    <OverviewSection
      id="repository-summary"
      title="Repository summary"
      description="What the analysis can say about this repository, and what it cannot yet."
    >
      <Card className="px-5 py-1">
        <dl>
          <Fact label="Purpose">
            <Unavailable />
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              What a repository is <em>for</em> is not recoverable from its structure.
            </p>
          </Fact>

          <Fact
            label="Architecture style"
            {...(profile.architectureStyle === null ? {} : { evidence: profile.architectureStyle.evidence })}
          >
            {profile.architectureStyle === null ? <Unavailable /> : profile.architectureStyle.value}
          </Fact>

          <Fact label="Languages" evidence={profile.languages.evidence}>
            <TagList items={profile.languages.value} />
          </Fact>

          <Fact
            label="Frameworks"
            {...(profile.frameworks === null ? {} : { evidence: profile.frameworks.evidence })}
          >
            {profile.frameworks === null ? (
              <>
                <Unavailable />
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  The analysis reports what framework extraction found — routes, environment variables — but
                  does not name the framework itself.
                </p>
              </>
            ) : (
              <TagList items={profile.frameworks.value} />
            )}
          </Fact>

          <Fact label="Main packages" evidence="the largest packages by declaration count">
            {profile.mainPackages.length === 0 ? (
              <Unavailable />
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {profile.mainPackages.map((entry) => (
                  <li key={entry.name}>
                    <Link
                      href={routes.package(entry.name)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {entry.name}
                      <span className="text-muted-foreground">{count(entry.declarations)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Fact>

          <Fact
            label="Entry points"
            {...(profile.entryPoints === null ? {} : { evidence: profile.entryPoints.evidence })}
          >
            {profile.entryPoints === null ? (
              <>
                <Unavailable />
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  No routes or controller roles were recorded, which are the two entry points the analysis
                  identifies. That is an absence of evidence, not evidence of absence.
                </p>
              </>
            ) : (
              <TagList items={profile.entryPoints.value} />
            )}
          </Fact>

          <Fact label="Important directories" evidence="packages grouped by their first path segment">
            {profile.importantDirectories.length === 0 ? (
              <Unavailable />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {profile.importantDirectories.map((entry) => (
                  <li key={entry.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-xs">{entry.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {pluralise(entry.packages, 'package')} · {pluralise(entry.files, 'file')} ·{' '}
                      {pluralise(entry.declarations, 'declaration')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
        </dl>
      </Card>
    </OverviewSection>
  );
}

function TagList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item} className="rounded-md border border-border bg-secondary/50 px-2 py-0.5 text-xs">
          {item}
        </li>
      ))}
    </ul>
  );
}
