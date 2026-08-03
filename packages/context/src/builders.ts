import type { GraphNode } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import { LIMITATION_DETAIL } from './limitations.js';
import type {
  ContextDependencies,
  ContextHealth,
  ContextImpact,
  ContextReferences,
  Limitation,
  LimitationCode,
  RelatedNode,
  RouteResult,
  SubjectHealth,
} from './types.js';

/**
 * How many related nodes a context carries, and how many of them are explained.
 *
 * A related node is cheap; an explanation is not. One `ExplainSymbolResult` is around 85 KB on this
 * repository, because it carries whole graph nodes throughout — so twenty of them make an impact context
 * roughly 3 MB, of which the explanations are 1.7 MB. A context exists to be consumed whole, by an
 * assistant with a budget or a client over a wire, and at that size most of it is bulk rather than help.
 *
 * Five is enough to see the shape of what a change touches while leaving the context consumable; every
 * related node is still listed with its identifier, so a consumer asks for more by requesting the symbol
 * kind for the one it cares about.
 *
 * The explained ones are the **first** in the order the capability already returned — depth-major for
 * impact, alphabetical for search. No reordering, no selection by importance, no ranking.
 */
export const RELATED_LIMIT = 100;
export const EXPLAIN_LIMIT = 5;

export const NO_REFERENCES: ContextReferences = {
  incomingCalls: [],
  outgoingCalls: [],
  references: [],
  typeReferences: [],
};

export const NO_DEPENDENCIES: ContextDependencies = {
  view: null,
  externalPackages: [],
  environmentVariables: [],
  cycles: null,
};

export const NO_IMPACT: ContextImpact = { analysis: null, summary: null };

export const NO_HEALTH: ContextHealth = { report: null, subject: null };

/**
 * Merges the composition's own limitations with those the contributing capabilities reported.
 *
 * Deduplicated by code — two capabilities warning about partial call coverage is one caveat — and
 * ordered by code so the field is deterministic. A capability's own list also stays on its own result,
 * so nothing is moved, only mirrored into one place a consumer can read.
 */
/** A limitation as any capability reports one: a code, fixed text and an optional count. */
type CarriedLimitation = {
  readonly code: string;
  readonly detail: string;
  readonly affected: number | null;
};

export function mergeLimitations(
  own: readonly (readonly [LimitationCode, number | null])[],
  carried: readonly (readonly CarriedLimitation[])[],
): readonly Limitation[] {
  const merged = new Map<string, Limitation>();

  for (const [code, affected] of own) {
    if (affected !== 0) {
      merged.set(code, { code, detail: LIMITATION_DETAIL[code], affected });
    }
  }

  for (const list of carried) {
    for (const entry of list) {
      if (!merged.has(entry.code)) {
        // Carried verbatim: a capability's wording belongs to that capability.
        merged.set(entry.code, entry as Limitation);
      }
    }
  }

  return [...merged.values()].sort((left, right) => left.code.localeCompare(right.code));
}

/** Related nodes, capped and deduplicated by identifier, keeping the first relation seen. */
export function relatedNodes(
  entries: readonly { readonly node: GraphNode; readonly relation: RelatedNode['relation']; readonly depth?: number | null }[],
  explain?: (id: NodeId) => RelatedNode['explain'],
): readonly RelatedNode[] {
  const seen = new Map<NodeId, RelatedNode>();

  for (const entry of entries) {
    if (seen.has(entry.node.id) || seen.size >= RELATED_LIMIT) {
      continue;
    }

    seen.set(entry.node.id, {
      node: entry.node,
      relation: entry.relation,
      depth: entry.depth ?? null,
      explain: null,
    });
  }

  const ordered = [...seen.values()];

  if (explain === undefined) {
    return ordered;
  }

  // Only a declaration can be explained. A file, a route or an external returns null, so asking would
  // spend a capability call to learn what the node kind already says.
  let explained = 0;

  return ordered.map((entry) => {
    if (explained >= EXPLAIN_LIMIT || !DECLARATION_KINDS.has(entry.node.kind)) {
      return entry;
    }

    explained += 1;

    return { ...entry, explain: explain(entry.node.id) };
  });
}

/** Node kinds `explain` can answer for. A File, Route, EnvironmentVariable or External cannot. */
const DECLARATION_KINDS = new Set<string>([
  'Class',
  'Interface',
  'TypeAlias',
  'Enum',
  'EnumMember',
  'Function',
  'Method',
  'Property',
  'Accessor',
  'Constructor',
  'Variable',
  'Namespace',
]);

/**
 * A file's condition, from the counts its own view reports.
 *
 * A file has no `SymbolView`, so `fanIn`, `fanOut` and cycle membership come from the file view and the
 * dependency view the explorer already produced. Nothing is recomputed and nothing is inferred:
 * `recursive` is false because recursion is a property of a call, not of a file.
 */
export function fileHealth(input: {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly inCycle: boolean;
  readonly findings: readonly string[];
}): SubjectHealth {
  return {
    fanIn: input.fanIn,
    fanOut: input.fanOut,
    isolated: input.fanIn === 0 && input.fanOut === 0,
    inCycle: input.inCycle,
    recursive: false,
    findings: input.findings,
  };
}

/** Route results carried out of whatever shape a capability reported them in. */
export function routesOf(entries: readonly { readonly route: RouteResult }[]): readonly RouteResult[] {
  const seen = new Map<NodeId, RouteResult>();

  for (const entry of entries) {
    seen.set(entry.route.node.id, entry.route);
  }

  return [...seen.values()].sort((left, right) => left.node.id.localeCompare(right.node.id));
}

/**
 * Findings from an already-obtained health report that name a given node.
 *
 * Takes the report rather than the capability, so a builder that needs both a report and the findings
 * within it computes the report once.
 */
export function findingsNaming(
  report: { readonly findings: readonly { readonly code: string; readonly nodes: readonly { readonly id: NodeId }[] }[] },
  id: NodeId,
): readonly string[] {
  return report.findings
    .filter((finding) => finding.nodes.some((node) => node.id === id))
    .map((finding) => finding.code);
}
