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
  dashboard: () => '/',
  explorer: () => '/explorer',
  architecture: () => '/architecture',
  health: () => '/health',
  search: (query?: string) => (query === undefined || query === '' ? '/search' : `/search?q=${encodeURIComponent(query)}`),
  symbol: (id: string) => `/symbol?id=${encodeURIComponent(id)}`,
  impact: (id: string) => `/impact?id=${encodeURIComponent(id)}`,
  file: (path: string) => `/explorer?file=${encodeURIComponent(path)}`,
  package: (name: string) => `/explorer?package=${encodeURIComponent(name)}`,
};

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
