import { Info } from 'lucide-react';

import { UNAVAILABLE } from '@/lib/repository-profile';
import { cn } from '@/lib/utils';

/**
 * Pieces the Repository Overview sections share.
 *
 * Kept together so a gap in the data looks the same everywhere. A reader should learn the shape of
 * "we do not know this yet" once, and then recognise it instantly wherever it appears.
 */

/**
 * What a field shows when the value cannot be determined.
 *
 * Not an error and not an empty state — the analysis succeeded, and this particular fact is simply not
 * something it produces yet. It reads as a pending capability rather than a failure, and it is never
 * silently replaced with a plausible-looking value.
 */
export function Unavailable({ className }: { readonly className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <Info className="h-3 w-3 shrink-0" aria-hidden />
      {UNAVAILABLE}
    </span>
  );
}

/**
 * One labelled fact.
 *
 * `evidence` is what makes this honest rather than decorative: a derived claim carries the figures it
 * came from, in the same place the claim is made. Where there is no value the row still appears — a
 * missing row would hide the fact that the field exists at all.
 */
export function Fact({
  label,
  evidence,
  children,
}: {
  readonly label: string;
  readonly evidence?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border py-3 last:border-b-0 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm sm:mt-0">
        {children}
        {evidence === undefined ? null : (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{evidence}</p>
        )}
      </dd>
    </div>
  );
}

/** A section heading for the overview page: title, optional count, optional trailing control. */
export function OverviewSection({
  title,
  description,
  id,
  action,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: string;
  readonly id?: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    // `min-w-0` is required, not cosmetic. This is a flex item inside the page's column *and* a flex
    // container itself, and a flex item defaults to `min-width: auto` — which means it sizes to its widest
    // content and defeats the `overflow-x-auto` the table primitive already provides. Without it the wide
    // packages table pushed the whole page sideways on a phone.
    <section aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
