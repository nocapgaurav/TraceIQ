'use client';

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Info } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';

import { count } from '@/lib/format';
import type { Layout } from '@/lib/graph-layout';
import { cn } from '@/lib/utils';

import '@xyflow/react/dist/style.css';

/**
 * The one React Flow surface in the app.
 *
 * Every graph — package dependencies, impact — goes through here, so panning, zooming, the minimap and
 * the dark-mode treatment are defined once. The component receives a finished `Layout` from a pure
 * function and does no layout of its own.
 *
 * Positions are fixed and dragging is off: the layout carries meaning (a column is a dependency depth),
 * so letting a node be dragged would let a user destroy the only information the arrangement conveys.
 */

const TONE: Readonly<Record<string, string>> = {
  target: 'border-primary bg-primary/10 ring-2 ring-primary/40',
  direct: 'border-warning/60 bg-warning/10',
  indirect: 'border-border bg-card',
  neutral: 'border-border bg-card',
};

interface CardData extends Record<string, unknown> {
  readonly label: string;
  readonly sublabel: string;
  readonly tone: string;
}

/**
 * A node.
 *
 * The two `Handle`s are **required, not decorative**: React Flow attaches an edge to a handle, and a
 * custom node without any silently drops every edge connected to it — the graph then draws as a field of
 * unconnected boxes while the edge count beside it says otherwise. They are made invisible rather than
 * omitted, since the arrangement already shows direction and a visible dot on each card adds noise.
 */
export function GraphNodeCard({ data }: Pick<NodeProps<Node<CardData>>, 'data'>) {
  return (
    <div
      className={cn(
        'w-[210px] rounded-md border px-3 py-2 text-left shadow-sm transition-colors',
        TONE[data.tone] ?? TONE.neutral,
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <p className="truncate font-mono text-xs font-medium" title={data.label}>
        {data.label}
      </p>
      <p className="truncate text-[10px] text-muted-foreground" title={data.sublabel}>
        {data.sublabel}
      </p>
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-0 !bg-transparent" />
    </div>
  );
}

const NODE_TYPES = { card: GraphNodeCard as React.ComponentType<NodeProps<Node<CardData>>> };

export function GraphCanvas({
  layout,
  linkFor,
  height = 460,
  emptyLabel = 'Nothing to draw',
  noEdgesNote,
}: {
  readonly layout: Layout;
  /** Where clicking a node goes. Returning `null` makes that node inert. */
  readonly linkFor?: (id: string) => string | null;
  readonly height?: number;
  readonly emptyLabel?: string;
  /**
   * Shown when there are nodes but no edges.
   *
   * A picture of unconnected boxes looks like a rendering fault, when it is usually a real and
   * explainable fact about the graph. The caller supplies the explanation, because only it knows which
   * limitation applies.
   */
  readonly noEdgesNote?: string;
}) {
  const router = useRouter();

  const nodes = useMemo<Node<CardData>[]>(
    () =>
      layout.nodes.map((node) => ({
        id: node.id,
        type: 'card',
        position: { x: node.x, y: node.y },
        data: { label: node.label, sublabel: node.sublabel, tone: node.tone },
        draggable: false,
        connectable: false,
      })),
    [layout.nodes],
  );

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: false,
        // A back-edge closes a cycle. Dashed and warning-toned, because it is the interesting one.
        style: edge.backEdge
          ? { stroke: 'var(--warning)', strokeWidth: 1.5, strokeDasharray: '4 3' }
          : { stroke: 'var(--border)', strokeWidth: 1.5 },
      })),
    [layout.edges],
  );

  if (layout.nodes.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {layout.edges.length === 0 && noEdgesNote !== undefined ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {noEdgesNote}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border" style={{ height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.2}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={linkFor !== undefined}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            const href = linkFor?.(node.id) ?? null;

            if (href !== null) {
              router.push(href);
            }
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-card" maskColor="rgb(0 0 0 / 0.15)" />
        </ReactFlow>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {count(layout.nodes.length)} of {count(layout.total)} nodes · {count(layout.edges.length)} edges
          {layout.edges.some((edge) => edge.backEdge) ? ' · dashed edges close a cycle' : ''}
        </span>
        {layout.truncated ? (
          <span className="text-warning">capped at {count(layout.nodes.length)} nodes for legibility</span>
        ) : null}
      </div>
    </div>
  );
}
