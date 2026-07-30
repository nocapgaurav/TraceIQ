import { ListingNote } from '@/components/domain/listing-note';
import { NodePill } from '@/components/domain/node-pill';
import { EmptyState } from '@/components/domain/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count } from '@/lib/format';
import type { Listing, NodeMetric } from '@/types/api';

/**
 * A ranked list of nodes with their connectivity figures.
 *
 * **All four numbers are shown, not one.** The API orders each hotspot list by its own criterion —
 * `mostCoupled` by total coupling, `mostConnectedFiles` by edge count — and picking a single column to
 * display would silently claim that column was the ordering. Showing fan-in, fan-out and both edge
 * counts states what was measured and leaves the reader to see why a row is where it is.
 *
 * Fan-in and fan-out count *distinct* neighbours; the edge counts count relationships, so an edge count
 * is always the larger of the pair.
 */
export function MetricList({
  title,
  description,
  listing,
}: {
  readonly title: string;
  readonly description?: string;
  readonly listing: Listing<NodeMetric>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description === undefined ? null : (
          <p className="text-[11px] font-normal text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="p-1">
        {listing.entries.length === 0 ? (
          <EmptyState title="Nothing recorded" />
        ) : (
          <>
            <div className="flex items-center gap-2 px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="flex-1">node</span>
              <span className="w-10 shrink-0 text-right" title="distinct nodes referencing this one">
                fan in
              </span>
              <span className="w-10 shrink-0 text-right" title="distinct nodes this one references">
                fan out
              </span>
              <span className="w-12 shrink-0 pr-1 text-right" title="incoming and outgoing edges">
                edges
              </span>
            </div>
            <ul>
              {listing.entries.map((entry) => (
                <li key={entry.node.id} className="flex items-center gap-2">
                  <NodePill node={entry.node} showPath={false} className="min-w-0 flex-1" />
                  <span className="w-10 shrink-0 text-right tabular-nums text-[11px]">{count(entry.fanIn)}</span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-[11px]">{count(entry.fanOut)}</span>
                  <span className="w-12 shrink-0 pr-1 text-right tabular-nums text-[11px] text-muted-foreground">
                    {count(entry.incomingEdges)}/{count(entry.outgoingEdges)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <ListingNote listing={listing} noun="entry" plural="entries" />
      </CardContent>
    </Card>
  );
}
