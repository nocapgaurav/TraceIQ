'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Band, stagger } from '@/components/marketing/landing-section';
import { AnalysisDialog } from '@/components/domain/analysis/analysis-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useVersion } from '@/hooks/queries';
import { routes } from '@/lib/routes';

/**
 * The hero.
 *
 * Client-side for two reasons and no others: the primary call to action opens a dialog, and the status
 * pill reads `/version`. Everything else on the landing page is static and stays on the server.
 */
export function Hero() {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <Band className="overflow-hidden border-b border-border pb-20 pt-16 sm:pb-28 sm:pt-24">
      <HeroBackdrop />

      <div className="relative flex flex-col items-center text-center">
        <div className="animate-fade-in">
          <Badge variant="outline" className="gap-2 rounded-full py-1 pl-1.5 pr-3 text-[11px]">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">v1.0</span>
            Repository Intelligence Platform
          </Badge>
        </div>

        <h1
          className="animate-fade-up mt-6 max-w-4xl text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl"
          style={stagger(1)}
        >
          Understand Any Repository in Minutes
        </h1>

        <p
          className="animate-fade-up mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl"
          style={stagger(2)}
        >
          AI-powered repository intelligence built on deterministic static analysis.
        </p>

        <div className="animate-fade-up mt-9 flex flex-col items-center gap-3 sm:flex-row" style={stagger(3)}>
          {/* Opens the analysis dialog. Real work now: a URL, a clone, and the pipeline. */}
          <Button
            size="lg"
            className="group w-full px-7 shadow-sm sm:w-auto"
            onClick={() => {
              setImportOpen(true);
            }}
          >
            Analyze Repository
            <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </Button>
          <Button size="lg" variant="outline" className="w-full px-7 sm:w-auto" asChild>
            <Link href={routes.dashboard()}>View Demo</Link>
          </Button>
        </div>

        <div className="animate-fade-up mt-7" style={stagger(4)}>
          <GraphStatus />
        </div>

        <dl
          className="animate-fade-up mt-16 grid w-full max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4"
          style={stagger(5)}
        >
          {VOCABULARY.map((item) => (
            <div key={item.label} className="bg-card px-4 py-5">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>
        <p className="animate-fade-up mt-3 text-xs text-muted-foreground" style={stagger(6)}>
          A closed vocabulary. Confidence is one of four levels, never a score.
        </p>
      </div>

      <AnalysisDialog open={importOpen} onOpenChange={setImportOpen} />
    </Band>
  );
}

/** The frozen graph vocabulary. Fixed counts, not measurements — they do not vary by repository. */
const VOCABULARY: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'Node kinds', value: '16' },
  { label: 'Relationships', value: '13' },
  { label: 'Confidence levels', value: '4' },
  { label: 'Roles', value: '6' },
];

/**
 * Decoration only, and marked as such: a rule grid fading out under a soft primary wash.
 *
 * `aria-hidden` plus `pointer-events-none` — it must never take a click from the buttons above it, nor
 * appear in the accessibility tree as an unlabelled region.
 */
function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="grid-backdrop absolute inset-0 opacity-[0.5] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)] dark:opacity-40" />
      <div className="absolute left-1/2 top-[-18rem] h-[34rem] w-[64rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl dark:bg-primary/15" />
    </div>
  );
}

/**
 * Whether the API currently holds a graph, read from `/version`.
 *
 * Reserves its own height while loading so the block below does not jump when the answer lands, and
 * renders nothing at all if the request fails — a landing page should not open with an error banner
 * about an endpoint the visitor did not ask for. The dashboard reports the failure properly.
 */
function GraphStatus() {
  const version = useVersion();

  if (version.isPending || version.isError) {
    return <div className="h-6" aria-hidden />;
  }

  const loaded = version.data.scanned;

  return (
    // `min-h-6` rather than `h-6`: the reserved height has to match the loading placeholder so the page
    // does not jump, but on a narrow phone this sentence wraps to two lines and a fixed height would
    // clip the second one.
    <p className="flex min-h-6 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {/* The dot and its sentence are one flex item, so a narrow screen never leaves the dot stranded. */}
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden
          className={
            loaded ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-success' : 'h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground'
          }
        />
        {loaded ? 'A repository graph is loaded — the demo is live data.' : 'No graph loaded yet.'}
      </span>
      <span className="font-mono text-[11px]">api {version.data.version}</span>
    </p>
  );
}
