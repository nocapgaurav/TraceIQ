/**
 * Deterministic graph layout.
 *
 * **Hand-written rather than a layout library.** No layout engine is in the approved stack, and the two
 * graphs this app draws are both naturally layered: a package graph by dependency depth, an impact graph
 * by the `depth` the analyser already reports. A force-directed layout would also settle differently on
 * every render, which would make the picture non-reproducible — the one property TraceIQ holds
 * everywhere else.
 *
 * These are pure functions over plain data, so they are unit-testable without mounting React Flow.
 */

export interface LayoutNode {
  readonly id: string;
  readonly label: string;
  readonly sublabel: string;
  readonly layer: number;
  readonly tone: 'target' | 'direct' | 'indirect' | 'neutral';
  readonly x: number;
  readonly y: number;
}

export interface LayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** A back-edge closes a cycle: it points from a deeper layer to a shallower one. */
  readonly backEdge: boolean;
}

export interface Layout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  /** How many nodes the input held before any cap was applied, so a truncated picture says so. */
  readonly total: number;
  readonly truncated: boolean;
}

export const COLUMN_WIDTH = 260;
export const ROW_HEIGHT = 74;

/**
 * How tall a single layer may get before it wraps into a second sub-column.
 *
 * Without this a graph whose nodes all share one depth — which happens whenever no dependency edge was
 * recovered — draws as one enormous vertical strip, and `fitView` then shrinks it until the labels are
 * unreadable. Wrapping keeps such a graph legible while leaving a layered graph untouched.
 */
export const MAX_ROWS_PER_LAYER = 10;

/**
 * Longest-path layering over a possibly-cyclic graph.
 *
 * A cycle has no well-defined depth, so relaxation is capped at the node count: after that many passes
 * every acyclic path has settled, and the remaining edges are exactly the ones inside a cycle. They are
 * kept and marked rather than deleted, because a dependency cycle is a fact worth seeing.
 */
export function layerByLongestPath(
  ids: readonly string[],
  edges: readonly { readonly source: string; readonly target: string }[],
): ReadonlyMap<string, number> {
  const layers = new Map<string, number>(ids.map((id) => [id, 0]));
  const present = new Set(ids);
  const relevant = edges.filter((edge) => present.has(edge.source) && present.has(edge.target));

  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;

    for (const edge of relevant) {
      const from = layers.get(edge.source) ?? 0;
      const to = layers.get(edge.target) ?? 0;

      if (to < from + 1) {
        layers.set(edge.target, from + 1);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return layers;
}

/**
 * Places layered nodes on a grid.
 *
 * Within a layer the order is alphabetical by id, which is what makes the same input draw the same
 * picture every time. A layer taller than `MAX_ROWS_PER_LAYER` wraps into sub-columns to its right, and
 * later layers are shifted past them so the wrap never overlaps the next layer.
 */
export function place(entries: readonly Omit<LayoutNode, 'x' | 'y'>[]): readonly LayoutNode[] {
  const byLayer = new Map<number, Omit<LayoutNode, 'x' | 'y'>[]>();

  for (const entry of [...entries].sort((left, right) => left.id.localeCompare(right.id))) {
    const bucket = byLayer.get(entry.layer);

    if (bucket === undefined) {
      byLayer.set(entry.layer, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  const layers = [...byLayer.entries()].sort((left, right) => left[0] - right[0]);
  const tallest = Math.min(MAX_ROWS_PER_LAYER, Math.max(1, ...layers.map(([, bucket]) => bucket.length)));
  const placed: LayoutNode[] = [];

  let column = 0;

  for (const [, bucket] of layers) {
    const rows = Math.min(bucket.length, MAX_ROWS_PER_LAYER);
    // Layers are centred against the tallest, so the graph reads as a spine rather than a staircase.
    const offset = ((tallest - rows) * ROW_HEIGHT) / 2;

    bucket.forEach((entry, index) => {
      placed.push({
        ...entry,
        x: (column + Math.floor(index / MAX_ROWS_PER_LAYER)) * COLUMN_WIDTH,
        y: offset + (index % MAX_ROWS_PER_LAYER) * ROW_HEIGHT,
      });
    });

    column += Math.max(1, Math.ceil(bucket.length / MAX_ROWS_PER_LAYER));
  }

  return placed;
}
