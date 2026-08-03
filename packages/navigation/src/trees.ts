import { listing } from '@traceiq/explorer';
import type { Listing } from '@traceiq/explorer';
import { NODE_KINDS } from '@traceiq/graph-api';
import type { GraphNode, NodeKind } from '@traceiq/graph-api';
import { ROLES } from '@traceiq/types';
import type { Role } from '@traceiq/types';

import {
  limitationsOf,
  mapListing,
  packageOfNode,
  roleGroupsOf,
  treeRef,
  type NavigationContext,
} from './navigation-context.js';
import type {
  ArchitectureGroup,
  ArchitectureNavigation,
  DependencyTreeEdge,
  DependencyTreeNode,
  FileTreeNode,
  PackageTreeNode,
  RoleTreeNode,
  RoleTreePackage,
  TreeRef,
} from './types.js';

/** Declaration kinds the architecture tree groups by, in vocabulary order. */
const GROUPED_KINDS: readonly NodeKind[] = NODE_KINDS.filter(
  (kind) =>
    kind !== 'File' &&
    kind !== 'Route' &&
    kind !== 'EnvironmentVariable' &&
    kind !== 'External' &&
    // A workflow step is not a declaration of the architecture. It belongs to its artefact, which the
    // Explorer shows in place, and grouping it here would put a hundred Markdown headings in the
    // architecture tree of a documentation repository.
    kind !== 'ArtifactElement',
);

/**
 * The repository's architecture, grouped and as four trees.
 *
 * `groups` and `packages` are Repository Explorer's answers carried whole: the flat grouping already
 * exists there and is not restated. The trees are the same facts arranged for navigation.
 */
export function architectureNavigationOf(context: NavigationContext): ArchitectureNavigation {
  return {
    packages: context.packages(),
    architectureTree: listing(architectureTreeOf(context)),
    packageTree: listing(packageTreeOf(context)),
    roleTree: listing(roleTreeOf(context)),
    dependencyTree: listing(dependencyTreeOf(context)),
    limitations: limitationsOf(
      [
        'roles-are-judgements',
        'package-boundary-is-derived-from-paths',
        'cross-package-imports-resolve-outside-analysis',
        'capped-lists',
      ],
      {},
    ),
  };
}

/**
 * Roles first, then declaration kinds, each with its members.
 *
 * Roles come before kinds because a role is what an engineer navigates by; a kind is how the language
 * spells it. A group with no members is omitted rather than reported empty.
 */
export function architectureTreeOf(context: NavigationContext): readonly ArchitectureGroup[] {
  // Each group carries the explorer's own list, so a capped group still reports its true total.
  const roleGroups: readonly ArchitectureGroup[] = ROLES.flatMap((role) => {
    const entries = roleListing(context, role);

    return entries.total === 0 ? [] : [{ group: role, category: 'role' as const, entries }];
  });

  const kindGroups: readonly ArchitectureGroup[] = GROUPED_KINDS.flatMap((kind) => {
    const entries = kindListing(context, kind);

    return entries.total === 0 ? [] : [{ group: kind, category: 'kind' as const, entries }];
  });

  return [...roleGroups, ...kindGroups];
}

/** Package → file → declaration. The structural spine of the repository. */
export function packageTreeOf(context: NavigationContext): readonly PackageTreeNode[] {
  return context.packages().entries.map((summary) => {
    const view = context.explore((explorer) => explorer.browsePackage(summary.name));

    const files: readonly FileTreeNode[] = (view?.files.entries ?? []).map((file) => {
      const fileView = context.explore((explorer) => explorer.browseFile(file.id));

      return {
        file: treeRef(file),
        declarations: listing((fileView?.declarations.entries ?? []).map(treeRef)),
      };
    });

    return { name: summary.name, files: listing(files), declarations: summary.declarations };
  });
}

/** Role → package → declaration, so a role can be read per package rather than as one flat list. */
export function roleTreeOf(context: NavigationContext): readonly RoleTreeNode[] {
  return ROLES.flatMap((role) => {
    // `total` is the role's true size, taken from the explorer's own listing; the package grouping can
    // only cover the entries that listing made visible, which each package's `truncated` flag states.
    const total = roleListing(context, role).total;
    const entries = roleEntriesWithPackage(context, role);

    if (total === 0) {
      return [];
    }

    const byPackage = new Map<string, TreeRef[]>();

    for (const entry of entries) {
      const bucket = byPackage.get(entry.packageName);

      if (bucket === undefined) {
        byPackage.set(entry.packageName, [entry.ref]);
      } else {
        bucket.push(entry.ref);
      }
    }

    const packages: readonly RoleTreePackage[] = [...byPackage.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([name, refs]) => ({ name, declarations: listing(refs) }));

    return [{ role, packages: listing(packages), total }];
  });
}

/**
 * Package → the packages it imports from and those importing it.
 *
 * Edge counts rather than edges: a dependency tree answers "what depends on what", and the edges
 * behind any one pair are a `browsePackage` call away.
 */
export function dependencyTreeOf(context: NavigationContext): readonly DependencyTreeNode[] {
  return context.packages().entries.map((summary) => {
    const view = context.explore((explorer) => explorer.browsePackage(summary.name));

    const dependsOn: readonly DependencyTreeEdge[] = (view?.dependencies.entries ?? []).map((entry) => ({
      name: entry.name,
      edges: entry.edges.total,
    }));

    const dependedOnBy: readonly DependencyTreeEdge[] = (view?.dependents.entries ?? []).map((entry) => ({
      name: entry.name,
      edges: entry.edges.total,
    }));

    return { name: summary.name, dependsOn: listing(dependsOn), dependedOnBy: listing(dependedOnBy) };
  });
}

function roleListing(context: NavigationContext, role: Role): Listing<TreeRef> {
  const architecture = context.architecture();
  const lists: Readonly<Record<Role, Listing<GraphNode>>> = {
    Controller: architecture.controllers,
    Service: architecture.services,
    Repository: architecture.repositories,
    Middleware: architecture.middleware,
    Model: architecture.models,
    Test: architecture.tests,
  };

  return mapListing(lists[role], treeRef);
}

function roleEntriesWithPackage(
  context: NavigationContext,
  role: Role,
): readonly { readonly ref: TreeRef; readonly packageName: string }[] {
  return roleGroupsOf(context)[role].map((node) => ({
    ref: treeRef(node),
    packageName: packageOfNode(node) ?? '',
  }));
}

const EMPTY: Listing<TreeRef> = { entries: [], total: 0, truncated: false };

function kindListing(context: NavigationContext, kind: NodeKind): Listing<TreeRef> {
  const architecture = context.architecture();
  const lists: Partial<Record<NodeKind, Listing<GraphNode>>> = {
    Class: architecture.classes,
    Interface: architecture.interfaces,
    Function: architecture.functions,
    Method: architecture.methods,
    Variable: architecture.variables,
    Namespace: architecture.namespaces,
  };

  const list = lists[kind];

  return list === undefined ? EMPTY : mapListing(list, treeRef);
}
