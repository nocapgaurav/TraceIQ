/**
 * Every internal link, built in one place.
 *
 * **Identifiers travel as a query parameter, not a path segment.** A `sym:` identifier contains both
 * slashes and a `#`; as a path segment the slashes would need a catch-all route and the `#` would be
 * read as a URL fragment and dropped before the server ever saw it. `encodeURIComponent` in a query
 * string escapes both, and `useSearchParams` decodes them back, so an identifier survives a round trip
 * unchanged.
 */
export const routes = {
  /** The landing page. The root is marketing; the application starts at `dashboard`. */
  home: () => '/',
  dashboard: () => '/dashboard',
  explorer: () => '/explorer',
  architecture: () => '/architecture',
  health: () => '/health',
  /**
   * Chat, optionally with a question already asked and a subject to ask it about.
   *
   * The Repository Overview and the Explorer hand off this way rather than running a second copy of the
   * chat pipeline. `subject` uses the same prefixed vocabulary the CLI's `--subject` accepts — `sym:…`,
   * `file:…`, `pkg:…` — so one spelling covers every interface. Omitted, the subject is the repository.
   */
  chat: (question?: string, subject?: string) =>
    withQuery('/chat', [
      ['q', question],
      ['subject', subject],
    ]),
  search: (query?: string) => (query === undefined || query === '' ? '/search' : `/search?q=${encodeURIComponent(query)}`),
  symbol: (id: string) => `/symbol?id=${encodeURIComponent(id)}`,
  // Optional, like `search`: the page has an empty state that asks for a declaration, so linking to it
  // without one is a valid entry point rather than a broken link with a dangling `?id=`.
  impact: (id?: string) => (id === undefined || id === '' ? '/impact' : `/impact?id=${encodeURIComponent(id)}`),
  file: (path: string) => `/explorer?file=${encodeURIComponent(path)}`,
  package: (name: string) => `/explorer?package=${encodeURIComponent(name)}`,

  /**
   * One Explorer selection, as a link.
   *
   * The Explorer's whole state is three parameters, so building them in one place keeps every caller —
   * and the page's own navigation — from assembling the query string slightly differently. Empty and
   * null are both dropped, so `/explorer` is what "nothing selected" looks like.
   */
  explorerAt: (selection: {
    readonly package?: string | null;
    readonly file?: string | null;
    readonly symbol?: string | null;
  }) =>
    withQuery('/explorer', [
      ['package', selection.package],
      ['file', selection.file],
      ['symbol', selection.symbol],
    ]),
};

/**
 * A path plus whichever parameters have a value.
 *
 * `encodeURIComponent`, not `URLSearchParams`: the latter form-encodes a space as `+`, and every other
 * link in this file uses `%20`. Both decode correctly, but one spelling across the app means a link is
 * comparable wherever it appears — in a test, in a log, or in the address bar.
 */
function withQuery(path: string, parameters: readonly (readonly [string, string | null | undefined])[]): string {
  const query = parameters
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

  return query === '' ? path : `${path}?${query}`;
}

/**
 * Which page an identifier belongs to.
 *
 * A `file:` node has no Symbol page — the Explorer is its detail view — so a list mixing files and
 * declarations can link every row correctly without each caller re-deriving the rule.
 */
export function linkForNode(id: string): string {
  if (id.startsWith('file:')) {
    return routes.file(id.slice('file:'.length));
  }

  if (id.startsWith('sym:')) {
    return routes.symbol(id);
  }

  // Routes, environment variables and externals have no page of their own; search is where they are
  // inspected, so link to a search for the identifier rather than to a page that would 404.
  return routes.search(id);
}
