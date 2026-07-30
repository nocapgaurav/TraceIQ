import { count, pluralise } from '@/lib/format';
import type { Listing } from '@/types/api';

/**
 * What a capped list left out.
 *
 * The API's `Listing` carries an exact `total` alongside a possibly-shortened `entries`, precisely so a
 * cap is never silent. Rendering only `entries` would throw that away and quietly imply the list is
 * complete, so every capped list in the UI shows this.
 */
export function ListingNote({
  listing,
  noun,
  plural,
}: {
  readonly listing: Listing<unknown>;
  readonly noun: string;
  /** Needed where the plural is not the singular plus `s` — `entry`/`entries`, `dependency`/`dependencies`. */
  readonly plural?: string;
}) {
  const written = plural === undefined ? pluralise(listing.total, noun) : pluralise(listing.total, noun, plural);

  if (!listing.truncated) {
    return <p className="px-2 py-1 text-[11px] text-muted-foreground">{written}</p>;
  }

  return (
    <p className="px-2 py-1 text-[11px] text-warning">
      showing {count(listing.entries.length)} of {written} — the API caps this list
    </p>
  );
}
