import { count, percent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Distribution } from '@/types/api';

/**
 * Charts, drawn with CSS and SVG.
 *
 * No charting library: none is in the approved stack, and every chart this app needs is a bar or a
 * ratio over at most a few dozen points. A dependency would add weight without adding a capability.
 *
 * Each chart is also a table in the accessibility tree — the bars carry `role="img"` with a label, and
 * the numbers are always written next to them, so nothing is conveyed by length alone.
 */

export interface BarDatum {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'default' | 'warning' | 'danger';
}

const TONE: Readonly<Record<string, string>> = {
  default: 'bg-primary',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export function BarChart({
  data,
  caption,
  max,
}: {
  readonly data: readonly BarDatum[];
  readonly caption: string;
  readonly max?: number;
}) {
  const ceiling = max ?? data.reduce((highest, datum) => Math.max(highest, datum.value), 0);

  if (data.length === 0) {
    return <p className="py-4 text-xs text-muted-foreground">{caption}: nothing recorded</p>;
  }

  return (
    <table className="w-full text-xs">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {data.map((datum) => (
          <tr key={datum.label}>
            <th scope="row" className="w-[38%] py-1 pr-2 text-left font-normal text-muted-foreground">
              <span className="block truncate" title={datum.label}>
                {datum.label}
              </span>
            </th>
            <td className="py-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full', TONE[datum.tone ?? 'default'])}
                  style={{ width: ceiling === 0 ? '0%' : `${Math.max((datum.value / ceiling) * 100, datum.value > 0 ? 1.5 : 0)}%` }}
                />
              </div>
            </td>
            <td className="w-14 py-1 pl-2 text-right tabular-nums">{count(datum.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A ratio, shown as a bar and a percentage. Used for coverage figures. */
export function RatioBar({ label, value, detail }: { readonly label: string; readonly value: number; readonly detail?: string }) {
  const tone = value >= 0.75 ? 'bg-success' : value >= 0.4 ? 'bg-warning' : 'bg-destructive';

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{percent(value)}</span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${percent(value)}`}
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }} />
      </div>
      {detail === undefined ? null : <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

/**
 * A distribution's five figures.
 *
 * Shown as numbers rather than a box plot: the API reports exactly min/median/mean/p90/max, and drawing
 * a box plot from five summary values would imply a shape of the underlying data that was never sent.
 */
export function DistributionRow({ label, distribution }: { readonly label: string; readonly distribution: Distribution }) {
  const cells: readonly [string, number][] = [
    ['min', distribution.min],
    ['median', distribution.median],
    ['mean', Number(distribution.mean.toFixed(2))],
    ['p90', distribution.p90],
    ['max', distribution.max],
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-2 last:border-0">
      <span className="w-40 shrink-0 text-xs text-muted-foreground">{label}</span>
      {cells.map(([name, value]) => (
        <span key={name} className="text-xs tabular-nums">
          <span className="text-muted-foreground">{name}</span> {count(value)}
        </span>
      ))}
    </div>
  );
}

/** A record of counts as a bar chart, largest first. Ordering is by value then name, so it is stable. */
export function CountsChart({
  counts,
  caption,
  limit = 12,
}: {
  readonly counts: Readonly<Record<string, number>>;
  readonly caption: string;
  readonly limit?: number;
}) {
  const data = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));

  return <BarChart data={data} caption={caption} />;
}
