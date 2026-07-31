import { cn } from '@/lib/utils';

/**
 * The landing page's own layout primitives.
 *
 * The application chrome is built for dense, scannable data: `PageHeader` truncates to one line, `Section`
 * sets a 14px heading, and `main` caps content at 1600px. A landing page wants the opposite — generous
 * measure, large type, air between bands — so it gets its own two primitives rather than fighting the
 * ones tuned for tables.
 *
 * Everything below still draws on the shared token set. No literal colour appears in this directory.
 */

/**
 * One full-width horizontal band.
 *
 * `bleed` cancels the padding `AppShell` puts on `<main>`, so a band's background reaches the edge of the
 * frame while its text stays on the same measure as every other band. Without it a tinted section would
 * float with a 16px gutter of page background around it, which reads as a mistake.
 */
export function Band({
  children,
  className,
  innerClassName,
  as: Component = 'section',
  ...props
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly innerClassName?: string;
  readonly as?: 'section' | 'div';
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Component className={cn('relative px-4 py-20 sm:py-24', className)} {...props}>
      <div className={cn('mx-auto w-full max-w-6xl', innerClassName)}>{children}</div>
    </Component>
  );
}

/**
 * The heading block that opens a band: a small label, a large title, and a sentence of context.
 *
 * The eyebrow is `aria-hidden`. It is a visual signpost repeating what the title already says, and a
 * screen reader announcing "How it works — Three steps from repository to answer" gains nothing from
 * hearing the category twice.
 */
export function BandHeading({
  eyebrow,
  title,
  lede,
  id,
  className,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede?: string;
  readonly id?: string;
  readonly className?: string;
}) {
  return (
    <div className={cn('mx-auto max-w-2xl text-center', className)}>
      <p aria-hidden className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
        {eyebrow}
      </p>
      <h2 id={id} className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h2>
      {lede === undefined ? null : (
        <p className="mt-4 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">{lede}</p>
      )}
    </div>
  );
}

/**
 * A stagger delay for an entrance animation.
 *
 * Capped, because the delay is decorative and an uncapped `index * step` would leave the last card of a
 * long list blank for most of a second. Reduced motion zeroes it in `globals.css`.
 */
export function stagger(index: number, step = 70, max = 420): React.CSSProperties {
  return { animationDelay: `${Math.min(index * step, max)}ms` };
}
