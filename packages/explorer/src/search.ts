import type { GraphNode } from '@traceiq/graph-api';
import { parseRouteId } from '@traceiq/query';

import type { ExplorerContext } from './explorer-context.js';
import { byId, listing } from './listing.js';
import type { MatchMode, SearchQuery, SearchResults } from './types.js';

/**
 * Deterministic search over the graph.
 *
 * **Exact or prefix only.** No fuzzy matching, no edit distance, no ranking, no scoring — a node
 * either matches every supplied filter or it does not, and results are alphabetical by identifier
 * throughout. Two identical queries always return the same list in the same order.
 *
 * Every field is an independent filter and all supplied fields must match. An empty query matches
 * nothing rather than the whole repository: returning every node would be an accident, not a search.
 */
export function searchOf(context: ExplorerContext, query: SearchQuery): SearchResults {
  const match = query.match ?? 'prefix';
  const index = context.index();

  const empty = isEmpty(query);

  const declarations = empty
    ? []
    : byId(
        index.declarations.filter(
          (node) =>
            matchesText(node, query.text, match) &&
            matchesPath(node, query.path, match) &&
            matchesKind(node, query) &&
            matchesRole(context, node, query) &&
            // A declaration is never a route, an environment variable or an external, so any of
            // those filters excludes every declaration.
            query.route === undefined &&
            query.environmentVariable === undefined &&
            query.externalPackage === undefined &&
            query.dependency === undefined &&
            query.manifest === undefined,
        ),
      );

  const files = empty
    ? []
    : byId(
        index.files.filter(
          (node) =>
            matchesText(node, query.text, match) &&
            matchesPath(node, query.path, match) &&
            (query.kind === undefined || query.kind === 'File') &&
            query.role === undefined &&
            query.route === undefined &&
            query.environmentVariable === undefined &&
            query.externalPackage === undefined &&
            query.dependency === undefined &&
            query.manifest === undefined,
        ),
      );

  const routes = empty
    ? []
    : byId(
        (index.nodesByKind.get('Route') ?? []).filter(
          (node) =>
            matchesRoute(node, query.route, match) &&
            matchesText(node, query.text, match) &&
            (query.kind === undefined || query.kind === 'Route') &&
            query.path === undefined &&
            query.role === undefined &&
            query.environmentVariable === undefined &&
            query.externalPackage === undefined &&
            query.dependency === undefined &&
            query.manifest === undefined,
        ),
      );

  const environmentVariables = empty
    ? []
    : byId(
        (index.nodesByKind.get('EnvironmentVariable') ?? []).filter(
          (node) =>
            matches(node.name, query.environmentVariable, match) &&
            matchesText(node, query.text, match) &&
            (query.kind === undefined || query.kind === 'EnvironmentVariable') &&
            query.path === undefined &&
            query.role === undefined &&
            query.route === undefined &&
            query.externalPackage === undefined &&
            query.dependency === undefined &&
            query.manifest === undefined,
        ),
      );

  const externalPackages = empty
    ? []
    : byId(
        (index.nodesByKind.get('External') ?? []).filter(
          (node) =>
            matchesExternal(node, query.externalPackage, match) &&
            matchesText(node, query.text, match) &&
            (query.kind === undefined || query.kind === 'External') &&
            query.path === undefined &&
            query.role === undefined &&
            query.route === undefined &&
            query.environmentVariable === undefined &&
            query.dependency === undefined &&
            query.manifest === undefined,
        ),
      );

  // Dependencies and manifests exist for every repository, whether or not anything analysed it, so
  // these two are the only search results a `universal` region can produce. Leaving them out made
  // search answer "nothing matched" for a Python or Java repository whose graph held the name asked
  // for — the exact shape of sparseness this must not have.
  const dependencies = empty
    ? []
    : byId(
        (index.nodesByKind.get('Dependency') ?? []).filter(
          (node) =>
            matches(node.name, query.dependency, match) &&
            matchesText(node, query.text, match) &&
            (query.kind === undefined || query.kind === 'Dependency') &&
            query.path === undefined &&
            query.role === undefined &&
            query.route === undefined &&
            query.environmentVariable === undefined &&
            query.externalPackage === undefined &&
            query.manifest === undefined,
        ),
      );

  const manifests = empty
    ? []
    : byId(
        (index.nodesByKind.get('Manifest') ?? []).filter(
          (node) =>
            // A manifest is addressed by its path, which is also what `path` filters on: both work,
            // and `name` here is the filename the graph recorded.
            matchesPath(node, query.manifest, match) &&
            matchesPath(node, query.path, match) &&
            matchesText(node, query.text, match) &&
            (query.kind === undefined || query.kind === 'Manifest') &&
            query.role === undefined &&
            query.route === undefined &&
            query.environmentVariable === undefined &&
            query.externalPackage === undefined &&
            query.dependency === undefined,
        ),
      );

  // A technology is a fact about the software, like a declaration, so it is searchable like one.
  // Leaving it out would mean a reader who can *see* "Next.js" on the Overview cannot find it by
  // typing it — the exact special-casing this search exists to avoid.
  const technologies = empty
    ? []
    : byId(
        (index.nodesByKind.get('Technology') ?? []).filter(
          (node) =>
            matches(node.name, query.technology, match) &&
            matchesText(node, query.text, match) &&
            (query.kind === undefined || query.kind === 'Technology') &&
            query.path === undefined &&
            query.role === undefined &&
            query.route === undefined &&
            query.environmentVariable === undefined &&
            query.externalPackage === undefined &&
            query.dependency === undefined &&
            query.manifest === undefined,
        ),
      );

  return {
    query,
    match,
    declarations: listing(declarations),
    files: listing(files),
    routes: listing(routes),
    environmentVariables: listing(environmentVariables),
    externalPackages: listing(externalPackages),
    dependencies: listing(dependencies),
    manifests: listing(manifests),
    technologies: listing(technologies),
    total:
      declarations.length +
      files.length +
      routes.length +
      environmentVariables.length +
      externalPackages.length +
      dependencies.length +
      manifests.length +
      technologies.length,
  };
}

function isEmpty(query: SearchQuery): boolean {
  return (
    query.text === undefined &&
    query.path === undefined &&
    query.kind === undefined &&
    query.role === undefined &&
    query.route === undefined &&
    query.environmentVariable === undefined &&
    query.externalPackage === undefined &&
    query.dependency === undefined &&
    query.manifest === undefined
  );
}

/** Exact or prefix, case-sensitive. Case folding would be a second rule to get wrong. */
function matches(value: string, term: string | undefined, mode: MatchMode): boolean {
  if (term === undefined) {
    return true;
  }

  return mode === 'exact' ? value === term : value.startsWith(term);
}

/** A name or an identifier may match, so `login` finds both `login` and `sym:…#login`. */
function matchesText(node: GraphNode, term: string | undefined, mode: MatchMode): boolean {
  if (term === undefined) {
    return true;
  }

  return matches(node.name, term, mode) || matches(node.id, term, mode);
}

/** A declaration matches on the path of the file it lives in, so a path filter selects a directory. */
function matchesPath(node: GraphNode, term: string | undefined, mode: MatchMode): boolean {
  if (term === undefined) {
    return true;
  }

  const fileId = node.kind === 'File' ? node.id : node.fileId;

  return fileId === null ? false : matches(fileId.slice('file:'.length), term, mode);
}

function matchesKind(node: GraphNode, query: SearchQuery): boolean {
  return query.kind === undefined || node.kind === query.kind;
}

function matchesRole(context: ExplorerContext, node: GraphNode, query: SearchQuery): boolean {
  if (query.role === undefined) {
    return true;
  }

  return (context.index().rolesByNode.get(node.id) ?? []).some((entry) => entry.role === query.role);
}

/** A route matches on its method or on its path, both read from the frozen identity. */
function matchesRoute(node: GraphNode, term: string | undefined, mode: MatchMode): boolean {
  if (term === undefined) {
    return true;
  }

  const identity = parseRouteId(node.id);

  if (identity === null) {
    return false;
  }

  return matches(identity.method, term, mode) || matches(identity.path, term, mode);
}

/** An external matches on the package name rather than on the `ext:npm:` identity prefix. */
function matchesExternal(node: GraphNode, term: string | undefined, mode: MatchMode): boolean {
  if (term === undefined) {
    return true;
  }

  return matches(node.externalName ?? node.name, term, mode);
}
