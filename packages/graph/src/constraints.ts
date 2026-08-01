import type { RelationshipType } from '@traceiq/types';

import { DECLARATION_NODE_KINDS, type GraphEdge, type GraphNode, type NodeKind } from './types.js';

export class GraphConstraintError extends Error {
  constructor(reason: string) {
    super(`Graph constraint violated: ${reason}`);
    this.name = 'GraphConstraintError';
  }
}

const DECLARATIONS: readonly NodeKind[] = DECLARATION_NODE_KINDS;

interface EndpointRule {
  readonly sources: readonly NodeKind[];
  readonly targets: readonly NodeKind[];
}

/**
 * The legal endpoint matrix, spec §2.3.
 *
 * The heritage and type rows are wider than they first look, because they must admit
 * everything legal TypeScript produces: `class A extends Mixin(Base)` resolves to a
 * `Function` or `Variable`, and `let x: Status.Active` resolves to an `EnumMember`.
 * Kinds still excluded are excluded deliberately — no heritage clause or type
 * annotation resolves to a `Property`, `Method`, `Constructor`, `Accessor` or `File`.
 */
export const ENDPOINT_RULES: Readonly<Partial<Record<RelationshipType, EndpointRule>>> = {
  DECLARES: {
    // A body declares too: since the IR records nested functions and arrows, the parent of
    // a declaration can be anything with a body — not only a file or a type container.
    sources: [
      'File',
      'Class',
      'Interface',
      'Enum',
      'Namespace',
      'Function',
      'Method',
      'Constructor',
      'Accessor',
      'Variable',
    ],
    targets: DECLARATIONS,
  },
  IMPORTS: {
    sources: ['File'],
    targets: ['File', 'External', ...DECLARATIONS],
  },
  EXPORTS: {
    sources: ['File'],
    targets: ['File', 'External', ...DECLARATIONS],
  },
  EXTENDS: {
    sources: ['Class', 'Interface'],
    targets: ['Class', 'Interface', 'TypeAlias', 'Function', 'Variable', 'External'],
  },
  IMPLEMENTS: {
    // `Enum` because a Java enum may implement interfaces, which is both legal and common —
    // `enum ComparableComparator implements Comparator` in Apache Commons Lang is one of many. The row
    // read `['Class']` while TypeScript was the only producer, and TypeScript enums cannot implement.
    sources: ['Class', 'Enum'],
    targets: ['Interface', 'TypeAlias', 'Function', 'Variable', 'External'],
  },
  CALLS: {
    // A call at module level is attributed to its file, so a file may be a caller.
    sources: ['File', ...DECLARATIONS],
    // `External` for the same reason IMPORTS and REFERENCES_TYPE admit it: a call can
    // leave the repository. It was absent while the call graph bound names only, which
    // gave it no way to tell a package's function from an unbound local; the type checker
    // resolves the callee's declaration and therefore knows which file it came from.
    targets: [...DECLARATIONS, 'External'],
  },
  /**
   * A manifest declaring a dependency. The only relationship a repository with no
   * language analyser produces, and the reason the frozen vocabulary needed no addition.
   */
  DEPENDS_ON: {
    sources: ['Manifest'],
    targets: ['Dependency'],
  },
  HANDLED_BY: {
    sources: ['Route'],
    targets: DECLARATIONS,
  },
  /**
   * A request this repository makes, reaching a route this repository serves.
   *
   * Reserved and unproduced since the contract was written; "execution continues to" is exactly
   * what an outbound call to a locally-served endpoint does. It is the only relationship that
   * crosses a language boundary — a React component's `fetch` reaching a Flask route — which is why
   * the source side admits `File`: a module-level request has no declaration, and dropping it would
   * lose the seam in precisely the repositories that have one.
   */
  CONTINUES_TO: {
    sources: ['File', ...DECLARATIONS],
    targets: ['Route'],
  },
  READS: {
    // A read sits in a declaration, or at module level — which is the file.
    sources: ['File', ...DECLARATIONS],
    targets: ['EnvironmentVariable'],
  },
  REFERENCES_TYPE: {
    sources: DECLARATIONS,
    targets: [
      'Class',
      'Interface',
      'TypeAlias',
      'Enum',
      'EnumMember',
      'Namespace',
      // `Function` and `Variable` for the same reason EXTENDS and IMPLEMENTS admit them, and this
      // row was simply the one that had not met the case yet. TypeScript keeps a type space and a
      // value space, and an identifier is a symbol path with no room to say which — so `type BENCH`
      // beside `const BENCH: BENCH` is one node wearing both meanings, and the annotation resolves
      // to it. zod declares exactly that, and rejecting the edge failed the whole scan.
      'Function',
      'Variable',
      'External',
    ],
  },
};

/**
 * Validates the graph before anything is written.
 *
 * Fails on the first violation with a message naming the offending row. A constraint
 * violation is a Graph Builder defect, not bad input: it means the translation
 * produced something the specification forbids, and continuing would persist it.
 *
 * SQLite enforces referential integrity again at insert time. This check exists so
 * the failure names the edge and the rule rather than surfacing as a foreign-key
 * error with no context.
 */
export function validateGraph(input: {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly unresolvedSourceIds: readonly string[];
  readonly roleNodeIds: readonly string[];
}): void {
  const kindById = new Map<string, NodeKind>();

  for (const node of input.nodes) {
    if (kindById.has(node.id)) {
      throw new GraphConstraintError(`two nodes share the identifier ${node.id}`);
    }

    kindById.set(node.id, node.kind);
  }

  for (const node of input.nodes) {
    if (node.fileId !== null && !kindById.has(node.fileId)) {
      throw new GraphConstraintError(
        `node ${node.id} names file ${node.fileId}, which is not a node`,
      );
    }
  }

  const edgeIds = new Set<string>();

  for (const edge of input.edges) {
    if (edgeIds.has(edge.id)) {
      throw new GraphConstraintError(`two edges share the identifier ${edge.id}`);
    }

    edgeIds.add(edge.id);
    validateEdge(edge, kindById);
  }

  for (const sourceId of input.unresolvedSourceIds) {
    if (!kindById.has(sourceId)) {
      throw new GraphConstraintError(
        `an unresolved reference is sourced at ${sourceId}, which is not a node`,
      );
    }
  }

  for (const nodeId of input.roleNodeIds) {
    if (!kindById.has(nodeId)) {
      throw new GraphConstraintError(`a role annotates ${nodeId}, which is not a node`);
    }
  }
}

function validateEdge(edge: GraphEdge, kindById: ReadonlyMap<string, NodeKind>): void {
  const sourceKind = kindById.get(edge.sourceId);
  const targetKind = kindById.get(edge.targetId);

  if (sourceKind === undefined) {
    throw new GraphConstraintError(
      `${edge.type} edge ${edge.id} is sourced at ${edge.sourceId}, which is not a node`,
    );
  }

  if (targetKind === undefined) {
    throw new GraphConstraintError(
      `${edge.type} edge ${edge.id} targets ${edge.targetId}, which is not a node`,
    );
  }

  if (edge.provenance.fileId !== null && !kindById.has(edge.provenance.fileId)) {
    throw new GraphConstraintError(
      `${edge.type} edge ${edge.id} has provenance file ${edge.provenance.fileId}, which is not a node`,
    );
  }

  const rule = ENDPOINT_RULES[edge.type];

  if (rule === undefined) {
    throw new GraphConstraintError(
      `${edge.type} is not an edge type this milestone produces (edge ${edge.id})`,
    );
  }

  if (!rule.sources.includes(sourceKind)) {
    throw new GraphConstraintError(
      `${edge.type} may not be sourced at a ${sourceKind} (edge ${edge.id})`,
    );
  }

  if (!rule.targets.includes(targetKind)) {
    throw new GraphConstraintError(
      `${edge.type} may not target a ${targetKind} (edge ${edge.id})`,
    );
  }
}
