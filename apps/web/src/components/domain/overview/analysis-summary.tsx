'use client';

import { Check } from 'lucide-react';

import { OverviewSection } from '@/components/domain/overview/shared';
import { Card, CardContent } from '@/components/ui/card';
import { analysisSummary } from '@/lib/repository-identity';
import type { Overview } from '@/types/api';

/**
 * Analysis Summary — what this run established, in one glance.
 *
 * Ticks, because every line is something the analysis actually found. A fact that came out zero is not
 * listed: "0 HTTP routes detected" says nothing about the repository, only about what was looked for.
 * Nothing here is a target or a score, so there is no line a reader could read as a grade.
 *
 * The counts also appear in Repository metrics at the foot of the page. That is deliberate — this
 * section answers "what did TraceIQ discover?" in a sentence each, and the metrics section is the
 * reference table behind it.
 */
export function AnalysisSummary({ overview }: { readonly overview: Overview }) {
  const facts = analysisSummary(overview);

  return (
    <OverviewSection
      id="analysis-summary"
      title="Analysis summary"
      description="What the analysis established about this repository."
    >
      <Card>
        <CardContent className="grid gap-x-8 gap-y-2.5 p-5 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.text} className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm">{fact.text}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                  {fact.evidence}
                </span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </OverviewSection>
  );
}
