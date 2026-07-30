import { describe, expect, it } from 'vitest';

import { ARCHITECTURE, IMPACT } from '@/test/fixtures';

import { COLUMN_WIDTH, MAX_ROWS_PER_LAYER, layerByLongestPath, place } from './graph-layout';
import { GRAPH_NODE_CAP, impactGraph, packageGraph } from './graph-models';

/**
 * Layout, tested as pure functions.
 *
 * These are the assertions that keep a picture honest: it draws only edges the payload holds, it layers
 * by the depth the analyser reported, it survives a cycle, and it produces the same coordinates every
 * time. None of that needs React Flow mounted.
 */
describe('layerByLongestPath', () => {
  it('puts a dependency one layer past its dependent', () => {
    const layers = layerByLongestPath(['a', 'b', 'c'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);

    expect([layers.get('a'), layers.get('b'), layers.get('c')]).toEqual([0, 1, 2]);
  });

  it('takes the longest path, not the first found', () => {
    const layers = layerByLongestPath(['a', 'b', 'c'], [
      { source: 'a', target: 'c' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);

    expect(layers.get('c')).toBe(2);
  });

  it('terminates on a cycle instead of relaxing forever', () => {
    const layers = layerByLongestPath(['a', 'b'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ]);

    expect(layers.size).toBe(2);
    expect(Number.isFinite(layers.get('a'))).toBe(true);
  });

  it('ignores an edge naming a node outside the set', () => {
    const layers = layerByLongestPath(['a'], [{ source: 'a', target: 'absent' }]);

    expect([...layers.keys()]).toEqual(['a']);
  });
});

describe('place', () => {
  it('puts a layer in its own column', () => {
    const placed = place([
      { id: 'a', label: 'a', sublabel: '', layer: 0, tone: 'neutral' },
      { id: 'b', label: 'b', sublabel: '', layer: 1, tone: 'neutral' },
    ]);

    expect(placed.find((node) => node.id === 'a')?.x).toBe(0);
    expect(placed.find((node) => node.id === 'b')?.x).toBe(COLUMN_WIDTH);
  });

  it('wraps a layer taller than the row cap into a second column', () => {
    const placed = place(
      Array.from({ length: MAX_ROWS_PER_LAYER + 3 }, (_, index) => ({
        id: `n${String(index).padStart(2, '0')}`,
        label: '',
        sublabel: '',
        layer: 0,
        tone: 'neutral' as const,
      })),
    );

    expect(new Set(placed.map((node) => node.x))).toEqual(new Set([0, COLUMN_WIDTH]));
    expect(placed.filter((node) => node.x === 0)).toHaveLength(MAX_ROWS_PER_LAYER);
  });

  it('shifts a later layer past a wrapped one, so they cannot overlap', () => {
    const placed = place([
      ...Array.from({ length: MAX_ROWS_PER_LAYER + 1 }, (_, index) => ({
        id: `a${String(index).padStart(2, '0')}`,
        label: '',
        sublabel: '',
        layer: 0,
        tone: 'neutral' as const,
      })),
      { id: 'z', label: '', sublabel: '', layer: 1, tone: 'neutral' as const },
    ]);

    // Layer 0 occupies columns 0 and 1, so layer 1 starts at column 2.
    expect(placed.find((node) => node.id === 'z')?.x).toBe(2 * COLUMN_WIDTH);
  });

  it('orders within a layer alphabetically, so the same input draws the same picture', () => {
    const input = [
      { id: 'z', label: 'z', sublabel: '', layer: 0, tone: 'neutral' as const },
      { id: 'a', label: 'a', sublabel: '', layer: 0, tone: 'neutral' as const },
    ];

    const first = place(input);
    const second = place([...input].reverse());

    expect(second).toEqual(first);
    expect(first[0]?.id).toBe('a');
  });
});

describe('packageGraph', () => {
  it('draws an arrow from a package to the one it depends on', () => {
    const layout = packageGraph(ARCHITECTURE);

    expect(layout.edges).toEqual([
      { id: 'packages/api→packages/core', source: 'packages/api', target: 'packages/core', backEdge: false },
    ]);
  });

  it('layers a dependency behind its dependent', () => {
    const layout = packageGraph(ARCHITECTURE);
    const api = layout.nodes.find((node) => node.id === 'packages/api');
    const core = layout.nodes.find((node) => node.id === 'packages/core');

    expect(api?.x).toBeLessThan(core?.x ?? 0);
  });

  it('labels a package with its file and declaration counts', () => {
    const layout = packageGraph(ARCHITECTURE);

    expect(layout.nodes.find((node) => node.id === 'packages/core')?.sublabel).toBe('10 files · 140 decls');
  });

  it('reports the true total when the node list is capped', () => {
    const many = Array.from({ length: GRAPH_NODE_CAP + 10 }, (_, index) => ({
      name: `p${String(index).padStart(3, '0')}`,
      dependsOn: { entries: [], total: 0, truncated: false },
      dependedOnBy: { entries: [], total: 0, truncated: false },
    }));

    const layout = packageGraph({
      ...ARCHITECTURE,
      dependencyTree: { entries: many, total: many.length, truncated: false },
    });

    expect(layout.nodes).toHaveLength(GRAPH_NODE_CAP);
    expect(layout.total).toBe(GRAPH_NODE_CAP + 10);
    expect(layout.truncated).toBe(true);
  });

  it('marks an edge that closes a cycle', () => {
    const layout = packageGraph({
      ...ARCHITECTURE,
      dependencyTree: {
        entries: [
          { name: 'a', dependsOn: { entries: [{ name: 'b', edges: 1 }], total: 1, truncated: false }, dependedOnBy: { entries: [], total: 0, truncated: false } },
          { name: 'b', dependsOn: { entries: [{ name: 'a', edges: 1 }], total: 1, truncated: false }, dependedOnBy: { entries: [], total: 0, truncated: false } },
        ],
        total: 2,
        truncated: false,
      },
    });

    expect(layout.edges.filter((edge) => edge.backEdge)).toHaveLength(1);
  });
});

describe('impactGraph', () => {
  it('places the target at depth 0 and marks it', () => {
    const layout = impactGraph(IMPACT);
    const target = layout.nodes.find((node) => node.id === IMPACT.target.node.id);

    expect(target?.x).toBe(0);
    expect(target?.tone).toBe('target');
  });

  it('keeps DIRECT and INDIRECT apart', () => {
    const tones = new Map(impactGraph(IMPACT).nodes.map((node) => [node.id, node.tone]));

    expect(tones.get('sym:packages/api/src/routes.ts#getUser')).toBe('direct');
    expect(tones.get('sym:packages/api/src/routes.ts#router')).toBe('indirect');
  });

  it('layers by the depth the analyser reported', () => {
    const layout = impactGraph(IMPACT);
    const indirect = layout.nodes.find((node) => node.id === 'sym:packages/api/src/routes.ts#router');

    expect(indirect?.x).toBe(2 * COLUMN_WIDTH);
  });

  it('draws only edges the analysis carried', () => {
    const layout = impactGraph(IMPACT);

    expect(layout.edges.map((edge) => edge.id).sort()).toEqual(['e1', 'e3']);
  });

  it('drops an edge whose other end was capped away rather than drawing a dangling arrow', () => {
    const layout = impactGraph({
      ...IMPACT,
      indirectlyAffected: [
        {
          node: { ...IMPACT.target.node, id: 'sym:x.ts#Far' },
          category: 'INDIRECT',
          depth: 3,
          via: { ...IMPACT.directlyAffected[0]!.via, id: 'e9', sourceId: 'sym:x.ts#Far', targetId: 'sym:absent.ts#Gone' },
        },
      ],
    });

    expect(layout.edges.map((edge) => edge.id)).not.toContain('e9');
  });

  it('is deterministic across calls', () => {
    expect(impactGraph(IMPACT)).toEqual(impactGraph(IMPACT));
  });
});
