# @traceiq/graph-api

## Purpose

The only way to read the repository graph, and the read model it returns.

This package exists so that a reader — the Query Engine, and everything above it —
depends on an abstraction rather than on SQLite. It contains **no database driver, no SQL
and no storage concept whatsoever**, which is why depending on it cannot pull a database
into a consumer's dependency tree.

## Responsibilities

- Define `RepositoryGraphApi`: six read operations.
- Define the read model: `GraphNode`, `GraphEdge`, `GraphRole`,
  `GraphUnresolvedReference`, and the node-kind vocabulary.

## Non-responsibilities

- **Traverses nothing.** `getOutgoing` returns one step from one node.
- Ranks nothing, filters nothing by relevance, infers nothing.
- Performs no framework analysis and no AI reasoning.
- Exposes no SQL and no SQLite type.
- Contains no implementation. `@traceiq/graph` provides the SQLite one.

## The interface

```ts
getNode(id): GraphNode | null
exists(id): boolean
getOutgoing(id, type?): readonly GraphEdge[]
getIncoming(id, type?): readonly GraphEdge[]
getEdges(type): readonly GraphEdge[]
getNodes(kind): readonly GraphNode[]
getRoles(nodeId): readonly GraphRole[]
getUnresolved(): readonly GraphUnresolvedReference[]
```

Eight operations, each a direct lookup. Deliberately no more: a predicate, a depth limit
or a sort order would be the beginning of a query language, and that belongs to the Query
Engine.

The optional relationship type on the edge accessors is the **only** filtering, added
because a traversal wanting one edge type should not read and discard the rest. It is
served by its own prepared statement rather than a nullable predicate, so each stays a
plain indexed lookup.

**Every operation is deterministic.** Lists come back in a defined order — nodes by
identifier, edges by identifier — so the same graph always answers the same way and a
caller never sorts defensively.

A missing node yields `null`; a node with no edges, or one that is not in the graph at
all, yields an empty list rather than an error. Asking about something absent is a normal
question, not a failure.

## Why the model lives here

`@traceiq/graph` needs the same node and edge types for the write side. Defining them
here and importing them there gives one definition rather than two that can drift, and
keeps the read model reachable without a database.

## Known Limitations

- **No role index.** `getRoles` answers per node, so finding every declaration carrying a
  role means asking each candidate. A `getNodesWithRole` accessor would make that a single
  lookup; the cost currently lands in the Query Engine's `findByRole`.
- **No batch accessor.** Fetching many nodes by identifier means one call each, which is
  what makes edge hydration N+1 for a caller.
- **No revision parameter.** Version 1 stores a single revision, so every read sees it.
  Revision-aware reads are a later concern.
