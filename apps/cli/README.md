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
| `traceiq chat` | Ask questions, grounded and cited — interactive |

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

## Chat

```
$ traceiq chat --model qwen2.5:7b-instruct
$ traceiq chat --model qwen2.5:7b-instruct --subject impact:sym:packages/core/src/service.ts#UserService.find
```

| Option | |
|---|---|
| `--model <id>` | Which model answers. **Required** — no default is assumed, so an answer never comes from whatever happened to be installed |
| `--provider <name>` | Which provider holds it. Default `ollama`, the only one implemented |
| `--subject <what>` | What to ask about: `repository`, `sym:<id>`, `impact:sym:<id>`, `file:<path>`, `pkg:<name>`, `route:<METHOD>:<path>`. Default `repository` |

In a session: `/subject` shows or changes what is being asked about, `/clear` forgets the conversation,
`/exit` leaves. **Ctrl+C cancels the answer in progress without ending the session** — a local model can
take ten seconds, and losing a whole session because one answer was going nowhere would make the REPL
unusable. A press with nothing generating, or a second within two seconds, exits with `130`.

Each answer prints its grounding first — how many facts, what they cost, and **what was left out** — then
the prose as it streams, then the verdict and every citation with the capability that established it:

```
> How large is this repository?
64 facts · 1920 tokens · tier standard · c0a8bdfbb1fe2e3f
  externalPackages: showing 15 of 51
  cycles: showing 15 of 18

The repository contains 228 files [f2] and 3148 declarations [f3].

verdict grounded · qwen2.5:7b-instruct · stop-sequence · 2002 prompt / 27 output tokens
  [f2] repository contains 228 files @traceiq/explorer
  [f3] repository contains 3148 declarations @traceiq/explorer
```

**`chat` contains no AI logic.** It reads a line, hands it to `RepositoryAnswerer`, prints what streams
back and formats the result. Its only access to the repository is a `ContextSource` — one method — so it
cannot traverse, query, search or reach a capability, and `chat.ts` imports no graph type at all.

**It will not resolve a subject from free text.** `--subject UserService` is refused, not guessed at:
turning a name into an identifier is repository search, it belongs to `traceiq search`, and doing it here
would put repository intelligence in the AI path. The error says so and points at `search`.

Colour is on for a terminal and off for a pipe or when `NO_COLOR` is set, so redirected output stays plain
and diffable — the same reason no other command colours anything.

`--provider` is the one place a vendor is named, in `src/providers.ts`. Every other file, including the
REPL, sees a `LanguageModel` and never learns what is behind it.

## Errors

Twelve failures, each with a fixed code and an exit status. A script can branch on the status without
matching prose.

| Status | Codes | Meaning |
|---|---|---|
| `2` | `unknown-command`, `missing-argument`, `unknown-option` | The command line was wrong |
| `3` | `repository-not-scanned`, `invalid-repository` | The repository is not in a usable state |
| `4` | `unknown-identifier`, `unknown-route`, `unknown-package`, `model-not-found` | The command was fine; the thing does not exist |
| `5` | `chat-failed` | A session started and nothing in it could be answered |

Chat adds four: `unknown-provider` (2), `provider-unavailable` (3), `model-not-found` (4) and
`chat-failed` (5). A failure raised by the AI layer during a session is printed with **its own code**,
unreworded, so a code seen here is the same code seen over HTTP.

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
