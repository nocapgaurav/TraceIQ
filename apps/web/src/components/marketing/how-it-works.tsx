import { MessageSquare, Network, ScanLine } from 'lucide-react';

import { Band, BandHeading, stagger } from '@/components/marketing/landing-section';

/**
 * How it works: three steps, in the order they actually happen.
 *
 * The connector between the cards is drawn only from `lg` up, where the three sit on one row. Stacked on
 * a phone a horizontal rule would point sideways at nothing.
 */

interface Step {
  readonly title: string;
  readonly detail: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

const STEPS: readonly Step[] = [
  {
    title: 'Analyze',
    detail: 'Static analysis scans the repository and builds an intelligence graph.',
    icon: ScanLine,
  },
  {
    title: 'Understand',
    detail: 'Automatically discover architecture, packages, entry points and relationships.',
    icon: Network,
  },
  {
    title: 'Ask AI',
    detail: 'Chat with an AI grounded entirely in repository facts.',
    icon: MessageSquare,
  },
];

export function HowItWorks() {
  return (
    <Band aria-labelledby="how-it-works">
      <BandHeading
        id="how-it-works"
        eyebrow="How it works"
        title="Three steps from repository to answer"
        lede="Each step reads the output of the one before it. Nothing re-reads your source code."
      />

      {/*
       * The connector sits outside the list, not inside it. An `<ol>` may contain only `<li>` — a stray
       * `<div>` is invalid markup and can disturb how assistive technology counts the items — so the
       * rule is a sibling positioned against a shared wrapper instead.
       */}
      <div className="relative mt-14">
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-[3.25rem] hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block"
        />

        <ol className="relative grid gap-6 lg:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="animate-fade-up group relative flex flex-col rounded-xl border border-border bg-card p-6 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
              style={stagger(index, 90)}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-background text-primary transition-colors duration-200 group-hover:border-primary/40 group-hover:bg-primary/5">
                  <step.icon className="h-5 w-5" />
                </span>
                <span
                  aria-hidden
                  className="font-mono text-4xl font-semibold leading-none text-border transition-colors duration-200 group-hover:text-primary/30"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>

              <h3 className="mt-5 text-lg font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </Band>
  );
}
