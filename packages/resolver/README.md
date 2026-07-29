# @traceiq/resolver

## Purpose

Enrich a `RepositoryIR` using the TypeScript type checker: bind the references the
IR recorded to the declarations they actually reach.

The Resolver enriches facts; it does not organise them. Every output entry is a
flat statement about one reference, carrying provenance that explains itself.
Assembling those into a graph is the Graph Builder's work.

## Responsibilities

- Resolve declaration symbols, and confirm whether a declaration is a module export.
- Resolve imported symbols, their modules and their bindings.
- Resolve exported symbols, including export specifiers the IR left unresolved.
- Follow aliases through import and export indirection to the declaring symbol.
- Resolve `extends` and `implements`.
- Resolve type references written in declaration signatures.
- Assign a confidence level and provenance to everything, and keep every
  unresolved reference visible.

## Non-responsibilities

- Builds no graph, creates no graph nodes, persists nothing.
- Knows nothing of Express, decorators or routes.
- Builds no call graph, and never enters a function body.
- Performs no AI reasoning and no framework-specific analysis.
- Never modifies the IR. It is read, and the result refers to it by identifier.

## Inputs

A `RepositoryIR` and the `ProjectContext` it was built from.

## Outputs

A `ResolvedRepository`:

```
repository       echoed from the IR
declarations     per IR declaration: hasSymbol, isExportedFromModule, provenance
relationships    resolved references, each with a target and a confidence
unresolved       references that could not be resolved, with a reason
```

Everything is a plain object. Tests assert the whole result survives a JSON round
trip, and that the IR is unchanged.

## Public API

```
Resolver                        resolve({ ir, context }): ResolvedRepository
RESOLVED_RELATIONSHIP_TYPES     the subset of the frozen vocabulary produced here
EXTERNAL_ORIGINS                package | node-builtin | typescript-lib | outside-analysis
UNRESOLVED_REASONS              the five reasons a reference may not resolve
RESOLVERS                       the five sub-resolvers named in provenance
```

No ts-morph value or type is re-exported.

## Relationship Types

Only the frozen vocabulary is used, and only the five types this milestone
produces: `IMPORTS`, `EXPORTS`, `EXTENDS`, `IMPLEMENTS`, `REFERENCES_TYPE`. The
type is written as an `Extract` of `RelationshipType`, so a name outside the
contract fails to compile rather than quietly inventing vocabulary.

There is deliberately no `ALIASES` type. Following an alias is not a separate
relationship — it is how an `IMPORTS` or `EXPORTS` target is arrived at, and the
provenance says so when a hop was taken.

## Confidence

| Level | Meaning | Where it arises |
|---|---|---|
| `CERTAIN` | Established syntactically; no resolution required | An `export` modifier on a declaration, already linked by the IR. A `node:` specifier, whose reserved prefix identifies a builtin by itself. |
| `RESOLVED` | The checker bound the reference to exactly one target | Almost everything else. |
| `INFERRED` | One plausible target from a heuristic, unconfirmed | A bare specifier that did not resolve — what an uninstalled dependency looks like. |
| `AMBIGUOUS` | Several targets plausible; every one recorded | See the limitation below: currently unreachable. |

## Targets

A reference resolves to a declaration, a file, or something external. **External is
a success, not a failure** — knowing that `express` comes from a package is exactly
what a consumer needs. Genuine failures are not targets at all; they go to
`unresolved`.

`typescript-lib` carries no name. A built-in such as `Promise` is declared across
five `lib.*.d.ts` files, so naming the file would make one type look like five
ambiguous candidates.

## Ambiguity

An ambiguous reference becomes one relationship per candidate, all sharing a
`candidateGroup`, so a consumer can tell alternatives from independent facts. The
group is derived from the reference site rather than generated, so repeated runs
agree.

Nothing is discarded. When a symbol declares at a site the IR did not record, the
resolution still succeeds against the sites it did record and the provenance says
how many were left out.

## How Correlation Works

A compiler node is traced back to an IR declaration **by source position**, not by
recomputing identifiers. The IR already decided which declarations exist, what they
are called, and which names it could address; re-deriving that here would duplicate
those rules and let the two drift.

`source-position.ts` therefore has to agree exactly with the IR Builder's own
position conversion. It is duplicated rather than shared, because exporting it from
`@traceiq/ir` would put a ts-morph type in that package's public API. Tests assert
that every relationship's source is a declaration or file the IR actually recorded,
which fails loudly if the two ever diverge.

Position matching alone is not enough: an `export` keyword shares its start position
with the declaration it modifies. A node must also be of a declaration kind, which
leaves exactly one candidate per position.

## Known Limitations

- **Cross-package workspace references do not resolve to declarations.** In this
  monorepo, `@traceiq/shared` resolves to `packages/shared/dist/index.d.ts` — inside
  the repository but outside the IR, because build output is ignored. Those
  references are reported as `external` with origin `outside-analysis`: on this
  repository, 169 of 1164 relationships. Mapping declaration output back to the
  source that produced it is the monorepo tsconfig question, which is deliberately
  not addressed here.
- **`AMBIGUOUS` is currently unreachable.** It would need one symbol to declare at
  two positions the IR recorded as *different* declarations. TypeScript merges
  declarations only within a module, and the IR folds same-file merges into one
  declaration, so the case does not arise: separate modules do not merge, a
  same-file `class`/`interface` pair folds into one declaration, and a module
  augmentation lives in an ambient block the IR skips. The expansion mechanism is
  unit-tested directly in `resolution-collector.test.ts` rather than through a
  fixture that would assert over an empty set.
- **Star re-exports are not expanded.** `export * from './x'` resolves to the
  module, not to each forwarded symbol. The forwarded set is derived rather than
  written, and materialising it is closer to organising facts than enriching them.
- **No call sites and no references outside signatures.** The IR records neither,
  and building a call graph is out of scope.
- **Type parameters have no target.** A reference to `T` is recorded as unresolved
  with the reason `type-parameter`, kept distinct so it is not mistaken for a
  failure. The IR does not record type parameters as declarations.
- **Type parameter constraints are not examined.** The `Shape` in
  `class A<T extends Shape>` is not resolved.
- **`import x = require('y')` is not resolved**, because the IR does not record it.
- **A bare Node builtin without the `node:` prefix** — `import fs from 'fs'` — is
  classified as a package rather than a builtin when it does not resolve. Only the
  reserved prefix is self-identifying.
- **Only the analysed file set is resolved against.** A file the IR did not record
  is skipped rather than attributed to a made-up identifier.

## Performance

Resolving this repository — 53 files, 434 declarations — takes roughly 50 ms and
produces 1164 relationships with 3 unresolved references, against a program already
held in memory.

Each file is walked once in full. Walking every descendant rather than only the
nodes the IR recorded is deliberate: it costs one traversal and needs none of the
IR's traversal rules restated, so correctness comes from the position match instead
of from two modules agreeing where to look.

## Testing Notes

Tests take a real temporary repository through the whole pipeline — Project Host, IR
Builder, Resolver — because the Resolver's input is a real IR and a real program,
and the correlation between them is the thing under test. Hand-rolled stand-ins
could disagree with what the earlier stages actually produce.

The collector, the declaration index and the external classification are unit-tested
directly on plain data, which is also where the ambiguous path is covered.
