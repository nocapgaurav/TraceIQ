# @traceiq/ir

## Purpose

Convert a loaded TypeScript program into the TraceIQ Intermediate Representation: a
language-independent, purely **syntactic** record of what a repository declares, how
its files import and export, and the call and member-access expressions those
declarations contain.

`src/types.ts` is the stable contract every later module consumes. It mentions no
TypeScript and no ts-morph type, so supporting a second language means adding a
second builder rather than changing the contract.

## Responsibilities

- Record the repository and its files.
- Record structural declarations with a stable identifier, kind, source locations,
  visibility where applicable, and syntactic modifiers.
- Record import statements and their bindings.
- Record export statements and exports written as a declaration modifier.
- Record call sites and identifier-rooted member-access chains.

## Non-responsibilities

- Resolves nothing. Module specifiers are kept as written; binding them to files is
  the Resolver's work.
- Builds no call graph. Call *sites* are recorded; binding a callee to a declaration
  is the Resolver's work and `CALLS` edges are a later milestone.
- Creates no relationships and no graph.
- Detects no framework, and performs no AI reasoning.
- **Never consults the type checker.** Every fact recorded is visible in the syntax
  tree. A file that does not type-check yields the same IR as one that does, and
  there is a test asserting it.

## Inputs

A `ProjectContext` from `@traceiq/project-host`.

## Outputs

A `RepositoryIR`:

```
repository     name (from the root directory) and absolute rootPath
files          id, repository-relative path, isDeclarationFile
declarations   id, fileId, kind, name, containerChain, visibility,
               modifiers, locations
imports        fileId, moduleSpecifier, isTypeOnly, bindings, location
exports        fileId, kind, exportedName, localName, moduleSpecifier,
               declarationId, isTypeOnly, location
callSites      fileId, enclosingDeclarationId, calleeText, calleeRootName,
               calleeMemberName, arguments, location
memberAccesses fileId, enclosingDeclarationId, text, rootName, path, location
```

Declarations, imports and exports are flat collections rather than nested inside
files. Every entry carries its `fileId`, so grouping by file stays possible while
the common case — iterating every declaration — needs no traversal.

Ordering is deterministic: files in the order the `ProjectContext` listed them, and
within a file, source order. Inline exports precede statement exports. Building the
same sources twice produces an identical IR, and there is a test asserting it.

Everything in the result is a plain object. A test asserts the whole IR survives a
JSON round trip, which is what language independence means in practice.

## Public API

```
IrBuilder            build(context): RepositoryIR
IrBuildError         a file is not addressable within the repository root
DECLARATION_KINDS    the twelve declaration kinds
VISIBILITIES         public | protected | private
```

Plus the IR types. No ts-morph value or type is re-exported: a consumer works with
plain objects and cannot reach the compiler through this package.

## Identity

Identifiers use the contract format `sym:<path>#<chain>`, built by
`@traceiq/shared`. They are unique within a `RepositoryIR`.

Because the format is a **symbol path**, several syntactic sites can share one.
Rather than emit duplicate identifiers — which would collide the moment the graph
keyed a node on one — the identifier is the unit, and sites are folded into a
single declaration with several `locations`. This is correct for the cases that
occur:

| Case | Result |
|---|---|
| Function, method or constructor overloads | one declaration, one location per signature and the implementation |
| A getter and setter pair | one `accessor` declaration, two locations |
| Merged interfaces in one file | one declaration, two locations, members from both |

Merging across files never happens, because the identifier contains the file path.

When folded sites disagree, the first in source order wins for `kind`, the first
non-null wins for `visibility`, and modifiers are unioned — an overload set whose
`export` sits only on the first signature is exported. TypeScript requires merged
declarations to agree on `export`, so the first site is authoritative.

## Expressions

`callSites` and `memberAccesses` exist because a great deal of a repository's meaning
lives in calls rather than declarations — route registration, dependency wiring,
environment reads. Nothing is resolved: a callee is text.

**Construction is an invocation.** `new Service()` is a call site carrying
`isConstruction: true`, not a separate collection. It has a callee, arguments, a position
and it invokes a constructor, so every field a call site already has means the same thing
for it — and a consumer that ignores the flag still sees the invocation. Modelling it
separately would have duplicated the shape and let a consumer miss half the invocations
in the repository.

An argument that is a string literal (or a template literal with no substitution)
carries its **value** as well as its text, which is what lets a consumer read a route
path without parsing expression text. Arguments stay in source order, so a middleware
chain remains ordered.

`memberAccesses` records only **outermost** identifier-rooted chains, and never a
callee — an inner link is a prefix of the chain already recorded, and a callee is
already a `CallSiteIR`. Chains rooted at `this`, at a call result, or at any other
expression are not recorded: they describe local structure rather than a cross-cutting
reference. An element access contributes its key only when that key is a string
literal, so `process.env['NAME']` reads but `process.env[key]` is rejected outright
rather than truncated into a different chain.

Every expression carries `enclosingDeclarationId` — the recorded declaration whose body
or initializer contains it, or `null` at module level. Attribution uses declaration node
identity, so it never restates which nodes the IR chose to record.

On this repository: 6,157 call sites — of which 204 are constructions — and about 900
member accesses across 86 files. Nested declarations add 46 declarations.

## Traversal Boundaries

Declaration traversal covers statements, and class, interface, enum and namespace
members, in source order.

It **does** enter function bodies, but records only what a later stage can address:

| Nested form | Recorded as | Why |
|---|---|---|
| `function inner() {}` | kind `function` | invocable by name |
| `const f = () => {}`, `const f = function () {}` | kind `variable` | invocable by name |
| `const svc = new Service()` | kind `variable` | holds an instance whose methods are invocable |
| `const n = 5`, `class Local {}`, a parameter | nothing | no call site can address it |
| `() => {}` passed inline | nothing | anonymous, so no identifier chain can name it |

A nested declaration's kind is the **same** kind the top-level walk would give it, so
`const f = () => {}` is a `variable` wherever it is written. Describing the same syntax
differently by depth would make the IR's own nesting an observable property.

Nesting is unbounded: `outer.deeper.deepest` is recorded, and bodies inside methods,
constructors, accessors and module-level arrows are entered too.

**Expression traversal enters bodies as well**, since that is where calls appear. The two
rules coexist: a local `class` inside a function is still not a declaration, while a
call inside that same function is still a call site.

Only `namespace` declarations are entered. An ambient `declare module 'x'` block or
a `declare global` augmentation describes an external or global shape rather than
this repository's, and its name — quoted, and free to contain dots — is not a valid
identifier chain segment.

A dotted namespace (`namespace A.B {}`) becomes nested chain segments. The
intermediate `A` gets no declaration, because the source declares none; the export
it produces names `A`, with no `declarationId` to point at.

## Extension Points

- **`DECLARATION_KINDS`** and the extractors in `declaration-extractor.ts` — a new
  declaration form is one kind plus one branch.
- **A second language** — implement a new builder producing the same `RepositoryIR`.
  Nothing in `types.ts` needs to change.
- **Identifier references** — still absent. Call sites and member accesses cover the
  expression forms consumers have needed; a general reference index would be a much
  larger addition.

## Known Limitations

- **Names the identifier format cannot address are skipped.** Destructuring
  patterns (`export const { PORT } = process.env`), computed members
  (`[Symbol.iterator]`) and string-literal members (`'content-type'`) have no stable
  representation in `sym:<path>#<chain>`, so those declarations are omitted rather
  than mangled. Their containers are still recorded. **This is silent** — the IR
  carries no count of what was skipped, because the milestone fixes the IR's shape.
- **The identifier cannot distinguish a static from an instance member.**
  `class C { static x; x }` is legal and yields one declaration with `isStatic`
  true. Rare, but a real limit of the frozen format.
- **Declaration merging across different kinds keeps the first kind.** A
  `class C` merged with a `namespace C` reports `class` with both locations. Rare
  and legal.
- **No type information.** No annotation text, no signatures, no parameters. Type
  references belong to the Resolver, and recording annotation text would invite
  consumers to parse strings.
- **`import x = require('y')` is not captured** — ts-morph exposes no accessor for
  it on a source file.
- **A computed element access is not recorded at all.** `process.env[key]` yields no
  member access, because the chain is not addressable and reporting `process.env`
  would claim a different access from the one written.
- **Call sites are unfiltered.** Every call is recorded, including test helpers such as
  `describe` and `expect`. Filtering would require knowing what a framework is, which
  this layer must not.
- **An anonymous function is never a declaration.** `describe('x', () => { … })` gives
  its callback no name, and `sym:<path>#<chain>` needs one. Every call inside such a
  callback therefore attributes to the nearest *named* enclosing declaration, or to the
  file. On this repository that is why 4,688 of 6,157 call sites attribute to a file: test
  suites are built almost entirely from anonymous callbacks.
- **A construction's receiver is recorded only when it is named.** `const svc = new
  Service()` links `svc` to its class; `new Service().run()` does not, because there is no
  declaration to hang the instance on. The IR records the two invocations and leaves the
  relationship between them unstated rather than inventing an anonymous declaration.
- **A local holding anything other than a function or a construction is still not a
  declaration**, so `const cfg = { run() {} }; cfg.run()` is unaddressable.
- **`declarationId` is set only for an inline `export` modifier.** For
  `export { local }`, matching the name to a declaration in the same file requires
  scope analysis, which is resolution.
- **The repository name comes from the root directory**, not package.json. A
  `ProjectContext` does not carry the inventory's name.
- **Declaration files are included.** `.d.ts` sources are in the inventory, so their
  declarations are in the IR. `FileIR.isDeclarationFile` lets a consumer filter.
- **`declare` is not recorded** as a modifier.

## Performance

Building the IR for this repository — 53 files, 294 declarations — takes roughly
450 ms, against about 180 MB already held by the program. Cost is dominated by
walking the syntax tree; the extraction itself allocates one small object per
declaration.

## Testing Notes

Tests run against real temporary repositories loaded through the real Project Host,
because the input is a loaded program. Inventories are hand-built rather than
produced by the scanner, so a failure here is an IR Builder failure.

The declaration and import/export suites each build one fixture repository covering
every form, once. Building a TypeScript program per assertion would dominate the
runtime for no gain.

`@traceiq/scanner` is a **dev** dependency only: the test helper needs the
`RepositoryInventory` type to construct one. No source file imports it.
