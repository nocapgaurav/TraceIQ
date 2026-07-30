/**
 * Display helpers.
 *
 * Presentation only: nothing here computes a repository fact, and every input came from the API.
 */

/** Trims an identity prefix for display. The full identifier stays available for navigation. */
export function shortId(id: string): string {
  return id.replace(/^(sym|file|route|env|ext):/, '');
}

/** The declaration name from an identifier — everything after the `#`, or the file path. */
export function symbolName(id: string): string {
  const hash = id.indexOf('#');

  return hash === -1 ? shortId(id) : id.slice(hash + 1);
}

/** The file part of a `sym:` identifier, or the whole path for a `file:` identifier. */
export function filePathOf(id: string): string {
  const withoutPrefix = shortId(id);
  const hash = withoutPrefix.indexOf('#');

  return hash === -1 ? withoutPrefix : withoutPrefix.slice(0, hash);
}

/** A ratio as a percentage, to one decimal place. */
export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** A count with thousands separators, using a fixed locale so output never depends on the host. */
export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function pluralise(value: number, singular: string, plural = `${singular}s`): string {
  return `${count(value)} ${value === 1 ? singular : plural}`;
}

/** Bytes as a human-readable size, for payload sizes the UI reports. */
export function bytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
}
