# @traceiq/graph

## Purpose

Translate structured facts into the persistent SQLite graph defined by
[`docs/04-graph-spec.md`](../../docs/04-graph-spec.md).

Three modules with one responsibility each:

- **`GraphBuilder`** — a pure function from facts to graph data. No filesystem, no
  compiler, no database.
- **`GraphStore`** — owns the SQLite database: its schema, its pragmas and its
  transactions. The only writer of the graph.
- **`SqliteGraphApi`** — the SQLite implementation of `RepositoryGraphApi` from
  `@traceiq/graph-api`. The only reader.

Keeping them apart is what makes the translation testable without SQLite, and what
keeps SQL out of the translation. **Every SQL statement in the system lives in
`graph-store.ts` or `sqlite-graph-api.ts`** — nothing above this package knows a table
name.

## Responsibilities

- Create nodes and edges from the IR, the resolved repository and framework annotations.
- Generate `External`, `Route` and `EnvironmentVariable` nodes under their approved
  identity schemes.
- Validate referential integrity and the legal endpoint matrix before writing.
- Populate every table, in one transaction.
- Stamp the placeholder revision.

## Non-responsibilities

- Resolves no symbols, and never consults the TypeScript type checker.
- Does not depend on `ts-morph`. Its absence from `package.json` is a checkable
  invariant.
- Performs **no framework analysis**. It creates `Route` nodes, but only by translating
  annotations another package decided; nothing here recognises Express.
- Infers no relationships.
- Computes no confidence value, with one specified exception (below).
- Performs no AI reasoning.
- **The Builder and Store never read the graph.** Reading goes through
  `SqliteGraphApi`, which is read-only by construction — its connection is opened
  `readonly`, so a bug there cannot corrupt a graph.
- **Nothing here traverses.** `getOutgoing` returns one step; following edges is the
  Query Engine's work.

## Inputs

```
RepositoryIR          @traceiq/ir
ResolvedRepository    @traceiq/resolver
FrameworkAnnotations  @traceiq/framework — roles, routes, environmentVariables
CallGraph             @traceiq/call-graph — CALLS relationships and unbound sites
```

Framework annotations are an **input**, not a second writer: the Framework Extractor
decides them and the Builder translates them, so the Builder stays the only module that
writes SQLite (spec §8.8). The annotation type is the producer's own, so writer and
producer cannot drift apart.

Depending on `@traceiq/framework` does not teach the graph about Express. A route has a
method, a path and an ordered handler chain in any web framework, and roles are frozen
contract vocabulary. What this package must not contain is logic that *recognises* a
framework — and it contains none.

## Outputs

`GraphBuilder.build` returns a `RepositoryGraph` — plain objects, JSON-round-trippable.
`GraphStore.write` persists it.

```ts
const graph = new GraphBuilder().build({ ir, resolved });
const store = GraphStore.open('.traceiq/repo.db');

store.write(graph, new Date().toISOString());
store.close();
```

`createdAt` is the caller's to supply. The translated graph is deterministic, and a
timestamp minted inside the store would make otherwise identical writes differ.

## What is derived rather than copied

Almost every field is copied. Three things are derived, each mechanical:

| Derived | How |
|---|---|
| `DECLARES` parentage | Walk `containerChain` upwards to the first ancestor that exists, else the file. Spec §2.1. Unchanged by nested declarations: a function nested in a function is found by the same walk, which is why the endpoint matrix rather than the derivation had to widen |
| `External` identity | Rename of the Resolver's target under the approved scheme. Spec §5.2 |
| Shared-node confidence | The **strongest** confidence among the annotations or edges that materialised it — `External`, `Route`, `EnvironmentVariable` |
| Edge identity | Concatenation of type, endpoints, name, provenance file and position |

The shared-node maximum is the **only** confidence the builder computes, and spec §6.2
permits it explicitly. It is order-independent, so output never depends on the order
things arrived in, and no edge's own confidence is ever altered.

## External identities

```
ext:npm:express            ext:npm:@types/node
ext:node:fs                ext:node:fs/promises
ext:builtin:Promise        ext:builtin:ReadonlyMap
ext:outside-analysis       (single nameless sentinel)
```

A package version never appears in an identity — a version is metadata, and including
it would make every upgrade look like a different dependency.

`ext:node:*` is `CERTAIN`: the `node:` prefix is reserved, so the specifier alone
identifies a builtin. `ext:builtin:*` takes its symbol from the *reference* name,
because a TypeScript built-in is declared across several `lib.*.d.ts` files and the
target deliberately carries no name of its own.

## Routes and environment variables

A route's identity carries no file, so two registrations of the same method and path in
different files are **one node** with both locations and a `null` `file_id`. Without
prefix composition that is common — `GET /` occurs in every router — and composing
prefixes, which is the Query Engine's job, will separate most of them.

`HANDLED_BY` edges carry the **ordinal**, which is what preserves middleware order:
`router.get('/x', requireAuth, handle)` yields ordinal 0 for `requireAuth` and 1 for
`handle`. A handler the Framework Extractor could not link — a member expression, an
inline function — becomes an unresolved reference rather than a silently missing edge.

An environment variable belongs to the process, not a file: every read of `PORT` points
at one `env:PORT` node with no `file_id`, and each read is its own `READS` edge from the
declaration that performs it. A name that cannot form an `env:` identifier —
`process.env['MY-VAR']` — is recorded as unresolved rather than mangled.

**Route paths are as written.** Prefix composition is deliberately not performed here.

## Constraint enforcement

Validation happens twice, on purpose:

1. **In the builder**, before anything is written — so the error names the offending
   edge and the rule it broke.
2. **In SQLite**, via foreign keys (`PRAGMA foreign_keys = ON`) and `CHECK`
   constraints — so a defect cannot reach disk even if validation were bypassed.

A violation is a Graph Builder defect, not bad input, and it fails fast. Nothing is
silently dropped.

`edges.type` is constrained to the thirteen frozen relationship names; `nodes.kind` is
deliberately **not** constrained, because node types are an open vocabulary — `Route`
and `EnvironmentVariable` joined it this milestone, and `DatabaseTable` is still to
come. A `CHECK` there would force exactly the migration the schema is designed to
avoid.

## Transactions

A whole graph is replaced in one transaction, so a partially written graph is never
observable. A failed write leaves the previous graph intact, including its deletions —
there is a test for that.

Delete order runs children before parents, and `nodes` is emptied in two statements
because `nodes.file_id` is self-referential: declarations must go before the `File`
rows they point at. Insert order mirrors it — revisions, `File` nodes, other nodes,
then everything that references a node. Nothing is deferred, so a dangling reference
fails at the statement that caused it.

## Known Limitations

- **`ext:outside-analysis` is a fourth identity form that the approved scheme does not
  name.** On this repository it absorbs 169 of 501 external references — workspace
  siblings resolving to their own `dist` output. The Resolver records no path for
  them, so no package name is recoverable, and they collapse to one node. Needs
  confirmation; see spec §11.1.
- **`revision_id` is always 1 and both hash columns are `NULL`** (approved decision
  2). Nothing can compute a content hash from the current inputs, so incremental
  refresh is not yet possible; the columns exist so it needs no migration.
- **A write replaces the previous graph.** History across revisions is a behaviour
  change, not a schema change.
- **A route merged across files loses its owning file.** `file_id` is `null` and the
  paths are local, both consequences of prefix composition being deferred.
- **`DatabaseTable` nodes do not exist** — that identity is still undefined.
- **`DEPENDS_ON` is not produced.** It needs a `Repository` node, which does not exist
  (the database *is* the repository), and the declared dependency list, which lives in
  the `RepositoryInventory` and is not an input.
- **No migrations exist.** A database whose `schema_version` differs is refused rather
  than migrated, which is correct while nothing has shipped.
- **Cross-package edges do not reach declarations** in a monorepo, inherited from the
  Resolver: a workspace sibling resolves to declaration output outside the IR.

## Performance

On this repository — 79 files, 659 nodes, 1930 edges — translation takes about 2 ms
and the write about 30 ms. Inserts use prepared statements reused across rows.

## Testing Notes

The builder is tested with synthetic IR and resolved inputs, which keeps each test
precise about the one fact it checks and needs no TypeScript program. The store is
tested against real temporary databases, including foreign-key enforcement, `CHECK`
rejection, rollback and repeat-write determinism.

`pipeline.test.ts` runs real TypeScript through all five stages into SQLite and
asserts the database satisfies its own integrity checks — the unit tests prove the
parts, that one proves they fit together.
