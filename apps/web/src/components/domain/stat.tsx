import { Card } from '@/components/ui/card';
import { count } from '@/lib/format';
import { cn } from '@/lib/utils';

/** One number with a label. The building block of every summary strip. */
export function Stat({
  label,
  value,
  detail,
  tone,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly detail?: string;
  readonly tone?: 'default' | 'warning' | 'danger';
}) {
  return (
    <Card className="p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-destructive' : undefined,
        )}
      >
        {typeof value === 'number' ? count(value) : value}
      </p>
      {detail === undefined ? null : <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </Card>
  );
}

export function StatGrid({ children }: { readonly children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{children}</div>;
}
