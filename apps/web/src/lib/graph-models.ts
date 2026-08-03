import { filePathOf, symbolName } from '@/lib/format';
import { layerByLongestPath, place, type Layout, type LayoutEdge } from '@/lib/graph-layout';
import type { ArchitectureNavigation, ImpactAnalysis } from '@/types/api';

/**
 * Turns an API payload into a layout.
 *
 * Kept out of the components on purpose: a component receives a finished `Layout` and renders it, so the
 * shape of the picture is decided by a pure function that a test can assert on directly.
 */

/** Beyond this many nodes the picture stops being readable, and the cap is always reported. */
export const GRAPH_NODE_CAP = 60;

/** The package dependency graph, from the architecture navigation's dependency tree. */
export function packageGraph(architecture: ArchitectureNavigation): Layout {
  const entries = architecture.dependencyTree.entries;
  const total = architecture.dependencyTree.total;
  const kept = entries.slice(0, GRAPH_NODE_CAP);
  const ids = kept.map((entry) => entry.name);
  const present = new Set(ids);

  const rawEdges = kept.flatMap((entry) =>
    entry.dependsOn.entries
      .filter((dependency) => present.has(dependency.name))
      .map((dependency) => ({ source: entry.name, target: dependency.name, weight: dependency.edges })),
  );

  const layers = layerByLongestPath(ids, rawEdges);
  const declarationsByName = new Map(architecture.packageTree.entries.map((entry) => [entry.name, entry.declarations]));
  const filesByName = new Map(architecture.packages.entries.map((entry) => [entry.name, entry.files]));

  const nodes = place(
    kept.map((entry) => ({
      id: entry.name,
      label: entry.name,
      sublabel: `${filesByName.get(entry.name) ?? 0} files · ${declarationsByName.get(entry.name) ?? 0} decls`,
      layer: layers.get(entry.name) ?? 0,
      tone: 'neutral' as const,
    })),
  );

  const edges: readonly LayoutEdge[] = rawEdges.map((edge) => ({
    id: `${edge.source}→${edge.target}`,
    source: edge.source,
    target: edge.target,
    backEdge: (layers.get(edge.target) ?? 0) <= (layers.get(edge.source) ?? 0),
  }));

  return { nodes, edges, total, truncated: total > kept.length };
}

/**
 * The impact graph.
 *
 * Layering comes straight from the analyser's `depth`, so the picture cannot disagree with the numbers
 * beside it. The target sits at depth 0; `DIRECT` and `INDIRECT` keep their own tones because the
 * categories are never merged.
 */
export function impactGraph(analysis: ImpactAnalysis): Layout {
  const affected = [...analysis.directlyAffected, ...analysis.indirectlyAffected];
  const total = affected.length + 1;
  const kept = affected.slice(0, GRAPH_NODE_CAP - 1);
  const targetId = analysis.target.node.id;

  const nodes = place([
    {
      id: targetId,
      label: symbolName(targetId),
      sublabel: filePathOf(targetId),
      layer: 0,
      tone: 'target' as const,
    },
    ...kept.map((entry) => ({
      id: entry.node.id,
      label: symbolName(entry.node.id),
      sublabel: `${entry.node.kind} · depth ${entry.depth}`,
      layer: entry.depth,
      tone: entry.category === 'DIRECT' ? ('direct' as const) : ('indirect' as const),
    })),
  ]);

  const present = new Set(nodes.map((node) => node.id));

  // An affected node's `via` edge names how the analyser reached it. Drawing that edge — rather than one
  // invented from the depths — is what keeps the picture a view of the graph instead of a sketch of it.
  const edges: readonly LayoutEdge[] = kept
    .filter((entry) => present.has(entry.via.sourceId) && present.has(entry.via.targetId))
    .map((entry) => ({
      id: entry.via.id,
      source: entry.via.targetId,
      target: entry.via.sourceId,
      backEdge: false,
    }));

  return { nodes, edges, total, truncated: total > nodes.length };
}
