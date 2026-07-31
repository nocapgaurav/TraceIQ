import { count, pluralise } from '@/lib/format';
import type { Listing } from '@/types/api';

/**
 * What a capped list left out.
 *
 * The API's `Listing` carries an exact `total` alongside a possibly-shortened `entries`, precisely so a
 * cap is never silent. Rendering only `entries` would throw that away and quietly imply the list is
 * complete, so every capped list in the UI shows this.
 *
 * `cappedBy` names who did the capping. Usually the API, but the Repository Overview shortens some lists
 * further for display — and saying "the API caps this list" there would be false. A cap must be visible
 * *and* correctly attributed, or the reader draws the wrong conclusion about the data.
 */
export function ListingNote({
  listing,
  noun,
  plural,
  cappedBy = 'the API',
}: {
  readonly listing: Listing<unknown>;
  readonly noun: string;
  /** Needed where the plural is not the singular plus `s` — `entry`/`entries`, `dependency`/`dependencies`. */
  readonly plural?: string;
  readonly cappedBy?: string;
}) {
  const written = plural === undefined ? pluralise(listing.total, noun) : pluralise(listing.total, noun, plural);

  if (!listing.truncated) {
    return <p className="px-2 py-1 text-[11px] text-muted-foreground">{written}</p>;
  }

  return (
    <p className="px-2 py-1 text-[11px] text-warning">
      showing {count(listing.entries.length)} of {written} — {cappedBy} caps this list
    </p>
  );
}
