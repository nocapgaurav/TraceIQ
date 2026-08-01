# TraceIQ Graph Specification

**Status:** proposed, awaiting approval. Once approved this is the frozen contract
for every graph-related package: Graph Builder, Graph Store and Query Engine.

**Version:** 1.0 (draft), revised after a consistency audit. Eleven inconsistencies
were found and corrected; §8.8 (who populates what), §10.1 (why each derived value
belongs here) and §10.2 (future milestones against this schema) were added to make
the audited properties checkable rather than implied.

No implementation exists. Two items block freezing outright: §11.1, without which
`External` is not a node type at all, and §11.2, without which two tables have no
writer.

---

## 0. Scope and inputs

In version 1 the Graph Builder consumes exactly two structures:

| Input | From | Carries |
|---|---|---|
| `RepositoryIR` | `@traceiq/ir` | repository, files, declarations, imports, exports, call sites, member accesses |
| `ResolvedRepository` | `@traceiq/resolver` | enriched declarations, resolved relationships, unresolved references |
| `FrameworkAnnotations` | `@traceiq/framework` | roles, routes, environment variables |
| `CallGraph` | `@traceiq/call-graph` | `CALLS` relationships and unbound call sites |

It has no access to the filesystem, the `ProjectContext`, the type checker, or the
`RepositoryInventory`. Anything not present in those structures cannot appear in the
graph, and this document says so explicitly wherever that bites.

**A `CallGraph` and a `RepositoryIR` may now be the join of several bounded compilations.** A
repository too large for one compiler program is analysed a semantic region at a time, each program
released before the next is loaded. That is invisible here: the units own disjoint file sets, so
what arrives is a concatenation and every identity is minted exactly once, as before. What changes
for a reader is that `revisions.source_hash` — reserved and unwritten since this document was
written — now carries a fingerprint of the analysed sources, so an unchanged repository is not
analysed twice.

**Later milestones add inputs, never writers.** The Framework Extractor produces
routes and role annotations; those arrive as a *third input to the Graph Builder*,
not as a second module writing to SQLite (§8.8). Adding an input is not a schema
change, and the Graph Builder remains the only module that writes the graph.

**The Graph Builder is a pure translation layer.** Almost every field is copied from
its inputs. It derives only the values below — each mechanical, deterministic and
specified in full so that it is checkable rather than judgemental:

| Derived value | Where | Nature |
|---|---|---|
| `DECLARES` parentage | §2.1 | arithmetic over `containerChain` and `fileId` |
| `External` node identity and confidence | §5.2, §6.2 | a rename of the Resolver's target, and a maximum over the edges that introduce it |
| Edge identity | §5.4 | concatenation of fields that already exist |

Nothing else is computed. In particular no confidence level is ever recalculated
for an edge, and no fact is improved, merged on meaning, or pruned.

---

## 1. Node types

### 1.1 Produced in version 1

| Node type | Source |
|---|---|
| `File` | `RepositoryIR.files` |
| `Class` | IR declaration, kind `class` |
| `Interface` | IR declaration, kind `interface` |
| `TypeAlias` | IR declaration, kind `type-alias` |
| `Enum` | IR declaration, kind `enum` |
| `EnumMember` | IR declaration, kind `enum-member` |
| `Function` | IR declaration, kind `function` |
| `Method` | IR declaration, kind `method` |
| `Property` | IR declaration, kind `property` |
| `Accessor` | IR declaration, kind `accessor` |
| `Constructor` | IR declaration, kind `constructor` |
| `Variable` | IR declaration, kind `variable` |
| `Namespace` | IR declaration, kind `namespace` |
| `Route` | `RouteAnnotation` from the Framework Extractor |
| `EnvironmentVariable` | `EnvironmentVariableAnnotation` from the Framework Extractor |
| `External` | `ResolutionTarget` of kind `external` — **conditional on §11.1** |
| `Technology` | a framework, runtime or infrastructure tool, detected from evidence |

> **`Technology` is a node, and a region is not.** The distinction is the reason for both. A region
> describes *the analysis* — how deeply TraceIQ read a directory — so making it a node would put the
> analysis into search results beside the code. A technology describes *the software*: that
> `apps/web` is a Next.js application is a fact of the same kind as "this file declares that class",
> and a reader searching `next` should find it. `category` (§3) carries what it is for, and the
> files that prove it travel in the provenance; no edge links a technology to its evidence, because
> no member of the frozen vocabulary means "is proof of" and stretching one would make that
> relationship unqueryable for what it does mean.

`External` is the one node type whose identity prefix does not yet exist in the
contract. If §11.1 is rejected it is not a node type at all, and external targets
become opaque edge columns instead; every other row of this table is unconditional.

Volume, measured on this repository at the time of writing: 71 files, 434
declarations and 1164 relationships produce 71 `File` nodes, 434 declaration nodes
and 12 distinct `External` nodes. These figures are evidence for the sizing and
identity decisions below, not part of the contract.

Declaration node types map **one-to-one** onto `DECLARATION_KINDS` from
`@traceiq/ir`. The mapping is a rename from kebab-case to PascalCase and nothing
more, so a new IR declaration kind is a new node type with no other consequence.

### 1.2 Deliberately absent

**`Repository`.** There is one database per repository, so the repository is the
database rather than a row in it. Its metadata lives in a singleton table (§8.2).
This removes the need for a `repo:` identity prefix.

**`Directory`.** Every `File` node carries its repository-relative path, from which
a directory tree is fully derivable by the Query Engine. Materialising directories
would add nodes that carry no information the paths do not already carry, and would
need an identity prefix the contract does not define.

**Architectural roles.** `Controller`, `Service`, `Repository`, `Middleware`,
`Model` and `Test` are **not node types**. They are confidence-bearing annotations
on declaration nodes, stored in `node_roles` (§8.5). The Framework Extractor decides
them and the Graph Builder writes them (§8.8). That a class is a class is proven
syntax; that it is a Service is a judgement, and the two must not be conflated into
one type.

### 1.3 Reserved, not produced

| Node type | Milestone | Identity |
|---|---|---|
| `DatabaseTable` | later | **not defined** — needs an identity prefix |

A node type with no identity scheme cannot be produced. §11.5 records this.

`Route` and `EnvironmentVariable` were reserved and are now produced, since the Graph
Builder consumes the complete framework annotation model.

---

## 2. Edge types

Edge types are drawn **only** from `RELATIONSHIP_TYPES` in `@traceiq/types`. No new
relationship name is introduced, and there is no generic `USES`.

### 2.1 Produced in version 1

| Edge | Derived from | Confidence |
|---|---|---|
| `DECLARES` | IR structure — see below | always `CERTAIN` |
| `IMPORTS` | `ResolvedRelationship` type `IMPORTS` | copied |
| `EXPORTS` | `ResolvedRelationship` type `EXPORTS` | copied |
| `EXTENDS` | `ResolvedRelationship` type `EXTENDS` | copied |
| `IMPLEMENTS` | `ResolvedRelationship` type `IMPLEMENTS` | copied |
| `REFERENCES_TYPE` | `ResolvedRelationship` type `REFERENCES_TYPE` | copied |
| `HANDLED_BY` | `RouteAnnotation.handlers` | copied from the route |
| `READS` | `EnvironmentVariableAnnotation` | copied |
| `CALLS` | `CallRelationship` from the call graph | copied |
| `CALLS` | `ExternalCall` from the call graph | target identity minted, as for an import |
| `CONTINUES_TO` | a client call matched to a `Route` | `INFERRED`, always |

> **`CONTINUES_TO` is produced, and needed no vocabulary change.** It was reserved and unproduced
> since this document was written; "execution continues to" is exactly what an outbound HTTP request
> to a locally-served endpoint does. It is the only relationship that crosses a language boundary —
> a React component's `fetch('/api/users')` reaching a Flask `@app.route('/api/users')` — and the
> source side admits `File` because a module-level request has no enclosing declaration. Always
> `INFERRED`: the two sides agree on a normalised path string, and nothing proves the request
> reaches *this* server. An absolute URL to another host is excluded for that reason.

> **`ExternalCall` is produced by every analyser, not only the checker-backed one.** It was
> documented as `RESOLVED` and checker-only, which made "which of my declarations use this
> dependency" a question only TypeScript could answer — and only with `node_modules` installed.
> Two rules produce these now. The checker types the receiver and reports `RESOLVED`. Every
> analyser can also read the *import statement*: a call rooted at a name the file imported from a
> package is a call into that package, whether or not the package is installed and whether or not
> the language has a type checker. That rule reports `INFERRED`, except in Go, where a package
> qualifier names exactly one import path and the internal rule already earned `RESOLVED`.

Five of the six are a field-for-field copy of a `ResolvedRelationship`. `DECLARES`
is the one edge the Graph Builder derives, and its rule is fully mechanical:

> **`DECLARES` derivation.** For each IR declaration *d* with
> `containerChain = [s₁ … sₙ]` and `fileId = f`:
>
> 1. For *k* from *n−1* down to 1, form the candidate identifier
>    `sym:<path of f>#s₁.….s_k`. The **first** candidate that exists as a
>    declaration is the parent; emit `parent —DECLARES→ d`.
> 2. If no candidate exists, or *n* = 1, emit `f —DECLARES→ d`.
>
> Step 1 walks upwards rather than taking the immediate parent because a dotted
> namespace (`namespace A.B {}`) declares `A.B` without declaring `A`. Under this
> rule `A.B` is declared by its file, and members of `A.B` are declared by `A.B`.

The rule is unchanged by nested declarations: a function nested in a function has the
outer function in its `containerChain`, so the same arithmetic finds it. What nesting does
change is which node kinds appear as a **source**, widened in §2.3.

This is arithmetic over `containerChain` and `fileId`, both already in the IR. It
involves no name resolution, no scope analysis and no compiler.

### 2.2 Reserved, not produced

`WRITES`, `TESTS`.

`HANDLED_BY`, `READS`, `CALLS`, `DEPENDS_ON` and `CONTINUES_TO` were reserved and are now produced.
Each left this list when a fact it already described became recoverable, and none required widening
the vocabulary — which is the property the freeze exists to protect.

`DEPENDS_ON` deserves a note: it is `Repository → ExternalPackage` in the contract,
and is **not producible in version 1 for two reasons** — there is no `Repository`
node (§1.2), and the declared dependency list lives in the `RepositoryInventory`,
which is not an input. Producing it would require adding the inventory as a third
input, which is a scope change rather than an implementation detail.

### 2.3 Legal endpoint matrix

Enforced at insert time. A violation is a **Graph Builder defect** and must fail
loudly; it must never be silently dropped.

| Edge | Legal source | Legal target |
|---|---|---|
| `DECLARES` | `File`, `Class`, `Interface`, `Enum`, `Namespace`, `Function`, `Method`, `Constructor`, `Accessor`, `Variable` | any declaration node |
| `IMPORTS` | `File` | `File`, `External`, any declaration node |
| `EXPORTS` | `File` | `File`, `External`, any declaration node |
| `EXTENDS` | `Class`, `Interface` | `Class`, `Interface`, `TypeAlias`, `Function`, `Variable`, `External` |
| `IMPLEMENTS` | `Class` | `Interface`, `TypeAlias`, `Function`, `Variable`, `External` |
| `CALLS` | `File`, any declaration node | any declaration node, `External` |
| `HANDLED_BY` | `Route` | any declaration node |
| `READS` | `File`, any declaration node | `EnvironmentVariable` |
| `REFERENCES_TYPE` | any declaration node | `Class`, `Interface`, `TypeAlias`, `Enum`, `EnumMember`, `Namespace`, `External` |

`IMPORTS` and `EXPORTS` admit three target kinds because the Resolver records two
granularities: a statement's module resolves to a `File` or an `External`, while a
binding resolves to a declaration. Both are needed — a side-effect import has no
bindings, and a resolved binding no longer says which module it came from.

**Why the heritage and type rows are wider than they first appear.** The matrix must
admit everything legal TypeScript can produce, or the Builder rejects valid code:

- `class A extends Mixin(Base)` — a mixin factory. The heritage expression resolves
  to a `Function` or a `Variable`, not a class.
- `let x: Status.Active` — an enum member used as a type resolves to `EnumMember`.
- A qualified type name may resolve to a `Namespace`.

Kinds that remain excluded are excluded deliberately: no heritage clause or type
annotation can resolve to a `Property`, `Method`, `Constructor`, `Accessor` or
`File`. A row outside this matrix is a Builder defect and must fail loudly.

---

## 3. Node schema

Every node carries the following. Columns are given in §8.

| Field | Type | Notes |
|---|---|---|
| `id` | identity string | §5. Primary key |
| `kind` | node type | §1 |
| `name` | text | IR `name`; for `File`, the repository-relative path |
| `file_id` | identity or null | Declaration nodes only; `null` for `File` and `External` |
| `container_chain` | text or null | Dot-joined IR `containerChain`; declaration nodes only |
| `visibility` | `public`\|`protected`\|`private`\|null | IR `visibility`; null where the language has no such concept |
| `is_exported` | boolean | IR `modifiers.isExported` — an `export` modifier in the syntax |
| `is_static` | boolean | IR `modifiers.isStatic` |
| `is_abstract` | boolean | IR `modifiers.isAbstract` |
| `is_readonly` | boolean | IR `modifiers.isReadonly` |
| `is_optional` | boolean | IR `modifiers.isOptional` |
| `is_async` | boolean | IR `modifiers.isAsync` |
| `is_declaration_file` | boolean or null | `File` nodes only |
| `has_symbol` | boolean or null | `ResolvedDeclaration.hasSymbol` |
| `is_exported_from_module` | boolean or null | `ResolvedDeclaration.isExportedFromModule` |
| `external_origin` | text or null | `External` nodes only |
| `external_name` | text or null | `External` nodes only; null for a TypeScript built-in |
| `confidence` | confidence level | §6 |
| `revision_id` | integer | §8.3 |

**`is_exported` and `is_exported_from_module` are both kept, deliberately.** The
first is syntax: an `export` keyword on the declaration. The second is what the
checker confirmed, and includes a declaration exported by a separate
`export { … }` statement. They disagree on real code — on this repository,
`local` in a fixture is exported only by statement — and collapsing them would
destroy the distinction between what was written and what is true.

**Locations are normalised** into `node_locations` (§8.4) rather than denormalised
onto the node, because a declaration may have several sites: overload signatures, a
getter/setter pair, or a merged interface. Ordinal 0 is the primary site, and sites
are stored in source order, matching the IR.

`File` and `External` nodes have **no rows** in `node_locations`. A file is not at a
position within itself, and an external target has no position in this repository. A
consumer must therefore treat an empty location set as normal for those kinds.

### 3.1 Enrichment may be absent

`has_symbol` and `is_exported_from_module` come from `ResolvedDeclaration`. On this
repository the Resolver enriches every IR declaration — 434 of 434, with no
duplicates — but the Graph Builder must **not** depend on that. Where no
`ResolvedDeclaration` exists for an IR declaration, both columns are `NULL`, meaning
*not established* rather than *false*. Substituting `0` would assert a checker result
that was never obtained.

### 3.2 Provenance for rows the Builder originates

Most rows copy provenance from the Resolver. Three kinds of row have none to copy, so
their evidence text is **specified here** rather than left to the implementer, to keep
it consistent and greppable:

| Row | `extractor` / `resolver` | `evidence` |
|---|---|---|
| `File` node | `graph-builder` | `recorded by the IR Builder as a source file of this repository` |
| Declaration node | `graph-builder` | `recorded by the IR Builder as a <kind> declaration` |
| `External` node | `graph-builder` | `introduced as the target of <n> resolved reference(s)` |
| `DECLARES` edge | `graph-builder` | `<parent kind> declares <child kind>, established syntactically` |

Declaration nodes additionally carry the Resolver's enrichment evidence where one
exists; the text above is the fallback, not a replacement.

---

## 4. Edge schema

| Field | Type | Notes |
|---|---|---|
| `id` | identity string | §5.4. Deterministic, never random |
| `type` | edge type | §2 |
| `source_id` | identity | Must exist as a node |
| `target_id` | identity | Must exist as a node |
| `name` | text or null | The name being resolved: a binding, an exported name, a type name |
| `confidence` | confidence level | §6 |
| `candidate_group` | text or null | §6.3. Shared by every candidate of one ambiguous reference |
| `ordinal` | integer or null | Position in an ordered chain. Set on `HANDLED_BY` to preserve middleware order; `null` on every other edge type |
| `provenance_resolver` | text | §7 |
| `provenance_file_id` | identity | §7. The file whose syntax produced the edge |
| `provenance_evidence` | text | §7. Human-readable explanation |
| `start_line`, `start_column`, `end_line`, `end_column` | integer | The reference site, not the target |
| `revision_id` | integer | §8.3 |

**Referential integrity is mandatory.** An edge whose source or target is not a
node is a Graph Builder defect. In particular, every `External` node must be
created before, or in the same transaction as, the edges pointing at it.

**The location is the reference site.** For `EXTENDS`, it is the heritage clause in
the subclass, not the base class's declaration. This is what makes an edge
explainable: it points at the text that caused it.

---

## 5. Stable identities

Identities are derived, never generated. No random or sequential surrogate key
appears in any identity.

### 5.1 Existing prefixes

From the frozen contract, built by `@traceiq/shared`:

```
file:<repository-relative path>              file:src/auth/auth.service.ts
sym:<repository-relative path>#<chain>       sym:src/auth/auth.service.ts#AuthService.login
route:<METHOD>:<path>                        route:POST:/api/auth/login
env:<NAME>                                   env:DATABASE_URL
```

**`env:<NAME>` is frozen** (approved). An environment variable belongs to the process
rather than to a file, so its identity carries no path: every read of `DATABASE_URL`
names the same node. A name that cannot form this identity — `process.env['MY-VAR']` —
is recorded as an unresolved reference rather than mangled into a different name.

**A route identity carries no file**, so two registrations of the same method and path in
different files are one node. Without prefix composition that is common: `GET /` occurs
in every router. Such a node carries every registration's location, and its `file_id` is
`null` because it belongs to no single file. Composing prefixes is a Query Engine
responsibility, and doing so will separate most of these.

`sym:` chains may contain a leading `#` on the final segment for an ECMAScript
private member (`…#AuthService.#secret`); parsing splits on the **first** `#`, which
always ends the path.

### 5.2 External identities (approved)

```
env:<NAME>                      env:DATABASE_URL
ext:npm:<package-name>          ext:npm:express
                               ext:npm:@types/node
ext:node:<module-name>          ext:node:fs
                               ext:node:fs/promises
ext:builtin:<symbol-name>       ext:builtin:Promise
ext:outside-analysis            (single sentinel node — see below)
```

**Package versions never appear in an identity.** A version is metadata; putting it
in an identity would make every upgrade look like a different dependency.

Derived from the Resolver's `ResolutionTarget` as follows:

| `origin` | Identity | Name source |
|---|---|---|
| `package` | `ext:npm:<name>` | `target.name` |
| `node-builtin` | `ext:node:<name>` | `target.name` with the reserved `node:` prefix stripped |
| `typescript-lib` | `ext:builtin:<symbol>` | the **relationship's** `name` — the target itself carries none, deliberately (§6.3) |
| `outside-analysis` | `ext:outside-analysis` | none available |

**`outside-analysis` has no approved form, and one is required.** The Resolver
reports these with `target.name` of `null` and records no path, so no package or
symbol name is recoverable — recovering one would mean inspecting paths, which is the
monorepo question that is out of scope. On this repository they are workspace
siblings resolving to their own `dist` output: 169 of 501 external references. They
therefore collapse to a **single sentinel node** carrying no name, exactly as the
approved-and-frozen §5.2 predecessor specified for nameless externals. See §11.1.

**Fallback.** If a `typescript-lib` target ever appears with no relationship name,
the identity is the bare `ext:builtin` with no symbol segment. This does not occur on
this repository — all 65 such references carry a name — but the rule exists so the
behaviour is defined rather than accidental. A name is never fabricated.

### 5.3 Identity stability

Identities survive an edit to a declaration's body. They do **not** survive a rename
or a file move, which reads as a delete plus a create. Rename detection is out of
scope, as recorded since the IR milestone.

### 5.4 Edge identity

Deterministic, so that analysing the same sources twice produces the same edge
identity and two revisions are comparable:

```
edge:<type>:<source_id>|<target_id>|<name>|<provenance_file_id>|<line>:<column>
```

The reference site is part of the identity because two references from the same
source to the same target at different positions are two distinct facts. The name is
included because one site may resolve several names. Fields are joined with `|`, and
absent fields render as the empty string.

**Separator invariant.** No constituent field may contain `|`. Identities use only
`file:`, `sym:` and `ext:` forms; a `name` is an identifier, a dotted qualified name,
or `default`. Verified across all 4656 field values produced by this repository: none
contains the separator. A field that could contain `|` would require escaping, and
introducing one is a contract change.

**Ambiguity does not collide.** The N edges of an ambiguous reference share source,
type, name, provenance and location, and differ only in `target_id` — which is part
of the identity, so each candidate gets a distinct one.

---

## 6. Confidence handling

Only the four frozen levels, in descending trust order:

```
CERTAIN  >  RESOLVED  >  INFERRED  >  AMBIGUOUS
```

Numeric scores are prohibited. This ordering is normative — §6.2 depends on it.

### 6.1 Edge confidence

Copied verbatim from the `ResolvedRelationship`. **For edges, the Graph Builder never
computes, adjusts, downgrades or upgrades a confidence level.** `DECLARES` is the one
edge it originates, and it is always `CERTAIN` because it is derived from syntax
alone.

This rule is about edges only. Node confidence needs a rule of its own, and §6.2
states the single aggregation the Builder is permitted to perform.

### 6.2 Node confidence

- `File` and every declaration node: **`CERTAIN`**. They exist in the IR, which is
  syntactic.
- `Route` and `EnvironmentVariable`: the **strongest** confidence among the annotations
  that materialised it, by the same rule as `External` below.
- `External`: the **strongest** confidence among the edges that introduced it, under
  the ordering above. A package reached by one `RESOLVED` import and one `INFERRED`
  import exists with `RESOLVED` confidence, because the best evidence settles whether
  a thing exists.

This maximum is the **only** confidence value the Graph Builder computes, and it is
listed as such in §0. It is deterministic and order-independent, so it does not make
the output depend on traversal order. It is an aggregation over facts already stated,
not an inference about the world: no edge's confidence changes, and no new claim is
made beyond "this node exists because at least one edge says so".

### 6.3 Ambiguity

An ambiguous reference is already expanded by the Resolver into one relationship per
candidate, all sharing a `candidateGroup`. The Graph Builder copies each into its
own edge, preserving the group. Ambiguity is therefore never collapsed, never
resolved by picking a winner, and never discarded.

A consumer reads a non-null `candidate_group` as "these edges are alternatives",
not as "these are independent facts".

> Note: `AMBIGUOUS` is currently unreachable in practice — see the Resolver README.
> The path is nonetheless specified and must be implemented, because the constraint
> is that ambiguity is never discarded, not that it is never encountered.

### 6.4 Unresolved references

A reference that could not be resolved is **not an edge**, because an edge requires
two endpoints. It is persisted in `unresolved_references` (§8.6) with its reason,
its unresolved text, its provenance and its location.

This keeps every unresolved reference visible and queryable — the Query Engine can
answer "what does this file reference that we could not resolve" — without inventing
a sentinel node type whose identity the contract does not define.

**Two of the reasons are not failures**, and the distinction is load-bearing rather than
cosmetic. `type-parameter` and `value-is-not-a-declaration` both mean resolution succeeded and
there is simply nothing addressable at the other end: a type parameter the IR does not record, or
an exported literal such as `module.exports = { printWidth: 80 }`. Filing those under a failure
reason makes a bind rate a measure of how much data a repository exports. Measured: 262 of React's
config-file literals were reported as `no-symbol`, in the same bucket as genuine checker faults.

The reason vocabulary is **open** (§8.6) and has now grown three times — `type-parameter` in the
Resolver milestone, `checker-failed` when a compiler fault had to be told from a compiler answer,
and `value-is-not-a-declaration` here. Each addition split one bucket that was conflating two
different facts, which is the only justification the vocabulary accepts.

---

## 7. Provenance model

Every node and every edge must be explainable. Provenance answers *why does this
row exist*, in three parts:

| Part | Meaning |
|---|---|
| `resolver` / `extractor` | Which component produced the fact |
| `file_id` | The file whose syntax produced it |
| `evidence` | A sentence a developer can read |

Evidence is not decoration. `'express' is a bare specifier naming package
'express', which is not installed or did not resolve` is what makes an `INFERRED`
edge auditable rather than mysterious.

**Provenance doubles as the derivation record.** `provenance_file_id` names the file
whose syntax produced each edge, which is exactly what an incremental refresh needs
in order to invalidate: *file X changed, so every edge whose provenance is X is
suspect*. No separate derivation table is required in version 1. Note the limit —
this identifies the file whose *syntax* produced the edge, not every file the
checker consulted to resolve it, so invalidation on this basis is conservative in
one direction and incomplete in the other. §11 records the consequence.

---

## 8. SQLite storage model

One database file per repository. No other database engine.

Definitions below are the normative schema. `INTEGER` with values 0/1 is used for
booleans, SQLite having no boolean type.

### 8.1 Conventions

- Foreign keys are declared and **must be enforced** (`PRAGMA foreign_keys = ON`).
- Identity columns are `TEXT`.
- `confidence` is `TEXT` constrained to the four levels.
- A whole analysis is written in **one transaction**. A partially written graph must
  never be observable.

### 8.2 Repository

```sql
CREATE TABLE repository (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  name        TEXT NOT NULL,
  root_path   TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);
```

Singleton by construction: one database per repository. `schema_version` exists so
the Graph Store can refuse a database it does not understand rather than
misinterpret one.

### 8.3 Revisions

```sql
CREATE TABLE revisions (
  id           INTEGER PRIMARY KEY,
  created_at   TEXT NOT NULL,           -- ISO 8601, supplied by the caller
  source_hash  TEXT                     -- NULL until incremental indexing exists
);

CREATE TABLE file_revisions (
  revision_id  INTEGER NOT NULL REFERENCES revisions(id),
  file_id      TEXT    NOT NULL REFERENCES nodes(id),
  content_hash TEXT,                    -- NULL until incremental indexing exists
  PRIMARY KEY (revision_id, file_id)
);
```

Every node and edge carries `revision_id`. **Version 1 writes the fixed placeholder
`revision_id = 1`** and stores one revision at a time; the schema permits several, so
keeping history later is a behaviour change rather than a migration.

Both hash columns are **nullable and written as `NULL` in version 1** (approved
decision 2). Neither is derivable from the Graph Builder's inputs — `RepositoryIR`
carries no file contents. `file_revisions` is still populated, one row per file, so
the table has a writer and gains hashes later without a migration.

### 8.4 Nodes and locations

```sql
CREATE TABLE nodes (
  id                      TEXT PRIMARY KEY,
  kind                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  file_id                 TEXT REFERENCES nodes(id),
  container_chain         TEXT,
  visibility              TEXT CHECK (visibility IN ('public','protected','private')),
  is_exported             INTEGER NOT NULL DEFAULT 0,
  is_static               INTEGER NOT NULL DEFAULT 0,
  is_abstract             INTEGER NOT NULL DEFAULT 0,
  is_readonly             INTEGER NOT NULL DEFAULT 0,
  is_optional             INTEGER NOT NULL DEFAULT 0,
  is_async                INTEGER NOT NULL DEFAULT 0,
  is_declaration_file     INTEGER,
  has_symbol              INTEGER,
  is_exported_from_module INTEGER,
  external_origin         TEXT,
  external_name           TEXT,
  confidence              TEXT NOT NULL
                          CHECK (confidence IN ('CERTAIN','RESOLVED','INFERRED','AMBIGUOUS')),
  provenance_extractor    TEXT NOT NULL,
  provenance_evidence     TEXT NOT NULL,
  revision_id             INTEGER NOT NULL REFERENCES revisions(id)
);

CREATE TABLE node_locations (
  node_id      TEXT    NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,        -- 0 is the primary site
  start_line   INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  end_column   INTEGER NOT NULL,
  PRIMARY KEY (node_id, ordinal)
);

CREATE INDEX nodes_by_file ON nodes(file_id);
CREATE INDEX nodes_by_kind ON nodes(kind);
```

`file_id` referencing `nodes(id)` is deliberate: a `File` is a node, so a
declaration's file is an ordinary foreign key rather than a parallel table.

### 8.5 Roles

```sql
CREATE TABLE node_roles (
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  role        TEXT NOT NULL
              CHECK (role IN ('Controller','Service','Repository','Middleware','Model','Test')),
  confidence  TEXT NOT NULL
              CHECK (confidence IN ('CERTAIN','RESOLVED','INFERRED','AMBIGUOUS')),
  evidence    TEXT NOT NULL,
  PRIMARY KEY (node_id, role)
);
```

Empty in version 1. Defined now because roles are part of the frozen contract, and
because a role is a confidence-bearing annotation — the reason it is a row here and
not a column on `nodes`, and not a node type of its own.

**Written by the Graph Builder, not by the Framework Extractor.** The extractor
produces role annotations as data; the Builder translates them into these rows. Two
modules writing the same database would give the graph two sources of truth and two
transaction boundaries (§8.8).

### 8.6 Edges and unresolved references

```sql
CREATE TABLE edges (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL
                       CHECK (type IN ('DECLARES','IMPORTS','EXPORTS','CALLS','IMPLEMENTS',
                                       'EXTENDS','REFERENCES_TYPE','HANDLED_BY','READS',
                                       'WRITES','DEPENDS_ON','CONTINUES_TO','TESTS')),
  source_id            TEXT NOT NULL REFERENCES nodes(id),
  target_id            TEXT NOT NULL REFERENCES nodes(id),
  name                 TEXT,
  confidence           TEXT NOT NULL
                       CHECK (confidence IN ('CERTAIN','RESOLVED','INFERRED','AMBIGUOUS')),
  candidate_group      TEXT,
  ordinal              INTEGER,          -- set on HANDLED_BY; NULL elsewhere
  provenance_resolver  TEXT NOT NULL,
  provenance_file_id   TEXT NOT NULL REFERENCES nodes(id),
  provenance_evidence  TEXT NOT NULL,
  start_line           INTEGER NOT NULL,
  start_column         INTEGER NOT NULL,
  end_line             INTEGER NOT NULL,
  end_column           INTEGER NOT NULL,
  revision_id          INTEGER NOT NULL REFERENCES revisions(id)
);

CREATE TABLE unresolved_references (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL
                       CHECK (type IN ('DECLARES','IMPORTS','EXPORTS','CALLS','IMPLEMENTS',
                                       'EXTENDS','REFERENCES_TYPE','HANDLED_BY','READS',
                                       'WRITES','DEPENDS_ON','CONTINUES_TO','TESTS')),
  source_id            TEXT NOT NULL REFERENCES nodes(id),
  name                 TEXT,
  reason               TEXT NOT NULL,   -- open vocabulary; see below
  text                 TEXT NOT NULL,
  provenance_resolver  TEXT NOT NULL,
  provenance_file_id   TEXT NOT NULL REFERENCES nodes(id),
  provenance_evidence  TEXT NOT NULL,
  start_line           INTEGER NOT NULL,
  start_column         INTEGER NOT NULL,
  end_line             INTEGER NOT NULL,
  end_column           INTEGER NOT NULL,
  revision_id          INTEGER NOT NULL REFERENCES revisions(id)
);

CREATE INDEX edges_by_source ON edges(source_id, type);
CREATE INDEX edges_by_target ON edges(target_id, type);
CREATE INDEX edges_by_group  ON edges(candidate_group);
CREATE INDEX edges_by_file   ON edges(provenance_file_id);
CREATE INDEX unresolved_by_file ON unresolved_references(provenance_file_id);
```

**Which vocabularies are constrained, and why the asymmetry is deliberate.**

| Column | Constrained | Reason |
|---|---|---|
| `edges.type`, `unresolved_references.type` | yes, to the 13 | The relationship vocabulary is frozen, so a `CHECK` can never force a migration and it catches a typo at insert |
| `confidence` everywhere | yes, to the 4 | Frozen vocabulary |
| `node_roles.role` | yes, to the 6 | Frozen vocabulary |
| `nodes.visibility` | yes, to the 3 | Closed language concept |
| `nodes.kind` | **no** | Node types are an *open* vocabulary: `Route`, `EnvironmentVariable` and `DatabaseTable` are still to come. A `CHECK` here would force exactly the migration §11.3 exists to avoid |
| `unresolved_references.reason` | **no** | Open vocabulary — grown three times now: `type-parameter`, `checker-failed`, `value-is-not-a-declaration` |

`edges_by_source` and `edges_by_target` are the two indexes that matter: forward
traversal for Execution Journey, reverse traversal for Impact Analysis. `edges_by_file`
serves invalidation. Traversals are bounded-depth and expressed as recursive CTEs;
no graph database is required, and adding one would buy operational cost without
enabling a query that cannot be written here.

### 8.7 Query direction

Features never read these tables. All graph access is through the Query Engine, and
the schema is an implementation detail behind it. Once feature code writes its own
SQL, the storage decision is frozen and every feature acquires its own understanding
of the schema.

### 8.8 Who populates what

Every table must have a writer, and there is only ever **one writer**: the Graph
Builder, through the Graph Store. "Decided by" names the module that produces the
facts; it never touches SQLite.

| Table | Written by | Decided by | Populated in v1 |
|---|---|---|---|
| `repository` | Graph Builder | IR (`repository`) | yes |
| `revisions` | Graph Builder | caller supplies the timestamp | yes |
| `file_revisions` | Graph Builder | **nobody yet** — see below | **no** |
| `nodes` | Graph Builder | IR + Resolver | yes |
| `node_locations` | Graph Builder | IR (`declaration.locations`) | yes |
| `node_roles` | Graph Builder | Framework Extractor | **yes** |
| `edges` | Graph Builder | Resolver, plus `DECLARES` from IR | yes |
| `unresolved_references` | Graph Builder | Resolver (`unresolved`) | yes |

One table remains unpopulated, and one has since gained its producer:

- **`node_roles` is now populated.** The Framework Extractor decides roles and hands them
  to the Builder as a third input, exactly as this section anticipated; no schema change
  was needed.
- **`file_revisions` has no producer at all.** `content_hash` is not derivable from
  either input — `RepositoryIR` carries no file contents — so nothing can fill it
  today, not even in principle. It is not merely deferred; it is blocked on §11.2.
  If §11.2 option (c) is chosen, this table and `revisions.source_hash` must be
  **removed from this specification** rather than left as columns nothing can ever
  write.

---

## 9. Non-goals

The Graph Builder does **not**:

- perform inference of any kind;
- perform resolution, or re-resolve anything the Resolver left unresolved;
- use the TypeChecker, or hold a `ProjectContext`;
- understand TypeScript — no ts-morph dependency, and no TypeScript concept in its
  vocabulary beyond the IR declaration kinds it renames;
- understand Express, decorators, routes or any framework;
- perform AI reasoning;
- build call graphs;
- assign architectural roles;
- compute, adjust or reinterpret confidence;
- decide what is interesting, deduplicate on meaning, or prune;
- answer questions — traversal belongs to the Query Engine;
- expand a star re-export into the symbols it forwards, which the Resolver
  deliberately left unexpanded.

The graph is also **not** a place where facts improve. If the graph is more accurate
than the Resolver's output, the Graph Builder has overstepped.

---

## 10. Architectural boundaries

```
RepositoryIR ────────┐
ResolvedRepository ──┤
FrameworkAnnotations ┼─→ Graph Builder ─→ Graph Store (SQLite)
CallGraph ───────────┘                          │
                                                ↓
                                          Graph API  ─→ Query Engine ─→ features
```

**The Graph API is the only read path.** It exposes six direct lookups — `getNode`,
`exists`, `getOutgoing`, `getIncoming`, `getEdges`, `getNodes` — and no SQL, connection
or driver type. Its interface and the read model live in `@traceiq/graph-api`, which
depends on no database at all, so a reader depends on the abstraction rather than on
SQLite. The SQLite implementation lives beside the store, in `@traceiq/graph`.

The API does not traverse: `getOutgoing` returns one step. Following edges, bounding
depth and deciding what to keep are the Query Engine's work.

| Rule | Consequence if broken |
|---|---|
| The parser never knows SQLite | Storage stops being replaceable |
| The graph never knows TypeScript | A second language becomes a schema migration |
| The Graph Builder never knows Express | Framework logic leaks below the extractor |
| Features never query SQLite directly | The storage decision freezes permanently |
| The Query Engine reads only through the Graph API | SQLite re-enters the layers above it |
| Every relationship carries provenance | Nothing can be explained or debugged |
| Ambiguity is never discarded | The graph asserts more certainty than it has |
| Unresolved references stay visible | Absence of an edge becomes indistinguishable from absence of a reference |

**Dependencies.** `@traceiq/graph` may depend on `@traceiq/ir`, `@traceiq/resolver`,
`@traceiq/framework`, `@traceiq/graph-api`, `@traceiq/types` and `@traceiq/shared`, plus
one SQLite driver. It must **not** depend on `ts-morph`, `@traceiq/project-host` or
`@traceiq/scanner`.

`@traceiq/graph-api` may depend only on `@traceiq/types` and `@traceiq/ir`. A database
driver appearing there would defeat its purpose.

Depending on `@traceiq/framework` does not teach the graph about Express: a route has a
method, a path and an ordered handler chain in any web framework, and roles are frozen
contract vocabulary. What the graph must not contain is logic that *recognises* a
framework. That
`ts-morph` is absent from its `package.json` is a checkable invariant and should be
asserted.

**Internal split.** Graph Builder and Graph Store are separate modules within
`packages/graph`, Builder depending on Store and never the reverse. Builder is a
pure function of its inputs and holds no connection; Store owns the schema,
migrations and transactions. Whether they become two packages is deferred until the
schema exists.

**Testability.** Because the Builder is pure, it must be testable without SQLite:
given an IR and a `ResolvedRepository`, it produces nodes and edges as plain data.
Persistence is tested separately against a temporary database file.

### 10.1 Why the derived values belong here and not in the Resolver

The three derivations of §0 were each checked against the alternative of moving them
upstream:

| Derivation | Could the Resolver do it? | Why it stays in the Builder |
|---|---|---|
| `DECLARES` parentage | Yes, mechanically | It is not a *resolution*. The Resolver's contract is "bind references to what they reach"; containment is structural and needs no checker. Emitting it there would put a non-resolved fact in `ResolvedRepository` and blur what that structure means. |
| `External` node identity | No | `ext:` is a *graph* identity. The Resolver deliberately models external targets as `origin` + `name` with no identity, so it stays independent of any storage or node scheme. |
| `External` node confidence | No | It is a maximum over *edges*, which do not exist until the graph does. |
| Edge identity | No | Same reason: edges are a graph concept. |

Conversely, nothing in this specification requires re-reading source, re-resolving a
symbol, or consulting a checker. If an implementation finds it needs any of those, the
fact belongs upstream and this specification is wrong.

### 10.2 Future milestones against this schema

Checked so that no later milestone is forced into a migration:

| Milestone | Needs | Migration required |
|---|---|---|
| Framework Extractor | `Route` nodes | no — `nodes.kind` is unconstrained and `route:` already exists |
| Framework Extractor | `HANDLED_BY`, middleware order | no — `edges.type` already admits all 13; `ordinal` is reserved (§11.3) |
| Framework Extractor | role annotations | no — `node_roles` exists |
| Execution Journey | forward traversal | no — read-only, `edges_by_source` |
| Impact Analysis | reverse reachability, revision diff | no — `edges_by_target`, `revision_id` |
| Context Builder / AI | read-only queries | no |
| `CALLS` edges | call sites | no *graph* change — it is an **IR** change, since the IR records no call sites |
| `READS` / `WRITES` | `EnvironmentVariable`, `DatabaseTable` | no schema change, but a **contract** change: both need identity prefixes (§11.5) |
| History across revisions | many revisions at once | no — the schema already permits it; only Builder behaviour changes |

Two entries are worth reading carefully. `CALLS` and `EnvironmentVariable` are not
blocked by this schema — they are blocked upstream, by the IR and by the identity
contract respectively. That is the correct place for them to be blocked; a schema that
accommodated them would be inventing data no module produces.

---

## 11. Decisions

Decisions 1–5 below were **approved**, and this document has been amended to match.
One consequence of decision 1 requires confirmation and is marked.

**11.1 — External identities. RESOLVED**, with one open consequence.

Approved: `ext:npm:<package>`, `ext:node:<module>`, `ext:builtin:<symbol>`, and
versions never in identities.

**Open:** the three approved forms cover `package`, `node-builtin` and
`typescript-lib`. They do **not** cover the Resolver's fourth origin,
`outside-analysis` — 169 of 501 external references on this repository — which
carries no recoverable name. §5.2 therefore adds a fourth form,
`ext:outside-analysis`, as a single nameless sentinel node. **Needs confirmation**;
the alternative is to drop those references from the graph entirely, which would make
14% of resolved references invisible.

**11.2 — Revision model. RESOLVED: keep the schema.** `revision_id = 1` and both
hash columns `NULL` until incremental indexing exists. Both hash columns are
therefore nullable, and `file_revisions` is populated one row per file so the table
has a writer (§8.8).

**11.3 — The reserved `ordinal` column (§4). RESOLVED: included**, always `NULL` in
version 1.

**11.4 — Unresolved references. RESOLVED: dedicated table** (§6.4, §8.6). No
sentinel node type.

**11.5 — `EnvironmentVariable` identity. RESOLVED: `env:<NAME>`**, frozen (§5.1). The
node type is produced.

**`DatabaseTable` identity remains undefined**, and that node type is therefore not
produced. Needed whenever database usage is extracted.

**11.6 — SQLite driver. RESOLVED: `better-sqlite3`.** Synchronous, mature, native
build. Its synchronous API suits a single-writer batch translation, and it keeps the
Node floor at 22.

Carried forward and still open: the `shared`/`types` boundary, `esModuleInterop`,
the `types: ["node"]` approach, per-package tsconfig in a monorepo (which caps
cross-package edges at `ext:outside-analysis`), job orchestration, and the
evaluation strategy.

---

## 12. Worked example

Source:

```ts
// src/base.ts
export interface Shape { a: string }

// src/impl.ts
import { Shape } from './base';
export class Impl implements Shape {
  value: Shape;
}
```

Resulting graph:

```
nodes
  file:src/base.ts                     File        CERTAIN
  file:src/impl.ts                     File        CERTAIN
  sym:src/base.ts#Shape                Interface   CERTAIN  is_exported=1
  sym:src/base.ts#Shape.a              Property    CERTAIN
  sym:src/impl.ts#Impl                 Class       CERTAIN  is_exported=1
  sym:src/impl.ts#Impl.value           Property    CERTAIN  visibility=public

edges
  DECLARES         file:src/base.ts        → sym:src/base.ts#Shape        CERTAIN
  DECLARES         sym:src/base.ts#Shape   → sym:src/base.ts#Shape.a      CERTAIN
  DECLARES         file:src/impl.ts        → sym:src/impl.ts#Impl         CERTAIN
  DECLARES         sym:src/impl.ts#Impl    → sym:src/impl.ts#Impl.value   CERTAIN
  EXPORTS          file:src/base.ts        → sym:src/base.ts#Shape        CERTAIN
  EXPORTS          file:src/impl.ts        → sym:src/impl.ts#Impl         CERTAIN
  IMPORTS          file:src/impl.ts        → file:src/base.ts             RESOLVED
  IMPORTS          file:src/impl.ts        → sym:src/base.ts#Shape        RESOLVED   name=Shape
  IMPLEMENTS       sym:src/impl.ts#Impl    → sym:src/base.ts#Shape        RESOLVED
  REFERENCES_TYPE  sym:src/impl.ts#Impl.value → sym:src/base.ts#Shape     RESOLVED   name=Shape
```

Note that both `IMPORTS` edges exist: the module-level edge records which file was
imported, and the binding-level edge records which declaration the name reached.
`EXPORTS` is `CERTAIN` because an `export` modifier needs no resolution, while
`IMPLEMENTS` is `RESOLVED` because the checker bound it.
