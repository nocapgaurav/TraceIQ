import { ArrowRight, Check, Quote, X } from 'lucide-react';
import Link from 'next/link';

import { Band, BandHeading, stagger } from '@/components/marketing/landing-section';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';

/**
 * Why TraceIQ: the argument the rest of the page is evidence for.
 *
 * A side-by-side, because the distinction is comparative and a list of virtues on its own would not
 * carry it. The left column describes how a general-purpose assistant necessarily behaves when its only
 * input is source text in a context window; the right describes what answering from a stored analysis
 * changes. Neither column names a competitor.
 */

const CONTRAST: readonly { readonly generic: string; readonly traceiq: string }[] = [
  {
    generic: 'Reads whatever source text fits in a context window',
    traceiq: 'Answers from a graph built by analysing the whole repository',
  },
  {
    generic: 'Infers relationships from how the code reads',
    traceiq: 'Resolves relationships with the TypeScript compiler, then stores them',
  },
  {
    generic: 'Sounds equally confident whether or not it knows',
    traceiq: 'Labels every fact CERTAIN, RESOLVED, INFERRED or AMBIGUOUS',
  },
  {
    generic: 'Cannot show where an answer came from',
    traceiq: 'Cites the exact facts behind every sentence',
  },
  {
    generic: 'May answer the same question differently each time',
    traceiq: 'Produces the same analysis, byte for byte, from the same repository',
  },
  {
    generic: 'Silently omits what it did not see',
    traceiq: 'Reports what was left out, and what the analysis could not resolve',
  },
];

export function WhyTraceIQ() {
  return (
    <Band aria-labelledby="why-traceiq">
      <BandHeading
        id="why-traceiq"
        eyebrow="Why TraceIQ"
        title="Grounded in analysis, not in guesswork"
        lede="A general-purpose assistant reads your code and predicts a plausible answer. TraceIQ analyses your code once, stores what it found, and answers from that — so an answer can be checked."
      />

      <div className="mt-14 grid gap-5 lg:grid-cols-2">
        <Column
          variant="generic"
          title="Generic AI assistant"
          caption="Working from source text alone"
          items={CONTRAST.map((row) => row.generic)}
        />
        <Column
          variant="traceiq"
          title="TraceIQ"
          caption="Working from a repository knowledge graph"
          items={CONTRAST.map((row) => row.traceiq)}
        />
      </div>

      <div className="animate-fade-up mt-6 rounded-xl border border-border bg-card p-6 sm:p-8" style={stagger(3)}>
        <Quote aria-hidden className="h-5 w-5 text-primary/40" />
        <p className="mt-3 text-pretty text-lg font-medium leading-relaxed tracking-tight sm:text-xl">
          The repository intelligence engine is the product. The AI is a consumer of it — it can read the
          facts the analysis produced, and it can read nothing else.
        </p>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          That boundary is structural rather than a matter of prompting. The AI layer is given assembled
          repository facts and has no route to the database, the graph or your source files. When it
          cannot answer from those facts, it says so — which is why an answer arrives with citations and a
          grounding verdict attached instead of a confident paragraph you would have to verify yourself.
        </p>

        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <Button className="group w-full sm:w-auto" asChild>
            <Link href={routes.chat()}>
              Ask the repository
              <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <Button variant="outline" className="w-full sm:w-auto" asChild>
            <Link href={routes.dashboard()}>Explore the analysis</Link>
          </Button>
        </div>
      </div>
    </Band>
  );
}

function Column({
  variant,
  title,
  caption,
  items,
}: {
  readonly variant: 'generic' | 'traceiq';
  readonly title: string;
  readonly caption: string;
  readonly items: readonly string[];
}) {
  const highlighted = variant === 'traceiq';
  const Icon = highlighted ? Check : X;

  return (
    <div
      className={
        highlighted
          ? 'animate-fade-up rounded-xl border border-primary/30 bg-card p-6 shadow-lg shadow-primary/5'
          : 'animate-fade-up rounded-xl border border-border bg-card/50 p-6'
      }
      style={stagger(highlighted ? 1 : 0, 90)}
    >
      <h3 className={highlighted ? 'font-semibold tracking-tight text-primary' : 'font-semibold tracking-tight'}>
        {title}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{caption}</p>

      <ul className="mt-5 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item} className="flex gap-3 text-sm leading-relaxed">
            <span
              aria-hidden
              className={
                highlighted
                  ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary'
                  : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
              }
            >
              <Icon className="h-3 w-3" />
            </span>
            <span className={highlighted ? 'text-foreground' : 'text-muted-foreground'}>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
