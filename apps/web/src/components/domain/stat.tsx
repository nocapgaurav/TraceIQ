import { Card } from '@/components/ui/card';
import { count } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * One number with a label. The building block of every summary strip.
 *
 * `compact` shrinks the figure for places where the numbers are supporting detail rather than the point
 * of the page — the Repository Overview's metrics section, where they sit below the answer to "what is
 * this repository?" instead of standing in for it. The default is unchanged, so the five pages that do
 * lead with their figures keep the larger treatment.
 */
export function Stat({
  label,
  value,
  detail,
  tone,
  compact = false,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly detail?: string;
  readonly tone?: 'default' | 'warning' | 'danger';
  readonly compact?: boolean;
}) {
  return (
    <Card className={compact ? 'p-2.5' : 'p-3'}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 font-semibold tabular-nums',
          compact ? 'text-lg' : 'text-2xl',
          tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-destructive' : undefined,
        )}
      >
        {typeof value === 'number' ? count(value) : value}
      </p>
      {detail === undefined ? null : <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </Card>
  );
}

export function StatGrid({
  children,
  compact = false,
}: {
  readonly children: React.ReactNode;
  readonly compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid gap-3',
        compact
          ? 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6'
          : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
      )}
    >
      {children}
    </div>
  );
}
