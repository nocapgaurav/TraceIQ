# @traceiq/scanner

## Purpose

Discover what a repository contains, before any code is parsed. The scanner
produces the `RepositoryInventory` every later stage is driven from.

It is the only module that walks the filesystem on behalf of the engine, and it
reads the contents of exactly one file: `package.json`.

## Responsibilities

- Resolve and validate the repository root.
- Discover TypeScript source files.
- Partition directories into those taking part in analysis and those ignored.
- Detect language, framework and package manager.
- Locate `tsconfig.json`, `package.json` and the lockfile.
- Resolve entry points, recording whether each was declared or guessed.
- Report which ignored directories actually exist.

## Non-responsibilities

- Does not parse TypeScript, and does not depend on ts-morph.
- Does not read source file contents. A file of invalid TypeScript scans exactly
  like a valid one — there is a test asserting this.
- Does not inspect imports or exports.
- Builds no IR, no graph, and resolves no symbols.
- Performs no framework analysis beyond detecting a declared dependency.

## Inputs

A path to a repository root, absolute or relative.

## Outputs

A `RepositoryInventory`. Every path in it is repository-relative and
POSIX-separated, except `rootPath`, which is absolute and resolved. Repository
-relative paths are the form node identifiers are built from, so an inventory
feeds `@traceiq/shared` directly.

`sourceFiles`, `directories` and `ignoredPaths` are sorted. Scanning the same
repository twice produces an identical inventory — filesystem walk order is not
guaranteed, and an unstable inventory would destabilise everything downstream.

## Public API

```
RepositoryScanner        scan(path): Promise<RepositoryInventory>
RepositoryScanError      the path is missing, not a directory, or unreadable
MalformedManifestError   package.json exists but cannot be interpreted
IGNORED_DIRECTORY_NAMES  the seven ignored directory names
CONVENTIONAL_ENTRY_POINTS  conventional entry candidates, in reporting order
```

## Detection Rules

**Language.** `typescript` when a root `tsconfig.json` exists *or* any TypeScript
source was found. A repository configured for TypeScript before it has sources is
still TypeScript.

**Framework.** `express` when `express` is a declared dependency in any of the
four dependency sections. Establishing that Express is actually *used* — which
routes exist, how routers compose — needs resolved symbols and belongs to the
Framework Extractor. Detection here is deliberately the shallowest possible.

**Package manager.** From the lockfile present at the repository root, in
precedence order: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
`bun.lock`, `bun.lockb`. Repositories do accumulate several lockfiles after a
migration; the first match wins and `lockfile.path` records which file the answer
came from, so the choice stays explainable. Lockfiles nested inside workspace
packages are ignored — they do not determine how the repository is installed.

**Entry points.** A declared target from `main`, `module`, `bin` or `exports`
counts only if it names a file the scan actually found, and `field` records which
package.json field it came from. Conventional candidates follow, marked
`origin: 'convention'` so a consumer can discount a guess against a declaration.
No path is reported twice.

## Ignored Directories

`node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `out` — at any
depth. The list is fixed by the milestone specification rather than configurable,
so the same source cannot produce two different inventories.

Source discovery uses `fast-glob` with ignore patterns. Directory partitioning
does **not**: `**/name/**` also matches the bare `name` entry, because the
trailing `/**` matches zero segments, so glob ignores cannot express "report the
directory but do not enter it". `directory-walk.ts` does that with an explicit
pruning walk, which is why `ignoredPaths` can name `node_modules` without
anything inside it ever being read.

## Error Handling

`scan` rejects with `RepositoryScanError` when the path is empty, does not exist,
is not a directory, or cannot be read.

A malformed `package.json` rejects with `MalformedManifestError` rather than
degrading. Treating it as absent would report language and framework as unknown
for a repository that clearly declares both, and that failure would be invisible.

A missing `package.json` is not an error — a repository without a manifest is
still scannable.

## Extension Points

- **More languages.** `SOURCE_FILE_PATTERN` and `detectLanguage` are the two
  places that know about TypeScript.
- **More frameworks.** `detectFramework` maps declared dependencies to a
  framework name; a second framework is one more entry.
- **More package managers.** Append to `LOCKFILES` in precedence order.
- **More entry conventions.** Append to `CONVENTIONAL_ENTRY_POINTS`; order is the
  reporting order.

## Known Limitations

- **Symlinks are not followed**, and a symlinked file or directory appears in no
  list. This keeps the walk inside the repository and immune to cycles, but a
  repository that genuinely symlinks source into place will under-report.
- **A source file whose name contains `#` cannot become a symbol identifier.** The
  scanner reports it; `@traceiq/shared` will reject it later. The scan is not
  failed over it, because discovery should not be the place that enforces
  identifier rules.
- **Only root-level config is located.** A monorepo whose packages each carry a
  `tsconfig.json` reports `tsconfigPath: null` unless one exists at the root.
  Resolving per-package compiler configuration belongs to the Project Host.
- **Conventional entry points are guesses.** `src/index.ts` is reported even when
  it is a barrel file re-exporting everything. `origin` marks the difference;
  nothing here judges whether an entry is meaningful.
- **Declared targets pointing at build output are dropped**, because build output
  is ignored and therefore never discovered. Mapping `dist/index.js` back to the
  source that produced it requires reading `tsconfig.json` and belongs to the
  Project Host.
- **Framework detection believes the manifest.** A repository that vendors Express
  without declaring it reports `unknown`; one that declares it while using
  something else reports `express`. That is the limit of what is knowable without
  parsing.
- **`ignoredPaths` names directories, not rules.** It records what was skipped, not
  the pattern list, which is exported separately as `IGNORED_DIRECTORY_NAMES`.
- **The walk is sequential.** It is pruned at every ignored directory, so it covers
  the source tree only. Concurrency was not added: it would trade a real risk of
  exhausting file descriptors on a large monorepo for an unmeasured gain.

## Testing Notes

Tests run against real temporary directories rather than a mocked `fs`. The
scanner's entire job is to observe a filesystem, so a fake would only prove it
matches our model of one — which is precisely the thing worth testing. The
fixture helper lives in `repository-fixture.test-helper.ts`, excluded from the
build alongside the tests.
