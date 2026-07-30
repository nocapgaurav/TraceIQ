import type { NodeId } from '@traceiq/types';
import { describe, expect, it } from 'vitest';

import { connectedComponents, maxDepthFromRoots, stronglyConnectedComponents } from './graph-algorithms.js';
import type { Adjacency } from './graph-index.js';

/** Builds an adjacency from `'a->b'` pairs, mirroring how the index builds one from edges. */
function adjacencyOf(pairs: readonly string[]): Adjacency {
  const out = new Map<NodeId, NodeId[]>();
  const incoming = new Map<NodeId, NodeId[]>();

  for (const pair of pairs) {
    const [from, to] = pair.split('->') as [NodeId, NodeId];

    (out.get(from) ?? out.set(from, []).get(from) ?? []).push(to);
    (incoming.get(to) ?? incoming.set(to, []).get(to) ?? []).push(from);
  }

  return { out, in: incoming };
}

const participants = (adjacency: Adjacency): readonly NodeId[] =>
  [...new Set([...adjacency.out.keys(), ...adjacency.in.keys()])].sort();

const componentsOf = (pairs: readonly string[]): readonly (readonly string[])[] => {
  const adjacency = adjacencyOf(pairs);

  return stronglyConnectedComponents(adjacency, participants(adjacency));
};

describe('stronglyConnectedComponents', () => {
  it('finds no cycle in an acyclic chain', () => {
    expect(componentsOf(['a->b', 'b->c', 'c->d'])).toEqual([]);
  });

  it('finds a two-node cycle', () => {
    expect(componentsOf(['a->b', 'b->a'])).toEqual([['a', 'b']]);
  });

  it('finds a longer cycle', () => {
    expect(componentsOf(['a->b', 'b->c', 'c->a'])).toEqual([['a', 'b', 'c']]);
  });

  it('treats a self-loop as a cycle, recursion being a real one', () => {
    expect(componentsOf(['a->a'])).toEqual([['a']]);
  });

  it('does not treat a lone node with no self-loop as a cycle', () => {
    expect(componentsOf(['a->b'])).toEqual([]);
  });

  it('finds several independent cycles', () => {
    const found = componentsOf(['a->b', 'b->a', 'x->y', 'y->x', 'p->q']);

    expect(found.map((component) => component.join(','))).toEqual(['a,b', 'x,y']);
  });

  it('separates two cycles joined by a one-way edge', () => {
    // a↔b → c↔d: two components, not one, because the link is not mutual. Tarjan emits the
    // deeper component first, which is its reverse topological order.
    const found = componentsOf(['a->b', 'b->a', 'b->c', 'c->d', 'd->c']);

    expect(found.map((component) => component.join(','))).toEqual(['c,d', 'a,b']);
  });

  it('orders members within a component by identifier', () => {
    expect(componentsOf(['z->y', 'y->z'])).toEqual([['y', 'z']]);
  });

  it('finds the same components whatever order the edges arrive in', () => {
    const forward = componentsOf(['a->b', 'b->c', 'c->a', 'x->y', 'y->x']);
    const backward = componentsOf(['y->x', 'x->y', 'c->a', 'b->c', 'a->b']);

    expect(forward).toEqual(backward);
  });

  it('handles a node inside a cycle that also points outside it', () => {
    const found = componentsOf(['a->b', 'b->a', 'a->c']);

    expect(found).toEqual([['a', 'b']]);
  });

  it('survives a chain far deeper than the call stack', () => {
    // Tarjan is iterative for exactly this reason: recursion would overflow here.
    const pairs = Array.from({ length: 50_000 }, (_, index) => `n${index}->n${index + 1}`);

    expect(stronglyConnectedComponents(adjacencyOf(pairs), participants(adjacencyOf(pairs)))).toEqual([]);
  });

  it('finds a cycle at the end of a very deep chain', () => {
    const pairs = [
      ...Array.from({ length: 20_000 }, (_, index) => `n${index}->n${index + 1}`),
      'n20000->n19999',
    ];
    const found = stronglyConnectedComponents(adjacencyOf(pairs), participants(adjacencyOf(pairs)));

    expect(found).toHaveLength(1);
    expect(found[0]).toHaveLength(2);
  });

  it('returns nothing for an empty graph', () => {
    expect(componentsOf([])).toEqual([]);
  });
});

describe('connectedComponents', () => {
  it('counts one component for a connected chain', () => {
    const adjacency = adjacencyOf(['a->b', 'b->c']);

    expect(connectedComponents(adjacency, participants(adjacency))).toEqual({
      count: 1,
      largest: 3,
      singletons: 0,
    });
  });

  it('counts separate components separately', () => {
    const adjacency = adjacencyOf(['a->b', 'x->y', 'p->q']);

    expect(connectedComponents(adjacency, participants(adjacency))).toMatchObject({
      count: 3,
      largest: 2,
    });
  });

  it('ignores direction, so two callers of one helper are one component', () => {
    const adjacency = adjacencyOf(['a->helper', 'b->helper']);

    expect(connectedComponents(adjacency, participants(adjacency)).count).toBe(1);
  });

  it('counts a self-looping lone node as a singleton', () => {
    const adjacency = adjacencyOf(['a->a']);

    expect(connectedComponents(adjacency, participants(adjacency))).toEqual({
      count: 1,
      largest: 1,
      singletons: 1,
    });
  });

  it('reports zeroes for an empty graph rather than failing', () => {
    expect(connectedComponents(adjacencyOf([]), [])).toEqual({ count: 0, largest: 0, singletons: 0 });
  });

  it('survives a very wide graph', () => {
    const pairs = Array.from({ length: 50_000 }, (_, index) => `hub->n${index}`);
    const adjacency = adjacencyOf(pairs);

    expect(connectedComponents(adjacency, participants(adjacency))).toMatchObject({ count: 1 });
  });
});

describe('maxDepthFromRoots', () => {
  it('measures the depth of a chain', () => {
    const adjacency = adjacencyOf(['a->b', 'b->c', 'c->d']);

    expect(maxDepthFromRoots(adjacency, ['a' as NodeId])).toBe(3);
  });

  it('is zero when the root reaches nothing', () => {
    expect(maxDepthFromRoots(adjacencyOf([]), ['a' as NodeId])).toBe(0);
  });

  it('is zero when there is no root at all, as in a pure cycle', () => {
    // Every node in a cycle has an incoming edge, so no root exists and nothing is reported.
    expect(maxDepthFromRoots(adjacencyOf(['a->b', 'b->a']), [])).toBe(0);
  });

  it('takes the shortest distance when two roots reach one node', () => {
    // deep->mid->target is 2; near->target is 1. The nearer root wins.
    const adjacency = adjacencyOf(['deep->mid', 'mid->target', 'near->target']);
    const depth = maxDepthFromRoots(adjacency, ['deep' as NodeId, 'near' as NodeId]);

    expect(depth).toBe(1);
  });

  it('terminates on a cycle reachable from a root', () => {
    const adjacency = adjacencyOf(['root->a', 'a->b', 'b->a']);

    expect(maxDepthFromRoots(adjacency, ['root' as NodeId])).toBe(2);
  });

  it('survives a chain far deeper than the call stack', () => {
    const pairs = Array.from({ length: 50_000 }, (_, index) => `n${index}->n${index + 1}`);

    expect(maxDepthFromRoots(adjacencyOf(pairs), ['n0' as NodeId])).toBe(50_000);
  });
});
