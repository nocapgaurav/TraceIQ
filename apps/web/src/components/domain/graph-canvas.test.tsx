import { ReactFlowProvider } from '@xyflow/react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { place } from '@/lib/graph-layout';

import { GraphCanvas, GraphNodeCard } from './graph-canvas';

/**
 * The canvas.
 *
 * jsdom reports every element as zero-sized, so React Flow cannot lay out or paint here — the pictures
 * themselves were checked in a real browser, and the layout maths is asserted in `graph-models.test.ts`.
 * What is worth testing here is the contract around the canvas: the empty state, the no-edges
 * explanation, the reported counts, and the handles.
 *
 * **The handle assertion is a regression test.** A custom React Flow node without `Handle` children
 * silently drops every edge attached to it, so the graph drew as a field of unconnected boxes while the
 * count beside it said "59 edges". Nothing else in the suite would have noticed.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const NODES = place([
  { id: 'a', label: 'a', sublabel: 'first', layer: 0, tone: 'target' },
  { id: 'b', label: 'b', sublabel: 'second', layer: 1, tone: 'direct' },
]);

const CONNECTED = {
  nodes: NODES,
  edges: [{ id: 'e1', source: 'a', target: 'b', backEdge: false }],
  total: 2,
  truncated: false,
};

const UNCONNECTED = { nodes: NODES, edges: [], total: 2, truncated: false };

describe('GraphCanvas', () => {
  it('shows the empty label when there is nothing to draw', () => {
    const { container } = render(
      <GraphCanvas layout={{ nodes: [], edges: [], total: 0, truncated: false }} emptyLabel="Nothing here" />,
    );

    expect(container.textContent).toContain('Nothing here');
  });

  it('reports how many nodes and edges it drew', () => {
    const { container } = render(<GraphCanvas layout={CONNECTED} />);

    expect(container.textContent).toContain('2 of 2 nodes · 1 edges');
  });

  it('says a cap was applied and what the true total was', () => {
    const { container } = render(<GraphCanvas layout={{ ...CONNECTED, total: 500, truncated: true }} />);

    expect(container.textContent).toContain('2 of 500 nodes');
    expect(container.textContent).toContain('capped at 2 nodes for legibility');
  });

  it('explains an edgeless graph rather than leaving unconnected boxes unaccounted for', () => {
    const { container } = render(<GraphCanvas layout={UNCONNECTED} noEdgesNote="No dependency was recovered." />);

    expect(container.textContent).toContain('No dependency was recovered.');
  });

  it('does not show the explanation when edges exist', () => {
    const { container } = render(<GraphCanvas layout={CONNECTED} noEdgesNote="No dependency was recovered." />);

    expect(container.textContent).not.toContain('No dependency was recovered.');
  });

  it('says when a dashed edge means a cycle, and not otherwise', () => {
    const cyclic = { ...CONNECTED, edges: [{ id: 'e1', source: 'a', target: 'b', backEdge: true }] };

    expect(render(<GraphCanvas layout={cyclic} />).container.textContent).toContain('dashed edges close a cycle');
    expect(render(<GraphCanvas layout={CONNECTED} />).container.textContent).not.toContain('dashed edges close a cycle');
  });

  it('gives every node a source and a target handle, so its edges can attach', () => {
    // React Flow only mounts nodes once it has measured the viewport, which jsdom cannot do, so the node
    // component is rendered directly. `Handle` reads React Flow's store, hence the provider.
    const { container } = render(
      <ReactFlowProvider>
        <GraphNodeCard data={{ label: 'a', sublabel: 'b', tone: 'neutral' }} />
      </ReactFlowProvider>,
    );

    expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(2);
    expect(container.querySelector('.react-flow__handle-left')).not.toBeNull();
    expect(container.querySelector('.react-flow__handle-right')).not.toBeNull();
  });

  it('shows a node’s label and sublabel', () => {
    const { container } = render(
      <ReactFlowProvider>
        <GraphNodeCard data={{ label: 'browseFile', sublabel: 'Method · depth 1', tone: 'direct' }} />
      </ReactFlowProvider>,
    );

    expect(container.textContent).toContain('browseFile');
    expect(container.textContent).toContain('Method · depth 1');
  });
});
