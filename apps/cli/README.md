# traceiq

The command-line interface to TraceIQ. Scan a TypeScript repository, then ask it questions.

```
traceiq scan .
traceiq overview
traceiq symbol 'sym:src/auth/user.service.ts#UserService.login'
```

## Architecture

**The CLI contains zero analysis logic.** It parses a command line, opens a graph, calls one
capability and renders the result. Every number it prints was computed by a package below it; nothing
here traverses, resolves, infers or interprets.

```
apps/cli
  → @traceiq/pipeline      scan (build + store) · open → RepositoryGraphApi
  → @traceiq/navigation    routes · architecture trees · dependency navigation
  → @traceiq/explorer      overview · packages · files · symbols · search · cycles · hotspots
  → @traceiq/impact        full impact analysis
  → @traceiq/health        full health report
  → @traceiq/query         (types only)
```

It never imports the scanner, the project host, the IR, the resolver, the framework extractor, the
graph builder, the graph store, SQLite or ts-morph. `@traceiq/pipeline` owns the write path and hands
back an abstract `RepositoryGraphApi`, so the CLI never learns what stores the graph.

To be precise about the closure rather than overclaiming: `better-sqlite3` and `ts-morph` **are**
installed transitively, through `@traceiq/pipeline`, and must be — something has to read the source
and open the database. What matters is that no SQLite or compiler concept reaches CLI code: it names
no connection, no statement, no driver and no compiler type, and swapping the storage behind
`RepositoryGraphApi` would not change a line here.

**One shared graph read per invocation.** `CommandSession` builds every capability over a single
`CachingGraph`, so a command that drives three of them — `symbol` uses Explain Symbol, Impact Analysis
and Repository Health — reads the database once rather than three times. Each capability is built
lazily: `routes` never constructs a health analyser.

**No global state.** One session per invocation, discarded with it. `run(argv, io)` is a function that
returns an exit status; nothing calls `process.exit`, and nothing is cached between calls. That is
what lets the whole CLI be tested by calling it.

## Command reference

| Command | What it answers |
|---|---|
| `traceiq scan <repository>` | Build the repository graph and store it |
| `traceiq overview` | Repository, graph and health summary |
| `traceiq architecture` | Roles, kinds and package dependencies |
| `traceiq packages` | Every derived package with counts both ways |
| `traceiq package <name>` | One package: files, dependencies, roles |
| `traceiq file <path>` | One file: declarations, imports, routes |
| `traceiq symbol <id>` | Everything recorded about one declaration |
| `traceiq impact <id>` | What a change to one declaration could affect |
| `traceiq routes` | Every route the repository registers |
| `traceiq route <method> <path>` | One route: chain, roles reached, health |
| `traceiq health` | Architectural health report |
| `traceiq search <text>` | Exact or prefix search, alphabetical |
| `traceiq dependencies <id>` | Direct and transitive dependencies |
| `traceiq cycles` | Import, call, reference and inheritance cycles |
| `traceiq hotspots` | The most connected declarations and files |

| Option | |
|---|---|
| `--db <path>` | Where the graph is stored. Default `.traceiq/graph.db` |
| `--profile` | Print how many database reads the command made |

`file` accepts a path or a `file:` identifier. `dependencies` accepts a package name or any
identifier — a value with no identity prefix is tried as a package.

## Examples

```
$ traceiq scan .
Scanned traceiq
---------------

repository             .
database               .traceiq/graph.db
files                  190
declarations           2448
call edges             2674
unbound calls          9608

$ traceiq route GET /users/:id
GET /users/:id
--------------

written path     /users/:id
effective path   /users/:id
prefix composed  false

Chain
-----

position    ordinal  declaration
----------  -------  --------------------------------
middleware        0  src/routes.ts#requireAuth
handler           1  src/routes.ts#getUser

$ traceiq impact 'sym:src/format.ts#heading'
directly affected    27
indirectly affected  3
unknown              136
```

## Output

Plain ASCII: **no colours, no progress bars, no box drawing, no Unicode.** Tables pad to their widest
cell, sections are separated by a blank line, nesting is two spaces per level. Output is identical
whether it goes to a terminal or a pipe — nothing consults the terminal width, the clock or the
environment.

Every capped list prints `shown of total` or a `... N more` line, so a truncation is never silent.
Every result that carries limitations prints them, because a caveat belongs where you read the number.

## Errors

Eight failures, each with a fixed code and an exit status. A script can branch on the status without
matching prose.

| Status | Codes | Meaning |
|---|---|---|
| `2` | `unknown-command`, `missing-argument`, `unknown-option` | The command line was wrong |
| `3` | `repository-not-scanned`, `invalid-repository` | The repository is not in a usable state |
| `4` | `unknown-identifier`, `unknown-route`, `unknown-package` | The command was fine; the thing does not exist |

```
$ traceiq symbol sym:nowhere.ts#Absent
error: unknown-identifier
  the graph holds nothing named 'sym:nowhere.ts#Absent'
  run 'traceiq search <text>' to find an identifier
```

Errors go to stderr and nothing goes to stdout, so `traceiq overview > out.txt` never writes a partial
report. A usage error opens no graph and touches no filesystem.

## Performance

Measured against TraceIQ itself — 190 files, 2,448 declarations, 2,662 nodes, 10,492 edges:

| Command | Wall clock | Database reads |
|---|---|---|
| `scan` (cold) | **1.45 s** | — |
| `routes` | 0.13 s | **1** |
| `impact` | 0.18 s | 886 |
| `search` | 0.21 s | 2,484 |
| `package` | 0.22 s | 2,484 |
| `overview` · `health` · `cycles` · `hotspots` | 0.20 s | 2,484 |
| `architecture` | 0.20 s | 2,868 |
| `symbol` | 0.24 s | 3,357 |

Every read command is a fresh process, so each pays its own start-up and index build; there is no
warm state between invocations. Within one invocation the graph is read once — `symbol` drives three
capabilities for 3,357 reads where running them separately costs more.

`routes` costs a single read because listing routes needs one node kind and nothing else. About 2,300
of the 2,484 baseline reads are `getRoles`, one per declaration, for want of a role index on the Graph
API.

## Limitations

- **A scan is a full rebuild.** There is no incremental update: `scan` reads the whole repository and
  rewrites the database.
- **The stored revision timestamp is fixed**, so two scans of one repository produce identical
  databases. Nothing reads it back, so no output is affected.
- **One repository per database.** `--db` selects which.
- **Long lists are capped at 20 rows** in the terminal, with the true total shown. The underlying
  capability caps at 100; the CLI does not page.
- **Everything inherited from below**: route prefixes are never composed, call coverage is partial and
  every `CALLS` edge is `INFERRED`, no interface or dynamic dispatch is recorded, package boundaries
  are derived from paths, and cross-package imports in a workspace resolve outside the analysed set.
  Each is printed in the `Limitations` section of the command it affects.

## Testing Notes

`run(argv, io)` is called directly with an injected writer, so every test exercises the real parsing,
dispatch, pipeline, capability and rendering path without spawning a process. The suite covers command
parsing, every formatting primitive, all eight error codes with their statuses, and a full pipeline
fixture — a two-package Express repository with a route chain, an unlinkable handler, an environment
variable, a mutual import cycle and recursion — that every command is run against. A determinism test
runs all fourteen read commands twice and asserts byte-identical output.
