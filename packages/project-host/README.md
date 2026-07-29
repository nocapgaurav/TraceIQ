# @traceiq/project-host

## Purpose

Own and manage the lifecycle of a single ts-morph `Project`, and expose the
TypeScript compiler through it.

This is the only module permitted to construct a `Project`. The boundary exists
because the TypeScript type checker is whole-program: any symbol lookup may touch
any file, so a second `Project` means a second copy of the compiler's memory for
the same repository.

Nothing here interprets what the compiler says. It is purely an abstraction over
the compiler.

## Responsibilities

- Create the ts-morph `Project` from a `RepositoryInventory`.
- Load compiler options from the repository's `tsconfig.json`.
- Create the `Program` eagerly.
- Expose the `TypeChecker`, the `SourceFile` set, and the `CompilerOptions`.
- Own the context's lifecycle, including explicit disposal.

## Non-responsibilities

- Builds no IR.
- Inspects no symbols, resolves no imports, resolves no declarations.
- Builds no graph, detects no Express routes, performs no AI reasoning.
- Introduces no orchestration. There is no run state, no progress reporting and no
  cancellation here.
- Never emits. Emission is prevented by never exposing the `Project`, not by
  overriding compiler options — the repository's options are used verbatim.

## Inputs

A `RepositoryInventory` from `@traceiq/scanner`.

The inventory is the authority on which files are analysed. `tsconfig.json` is
read for compiler options only, and none of the files it lists are added: its
`include` and `exclude` answer a different question — what to compile — and
letting them decide would let the analysed file set disagree with the inventory
that produced it.

## Outputs

A `ProjectContext`:

```
rootPath                    absolute repository root
tsconfigPath                repository-relative, or null
compilerOptions             frozen copy of the options in force
typeChecker                 the checker for this program
sourceFiles                 the analysed files, in inventory order
findSourceFile(path)        lookup by repository-relative path
isDisposed / dispose()      lifecycle
```

A context is an immutable snapshot. Nothing adds, removes or edits files, so a
checker handed to a consumer cannot be invalidated underneath it mid-analysis.

## Public API

```
ProjectHost                    load(inventory): ProjectContext
ProjectContext                 the snapshot described above
ProjectHostError               inventory rejected, or the project could not be built
ProjectContextDisposedError    a disposed context was used
DEFAULT_COMPILER_OPTIONS       options used when the repository has no tsconfig
```

`SourceFile` and `TypeChecker` are re-exported so a consumer can type what it
receives without declaring a direct ts-morph dependency of its own.

## Design Notes

**`load` is synchronous.** Creating the `Program` is CPU-bound and blocks for as
long as it takes. Returning a promise would imply an ability to yield that does
not exist. Reporting progress and allowing cancellation belong to a layer above
this one, which does not exist yet by decision.

**`node_modules` is resolvable but not analysed.** Only the inventory's files are
added, so `sourceFiles` never contains a dependency. The `Program` still resolves
module imports from disk, so the checker reaches declaration files under
`node_modules` normally. There are tests asserting both halves: that a symbol
imported from a package resolves to its real type, and that its declaration file
is absent from `sourceFiles`.

**"One `Project` instance" means one per context, not one per process.** A
process-wide singleton would be global state, which the architecture forbids. The
host is stateless; each `load` returns an independently owned context, and
disposing one does not affect another.

**Files are added one at a time.** ts-morph offers a batch call, but it takes
globs: a path containing glob syntax would be silently misinterpreted, and a
failure would name the batch rather than the file.

**Compiler options leave as a frozen copy.** The compiler's own options object is
mutable and shared with the `Program`; handing it out would let a consumer change
how the checker behaves.

## Extension Points

- **`DEFAULT_COMPILER_OPTIONS`** — the options used when a repository has no
  tsconfig.
- **`ProjectContext`** — the place to expose more of the compiler if a later
  milestone genuinely needs it. The surface is deliberately narrower than what
  ts-morph offers; widening it speculatively would invite consumers to reach past
  this boundary.

## Known Limitations

- **A monorepo solution tsconfig yields no useful compiler options.** A root
  `tsconfig.json` containing only `files: []` and `references` delegates every
  real option to the projects it references, so the context reports essentially
  nothing — no `strict`, no `target`, no `moduleResolution`. Analysis then runs
  under compiler defaults rather than the repository's actual settings, which can
  change how modules resolve. This repository is itself such a case. Honouring
  per-package configuration would mean more than one `Project`, which is an
  architectural decision and is therefore not taken here.
- **`paths` mappings are only honoured if the root tsconfig declares them.**
  A consequence of the above.
- **Memory is proportional to the whole program, not the analysed set.** Loading
  this repository — 37 source files — uses roughly 180 MB, because the program
  includes every declaration file reached through resolution. Large repositories
  should expect this to dominate.
- **A stale inventory fails the load.** If a file named by the inventory is no
  longer on disk, `load` throws rather than skipping it. Silently dropping files
  would make the analysed set differ from the inventory without anything saying so.
- **`dispose` releases references, nothing more.** ts-morph exposes no teardown of
  its own, so reclamation depends on the garbage collector once the last reference
  is gone.
- **No diagnostics are exposed.** Whether the repository type-checks is not
  reported, because nothing downstream consumes it yet. Adding it is a one-line
  change when something does.

## Testing Notes

Tests run against real temporary projects on disk, including a hand-built
`node_modules` package with its own declaration file, which is how module
resolution is proven rather than assumed.

Several tests ask the exposed checker for the type of a declaration. That is the
test exercising what the host hands out — the host itself inspects no symbols.
Asking a real question is the only way to prove the program was assembled
correctly, because a misconfigured program yields `any` rather than an error.

Inventories are hand-built rather than produced by running the scanner, so a
failure here is a Project Host failure and never a scanner one.
