# Progress

Milestones are referred to by name rather than number, since the engineering
contract does not restate the roadmap.

## Universal Repository Understanding — a file with no declarations is not a file with no purpose

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web` clean;
**2,903 backend + 385 web** tests passing. Validated on **5 structurally different repositories**.

### One sentence of cause

Every relationship in the graph's vocabulary needed a declaration at one end, so a repository's Dockerfile,
its workflows, its compose file and its README could each hold a node and never appear at either end of an
edge — and every layer above the graph, having nothing else to read, described whichever code produced the
richest AST.

The symptom a user saw was one sentence. Opening `.github/workflows/release.yml` in the Explorer showed six
zeroes and **"This file declares nothing"** — true of declarations, false of the file, and indistinguishable
to a reader from "this file does nothing". The same blindness ran the whole depth of the product: a
deployment question was answered from a technology list because no fact carried what a compose file
declares; an onboarding question was answered from a fan-in ranking because no fact carried what a README
says; and a repository of 505 files and 42 declarations was described by the 42.

### The artefact model

A new package, `@traceiq/artifact`, reads what the language analysers cannot. It is a pure function of a
file inventory and a `readFile` callback — the same shape as the technology detector — so the whole layer is
exercised against synthetic repositories in memory and its dependency list is two entries.

Every reader produces the same four things, which is what makes the abstraction extensible: a family, a flat
list of elements with a section path, a list of references with candidate paths, and **a sentence saying what
was not read**. A new format is one function plus one row in `READERS`; nothing downstream changes, because
nothing downstream knows which reader produced what it shows.

**The boundary sentence is required, never optional, and it is the honesty mechanism.** No reader is a
conforming parser for its format, so every reader has something it did not look at. An artefact with no
elements *and a boundary sentence* is a completely different claim from an artefact with no elements and
nothing said: the first means "this was read and declares nothing of these kinds", and the second would mean
nobody looked.

### Artefact families

Eighteen families, in `@traceiq/types` so the graph, the Explorer, the AI layer and the web app share one
vocabulary. Fifteen have a reader; three are recorded by presence.

| family | what is read |
|---|---|
| `ci-workflow` | jobs, declared prerequisites, steps, commands, triggers, conditions, variable names |
| `container-image` | stages, base images, commands, exposed ports, variable names, copied paths, cross-stage copies |
| `container-compose` | services, images, build contexts, ports, volumes, networks, `depends_on`, commands |
| `orchestration-resource` | each document's kind and name, container images, ports, variable names |
| `infrastructure-as-code` | Terraform blocks — resources, data sources, modules, variables, outputs; module sources |
| `package-manifest` | scripts, workspace members, declared entry points, metadata (TOML and XML by section) |
| `schema` | tables, views, indexes, altered tables, Prisma/GraphQL model declarations |
| `documentation` | headings in both Markdown syntaxes, and links that resolve to repository files |
| `script` | functions, uppercase assignments, invoked paths, variable references |
| `test` | suites, and a bounded sample of case names |
| `environment-configuration` | **variable names only** — see below |
| `tool-configuration`, `build-configuration`, `workspace-configuration`, `data` | sections, settings, referenced paths |
| `lockfile`, `generated` | presence, with the reason they were not read |
| `unknown-artifact` | presence, language, position, and a boundary saying no reader exists |

**A `.env` file's values are never recorded.** It holds live credentials in a great many repositories, and a
value recorded here would reach the graph, then a projection, then a prompt, then an answer. The reader
enforces it and a test asserts it against a fixture containing a plausible secret.

**A YAML file's family is decided by content, never by name.** `deploy.yml` is a workflow in one repository,
a compose file in the next and a Kubernetes manifest in the third; what is knowable is what its top level
declares. A test holds the same filename classifying two ways.

### Graph and fact changes

Schema version **4**. Six relationship types, one node kind, one column:

| addition | what it means |
|---|---|
| `CONTAINS` | an artefact holds an element, or an element holds a nested one |
| `REFERENCES` | an artefact names a path that resolves to a file |
| `RUNS` | a command inside an artefact invokes a file |
| `CONFIGURES` | a configuration file configures a detected technology |
| `DOCUMENTS` | a documentation artefact links to a file |
| `USES_ENV` | an artefact supplies or names an environment variable |
| `ArtifactElement` | one structural piece of an artefact |
| `nodes.artifact_kind` | the family for a `File`, the element kind for an `ArtifactElement` |

`DEPENDS_ON` was widened to `ArtifactElement` on both sides, and that row is the substantive one: a
workflow's `needs:` and a compose `depends_on:` are the repository **stating** an order, which is the only
ordering evidence a configuration format ever gives.

Three decisions worth stating:

- **`art:` is its own identifier prefix.** A `sym:` names a declaration a compiler parsed; an `art:` names a
  structure a line reader recognised. A consumer listing declarations filters on `sym:`, and sharing the
  prefix would put workflow steps in that list with nothing able to tell them apart again.
- **`CONTAINS` is excluded from `REFERENCE_TYPES`**, exactly as `DECLARES` is. Otherwise a repository whose
  YAML is thorough reads as its most coupled region — the hotspot-as-importance failure through a new door.
- **An unresolvable reference is recorded, not dropped.** A workflow invoking a script that no longer exists
  is a real finding, and the absence of a `RUNS` edge must stay distinguishable from the absence of a
  command.

Seven new fact predicates: `artifact-inventory`, `declares`, `artifact-ordering`, `runs`, `documents`,
`configures`, `onboarding`.

### Explorer

Same layout, same components, same tab strip. What changes is the information.

A file carrying an artefact family leads with a **deterministic summary** assembled from graph facts — what
kind of artefact, what role, what it declares, what it configures, what it reaches, what references it,
where it sits — followed by its structure grouped by the section the reader recorded, in **file order**,
because that is the only order that was observed. Sibling prerequisites are shown as `needs X — declared by
this artefact`. Three further tabs carry what it reaches, what reaches it, and what it named that resolved
to nothing, each with the evidence verbatim.

The declaration tabs stay present rather than being hidden: a `vitest.config.ts` is genuinely both a tool
configuration and a TypeScript module with an export. Their empty state now reads **"No source-code
declarations were extracted from this file"**, and where the file is an artefact it adds that what it does
declare is one tab away.

`RepositoryOverview` gains an artefact roster by family and a capped digest of the artefacts that describe
the repository — restricted to `SYSTEM_ARTIFACT_KINDS`, capped **per family** as well as overall so a
repository with two hundred workflows cannot spend the whole digest on workflows and leave its README
unmentioned.

### Retrieval

No second RAG path, no file contents in the prompt. Two extractors and one reordering:

- `artifact-inventory` is **pinned into the stable prefix** beside the area map: what a repository is made
  of does not change with the question.
- `key-artifacts` sits in the steerable region and in the `architecture` fact group, because on a repository
  whose services are wired in YAML the artefacts *are* the architecture.
- `onboarding` leads the `locate` intent, ahead of `hotspots`. `key-artifacts` leads `deployment`.

The `deployment` lead's fact allocation was rebalanced from `architecture: 0.15, supporting: 0.6` to
`0.35 / 0.4`. The old shares carried a comment saying a deployment answer is mostly technologies and
configuration — true while those were the only deployment evidence that existed. Measured before the change:
**4 artefact facts of 85** on a repository whose deployment is entirely in YAML.

`WORKFLOW_QUESTION` gained `walk me through`, whose absence meant the single most workflow-shaped question
anyone asks matched `IMPORTANCE` on the word *important* and received a ranked component list.

### Onboarding

`identity.onboarding` admits four kinds of evidence and **no ranking**: documentation the repository ships
(and the files it links to), an entry point a manifest declares, a route or an unimported unit, a separately
packaged directory, and a traceable workflow. The route is built from that list and from nothing else — it
used to fall through to `identity.critical`, which is the fan-in ranking, so "where should I start" answered
with the most-referenced declaration: the worst possible first file, since it is referenced by everything
precisely because it assumes everything.

Two refinements the corpus forced:

- **A route of four documents is not a route.** Each kind contributes at most twice, so a repository with
  seven READMEs gets documentation, then an entry point, then a boundary.
- **An entry point into a build output is not a place to start reading.** Every published package declares
  `main: ./dist/index.js`, so a monorepo's manifests recommended a compiled bundle — twice.

An orientation question with no onboarding evidence gets `absent` or `undetermined` and an empty route,
which is the honest outcome rather than a substitution.

### Claim strength

Three rules, taking `entailment.ts` from five to eight. Rule **order** is now load-bearing and documented:
a denial is adjudicated as a denial, and a quality verdict and a recommendation before the ordering rule.

| transformation | licensed by |
|---|---|
| structural prominence → architectural centrality | a capability naming it, a request flow, a workflow, a route it serves, an entry point |
| file presence → a quality verdict | nothing; no wording of this claim is supportable |
| a ranking → "where to start" | onboarding evidence, a `documents` link, an entry point, a package boundary, a route |

`execution-order` gained `artifact-ordering` as a licence, which is the one addition that *widens* what an
answer may say: "the release job runs after the build job" is written in the repository's own YAML and used
to be rejected. `configuration-as-runtime` gained a concept-gated licence — a `declares` fact licenses "runs
on push" only when it names a trigger, because a `declares` fact exists for every artefact.

Two defects were caught during the work. `exists-to` was initially a licence for a centrality claim, which
meant any repository with a derivable purpose licensed a claim about any declaration in it; and the
recommendation rule matched a bare "begin with", so *"the deployment appears to begin with `x.py`"* was
adjudicated as a recommendation and the ordering rule never ran on it.

The prompt gained two rules: no volunteered "next, look at X", and no quality judgements.

### Corrective generation

`retrieval → generation → verification → one bounded correction → verification → return`.

The corrective prompt is the original prompt plus one instruction, so a provider reuses the whole evaluated
prefix. It names the failed sentences and the reason each failed, and demands the same length and depth —
because a rewrite has a trivially available way to make zero unsupported claims, which is to say almost
nothing. A rewrite shorter than two fifths of the original is rejected on that ground alone.

At most one correction, and the bound is structural rather than arithmetic: the correction is set in a
branch guarded by the attempt count, so no state reaches a third generation. A supported first pass costs
nothing; `unverifiable` is not corrected either, since it means nothing was cited. The safer of the two
answers is returned, ties to the rewrite, with its verdict and diagnostics intact.

`Answer.attempts` and `Answer.corrections` reach the CLI, the REST API and the web app. A `restart` stream
event tells a consumer holding already-streamed prose to discard it; the web app clears the turn, and the
terminal draws a rule and says the answer above was rejected.

### Validation

Five repositories, chosen for structural difference and none of them in the previous corpus.

| repository | shape | files | declarations | artefacts (read) | elements | unresolved |
|---|---|---|---|---|---|---|
| `sindresorhus/execa` | library, documentation-heavy | 644 | 2,415 | 383 (376) | 1,274 | 0 |
| `docker/awesome-compose` | container collection | 479 | 263 | 403 (253) | 1,525 | 56 |
| `actions/starter-workflows` | CI/template repository | 505 | **42** | 502 (375) | 2,778 | 59 |
| `pallets/flask` | framework | 236 | 1,839 | 202 (185) | 798 | 2 |
| TraceIQ | monorepo | 665 | 7,247 | 287 (247) | 2,642 | 234 |

Artefact edges produced:

| repository | REFERENCES | RUNS | CONFIGURES | DOCUMENTS | USES_ENV |
|---|---|---|---|---|---|
| execa | 0 | 0 | 1 | **300** | 1 |
| awesome-compose | 63 | 3 | **81** | 64 | **163** |
| starter-workflows | 2 | 0 | 9 | 0 | **434** |
| flask | 2 | 0 | 10 | 0 | 12 |
| TraceIQ | 91 | 0 | 12 | 1 | 43 |

What the semantics actually say, which is the test the milestone sets rather than whether an answer is
labelled grounded:

- **`starter-workflows`** — category `infrastructure`, 42 declarations, and every question now reaches
  **21–23 artefact facts**. The repository is described by its 183 workflows rather than by its 42
  declarations.
- **TraceIQ's own compose file** yields `ollama → ollama-pull → api → seed` as a four-step declared order,
  and references both Dockerfiles and the two scripts it mounts. No code in the repository establishes any of
  it. "Walk me through one important workflow end to end" now leads with `workflow` rather than a component
  ranking.
- **`flask`** — onboarding is `CHANGES.rst`, `README.md`, then the declared order of
  `.github/workflows/publish.yaml`. No step is a ranked declaration.
- **`awesome-compose`** — 39 compose files and 35 Dockerfiles produce 81 `CONFIGURES` and 163 `USES_ENV`
  edges on a repository with 263 declarations.
- **Absence is still absence.** `How does caching work?` and `How does authentication work?` return `absent`
  or `undetermined` on four of the five, with the section list and the component list suppressed.

Three defects the corpus caught and the unit tests had not:

1. **A sequence item nested inside the item above it.** An item frame sits at the same indentation as the
   next item, so unwinding only deeper frames left the previous item open — every step of a CI job was
   recorded as a child of the step above it.
2. **431 phantom dead links on one repository.** A path with two readings was emitted as *two* references,
   so the unchosen alternative was recorded as unresolved. References now carry ordered candidates and the
   translator resolves against the scan's inventory. execa: 431 → 0. flask: 147 → 2.
3. **`COPY --from=someorg/sometool` read as a stage prerequisite.** `--from` names either an earlier stage or
   a registry image, and only the first is ordering. One dangling `DEPENDS_ON` per Dockerfile.

A fourth was a deliberate prioritisation rather than a defect: test files contributed 3,084 of execa's 3,471
elements. Suites are the semantic content and individual case names are bulk, so cases are capped at eight
per file and the boundary says how many were omitted. execa's node count fell from 6,633 to 4,436.

### Token and performance impact

Prompt totals **4,261–4,619** across 55 question-repository pairs, of which artefact facts are
**194–1,020 tokens** — 4% to 22%, highest on the CI repository where they are the only evidence there is.
Measured with the same counter the budget charges against. The totals are bounded by the tier rather than by
what is available, so what changed is the *composition* of the prompt rather than its size.

Analysis cost is **0.5–0.6 s** for the artefact-heavy repositories (479–505 files) and 12.8 s for TraceIQ,
whose cost is dominated by TypeScript compilation. Artefact reading is one pass of line reading over
non-source files, sharing the file reader with technology detection so a file wanted by both is opened once.

Graph growth, after the test cap: **+1,274 to +2,778 nodes**, all `ArtifactElement`. Bounded three ways —
60 elements and 60 references per artefact, 8 test cases per file, and a 512 KB read limit — and each cap is
reported rather than applied silently.

### Limitations

**Formats TraceIQ still does not semantically understand.** Ansible playbooks, Helm templates before
rendering, Kustomize overlays, Bazel and Buck build files, CMake, Gradle Groovy/Kotlin DSL beyond section
headers, systemd units, nginx and Apache configuration, OpenAPI and JSON Schema as *schemas*, protobuf,
GraphQL SDL beyond type declarations, Jupyter notebooks, `.proto` service definitions, Puppet, Chef,
CloudFormation beyond top-level blocks, and every binary or archive format. Each is recorded with its
family, its position and a boundary saying no reader exists.

**Within the formats that are read.** No reader is a conforming parser. YAML anchors and aliases are not
expanded, flow sequences are kept whole rather than split, and a templated file is read as the template
rather than as what it renders to. Docker build arguments are not substituted and no base image is
inspected. Compose `extends`, profiles, `env_file` contents and override files are not resolved. A schema's
columns, constraints and foreign keys are not read, so relationships *between* entities are not established.
Markdown prose is not interpreted: the headings say what a document covers, not what it says. Shell control
flow is not followed, so nothing establishes what runs or under what condition.

**Resolution.** A reference resolves to a *file*, so a path naming a directory — a `tsconfig` project
reference, a build context — stays unresolved. So does a path into a build output, correctly: the repository
names `dist/index.js` and the graph holds no such file. TraceIQ's own 234 unresolved references are almost
entirely those two cases.

**`RUNS` is narrow by design.** A command yields a `RUNS` edge only where a recognised runner is followed by
a path-shaped argument that resolves. `npm run build`, `pnpm --filter x test` and `pytest` name no file, so
four of the five validated repositories produce zero — which is honest and is why the edge count is reported
beside the others.

**Inference.** Every family decision from a path is a convention: a directory named `migrations` is a schema
family, a `k8s` directory is not what makes a file a Kubernetes resource (its `apiVersion` is). The
repository *type* inference is unchanged by this milestone and still mis-describes a collection of sample
applications as an application, because its routes are real and its samples sit in top-level directories.

**Corrective generation.** One pass. Whether a model obeys the instruction to keep its length is not
enforceable from here beyond the two-fifths floor, and a rewrite that fails again is returned with its
warning rather than rewritten a third time.

## Semantic Understanding — structural prominence is not semantic importance

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web` clean;
**2,762 backend + 376 web** tests passing. Structural invariants on **15 repositories**, zero failures.

### One sentence of cause

A fan-in count measures how much of a repository points at a declaration. It says nothing about whether
that declaration is what the repository is *for* — and the whole answering pipeline was reading the first
number as the second.

On an umbrella repository of git submodules whose only analysable code is four Python scripts under
`.ci/scripts`, that produced every failure at once. `set_secret.py` genuinely has the highest fan-in, so it
was the repository's most important component, the answer to "explain the architecture", the answer to
"what tests should I read first", and — because its name contains `secret` — the basis of an invented
authentication architecture.

### Five root causes

| # | cause | consequence |
|---|---|---|
| 1 | `.ci`, `.github` and their siblings were not in the region-role vocabulary at all | CI scripts were production code, so they ranked, and nothing else did |
| 2 | Repository identity was derived **only from declarations** | a repository whose code is CI *is* a CI tool, as far as the identity could tell |
| 3 | Importance was global | the same ranking answered every question, so every question got CI |
| 4 | Nothing asked whether the requested concept existed | a caching question on a repository with no cache got 67 facts about something else, and the model explained those |
| 5 | Grounding adjudicated **naming**, not entailment | "authentication works through `set_secret.py`" passes every naming check: the file is real, the citation resolves |

### Repository identity, from the shape rather than from the code

`structure.ts` now folds the packages listing into a **top-level area map** — each directory with its
semantic role and size — and derives a `RepositoryCategory` from it: `codebase`, `monorepo`, `collection`,
`infrastructure`, `umbrella` or `unknown`. This is deliberately separate from `profile.ts`'s
`RepositoryType`, which reads routes, manifests and role annotations. They agree on ordinary repositories
and disagree on exactly the ones that mislead: on the umbrella case the type is `unknown` and the category
is `umbrella`, and the second is what a reader needs.

The area map is emitted as `area` facts, pinned into the **stable prefix** — a directory map does not
change with the question — so it is citeable and costs nothing to reuse across a session.

**The one signal that made the umbrella case solvable was `.gitmodules`.** Submodule mount points contain
zero files on any clone that did not initialise them, so the scanner correctly sees nothing and the
listing correctly omits those directories. Without reading `.gitmodules` the honest conclusion from what
remains is "94% CI and deployment" — true of what was scanned, wrong about the repository. The category
carries that caveat in its own evidence line rather than hiding it.

**README prose is deliberately not used.** The scanner records a file's path, language, role and size, and
no content, so README text is not available to this layer at all. Adding it would mean a new extraction
path through the scanner, graph and context packages, and every failure listed above turned out to be
fixable from structure the graph already had. Recorded as a limitation rather than done badly.

### Semantic roles, and why they are not importance

The region-role taxonomy gained `ci`, `deployment`, `configuration`, `sample`, `script` and `migration`.
Two rules keep it safe:

- **A role word gets a leading dot and a compound tail** (`.ci`, `docs_src`, `test_utils`), because the
  conventions are spelt both ways.
- **`samples`, `starters` and `templates` are matched only in the first path segment.** Spring PetClinic
  lives under `org/springframework/samples/`, so the word buried in a Java namespace is domain vocabulary;
  the same word at the top of a tree is the repository telling you what it holds.

`rankComponents` gained a `roles` option. The measurement is unchanged — it is still fan-in, route
ownership, coupling and role — and what moves is the **eligible set**, normalised within itself so that
"the most prominent CI script" means something rather than being the lowest entry in a list of
controllers. `identity.byRole` carries a ranking per non-production role that has declarations.

### Query-dependent retrieval

`INTENT_ROLES` maps an intent to the semantic roles its evidence must come from, and `rolesForLocating`
does the same for the several different requests `locate` covers. A question restricted to a role that has
no components gets **an empty list, not a fallback** — falling back to the default ranking is what produced
every observed failure, and an empty list is what lets the sufficiency check say the honest thing.

### Evidence sufficiency

`EvidenceSufficiency` is computed before generation with three verdicts, and the middle one is the point:

- **`established`** — answer it.
- **`absent`** — nothing found, and the analysis could have found it. The guidance asks for two or three
  sentences saying so, and explicitly says *"the analysis did not identify it — not that the repository
  does not have it"*.
- **`undetermined`** — nothing found, and the analysis could not have found it here. Reached when no
  region was analysed deeply enough, or when none of the repository's *own* code was analysed at all — an
  umbrella's contents are in other repositories by construction.

Where the verdict is not `established`, the section list and the ranked component list are **suppressed**,
and the plan carries no components. That is the padding removed at the source. The one exception is a
role-restricted question whose role did produce components: asked what handles deployment on a repository
whose deployment *technology* no detector could name, the CI scripts are the relevant, correct answer.

### Claim strength

`entailment.ts` adds five rules, each written against a sentence a model actually produced, each asking
one question: is there a fact of the *kind* that would license this?

| transformation | licensed by |
|---|---|
| reference → execution order | a workflow, a route-to-handler edge or a recorded call |
| secret management → authentication | access-control middleware or an authentication route |
| declared technology → observed behaviour | a role annotation, a workflow, or a recorded responsibility |
| no evidence → nonexistence | nothing; the supportable wording is "not identified" |
| configuration file → confirmed run | a recorded workflow |

Hedged sentences are accepted and reported as `inferred`; flat assertions are `unsupported` and make the
answer ungrounded, on the same footing as an invented identifier — a sentence of real names saying an
unsupported thing is *more* misleading than one naming a file that does not exist.

Two defects in these rules were caught by their own battery: the licence check originally searched all
facts, so a `characterised-as` claim *derived from* a secret-shaped variable licensed the very sentence it
was too weak to support; and the absence rule sat after the secrets rule, so "there is no authentication"
was reported as a secrets claim — the right verdict for the wrong reason.

### microsoft/AI: before and after

| question | before | after |
|---|---|---|
| Explain the architecture. | CI scripts as the top components | `umbrella`; area map; **no components** |
| What tests should I read first? | CI Python scripts | `locate` lead, `roles: [test]`, **nothing substituted**, `undetermined` |
| How does authentication work? | authentication inferred from `set_secret.py` | `undetermined`, no components |
| How does caching work? | correct absence, padded with structure | `undetermined`, no components, two-to-three-sentence instruction |
| What handles deployment? | (undifferentiated) | `roles: [deployment, ci, script]`, names `.ci/scripts` |
| repository identity | `type: unknown`, nothing else | `umbrella` — declares git submodules; `.ci` (ci, 85 files), `AzureDeployment` (deployment) |

No regressions elsewhere: LinkForge stays `application`/`monorepo` with its own components, PetClinic
stays a `service`, React and stripe/ai keep the categories the previous milestone established.

### Conversation memory

Unchanged and re-verified. **37-turn** sessions on two repositories, zero budget failures against 34–35
that would fail under transcript replay, conversation state 125–219 tokens, zero raw history tokens.

The brief's transition sequence works in both directions: turn 5's "What tests cover that?" inherits the
session focus *and* restricts to `roles: [test]`; turn 7's "How does authentication work?" — four turns
after a deployment question — does **not** inherit deployment. Explicit current-turn intent outranks
inherited focus.

### Token impact

Prompt totals **3,066–3,560** across 165 question-repository pairs, against 3,418–3,552 before: unchanged
at the top, lower at the bottom. Facts 35–79. Guidance averages 738 tokens for an absence and 744 for an
explanation — the absence instruction *replaces* the section list rather than adding to it, so the
guidance says something different rather than something longer. One stable prefix per repository on all
15. Planning stays under a millisecond per question.

### Limitations

**Graph.** README and documentation *content* is never read — only paths, roles and sizes. Submodule
contents are not analysed, by construction. Environment variables and external packages still cannot be
attributed to a file in a repository context.

**Inference.** Test coverage remains a filename match. The role vocabulary is conventional, so a
production directory named `scripts` is classified `script`; `starter`, `template`, `scaffold`, `site`,
`perf` and `deps` were tried and removed because each becomes a plausible production package once a suffix
is attached. `packages/integration` is still not treated as tests.

**Entailment.** Five rules, not a prover. It catches the transformations that were observed and leaves
prose it cannot classify alone, which is deliberate: a validator that fires on sentences it does not
understand is one somebody turns off. It cannot detect a wrong claim about a real relationship — saying
`f12` proves X when it proves Y still passes.

**Model.** Whether the model obeys the two-to-three-sentence instruction for an absence is not enforceable
from here.

## Structural Scope — every fact true, the architecture fiction

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`,
`docker compose build api` clean; **2,722 backend + 376 web** tests passing. Structural invariants
checked on **14 repositories**, zero failures.

### The failure was composition, not detection

Asked to explain `stripe/ai`, TraceIQ reported a persistence layer of **Mongoose, SQLite, Drizzle ORM
and PostgreSQL**, a stack of **Next.js, React, Flask and Express**, six workflows named for checkout and
payment, and a surface exposing `POST /create-checkout-session`, `POST /pay` and
`GET /customer/:email/bookings`.

Every one of those detections was correct. Mongoose is in `benchmarks/furever/environment`; PostgreSQL
and Drizzle are under the two `benchmarks/saas-starter` fixtures; SQLite is under the two
`benchmarks/galtee` ones; Flask is in `benchmarks/card-element-to-checkout/environment/server`. They are
**six different sample applications**, written to be graded by a benchmark, and no two have ever run in
the same process. The repository's own code is `llm/ai-sdk`, `llm/token-meter` and three packages under
`tools/`, none of which serves an HTTP route.

Nothing was wrong with any fact. What was missing was the question **"where was this found?"**, asked
before the answer was composed — and the graph had always recorded the answer.

### Five root causes, each in a different file

| # | cause | why it survived |
|---|---|---|
| 1 | `summariseArchitecture` unioned technologies across the whole tree | every technology already carried its `regionPath`; nothing read it |
| 2 | `ownRoutes` filtered on the route's registration file, and 11 of 16 route nodes carry `fileId: null` | the "absence of evidence is not evidence" rule kept every unattributed route |
| 3 | route nodes are **merged by method and path** — `GET /` was one node "materialised from 4 framework registration(s)" | there is no single file to name, so no path evidence exists at all |
| 4 | role layers were unscoped, so a fixture's `Salon` and `SalonSchema` were the whole `Model` layer | `capabilitiesOf` derives the repository's domains from layer member names |
| 5 | external packages and environment variables cannot be attributed to a file in a repository context | `dependencies.view` is `null` there; env nodes are merged by name |

Cause 3 needed a different kind of fact: **a route needs a framework to register it.** Where no
production region declares a backend framework, nothing in the repository's own code could have
registered the route, so the merged registrations must all be the demonstrations'. Cause 5 is contained
rather than solved — an unplaceable name cannot establish a domain in a repository where most of the
analysed source is not the repository's own.

### One vocabulary, in one place, applied everywhere

`structure.ts` is as much a consolidation as an addition. The knowledge that `examples` and `benchmarks`
demonstrate a repository rather than constitute it already existed three times over — `DEMONSTRATION_PATH`
in `profile.ts` decided repository *type*, `GENERATED_PATH` in `importance.ts` decided *ranking*, and
neither reached the technologies, the entry points or the workflows. Now one table classifies every region
as production, example, test, benchmark, generated, vendored or documentation, and eight consumers read it.

The vocabulary is **conventional, never repository-specific**: `stripe/ai` calls its fixture directories
`environment` and `solution`, and neither word appears — they are caught by sitting under `benchmarks/`.

### stripe/ai, before and after

| | before | after |
|---|---|---|
| type | `application` | `monorepo`, several units, production share 0.28 |
| persistence | Mongoose, SQLite, Drizzle ORM, PostgreSQL | none — correct, no production package declares one |
| stack | Next.js, React, Flask, Express | Docker, GitHub Actions (root), Jest, pytest |
| workflows | 6, named for checkout and payment | none |
| entry points | `POST /create-checkout-session`, `POST /pay`, … | `tools/python`, `llm/ai-sdk`, `tools/typescript`, `llm/token-meter`, `tools/modelcontextprotocol` |
| security | 9 secret-shaped variables | none — no surface to guard |
| domains | rendering, routing, persistence, networking, authentication, configuration | testing, build, deployment, persistence |
| top components | `Salon`, `SalonSchema`, `SettingsProvider` | `tools/python`, `llm/ai-sdk`, `meteredModel` |

42 technologies are still recorded — as `benchmark` and `example`, with their regions, so an answer can
say what is true about them.

### Locating questions get places, not descriptions

"What tests should I read first?" received an architecture overview, and the cause was that **the only
test evidence a prompt ever carried was the count `N declarations carry the Test role`.** A count cannot
be opened. So the projection had nothing for the question, the importance ranking answered instead, and
the reader was handed the most-referenced declarations.

A `locate` intent, a `locate` lead with its own three sections, and a `tested-by` fact part now carry test
names with their paths. Coverage is mapped by stripping the ecosystem's test affix and matching against
annotated declarations — PetClinic maps 12 of 17 (`OwnerControllerTests.java` → `OwnerController, Owner`)
and every line says the mapping is a naming convention rather than an observed relationship. Where nothing
matches, the fact says the analysis cannot say.

Question breadth now also reaches the depth rule: a locating answer is `focused` whatever the repository's
size, because a four-filename answer given the "explain the major modules" instruction is padding.

### Grounding: two false positives fixed, strictness proved intact

`grounding-battery.test.ts` adjudicates 16 claim shapes a correct answer makes and 12 fabrications of the
**same shapes** against a real projection. Two categories were genuinely wrong:

- **`CI/CD` was reported as a package no fact carried.** It is slash-shaped, so it was adjudicated. The
  standing instruction already forbids generalising GitHub Actions into "CI/CD" — that is a prose rule a
  reader judges, not a naming claim a verifier can decide. `isProseAcronym` exempts short all-letter and
  all-caps slashed segments; `aws-sdk/client-s3`, `next.js/router`, `@prisma/client` and `React/DOM` are
  all still adjudicated and held as negative controls.
- **`env:REDIS_URL` was called an invention** while the facts said `reads-env REDIS_URL`. The model was
  using the identifier prefix the system prompt taught it. The extractors now declare the `env:` identity.

Route paths turned out to work already; the first version of the battery declared its permitted set by
hand and was testing the fixture rather than the guard.

### Regressions the existing suite and the corpus caught

| caught by | regression |
|---|---|
| `profile.test.ts` | scoping `routeCount` made the framework proportion test compare a number with itself — Flask and Gin became web services again. Both counts are now carried. |
| `boundary.test.ts` | a doc comment named a model vendor, which the package forbids anywhere in source |
| `projection.test.ts` | `which` in the `locate` vocabulary made "Which modules are most referenced?" a locating question |
| `grounding.test.ts` | an existing test asserted `CI/CD` *should* fail — reversed with the reasoning stated |
| React corpus run | consolidating three patterns dropped `fixtures?`, and React immediately re-acquired a workflow through `fixtures/flight/server` |
| FastAPI corpus run | `docs_src` does not match `docs`; role words now accept a `[_-]…` compound tail |
| LinkForge corpus run | the eight tests inside the cap were all unmapped page tests; tests with resolved coverage now sort first |

### Cross-repository invariants — 14 repositories, 0 failures

Checked as properties, never as prose: an incidental technology never reaches the stack; no ranked
component or unit comes from a non-production path; a repository serving no route has no routed workflow
and no route groups; a library or framework never acquires one; a security surface needs a route or a
middleware; caching is never claimed without a detected cache; one stable prefix and one system message
per battery; more than one answer shape per repository.

| repository | type | composition | own/declared routes | routed workflows | set aside |
|---|---|---|---|---|---|
| stripe/ai | monorepo | several (0.28) | 0/14 | 0 | 40 benchmark, 4 example |
| React | framework | several (0.82) | 0/11 | 0 | 51 test, 1 benchmark, 1 example |
| LinkForge | application | several | 16/16 | 4 (+2 inferred) | — |
| Spring PetClinic | service | single | 16/16 | 6 | — |
| Flask | library | single (0.52) | 0/134 | 0 | 3 example |
| Gin | library | single | 4/112 | 0 | — |
| FastAPI | library | single | 0/598 | 0 | — |
| zod | monorepo | several (0.83) | 0/0 | 0 | 1 benchmark, 1 documentation |
| axios, commons-lang, express, dash, client-go, zustand | library / framework | — | 0 | 0 | — |

### Measurements

Prompt totals 3,435–3,552 tokens across the battery, of which facts are ~1,900–1,990 and guidance
~1,450–1,550; fact counts 41–76. Prefix reuse: one stable prefix and one system message per repository on
all 14. Planning 172–892 µs per question. Thirty-turn sessions still complete on all six repositories
tried with **zero** budget failures against 27–28 that would have failed under turn replay, conversation
state 153–225 tokens.

### A mechanism built and then removed

A `confine` option was added so a focused question's supplement could stop at the planned parts instead of
filling the tier. Measured on LinkForge, PetClinic and React it was **inert** — for every question the
product would have confined, the output was byte-identical, because the planned parts already exhaust the
budget before an unplanned extractor runs. Relevance was already coming from the reordering and the
allocation. It was removed rather than shipped with a justification it had not earned.

### Live validation — the milestone battery through a real model

Ten questions through `RepositoryAnswerer` against `qwen2.5:7b-instruct` on `stripe/ai`, as one growing
session. **Zero occurrences of Mongoose, SQLite, Drizzle, PostgreSQL, Next.js, Flask, Express,
`/create-checkout-session` or `/pay` in any of the ten answers.** Seven verdicts `grounded`, three
`ungrounded` — and all three rejections are the guard catching the model inventing paths (`@/app`,
`@/components`, `@/lib`; `llm/ai-sdk/token-meter.ts#trackUsage`; `benchmarks/furever/package.json`), which
is the negative control working in production rather than a regression.

Three answers are worth quoting because they show the mechanisms reaching prose:

- *Architecture*: "This repository is a monorepo organised around persistence, testing, build, and
  deployment… ★★★☆☆ tools/python, ★★★☆☆ llm/ai-sdk, ★★☆☆☆ tools/typescript, ★★☆☆☆ llm/token-meter…"
- *Tests*: names two real test paths, then "The mapping is based on the naming convention rather than a
  recorded relationship in the graph" — the `CERTAIN`/`INFERRED` distinction survived into the sentence.
- *Caching*: "The analysis could not establish specific details about caching mechanisms" — evidence
  absence produced explicit uncertainty instead of a plausible cache.

Answers ran 113–326 words in 86–517 s; prompts 3,325–3,400 tokens with conversation state 0–201.

**The live run also found the last leak.** The architecture answer said "953 files across five main
regions: benchmarks/furever, tools/python, llm/ai-sdk, benchmarks/card-element-to-checkout,
benchmarks/saas-starter-partial-payments" — naming three benchmark fixtures among the repository's main
regions. Every other consumer of structural scope had been fixed; the `regions` fact still presented all
fifty regions as equals, largest first, which on a repository that is 72% demonstrations means the
demonstrations lead. Region facts now carry their role and sort production first.

### Known limitations

**Graph limitations.** Route nodes and environment-variable nodes are merged by name, so a route
registered in four fixtures has no file and a variable read in four places has no place; a repository
context's `dependencies.view` is `null`, so an external package cannot be attributed to a file. All three
are contained by the production-share rule rather than solved. LinkForge's backend tests are not annotated
with the Test role at all, so its test question is answered from frontend tests.

**Inference limitations.** Test coverage is a filename match and says so. `meteredModel` in `llm/ai-sdk`
is annotated `Model`, so `stripe/ai` claims a `persistence` domain from an LLM-model wrapper — an honest
derivation from a naming collision the graph cannot resolve. `packages/integration` is not in the
conventional vocabulary, so zod still reports Drizzle ORM from an integration-test package. `integration`
was left out deliberately: a directory of that name is at least as likely to be a repository's own
integration layer.

**Model limitations.** The answer's structure, depth and evidence are decided by the planner; whether the
model follows the section order is not enforceable, and the grounding guard checks naming claims rather
than whether a cited fact supports the sentence it is attached to.

## Conversational Memory — long sessions, without shortening a single answer

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,643 backend + 376 web** tests passing. Validated with **thirty-turn sessions on five
repositories**.

### The failure was arithmetic, and it had nothing to do with the repository

Every prior turn was replayed into the prompt in full, so the reservation grew by the length of every
answer. Three detailed answers at 800–900 tokens is 2,500 tokens against a `standard` tier that holds
3,400, and the fourth question failed with `budget-not-satisfiable`. The graph still held every fact the
question needed. What had run out was room to restate prose the model had already written.

Measured on the battery: replaying a thirty-turn session reserves **29,500 tokens** by the last turn and
first crosses the tier at **turn three**.

### Answers are the product, so the conversation is what gives way

`memory.ts` derives a `ConversationState` — covered topics by kind, the current focus, what the session
has not reached, the reader's level, questions the guard rejected, and a four-question window — and that
is what the model is shown. The turns go no further than the derivation. Every cap in the file is a
**constant**, so the rendered block settles at 171–222 tokens and stays there whether the session is four
turns long or forty.

Three properties make it safe to keep across a session whose facts are rebuilt every turn:

- **Derived, never accumulated.** A pure function of the transcript and the identity, recomputed each
  turn. A forty-turn session replays to the same forty prompts, which is the reproducibility the whole
  pipeline below `generate` depends on.
- **It can only name what the identity carries.** A topic is matched against a closed vocabulary of
  domains, workflows, components and technologies the repository demonstrably has, so the state can say
  a session covered `urlService` and can never say what `urlService` is. Facts come from the graph.
- **It subtracts and it steers; it never adds.** `covered` removes explanations already given; `focus`
  supplies a subject to a question that named none. Neither can put a topic in an answer the current
  question did not ask for.

### Follow-ups, and answers that still stand alone

A question that points back — a pronoun, an anaphoric opener, or a three-word fragment — inherits the
session's focus, and the scope is recomputed from it so the depth rule, the section template and the
exclusions all agree it is a question about one part of the repository. "Where is this implemented?" is
now answered about the thing the session was discussing instead of restarting on the architecture.

Not re-explaining and standing alone are rendered as **one instruction**, because separating them
produces the two opposite failures: told only the first, a model writes "as explained above" and the
answer is unreadable on its own; told only the second, it re-explains everything and the session goes in
circles.

### Validation: thirty turns, five repositories

| repository | failures | would have failed | first replay failure | reserved, turn 1 → 30 | replay at turn 30 | session block | follow-ups resolved |
|---|---|---|---|---|---|---|---|
| LinkForge | **0** | 28 of 30 | turn 3 | 1,479 → 1,832 | 29,744 | 180–214 | 5 |
| React | **0** | 28 of 30 | turn 3 | 1,450 → 1,808 | 29,793 | 183–202 | 5 |
| Spring PetClinic | **0** | 28 of 30 | turn 3 | 1,434 → 1,718 | 29,696 | 176–205 | 4 |
| Flask | **0** | 28 of 30 | turn 3 | 1,357 → 1,756 | 29,500 | 181–222 | 5 |
| Gin | **0** | 27 of 30 | turn 4 | 1,336 → 1,716 | 29,434 | 171–216 | 5 |

One stable fact prefix and one system message per session on all five, so prompt-prefix reuse survived.
`history` tokens are zero on every turn of every session. Deriving the state costs 482–757 µs per turn.

### Four defects the sessions found

| where | wrong behaviour | why | fix |
|---|---|---|---|
| LinkForge, turn 30 | "what should I look at next?" narrowed to Next.js | `next` is a subsystem the repository genuinely contains, and `focusOf` matched it | sequence adverbs joined the question vocabulary — they are how a question is positioned, never what it is about |
| React, turn 5 | "Why is Redis used?" inherited the previous turn's authentication focus | the follow-up test anchored on the opening word, and `why` opens both a continuation and a new question | a pronoun, an anaphoric opener, or a three-word fragment — not a leading `why` |
| all five | "what should I look at next?" planned as a workflow answer with no suggestions | the orientation patterns covered "where do I start" but not the way a session ends | "look at next", "what next", "where next" |
| all five | the block reached 326 tokens and cost 14 facts of 46 | a six-question window, a three-line guard, and a kind tag per topic | four questions, two lines, topics grouped by kind — 171–222 tokens |

### Files

| File | Change |
|---|---|
| `packages/ai/src/memory.ts` | New. `ConversationState`, `deriveState`, `renderState`; topic vocabulary, focus carrying, level, goal, remaining, open questions, window and compression |
| `packages/ai/src/plan.ts` | `PlanInput.state` replaces `history`; focus inheritance with the re-widening guard; `continues`; `suggested`; the session as an audience floor |
| `packages/ai/src/prompt.ts` | The fenced session block between the facts and the question; the state replaces the replay in `assemble`, `promptBreakdown` and `reservedTokens` |
| `packages/ai/src/strategy.ts` | Continuation, answer-independence and next-topic guidance |
| `packages/ai/src/answer.ts` | Derives the state once per answer, threads it everywhere, reports it; `stateFor` for inspection |
| `packages/ai/src/stream.ts` | `GroundingSummary.conversation` |
| `packages/ai/src/intent.ts` | Sequence adverbs in the question vocabulary |
| `apps/cli/src/chat.ts` | Records the guard's real verdict, so open questions are real |
| `apps/api/src/chat.ts`, `apps/web/src/types/api.ts` | The `conversation` prompt section on the wire |
| `packages/ai/src/memory.test.ts` | New. 19 tests: what a session establishes, that it stops growing the prompt, what reaches the model |

### Known limitations

- **A session is not free.** The block is real tokens, and those tokens are facts the projection cannot
  buy: on LinkForge the fact count falls from 46 to about 36 over a session. The price is paid **once** —
  turn 12, turn 30 and turn 40 project identically — where the old behaviour charged it every turn and
  then ended the session. Raising the tier is the lever for a caller who wants both.
- **Topics are matched, not understood.** An answer that discussed the cache without writing "Redis" did
  not, as far as the state is concerned, cover it. The alternative is extracting topics from prose, which
  would let conversation memory assert something the repository does not contain.
- **The API cannot report open questions**, because the wire's history carries no verdict. The CLI now
  does. A turn nobody labelled arrives as `unverifiable`, which means "not told" rather than "failed".
- **Compressed turns lose their questions, not their topics.** Beyond the four-question window the path
  is a count; what those turns explained survives in `covered`.

## Question Execution Planner — the planning layer decides, not the model

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,612 backend + 376 web** tests passing. Validated over the same **13 repositories**, ten
questions each.

### The previous milestone knew what the repository was. It still let the model decide what to say

`identity.ts` established what a repository is *for*, and `plan.ts` selected the workflows and
components a question needed. Everything after that selection was still the model's: what the answer's
sections were, in what order, what to leave out, what to admit it could not settle, and how much of the
fact budget each part of the answer deserved. So a caching question and an architecture question about
one repository received the same answer *shape* — one shaped by the standing instruction and by
whichever facts happened to fit.

The planner now decides all of it before a fact is chosen. What reaches the model is a plan; what the
model contributes is prose.

### Structure: nine templates, not one with parameters

`LEAD_SECTIONS` and `INTENT_SECTIONS` are twelve ordered section lists — a workflow answer, an
orientation route, a caching answer, a compilation pipeline — each naming what its sections must
establish. An orientation answer is not a shorter architecture answer; it is a route, and its second
section is a place to start rather than a layer diagram. Every list opens with a section that stands
alone in one paragraph, which is the progressive disclosure: a reader who stops after the first has an
answer rather than an introduction.

### Evidence planning: no section is generated without evidence

Each section names the identity fields it cannot be written without, and a section whose fields the
identity does not carry is **dropped and recorded in `unknowns`** — phrased as a statement about the
analysis ("no cache technology was detected"), never about the repository. Asked "explain caching",
twelve of the thirteen validation repositories have no cache, and all twelve now plan an answer that
says so instead of one that fills the gap.

### Allocation: reordering was not enough

`parts` put the plan's parts at the front of the supplement, and the front of the supplement is where
the budget goes — so a workflow question got its request flow *and* whatever large listing sorted next,
and the ranked components the plan had also asked for were priced out. `FactAllocation` gives each of
four groups a share, applied to the supplement only so the cacheable core stays question-independent,
followed by an unallocated sweep so a group that declines its share leaves the room to someone else.
Measured across 130 question-repository pairs, the allocated projection spends the same budget to
within one fact every time, and buys visibly different facts with it: React asked how authentication
works went from 32 supplement facts to 47.

### Everything else the plan now carries

Audience (steers assumption, never depth), exclusions (concepts the repository demonstrably has that
this answer must leave alone — never invented, never a filter on the facts), a navigation route for
orientation questions, question decomposition, repository memory over the conversation history, and a
reported confidence. All deterministic, all free, and cached against the identity so the four consumers
in one request derive it once.

### Five defects the corpus found

| repository | wrong plan | why | fix |
|---|---|---|---|
| LinkForge | "where do I add a new route?" got a five-step reading list | `ORIENTATION` matches "where do I", which is also how a contributor asks where a change goes | a contribution question is never an orientation question |
| LinkForge | "where should I start?" forbade authentication, caching, persistence, deployment and testing | orientation and importance counted as narrow questions, so the exclusion list fired on questions whose whole purpose is breadth | exclusions only where the question actually narrowed |
| client-go | a route beginning "then read" | no routes and no workflow, so the first two steps were absent and the path began in its own middle | stages assigned by position: the first step that exists is where to start |
| axios, dash, react, zustand | a caching answer opening on "how it is configured" | the section that introduces the cache was dropped for want of one, and the survivors kept their order | a template that loses its opening gets the honest floor back |
| React | "where should I start?" traded eight package facts for eight route facts | the orientation allocation reserved 20% for workflow facts, and a route's last step is one workflow | one share, sized to one step |

### Files

| File | Change |
|---|---|
| `packages/ai/src/plan.ts` | The planner. Sections, evidence checks, exclusions, unknowns, navigation, decomposition, allocation, audience, confidence, memory, cache |
| `packages/ai/src/projection.ts` | `ProjectionOptions.allocation`, the part-to-group map, group ceilings on the supplement and the unallocated sweep |
| `packages/ai/src/strategy.ts` | `questionGuidance` renders the plan: sections in place of the coverage list, plus audience, route, exclusions, unknowns and memory |
| `packages/ai/src/answer.ts` | History reaches the planner; the allocation reaches the projection; the shape reports the new decisions |
| `packages/ai/src/stream.ts` | `AnswerShape` carries audience, confidence, sections, exclusions, unknowns, covered and allocation |
| `packages/ai/src/plan.test.ts` | 51 tests over structure, evidence, exclusions, audience, navigation, decomposition, allocation, memory, confidence, caching and rendering |
| `packages/ai/src/index.ts` | The new public surface |

### Invariants that held on all thirteen

One stable fact prefix and one system message per repository across the whole ten-question battery —
the property prompt-prefix reuse depends on, and the one an allocation derived from the question would
have broken had it reached the core. Four to five distinct answer leads and five to seven distinct
section orders per repository, so the planner is visibly deciding something. Question guidance 408–490
tokens at its per-repository maximum, against 205–457 before the planner grew a structure. Planning
costs 172–892 µs per question.

### Known limitations

- **A `technology` answer has no tradeoffs section**, though the shape a reader expects has one. The
  graph records that Redis is present; it records nothing about what choosing it cost, and a section
  asking for tradeoffs is a section a model can only fill from outside the facts.
- **Exclusions do not filter facts**, only instruct. The projection is a reordering everywhere,
  deliberately, because a classifier that was wrong about the question would otherwise cause a missing
  repository rather than a differently-ordered one — and the planner is a classifier.
- **Decomposition is merged, never answered separately.** Two generations concatenated would produce
  two answers with two openings, which is worse than the failure it fixes.
- `intentOf` does not know the word "shipped", so "how is this shipped?" reads as `overview`. The
  keyword table is closed by design; this is a missing row, not a missing mechanism.

## Repository Identity — what the repository is *for*, not what it contains

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,561 backend + 376 web** tests passing. Validated over the same **13 repositories**.

### The previous milestone made the answer fit the repository. It still described an inventory

Adaptive reasoning gave React a different instruction from LinkForge, and both instructions were about
*shape*: a type, a scale, a set of traits. Neither said what the repository was **trying to
accomplish**. The guidance opened "It is a service" — a category — where a senior engineer would open
"it shortens URLs, and a redirect arrives at `GET /:shortCode`".

Three new derivations close that gap, and each rests only on numbers the graph already computed.

### Importance: everything used to weigh the same

A projection listed `PrismaUrlRepository` and `formatDate` as two facts of equal rank, so a model spent
the same sentence on each. `importance.ts` scores every declaration and package from signals a
capability already measured — route ownership, fan-in, coupling, role, package dependents — and carries
**the raw numbers with every score**, so "the most important declaration here" is checkable rather than
asserted. The weighting is a declared table; the measurements are the graph's.

### Workflows: the one thing an inventory can never say

`RouteResult.handlers` is an ordered list of edges from a route to the declarations registered against
it — the only measured chain in the whole graph. `workflow.ts` turns it into what happens when the
repository does its job, and keeps the two confidences apart: the route-to-handler steps are `CERTAIN`
because edges back them, and the continuation into a service and a repository is `INFERRED` because
role annotation and name agreement are not an observed call. The rendered line says so.

### Identity and planning

`identity.ts` composes a purpose **assembled from evidenced clauses, never written**, and twenty
further fields that are `Evidenced<T> | null` — a repository with no detected cache has `caching:
null`, not `'none detected'`. `plan.ts` then asks what *this question* needs before any fact is
selected, which is the reordering the whole milestone turns on.

### Six defects the corpus found

| repository | wrong answer | why | fix |
|---|---|---|---|
| LinkForge | `analyticsController` at ★★★★★ on nothing but its name | scores divided by the signals a component *had*, so one weak signal scored a perfect 1.0 | divide by what the kind could achieve |
| LinkForge | `XOR`, `SelectSubset` ranked above every controller | Prisma type helpers in `src/generated`, honestly referenced 66 and 57 times | exclude generated and vendored paths |
| LinkForge | the four most important declarations were its rate limiters | the extractor linked only `createLimit`; a middleware was the last linked handler | a Middleware cannot own a route |
| LinkForge | workflows named "limit requests" | named after whichever handler linked | name from the route prefix, or a domain two layers agreed on |
| PetClinic | three workflows all called "owners requests" | all mounted under `/owners` | disambiguate with the trigger |
| React | `flow-typed/environments` its most important unit | type stubs, imported by 46 packages | type-stub directories are not components |

### The regression this very nearly shipped

The core's ceiling is a share of `TIER − reserved`, and `reserved` includes the guidance the question
steers. Harmless while question guidance was forty tokens; once the planner emitted workflows and a
ranked component list it ranged from **205 to 457 tokens** across one battery, the ceiling moved by
hundreds, a different number of facts fitted under it, and the prompt prefix a provider caches differed
between two questions about the same repository — **identical on 3 of 13 repositories, different on the
other 10**. Budgeting the core against a question-independent reservation restores it: **13 of 13**.

Nothing caught this but the corpus. Every unit test passed throughout.

### The same question, thirteen repositories

| question | LinkForge | PetClinic | React | client-go | the libraries |
|---|---|---|---|---|---|
| Explain the architecture | **workflow** | **workflow** | **extension-points** | **extension-points** | **api** |
| Where should I start? | orientation | orientation | orientation | orientation | orientation |
| What are the most important parts? | components | components | components | components | components |
| How does authentication work? | subsystem | workflow | subsystem | subsystem | api / subsystem |

PetClinic derives `owner ★★★★★`, `pet ★★★★★`, `vet ★★★★` — **business domains, not packages** — and is
told to narrate `GET /owners/find → initFindForm`. React is told not to describe a request flow, and to
start from `packages/react` and `compiler/packages`.

### What it costs

| | before | after |
|---|---|---|
| guidance share of prompt | 7.1 %–10.1 % | 14.7 %–20.4 % |
| **total prompt** | 3,000–3,500 | **3,048–3,476** |
| stable prefix per repository | 1 | **1** |

The total is unchanged because the guidance is reserved *before* facts are admitted: it displaces
evidence rather than adding to the prompt. Two renderings keep that affordable — the `workflow` fact
carries what each step does, and the instruction carries only the chain.

### Files

| File | Change |
|---|---|
| `packages/ai/src/importance.ts` | **new** — signals, weights, kind-relative normalisation |
| `packages/ai/src/workflow.ts` | **new** — measured route chains, conventional continuation |
| `packages/ai/src/identity.ts` | **new** — purpose, domains, 20 evidenced fields, per-context cache |
| `packages/ai/src/plan.ts` | **new** — what the reader needs, before what facts fit |
| `packages/ai/src/identity.test.ts` | **new** — 33 tests, six of them corpus regressions |
| `packages/ai/src/projection.ts` | the `purpose` extractor, `coreReserved`, plan-led part ordering |
| `packages/ai/src/prompt.ts` | `fixedReservedTokens`, plan threaded through |
| `packages/ai/src/strategy.ts` | identity-led guidance, ranked domains, compact instructions |
| `packages/ai/src/facts.ts` | `exists-to`, `workflow`, `ranks`; identity on the projection |
| `packages/ai/src/answer.ts`, `stream.ts` | plan replaces strategy; lead and need reported |

### Known Issues

- **Flask, Gin, FastAPI and express derive weak domains** — `routing`, `networking` at ★. Domain
  weighting needs two role layers to agree on a noun, and framework repositories do not annotate that
  way. PetClinic and LinkForge, which do, produce real business domains.
- **`cn` is LinkForge's top-ranked declaration** at 70 references. Fan-in is a real measurement and it
  systematically favours utilities. Raising `role` to 0.22 mitigated it; it did not remove it.
- **A workflow's continuation is never observed.** It rests on role annotation plus name agreement, and
  is emitted `INFERRED`. A real call-chain traversal would need per-symbol contexts and would cost
  latency this milestone was told not to spend.
- **The identity cache is per-context, not per-graph.** One request derives once; two requests derive
  twice. Caching against the graph would mean holding a derived object across a database this package
  cannot see.
- **Still not visible on the HTTP/web surface.** `apps/api/src/chat.ts` uses explicit field mappers that
  forward neither `shape` nor the guidance token fields.

### Next Milestone

Answer evaluation, unchanged from the last milestone and now more pressing. Everything measured here is
the prompt. Whether a narrative built from a ranked identity produces a *better answer* than a correct
inventory needs labelled data over the corpus that is now scanned.

## Repository-Adaptive Reasoning — the answer changes with the repository

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,528 backend + 376 web** tests passing. Validated over **13 repositories** in five languages
through the real pipeline.

### The problem was not grounding, and that is what made it hard to see

Every answer was already grounded, cited and correct. Every answer was also the *same shape*. The
standing instruction told the model to explain "where a request enters, what it passes through, where
state is kept" — an excellent sentence for a web service, and the only sentence any repository ever
received. React has no request to trace. A Terraform module has no layers. Asked to explain the
architecture, the model's options were to obey that instruction wrongly or to quietly ignore the thing
it was told most emphatically.

So the fixed prompt now states only what is true of every repository — cite, do not exceed the facts,
invent nothing — and *how* to explain one is composed per repository from a profile.

### A profile is a restatement, or it is a fabrication upstream of every sentence

`profile.ts` derives what the repository **is** from the graph alone, under the same discipline
`architecture.ts` already observed: every field restates counts, names and detections the graph holds;
a dimension that cannot be proven is absent; nothing is a judgement about quality. `type` has an
`unknown` member and it is used — a repository whose evidence supports no rule gets `unknown`, and the
strategy falls back to scale and domains, which are always measurable.

The type rules are a **ranked list, first match wins**, ordered from the most structurally distinctive
to the least: infrastructure → compiler → framework → application/service → cli → tooling → monorepo →
library → unknown. Each carries the evidence that fired it, so a reader checks the characterisation
rather than trusting it.

**Scale is measured against what a projection can actually name**, not against a file count somebody
chose. A repository is `small` when every package, role-bearing declaration and route group fits in the
facts a model is given, and `huge` when not even the package list fits. `NAMING_CAPACITY` is the sum of
the standard-tier caps in `projection.ts`, and a test asserts the two agree — a cap that changed in one
place and not the other would silently redefine what "small" means.

### Five defects the corpus found that no unit test would have

Validation over thirteen real repositories was not a confirmation step. It found five rules that were
wrong, each of which looked reasonable when written:

| repository | wrong answer | why | fix |
|---|---|---|---|
| Flask | `cli` | depends on `click`, because it ships `flask run` | a parser **and** a top-level command directory |
| Apache Commons Lang | `tooling` | uses JUnit — as does nearly every library alive | requires a command directory too |
| Plotly Dash | `compiler` | two test fixtures both named `…generator…` | two **distinct** stages, not two packages |
| LinkForge | `plugin-oriented` | matched `tests/integration` and a file in `docs/` | narrower stems, and packages must carry declarations |
| LinkForge, client-go, Dash | "Explain the architecture" → **focused** | `docs/architecture` is a derived package | source-bearing units, plus a question-vocabulary guard |

The last is the sharpest. The most repository-wide question anyone asks was narrowing itself to a
documentation folder, on three of twelve repositories, because a path-derived package happened to be
called `architecture`.

### Frameworks are not services, and 134 real routes said otherwise

Flask's repository yields **134 routes**, Gin's **112**, FastAPI's **598** — every one real, extracted
from real decorators. Every one inside a test or an example. Counting them made the best-known
micro-frameworks in Python and Go into web services, and the service instruction told the model to
trace a request to persistence and not to describe a user interface. Both statements are wrong about a
framework, and confidently wrong.

Three corrections, in the order they were needed:

1. **Path filtering.** A route declared in `tests/` or `examples/` is one the repository *shows how to
   write*. 134 → 13, 112 → 6, 598 → 17.
2. **Filename conventions**, because Go puts `router_test.go` beside `router.go` and so no directory is
   named for tests. Java, Python and JavaScript each spell the same convention differently.
3. **A proportion.** All three were *still* services on what remained — Gin's `routergroup.go`, where
   the `GET` method that registers a route is defined. A framework providing routing always leaks a few
   routes into an extractor looking for routing. Below a quarter of the total, the residue is machinery
   rather than a surface. This is the one threshold in the file that is a judgement, and it says so.

Two path words had to be removed by measurement. `samples` discounted every one of Spring PetClinic's
owner routes, because it lives at `org/springframework/samples/petclinic/` — a word that is ordinary
vocabulary inside a namespace cannot disqualify what lives under it.

**React needed a structural fix rather than a filter.** It carries five routes, from the little Express
servers under `fixtures/flight/server` that exercise Flight and SSR, and was profiled as an *Express
application*. A repository built for other people's code to plug into is a framework whatever else it
also contains, so the framework rule now asks before the route rule.

### The guidance is split in two, and the split is a cache decision

A provider reuses the longest prompt prefix it has already evaluated, and the system message is the
front of it. So the half of the guidance that depends only on the repository renders into the system
message, where it is byte-identical for every question; the half the question steers renders after the
question, where varying it costs nothing. Putting question-derived text in the system message would
re-evaluate thousands of tokens on every turn.

Measured across all thirteen repositories: **one stable fact prefix and one system message per
repository across four different questions.** The property the previous milestone built is intact.

### What it costs

| | tokens |
|---|---|
| repository guidance | 269–389 |
| question guidance | 44–72 |
| **share of the whole prompt** | **7.1%–10.1%** |

Under a tenth of the prompt, and it displaces facts rather than adding to the total — the projection's
budget is reserved for it before a fact is admitted.

### The same question, thirteen repositories

Asked *"Explain the architecture."*:

| repository | type | scale | depth | opens with |
|---|---|---|---|---|
| Spring PetClinic | service | small | **complete** | what the service is responsible for and who calls it |
| LinkForge | application | medium | **modules** | what the application does for its users |
| React | framework | large | **boundaries** | what someone building on it writes against |
| client-go | framework | large | **boundaries** | the public surface a consumer imports |
| FastAPI | library | large | **boundaries** | what the library does and what a caller gets |
| Flask, Gin, express, axios, zod, zustand, Dash, commons-lang | library | medium | **modules** | the public API and what it is for |

PetClinic is told to walk every subsystem and trace the flow end to end. React is told the repository
is too large to explain at once, to start from the subsystem boundaries, **not** to describe a request
flow, and to close by naming what is worth asking about next.

Asked *"Explain caching."* the same repositories diverge again: LinkForge, PetClinic, Flask and express
narrow to `focused` on the cache subsystem; the rest stay repository-wide, because narrowing at a
subsystem the facts cannot support would aim the whole answer at nothing.

### Files

| File | Change |
|---|---|
| `packages/ai/src/profile.ts` | **new** — type, scale, traits, stack, domains, units; every field evidenced |
| `packages/ai/src/strategy.ts` | **new** — profile + scope → depth, opening, coverage, drill-down; both renderings |
| `packages/ai/src/profile.test.ts` | **new** — 42 tests, one per rule, five of them corpus regressions |
| `packages/ai/src/strategy.test.ts` | **new** — the same question on a service and a framework |
| `packages/ai/src/intent.ts` | `scopeOf`, `focusOf`, the question-vocabulary guard |
| `packages/ai/src/projection.ts` | the `profile` extractor, `TYPE_PARTS`, `PINNED`, profile on the projection |
| `packages/ai/src/prompt.ts` | `systemMessage`, `reminderFor`, guidance in the breakdown and the reservation |
| `packages/ai/src/answer.ts` | derives the strategy, threads it through, reports the shape |
| `packages/ai/src/facts.ts` | the `characterised-as` predicate; `profile` on `ContextProjection` |
| `packages/ai/src/stream.ts` | `AnswerShape` on the grounding summary |

### Known Issues

- **Flask, Gin, FastAPI and express profile as `library` rather than `framework`.** All four are
  frameworks. The framework rule needs extension-point packages, and none of them name their packages
  that way. This is a deliberate under-claim: the library instruction — explain the public surface and
  how the implementation is organised behind it — is close to right for a framework, while the service
  instruction it replaced was actively wrong.
- **`sdk` is in the vocabulary and no rule claims it.** No graph evidence distinguishes an SDK from a
  library.
- **The 25% route share is a judgement.** It excludes 10%, 5% and 3%, and admits a service with three
  test routes for every real one. A service with a heavier ratio than that would be read as a library.
- **FastAPI's projection reaches zero graph identifiers.** `architecture-summary` is `ALL`-capped and
  pinned first, and on a repository with 372 packages it consumes the standard budget before any
  identifier-bearing part runs. Pre-existing, exposed rather than caused by this milestone; answers
  remain groundable through `terms` (221 for FastAPI).
- **`monorepo` is reachable but rarely reached**, because a more specific type usually fires first. It
  is also a packaging fact rather than a kind of software, which is why `multi-package` exists as a
  trait alongside it.

### Next Milestone

Answer evaluation. Every measurement in this milestone is of the **prompt** — the profile, the
guidance, the facts, the token cost — because that is what a test can assert. Whether the adapted
instruction produces a *better answer* is model evaluation, needs labelled data over the corpus that is
now scanned, and is the one thing this milestone could not measure about itself.

## AI Experience — grounding, explanation and prompt size

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,439 backend + 376 web** tests passing. Measured on `facebook/react` (7,280 files).

### Instrumentation first, because "reduce the prompt" cannot be acted on without it

Every previous attempt at trimming was guided by reading a rendered prompt and forming an impression
of what looked long. `promptBreakdown` reports tokens by section and by fact predicate, using the same
counter the budget charges against. The first run of it answered the question immediately:

| predicate | tokens | facts |
|---|---|---|
| **limitation** | **1,081** | 17 |
| has-role | 899 | 7 |
| has-package | 858 | 26 |
| built-with | 777 | 10 |
| depends-on | 534 | 25 |
| region-depth | 511 | 4 |

The largest single cost in every prompt, on every question, was seventeen fixed sentences about the
analysis's own caveats — **a fifth of the whole prompt**. Nobody had guessed that.

They were also damaging answers. Asked what to understand first about React, the model had ended with
*"The repository overview is computed independently for health reports [f38]"* — a caveat about
TraceIQ's internals restated as a fact about React. Verbose boilerplate does not sit inertly in a
prompt; a model reaching for something to say will say it. The codes are kept, because they are what
qualifies an answer; the prose is not. 1,081 tokens → **160**.

Two smaller cuts followed the same evidence: a technology's evidence sentence keeps the clause naming
the file a reader can check and drops the explanation of what a lockfile is, and a region group stops
repeating a fixed sentence describing the depth it has already stated.

### Compression alone changes nothing, and that is worth stating

A projection always spends its budget, so denser facts bought more facts rather than a smaller prompt.
Lowering `standard` from 6,000 to 3,400 is what converts the compression into a faster answer. The
number is chosen against the clock: prompt evaluation runs near 50 tokens per second, so every 1,000
tokens is about 20 seconds before the first word appears.

| question | before | after |
|---|---|---|
| main packages | 5,458 | **3,267** |
| architecture | 5,460 | **3,335** |
| technologies | 5,927 | **3,336** |
| most referenced | 4,520 | **3,069** |
| authentication | 5,922 | **3,354** |

Every common question now lands inside the 3,000–3,500 target, a **41% reduction**, with limitations,
technologies and regions carrying the same information in fewer tokens.

### Two intent bugs the measurement exposed

**"Explain the architecture and how modules communicate" was classified `packages`.** The word
`modules` sat in the package keyword list and that list was checked first, so the single most
obviously architectural question received a package listing. An explicit architecture word now wins
over an ambiguous one.

**There was no authentication intent at all.** "How does authentication work?" fell through to
`overview` and was answered from package counts. A `security` intent now leads the supplement with
routes, environment variables and middleware — where a login endpoint, a token secret and an auth
guard actually live. Measured after: that question's supplement carries 15 `reads-env` and 11
`handles-route` facts where it previously carried none.

### The verifier was wrong about a right answer

Asked to explain React's architecture, the model produced a well-cited answer naming `ModalDialog.js`,
`ProfilerContext.js` and `InspectedElementContext.js`, and the guard marked all three as names no fact
carried — for three files whose **full paths were in the identifiers it had just been given**. Nobody
writing about a file calls it `packages/react-devtools-shared/src/devtools/views/ModalDialog.js` in a
sentence. A file's basename is now a permitted name.

That failure also showed the report was not a diagnosis. A bare list of rejected strings cannot
distinguish an invention from a verifier being too strict about how a real name is written, and
finding out meant re-deriving the projection by hand. Every rejection now says what it was checked
against, how many names were available, and the closest thing the facts did carry — matched by
substring rather than edit distance, because these failures are granularity mismatches rather than
typos.

### Answers explain instead of listing

The standing instruction now opens with what a good answer does — explain what the parts are for and
how they fit together, use numbers as evidence for a claim rather than as the claim — and forbids
restating an analysis caveat as though it described the repository. Same question, same repository:

> **Before.** "The repository contains several main packages including compiler,
> flow-typed/environments, packages/react-devtools-shared, packages/react-dom-bindings, and
> packages/react-dom [f22]. These are among the larger package directories in terms of files and
> declarations."

> **After.** "…`packages/react` contains 374 declarations and imports 7 other packages, indicating its
> central role [f40]. Similarly, `packages/react-dom` has 1199 declarations and imports 8 packages,
> suggesting it is also a key component [f30]…"

One citation became three, and the counts became the evidence for a claim about role rather than the
claim itself.

### Not done

The rewritten instruction costs 217 more tokens than the one it replaced (339 → 556), which is a real
charge against the budget it is spent inside. It was accepted because answer quality is the higher
priority, but it is the reason the target is 3,300 rather than 3,000.

A model still occasionally ends on an uncited summarising sentence — "these are likely core components
of the frontend" — which rule 2 forbids. The verifier does not catch it, because there is nothing
fabricated in it to catch.

## Analysis Out of Process — the API stops stopping

**Status:** the execution change is complete and measured; the large-repository and multi-repository
parts of the milestone are not, and are listed under "Not done". `pnpm build`, `pnpm typecheck:tests`,
`pnpm typecheck:web`, `pnpm build:web` clean; **2,431 backend + 375 web** tests passing.

### Both premises were checked, and one of them was false

**Analysis blocks the event loop.** `GET /ping` sampled every 250 ms throughout a React analysis:

| | idle | during analysis, in process |
|---|---|---|
| median | 5.0 ms | 4.9 ms |
| p90 | 7.1 ms | 11.9 ms |
| max | 14.9 ms | **30,000 ms** (the client's own timeout) |
| samples over 5 s | 0 | **7** |

**Inference does not.** The milestone asked for an inference worker on the premise that "the API event
loop must never spend minutes waiting for inference". Sampled the same way through a full generation —
prompt evaluation and all — the API's median was **8.9 ms, p90 18 ms, max 134 ms, nothing over a
second**. `OllamaModel.generate` awaits a streaming `fetch`: it is a socket read, and an awaiting
socket costs an event loop nothing. An inference worker would have added a process hop, a second
streaming transport and a new failure mode to fix a problem that does not exist, so it was not built.

### What moved

An analysis now runs in a forked child process. A process rather than a worker thread for three
reasons, the first decisive: a graph build peaked at **2,046 MB** on React, and a thread shares the
parent's heap — an analysis that exceeds the limit would take the API with it. A child can also be
given its own `--max-old-space-size`, and can be killed, which is the only way to stop synchronous
compiler work.

Measured the same way, with the worker genuinely active:

| | in process | in a worker |
|---|---|---|
| median | 4.9 ms | **2.9 ms** |
| p90 | 11.9 ms | **5.4 ms** |
| max | **30,000 ms** | **2,060 ms** |
| samples over 5 s | 7 | **0** |
| requests served | 192 in 240 s | **520 in 150 s** |
| React analysis wall-clock | ~4 min | **92 s** |

The analysis also got faster, which was not the goal: it no longer shares a heap or a thread with a
server.

### The banner lied, and the telemetry caught it

The composition root passed an executor, `startServer` did not forward it to `createApp`, and the
startup line printed "analysis: 1 worker, out of process" while every analysis ran inline. Nothing
failed. It was caught because `telemetry.worker`, `cpuMs` and `peakRssBytes` — figures only a worker
can produce — came back `null` on a job that claimed to have used one.

The first version of `/healthz` reported `inProcess: false` as a **constant**, written the same
afternoon. It now reports what the wiring actually is. A health endpoint that repeats an intention is
worse than none, because it launders a guess into a fact.

### Queueing, cancellation and retries

The registry refused a second submission because "a scan replaces the entire database, so two
concurrent analyses would race for one file". That was true of the *destination*, not the work. An
analysis is now handed a **staged database of its own** and the API adopts it by rename — atomic on
one filesystem — only if it succeeded. So two analyses cannot collide, and a second fault nobody had
named is gone too: an analysis that failed halfway had already overwritten a graph that was working.

Submissions queue instead of being refused, drawn by a bounded pool. Bounded because an analysis peaks
at 2 GB, so concurrency is a memory decision before it is a throughput one. Waiting is reported
(`telemetry.queueWaitMs`) rather than hidden. `cancelled` is a status distinct from `failed`, because
a UI that showed a user's own Stop as an error would be lying about their own action. Retries apply to
a closed list of three failures that are about the run rather than the repository.

Validated live: three repositories submitted at once — one `running`, two `queued` with real waits;
the third cancelled while waiting, settling as `cancelled` with `error: null`; `GET /overview`
answering in **2 ms** throughout.

### Not done

**The large-repository sweep did not happen.** Next.js, VS Code, Kubernetes, Angular and TensorFlow
were not analysed, and the eleven-repository end-to-end matrix was not run. What is validated is
React, Flask, Gin and spring-petclinic.

**Multi-repository serving does not exist.** The API still serves one graph. Analyses are concurrent
and isolated, but the read side has no repository parameter, so "chat about React while Flask
analyses" is only true until the second one is adopted. That is the next architectural step and it
touches every endpoint and the whole frontend.

**Adoption still blocks, for about two seconds.** Reopening a 339 MB graph and warming its
whole-repository results is synchronous CPU in the API. Splitting the warm into one capability per
event-loop turn cut the worst case from tens of seconds to 2.06 s, but `overview()` alone is 2.3 s and
cannot be subdivided from here. Every stall in the "after" column above is this.

**Nothing was persisted.** Job state is still in memory and does not survive a restart, and no
projection, prefix or summary cache was added.

## Context, Cache and Question-Awareness — the last AI infrastructure milestone

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,428 backend + 375 web** tests passing. Measured on `facebook/react` (7,280 files, 39,040
nodes) through the deployed stack.

The previous milestone ended by naming context acquisition as the bottleneck at three orders of
magnitude above projection. That turned out to be two separate problems wearing one number, and only
one of them was the one that had been reported.

### The reported figure was contended, and the real one was hiding behind it

"21–27 seconds cold" had been measured while a 7B model was saturating every core of the same
machine. Re-measured in isolation, stage by stage on React:

| stage | cold | heap |
|---|---|---|
| open the graph | 5 ms | — |
| `explorer.overview()` | **2,287 ms** | +319 MB |
| `explorer.hotspots()` | 502 ms | +4 MB |
| `explorer.cycles()` | 434 ms | — |
| `health.analyze()` | 631 ms | +34 MB |
| `context.build(repository)` — first | 3,990 ms | |
| `context.build(repository)` — **repeat** | **1,543 ms** | |
| `project()` | 3 ms | |

Two findings, and the second is the one that mattered. Cold acquisition is ~4 s, not 21 — the rest
was CPU contention with inference, which is a scheduling fact about a single-machine deployment
rather than a property of the code. And **every repeat cost 1,543 ms of recomputation**: the
`CachingGraph` memoises graph *reads*, so a second capability reading the same node is free, but the
*aggregation* over those reads ran again for every question asked.

### The smallest change was the one the docstrings had already promised

`RepositoryExplorer` says "an instance holds one immutable revision, so repeated calls return
identical results". That is a licence to memoise, and `CachingGraph` makes the identical argument one
layer down. The four argument-free whole-repository results — overview, architecture, cycles,
hotspots — and the health report are now computed at most once per open graph. Parameterised results
are deliberately untouched: caching an unbounded set of file and symbol views would be a memory leak
wearing a performance improvement.

| | before | after |
|---|---|---|
| repeat repository context | 1,543 ms | **0 ms** |
| package context on a warm holder | 445 ms | **6 ms** |
| second `GET /overview` | full recompute | **0.2 ms** |

Cold is unchanged by memoisation, so it was **moved instead of shrunk**: opening a graph now schedules
the whole-repository computation on the next event-loop turn. Somebody pays the four seconds; the
choice is between a user with a question and a process that has just finished a scan. Live, the first
`GET /overview` after a restart takes 5,982 ms and the next takes 1.1 ms.

### One prompt prefix, five different questions

The previous milestone observed that a repeat question reused 4,832 of 4,843 prompt tokens and
answered in 19 seconds against 108. This milestone makes that **intentional** rather than lucky.

A projection is now two passes. The **core** runs the extractors in declared order at reduced caps
against three fifths of the budget, and reads nothing about the question — so the rendered bytes
before the question are identical for every question about one repository at one tier. The
**supplement** then re-runs the same extractors at full caps, led by whatever the question is about,
and keeps what the core could not afford.

Measured on React, five different questions: **one distinct stable prefix**. The provider's own log
is the proof, and it is exact — `cached n_tokens` is what it did not have to evaluate again:

| question | prompt | reused | evaluated | eval time | first token | answer |
|---|---|---|---|---|---|---|
| cold | 4,646 | — | 4,646 | — | 5.1 s | 25.0 s |
| **repeat**, identical | 4,646 | 4,645 | **1** | 0.2 s | **0.5 s** | 11.8 s |
| **similar**, same intent | 4,643 | 4,569 | **74** | 8.7 s | 9.3 s | 26.6 s |
| **different**, technology | 5,019 | **2,909** | 2,110 | 89.7 s | 90.1 s | 140.1 s |
| **different**, hotspots | 3,785 | **2,908** | 877 | 30.8 s | 31.5 s | 47.9 s |

The two bottom rows are the ones that matter. They are entirely different questions producing
entirely different supplements, and the provider reused **2,908 and 2,909 tokens** — the same prefix,
to within the one token of rounding that separates two different tails. Without the split each would
have re-evaluated its whole prompt: 5,019 instead of 2,110, and 3,785 instead of 877. That is 58% and
77% of the prompt evaluation removed from a question the cache would previously have missed entirely.

Every one of the five answers came back `grounded`, with 2 to 11 citations and **zero** unsupported
terms; the two slow ones carried 8 and 3 heartbeats through the wait.

The two-pass split needed one non-obvious correction. Deduplication had been marking every fact an
extractor *offered*, so the core pass — which sees sixty technologies and can afford four — retired
the other fifty-six as "already said", and the supplement found nothing left anywhere. A fact a
budget could not afford has not been said; `seen` now records what was **emitted**.

### The question decides what is worth reading, and being wrong about it is cheap

`intentOf` classifies a question into `architecture`, `technology`, `hotspots`, `packages` or
`overview` by whole-word keyword match. Deterministic, because everything below `generate` is
reproducible and a sampling classifier would put a coin flip upstream of the evidence. Free, because
prompt evaluation runs at ~50 tokens per second and a second model call to decide what the first
should read would cost more than the saving.

**Safe when wrong**, which is what lets it be six lines instead of a model: an intent *reorders* the
supplement and never filters it, so every part remains reachable under every intent. A misclassified
question gets a differently-ordered supplement, never a missing repository.

### Compression, because a cap that keeps a hundred true things can still drop the useful ones

Capping was the previous milestone's fix and it bought coverage at the cost of shape. Four parts are
now summarised rather than truncated:

- **Languages** — ten `written-in` facts became one line in size order:
  `javascript (3964), markdown (1998), typescript (541), json (154), rust (120), …`
- **Regions** — React has 129 and Next.js 688. Grouped by `(language, depth)`, every region is
  accounted for in a count and the largest few are named:
  `90 javascript regions (1932 of 3006 files are source) analysed to semantic depth — compiler,
  compiler/packages/react-forgive, fixtures/art and 87 more`.
- **Dependencies** — grouped by the namespace their publisher gave them, read from the separator the
  ecosystem itself defines: `13 npm packages under @babel: @babel/code-frame, @babel/core, …`
- **Roles** — one line per role naming six members, rather than one line per declaration.

The result on React, at the same tier: **138 facts in 5,456 tokens** against 116 in 5,572 — and the
newly-affordable parts include 33 dependency facts, 15 environment variables and 11 routes, none of
which had ever reached a prompt before.

Compression created one grounding hazard and it had to be closed in the same change. A dependency
family renders every member's name and **no `ext:` identifier at all**, so the guard would have called
a model's `ext:npm:@babel/core` an invention for a package the facts plainly listed. Facts now declare
the identities they stand for without printing, and the last-segment form of every claimed name is
admitted too — `@babel/core` as `core`. Widening a permitted set can only make the guard more
permissive, never wrong, and the asymmetry is deliberate: an unflagged fabrication costs one sentence,
a false accusation costs a correct answer its credibility.

### Cost, end to end

| | previous milestone | this one |
|---|---|---|
| facts / fact tokens | 116 / 5,572 | **138 / 5,456** |
| prompt tokens | 4,844 | **4,646** |
| context acquire, repeat | 1,543 ms | **0 ms** |
| projection | 3–9 ms | 0.5–5 ms |
| distinct prompt prefixes across 5 questions | 5 | **1** |

### Not done

The new bottleneck is not in this layer. Prompt evaluation at ~50 tokens per second still dominates
every cold answer, and the API is single-threaded, so an in-process analysis blocks every other
request — `GET /overview` was measured timing out at 60 s while a scan and an inference ran together.
Both are deployment shape rather than AI-layer design.

## Production Integration & AI Quality — making the product reflect the engine

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,412 backend + 375 web** tests passing. Validated through the deployed stack, not through
the test suite.

The engine could already do multi-language analysis, technology detection, architecture extraction
and bounded incremental compilation. Ask TraceIQ exposed almost none of it. This milestone changed no
analyser and added no capability; every defect below was in the layer between the graph and the
answer.

### The diagnosis was wrong before it was measured

The reported symptom was "proxy timeout", and the proposed fix was a longer proxy timeout. Both were
wrong, and finding out cost one experiment each.

**Next's proxy is not the binding constraint.** Its default is `proxyTimeout: 30000` applied as
`proxyReq.setTimeout(30000, …)` — a socket *inactivity* timeout, not a total duration. A stream was
watched idle for **1,788 seconds** through it without being cut. What the proxy default does do is
sit below the real gap on any hop that enforces it, and every deployment adds hops this repository
cannot configure: nginx's 60-second `proxy_read_timeout`, a managed edge's idle limit. So the fix is
**heartbeat frames, with the timeout raised but kept finite** — an SSE comment every ten seconds
resets every idle timer in the chain at once, and a finite ceiling stays useful as the only signal
that distinguishes a slow API from a dead one. Ten seconds is under a third of the tightest timeout
in a realistic chain, so two heartbeats can be lost and the connection still survives.

**The real reason nothing arrived is that nothing was arriving.** Prompt evaluation on the reference
stack runs at **45.75 tokens per second**. A 4,087-token prompt is 89 seconds before the first token,
and the API put nothing on the wire for any of it.

### The largest defect was a number that disagreed with itself

`/api/show` reports the model's **trained** context length — 32,768 — and the projection was budgeted
against it. The daemon, given no `num_ctx`, chooses its own, resizes it between requests, and
discards the excess **from the front**. Measured live:

| prompt sent | `prompt_eval_count` | asked for the first fact id of N |
|---|---|---|
| 1,163 tokens | 1,745 | `[f1]` of 60 — correct |
| 6,043 tokens | 2,050 | `[f241]` of 300 |
| 24,811 tokens | 2,050 | `[f1148]` of 1,200 |

What is dropped from the front is the system prompt and the highest-priority facts — identity,
composition, limitations, every rule about citing. The model was answering from the tail of a list it
had been handed the wrong end of, and nothing anywhere reported it.

`num_ctx` is now sent on every request, equal to the window the provider advertises upward, which is
`min(trained, 16,384)`. The two numbers cannot disagree because they are one number. It is held
constant for the life of the model as well: changing it makes the daemon reload the weights, measured
at 106.8 seconds. Live proof from the daemon's own log: `n_ctx_slot = 16384 … task.n_tokens = 4846`,
`truncated = 0`.

### The projection spent its whole budget before reaching anything about the repository

`facebook/react` derives 141 technology regions, each a `region-depth` line of roughly forty tokens.
Composition alone asked for 5,600 of a 6,000-token budget, so the projection stopped there:

```
factCount: 66, tokens: 5450, omissions: [composition kept 59 of 141]
```

Not one package, architecture, hotspot or dependency fact was reached — **on any question**. "What
are the main packages?" was not answered badly; it was unanswerable, because no package fact existed.

Regions are now capped at twelve and ordered by source file count, and `packages`, `architecture`,
`hotspots` and `dependencies` are extractors of their own. Same question, same repository, after:

```
factCount: 112, tokens: 5434, omissions: [regions 12/129, packages 18/100,
                                          architecture 24/37, hotspots 10/120]
```

**73% more facts for 1% more tokens**, and the added ones are the ones the questions are about.

**Ordering by a number the engine already computed is not a ranking model, and the alternative was
worse.** React's 141 packages come back alphabetically; the first twelve are `.codesandbox/ci.json`,
`.editorconfig`, `.eslintignore` and `.git-blame-ignore-revs` — single non-source files. A cap of
eighteen off the front of that list answers "what are the main packages" with a dozen dotfiles.
Sorting by `declarations`, a field `PackageSummary` already carries, reads the number the Explorer
computed instead of discarding it. Every ordering names the field it sorts on, ties break on the
identifier, and the fact carries the number so a reader can check the ordering rather than trust it.

A second defect surfaced while splitting the extractors: **technologies were never projected for the
repository kind at all.** The repository branch returned from `identity` before reaching the
technology loop, so "what technologies are used" was answerable about a symbol and not about a
repository.

### Every dependency the model had ever been shown was a language builtin

React has 740 external nodes: **395 `builtin`, 11 `node`, 333 `npm`, 1 `outside-analysis`**. The
architecture view returns them identifier-ordered and capped at 100 — and `ext:builtin:` sorts before
`ext:npm:`. So the hundred externals that survived the cap were `AbortController`, `AbortSignal`,
`AnalyserNode`, `Animation`, and not one of React's 333 npm packages appeared in the architecture
view, in the context assembled from it, or in any answer built on it.

Two changes, because there were two faults. The Explorer now orders external listings
**dependency-first**, so the cap keeps the answer instead of dropping it — nothing is excluded and
`total` is unchanged, and the Architecture page gains the same fix. The projection then admits an
`ext:` identity only where the kind is an ecosystem and a name is present.

**The filter denies rather than allows, and that is the whole cross-language design.** Listing npm,
pip, Maven, Gradle, Go modules, Cargo, NuGet, Composer and Bundler means a tenth ecosystem silently
vanishes from every answer until somebody remembers this file. The things that are *not* packages —
a language's builtins, a language's standard library, the nameless sentinel — are a closed and
slow-moving set, so denying those admits every ecosystem including ones that do not exist yet. It is
applied centrally rather than in the dependency extractor, because a builtin also reaches a prompt
through a call edge and through a dependency closure. Measured after: **25 real npm packages, zero
non-ecosystem externals anywhere in the projection.**

### Grounding was extended, and its first version was wrong in the dangerous direction

Grounding stopped at identifiers, so "this repository depends on Express" was unfalsifiable while
`sym:src/a.ts#B` was not — and a model told a repository is JavaScript will volunteer plausible
dependencies. Package, framework, technology and dependency names are now a closed set too.

The first version reported a **correct** answer as ungrounded, flagging eight terms the facts plainly
carried: region paths printed inside a `built-with` clause, and the file path inside a `sym:`
identifier. A guard that is wrong about a right answer is worse than no guard. Facts now *declare*
the names they make claimable rather than having them parsed back out of rendered prose, and every
identifier contributes its path and declaration chain as well as itself. Candidates are restricted to
two shapes a model only writes when it means an artefact — a backtick span and a bare coordinate —
and a bare lowercase word is never adjudicated however it is quoted, because the cost of a false
accusation is higher than the cost of a missed one.

### Rules four thousand tokens ago are rules a small model has forgotten

Asked to explain React's architecture, the model returned 582 tokens of correct, specific prose with
**zero citations** — and markdown headings, which the same standing instruction forbids. The rules
had not been refused; they were 4,800 tokens away in a system message. Restating the one rule the
whole verification layer depends on immediately after the question costs about thirty tokens. Same
question after: `grounded`, four citations, plain prose.

### Validated through the product

`facebook/react`, cold prompt cache, through the browser's own proxy at `/api`:

| | before | after |
|---|---|---|
| facts / prompt tokens | 66 / 5,450 | 112 / 5,434 |
| package facts | 0 | 18 of 100 |
| architecture facts | 0 | 24 of 37 |
| hotspot facts | 0 | 10 of 120 |
| dependency facts | 0 | 25, all real npm |
| language builtins shown | up to 15 of 15 | 0 |
| heartbeats during the 102-second wait | 0 | **10** |
| verdict | `ungrounded`, 0 citations | **`grounded`, 4 citations** |
| falsely unsupported terms | 8 | 0 |

The answer itself, which before this milestone could not have been produced at all:

> The main packages in this repository include compiler/packages/babel-plugin-react-compiler, …
> flow-typed/environments has 9 files with 4053 declarations [f62], and packages/react-devtools-shared
> has 616 files with 3328 declarations [f63].

**Cost.** Projection is **6–9 ms** and is not worth optimising. Acquiring a repository context is
3.9 s warm and 21–27 s cold on React — three orders of magnitude more, and the thing to attack next.
Prompt evaluation dominates everything: 4,844 prompt tokens, 108 s to first token cold, 127 s to a
complete answer. Warm, the daemon reuses **4,832 of 4,843** prefix tokens and the same answer takes
35 s — which is why the fact block being *stable* matters as much as it being *small*.

### Not done

The 7B model still mis-attributes occasionally — it wrote a package name beside a region's file count
in one answer. The citation makes it checkable, which is the point of the layer, but it is not fixed.
Hotspot ranking surfaces test scaffolding on React (`expect`, `it`, `describe` are genuinely the most
referenced declarations), which is honest and unhelpful. Only two repositories were driven end to end
through chat in this pass; the remaining eight in the corpus were not re-validated after the change.

## Product Integration — one pipeline, reached from every surface

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,387 backend + 375 web** tests passing; ground truth 5 of 5 exact. Ten repositories
analysed through the HTTP API and the browser.

### The reported failure was not in the code

`POST /analysis` accepted `pallets/flask`, cloned and validated it, then failed the scan stage with
`unsupported-repository` — *"pallets/flask is not a TypeScript repository, so there is nothing for
TraceIQ to analyse."* Tracing the path found no such gate: `endpoints.ts handle()` →
`AnalysisRegistry.start()` → `#run` → `RepositoryAnalyzer.analyze` → `RepositoryPipeline.scan` →
`defaultAnalyzersFor(inventory)`, with the only mention of the string a comment recording its
removal three milestones earlier.

The proof of what was actually running:

```
docker exec traceiq-api-1 grep -r "is not a TypeScript repository" /app   # 1 hit, repository-analyzer.js
grep -r "is not a TypeScript repository" packages/                        # 0 hits
```

The images were built 2026-07-31, before any of the last three milestones existed. Every capability
was present in source and absent from the running product. **The deployed artefact is part of the
system; a milestone that ends without rebuilding it has not shipped.**

Rebuilding required dropping the `traceiq-graph` volume, which held a schema-v2 database the v3
build correctly refuses to misread. The `ollama-models` volume was kept — a 4.7 GB re-pull for no
reason. Chat's inability to name a repository's language had the same single cause: the stale AI
projection carried no `written-in` facts.

### What the audit found once the product was current

Every `RepositoryPipeline` consumer — CLI, API analysis, API graph-holder, bench — constructs the
same class; every analyser construction is inside `defaultAnalyzersFor`. No duplicated pipeline, no
registry bypass, no CLI-only or UI-only feature. One dead export (`COMPILER_ANALYZERS`, no caller,
misrepresenting the analyser set) removed. OpenAPI compared method-and-path against the source
`ENDPOINTS` table: 22 = 22, zero drift.

### Three real defects, each found by using the product rather than by reading it

**A grounded answer reported as unverifiable.** The chat page showed `unverifiable` beside a
paragraph that had plainly cited `[f8-f12]`. `CITATION_PATTERN` accepted `[f8]` and `[f8, f10]` and
not the range form, so an answer with five real citations was scored as having none. Ranges now
expand, bounded at 50 ids so a malformed `[f1-f9999]` cannot flood the list. The same question now
returns `grounded` with 6 citations.

**A Spring repository reported as having no framework.** Two components disagreed about how a
dependency is spelled: `fromPomXml` emits `org.springframework.boot:spring-boot-starter-web`, and
the rule listed the bare npm-style artifact. Matching now compares the artifact half of a
coordinate — never the group, so one vendor's namespace cannot stand in for its products. That
exposed a second half: spring-petclinic declares `spring-boot-starter-webmvc`, `-actuator`,
`-cache`, `-thymeleaf`, `-validation` and `-data-jpa`, and *none* of the two names the rule listed.
Spring publishes dozens of starters, so `DependencyRule` grew an optional `prefixes` field for a
technology distributed as a family. Evidence, from the live API: *"Spring Boot is used: build.gradle
declares 'spring-boot-starter-actuator', …"*.

The failure mattered because another surface already knew: the capability line said *"Java sources
were parsed and Spring or Jakarta annotations recognised"* on the same page that said no framework
was named. **Two surfaces disagreeing about one repository is worse than either answer alone.**

**The dialog's examples taught the wrong thing.** `facebook/react`, `openai/openai-node` and
`honojs/hono` — all TypeScript or JavaScript, in the one place a first-time visitor looks. Now one
per semantically-analysed language: React, Flask, spring-petclinic, Gin.

### Validated through the deployed product

Every stage OK, no `unsupported-repository`, each also opened in the browser:

| repository | files | depth | framework named |
|---|---|---|---|
| pallets/flask | 236 | framework | Flask ×3 regions, Redis |
| spring-projects/spring-petclinic | 131 | framework | Spring Boot, K8s, Compose |
| gin-gonic/gin | 130 | framework | Gin, Go modules |
| tiangolo/fastapi | 3,137 | framework | FastAPI |
| apache/commons-lang | 712 | semantic | — |
| kubernetes/client-go | 2,531 | semantic | — |
| vuejs/core | 704 | semantic | — |
| nestjs/nest | 2,128 | framework | NestJS |
| facebook/react | 7,280 | framework | Next.js, Jest, Rollup, Yarn, Cargo |

The Flask dashboard reads `LANGUAGE: Python`, `HTTP ROUTING: 134 routes`, `Analysis depth:
FRAMEWORK` and contains the word "TypeScript" zero times. spring-petclinic was started from the
dialog itself and navigated to a Java/FRAMEWORK dashboard naming Spring Boot. The failure path was
exercised too: a nonexistent repository renders the server's own `repository-not-found` code,
message and hint with later stages marked skipped — the dialog holds no error vocabulary of its own,
so a new code surfaces without a frontend change.

### Not done

Next.js still has not been validated through the API. Bounded compilation removed the memory
ceiling, but the wall-clock cost of 22,400 sources exceeds what an interactive validation pass can
wait for; it is a scheduling problem rather than an architectural one.

## Incremental & Bounded Analysis — removing the whole-program ceiling

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web`
clean; **2,377 backend + 375 web** tests passing; ground truth 5 of 5 exact.

The previous milestone ended with Next.js unanalysable: 22,400 sources exhausted a default heap and
had not finished at 12 GB. This one removes the reason.

### Measured first, and the first two measurements changed the design

**Where the memory goes.** Stage by stage on React, with a collection between each:

| stage | heap after | added |
|---|---|---|
| scanned (4,505 sources) | 25 MB | — |
| project loaded | 526 MB | **+501 MB** |
| IR built | 1,200 MB | +674 MB |
| resolved | 1,235 MB | +35 MB |
| call graph | 1,527 MB | +292 MB |
| disposed | 212 MB | **−1,315 MB** |

The compiler holds 1.3 GB of a 1.5 GB peak. Everything else is downstream of it.

**Whether regions actually partition anything.** They do, but not enough on their own:

| repository | sources | regions | largest region |
|---|---|---|---|
| react | 4,505 | 129 | 1,967 (43.7%) |
| zod | 409 | 8 | 287 (70.2%) |
| dash | 487 | 16 | 204 (41.9%) |
| **next.js** | **22,400** | **688** | **13,151 (58.7%), the root** |

Next.js's root region is 13,151 sources, of which **6,715 are under `test/e2e/app-dir`** —
hundreds of independent fixture applications that share no manifest and import nothing of each
other's. It is a leftovers bucket rather than a semantic unit, and compiling it as one program is
the ceiling.

**What a bounded program actually costs.** This is the measurement that mattered most, because it
contradicted the reasoning the old design rested on:

| program | roots | heap | time |
|---|---|---|---|
| whole repository | 4,505 | **501 MB** | 1,025 ms |
| largest region alone | 1,967 | **69 MB** | 227 ms |
| `packages/react-dom` | 224 | 97 MB | 213 ms |

Cost tracks the **type surface reached**, not the file count — a 224-file package costs more than a
1,967-file one — and a region reaches far less of it than a repository. Compiling all 113 of
React's units in turn: peak **501 MB → 209 MB**, total time **1,012 ms against 1,025 ms**, and 5 MB
resident afterwards.

### What was built

**A unit owns files; its program contains rather more.** The old docstring said running per region
would mean "no cross-region resolution at all". That was wrong, and the reason is that a unit's
roots are not its program: whatever those roots import — a sibling package through a path mapping,
a relative file in another region, a `.d.ts` under `node_modules` — TypeScript's own module
resolution pulls in. A frontend does not load the backend's symbols because nothing in the frontend
imports them.

**Two passes, because one was measurably wrong.** Resolving each unit against its own IR alone put
cross-unit targets outside the analysed set: on TraceIQ, opaque IMPORTS went **19 → 1,581** and
`CALLS internal` fell 61.2% → 56.1%. So every unit's IR is built first, one declaration index is
built over all of it, and every unit is then resolved against that. The index is plain data keyed by
source position, so the second pass needs nothing from the first — which is what lets each program
be released as soon as its IR exists. Accuracy came back exactly: opaque IMPORTS 19, internal 61.1%.

**Bounding is off below 8,000 sources, and that is the measurement's verdict rather than caution.**
A unit's program re-parses every shared dependency it reaches, so a source imported by thirty
packages is parsed thirty times. Measured on TraceIQ: building the IR took **1.8 s as one program
and 8.4 s across 32 units** — same files, 4.8× the work — while program construction was near-free
either way (118 ms against 219 ms). A repository that already analyses comfortably should not pay
for a ceiling it never reaches. React (4,505) stays on the single-program path; Next.js (22,400)
does not.

**A region above 4,000 roots is split by directory.** The one place accuracy can be affected: a
relative import crossing two parts of a split region is reported unresolved. It applies to no
repository in the corpus except Next.js, and the capability reason says so rather than letting an
absence read as a fact about the code. A single directory over the budget is returned oversized
rather than cut at an index — a program that is too big is a better failure than one that is wrong.

**Failure is per unit.** One program throwing used to abort the analyser and drop every region to
discovery depth together. A unit now costs its own files, the rest are analysed in full, and the
outcome reports the difference even though it succeeded.

**An unchanged repository is not analysed twice.** `revisions.source_hash` — reserved and unwritten
since the graph contract was drafted — now carries a fingerprint over every analysed source: path,
size and modification time, the same triple every build tool uses and cheap for the same reason.
Per unit as well as per repository, because reusing *part* of a graph is not sound yet and the
record of which units moved cannot be recovered afterwards.

**Thresholds are overridable** via `TRACEIQ_WHOLE_PROGRAM_LIMIT` and `TRACEIQ_FILE_BUDGET`. The
defaults suit an ordinary heap, which is the one thing a library cannot know: a build agent with
64 GB should compile far more at once than a container capped at 1 GB.

### Accuracy

Bounded and whole-program output is asserted **identical** by test, on a workspace whose packages
import each other — same IMPORTS edges, same CALLS edges, same declaration count, each file owned
exactly once.

| repository | IMPORTS | CALLS internal | opaque IMPORTS |
|---|---|---|---|
| traceiq | 100.0% → 100.0% | 61.2% → 61.1% | 19 → 19 |

### Scalability, validated

| repository | sources | plan | before | after |
|---|---|---|---|---|
| traceiq | 474 | 1 unit (whole program) | 5.4 s | unchanged |
| react | 4,505 | 1 unit (whole program) | 1.5 GB peak | unchanged |
| angular | 7,141 | 1 unit (whole program) | — | under the threshold |
| **vscode** | **12,220** | **101 units, largest 3,877** | would exceed a default heap | bounded |
| **next.js** | **22,400** | **~600 units** | **OOM at 4 GB, unfinished at 12 GB** | **ran under 2.4 GB** |

**Next.js no longer exhausts memory.** Watched through a 35-minute run, resident memory cycled
between **0.2 GB and 2.3 GB** as units loaded and released — against a previous run that died
outright. The ceiling is gone.

**It did not finish inside the session, and wall-clock is now the binding constraint rather than
memory.** That is a real result and worth stating plainly: bounding converted an impossible scan
into a slow one, and the next thing to fix is the 4.8× re-parsing cost below, not the memory.

### Known limitations

- **Bounded mode is 4.8× slower per file**, because shared dependencies are re-parsed per unit.
  That is the price of the ceiling and is only paid above the threshold. Sharing a parsed-file cache
  across programs would remove most of it; ts-morph exposes no `DocumentRegistry` hook, so it would
  mean constructing the compiler host directly.
- **Incremental reuse is all-or-nothing.** An unchanged repository is skipped entirely; a changed
  one is rebuilt entirely. Rebuilding a subset is unsound without invalidating every unit that
  resolves *into* a changed one, and that dependency record does not exist yet. The per-unit
  fingerprints are the input it will need.
- **The fingerprint misses an edit preserving both size and timestamp.** `force` exists for it.
- **A relative import crossing a split region is unresolved.** Only above the file budget.

## Repository Intelligence Platform — frameworks, architecture and the cross-language seam

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web` clean;
**2,355 backend + 375 web** tests passing; ground truth **5 of 5 cases exact**. Validated on fifteen
public repositories across six ecosystems and in a real browser.

### Three defects found by measuring, two of them serious

**67 of TraceIQ's own call edges were fabricated.** `CheckerBinder#identify` walks outwards from the
compiler's declaration to the IR's, because `const f = () => {}` resolves to the arrow while the IR
recorded the variable. The walk was unbounded, so any local the IR does not model bound to whichever
declaration enclosed it: `const [n, setN] = useState(0)` made `setN(…)` an edge from `App` to `App`.
**Every React component in this repository called itself** — 83 self-referential edges, all
checker-bound, none in the source. A parameter did the same without even a body to cross:
`function f(cb) { cb() }` bound `f → f`. The walk now stops at a function boundary; 16 self-calls
remain and every one is genuine recursion.

**A named import from an uninstalled package was reported as a failure.** The checker hands back a
symbol with no declaration sites, which is true of the symbol and misleading about the repository:
the module *did* resolve, to an external, and `import { useState } from 'react'` is a dependency on
react whichever binding it names. React carried **5,226** of these. Its IMPORTS bind rate went
**74.5% → 92.3%** (+4,596 resolved), zod's **73.0% → 97.3%**.

**One legal file name cost Next.js its entire scan.** `#` is the delimiter in `sym:<path>#<chain>`,
so `normalizeRepoPath` rejected any path containing one — and Next.js ships
`test/e2e/app-dir/resource-url-encoding/app/client#component.tsx`. The throw escaped the *file* node,
which `buildTolerantly` cannot retry past: it retries without an analyser, and there is no retrying
without files. All 22,554 sources failed over one file. Percent-encoded now, which is reversible and
safe for every existing parser — they split on the first literal `#`, and an encoded one has none.

### Technology detection, with evidence

A new package, `@traceiq/technology`. Forty-eight rules across six categories, and **no claim without
proof**: every detection names the files that establish it and what was found in each.

Three sources, all direct readings: a **declared dependency** (`"next": "^14"`), a **marker file**
(`docker-compose.yml`, `next.config.js`, `*.tf`), and a **manifest's own name**. That last one is
what makes a framework's own repository self-identifying — nestjs/nest does not depend on
`@nestjs/core`, it *is* `@nestjs/core`, and without the rule scanning it found every framework Nest
uses and not the one it is. Hono, Fastify and Vue behaved the same way.

**Kubernetes is the one detection that reads a file's contents**, and it has to: `.yaml` is the
extension of CI config, application config, Compose files and OpenAPI documents alike. A Kubernetes
document states `apiVersion` and `kind` at the top level and nothing else in common use states both.
Bounded to YAML candidates and the first two kilobytes of each.

Detection is **per region**, which is what makes it useful in a monorepo. TraceIQ describes itself as
Docker, Compose, GitHub Actions, pnpm and Vitest at the root; Express in `apps/api`; Next.js, React
and Vitest in `apps/web`; SQLite in `packages/graph`.

**The confidence field is `CERTAIN` for every rule, and that is a finding.** An earlier version rated
an extension match INFERRED, on the theory that a file type is weaker evidence than a marker file.
The first test written against it disproved the theory — `.tf` *is* Terraform, and the extension is
owned exclusively. INFERRED is documented as reserved for a rule that infers rather than reads.

### Architecture extraction

Each region is classified `application`, `service`, `library`, `infrastructure`, `tooling` or
`unknown`, from the technologies found in it, with the reason carried for a reader to check.

The priority order is not arbitrary. A frontend framework beats a backend one, because a Next.js app
that also serves API routes is still the thing a user opens. Infrastructure is checked only after
code has been ruled out, because almost every application region also carries a Dockerfile —
checking it first reclassified the whole repository. `unknown` is returned rather than avoided: a
region holding only documentation is none of the others, and calling it a library would invent a
fact.

### The cross-language seam

**`CONTINUES_TO`, and it needed no vocabulary change.** The relationship has been reserved and
unproduced since the contract was written, and "execution continues to" is exactly what an outbound
request to a locally-served endpoint does — the position `DEPENDS_ON` was in before the milestone
that gave it manifest-to-dependency.

Routes have been extracted for every supported language for two milestones and **nothing recorded who
called them**, so a repository whose React frontend talks to its Flask backend was two disconnected
graphs. `extractClientCalls` reads the other end: `fetch('/api/users')`, `api.get('/api/users')`,
`axios.post(…)`. Matching normalises both sides for what cannot be compared across languages — the
origin, the query string, a trailing slash, and the *name* of a path parameter, since Express writes
`:id`, Flask writes `<int:id>`, Spring writes `{id}` and a caller writes `42`.

Verified end to end on a purpose-built polyglot repository: a TypeScript React component's `fetch`
links to a Python Flask route, across two analysers that never meet. React's own repository produced
**50** such edges.

**Conservative by construction, and one of the guards was added because it was wrong first.**
`removeUser` stating `{ method: 'DELETE' }` linked to a GET endpoint, because the method is in the
options object where the callee shape cannot show it. Reading it turned a fabricated edge into no
edge. A template literal is skipped entirely; an absolute URL to another host is excluded rather than
stripped to its path, since sharing a path shape with a local route would assert the repository calls
itself.

### Surfacing

`Technology` is a node kind, not a capability row, and the distinction from a region is the reason: a
region describes the *analysis* and would pollute search results, while a technology describes the
*software* and a reader searching `next` should find it. It needed one nullable column,
`nodes.category` — schema version 3. Reusing `external_kind` was tried and reverted, because it is a
closed vocabulary of packaging systems and a consumer filtering `external_kind = 'npm'` must never
meet `'frontend'`.

Technologies reach search, the `/overview` payload, `RepositoryContext`, and a new `built-with` AI
predicate carrying the evidence — so a future answer can begin "a Next.js application talking to a
Flask service" rather than with a file count.

**The Overview names frameworks now.** The field's comment read "framework extraction reports these
outcomes; it does not name the framework", which was true and was a gap: a Spring Boot service was
shown as "HTTP routing (16 routes registered)" and the reader left to work it out. The rule the
comment stated still holds — nothing is inferred in the browser, every name and every reason comes
from the API.

### Regression

| repository | IMPORTS | CALLS | note |
|---|---|---|---|
| traceiq | 100.0% → 100.0% | 79.8% → 79.2% | +367 resolved on a larger source tree |
| react | 74.5% → **92.3%** | 49.8% → 48.6% | +4,596 imports; −1,858 fabricated calls; **14.4 s faster** |
| zod | 73.0% → **97.3%** | 73.5% → 73.3% | +566 imports |
| express | 98.2% → 98.2% | 24.2% → 23.9% | unchanged but for fabricated calls |
| flask, fastapi, petclinic, commons-lang, gin, client-go | unchanged | unchanged | byte-identical |

Ground truth held at **100% precision and recall on all five languages** throughout.

The CALLS movement is downward and is the point: those edges were not in the programs.

### Repository validation

Fifteen repositories. The ten from the previous corpus are unchanged or improved. Five new:

| repository | ecosystem | files | declarations | edges | self-detected |
|---|---|---|---|---|---|
| nestjs/nest | NestJS | 2,128 | 7,625 | 50,812 | **NestJS** |
| vuejs/core | Vue | 704 | 5,279 | 63,957 | **Vue** |
| honojs/hono | Hono | 477 | 2,894 | 21,248 | **Hono** |
| fastify/fastify | Fastify | 390 | 1,698 | 21,215 | **Fastify** |
| vercel/next.js | Next.js | 22,554 sources | — | — | **scale limit, below** |

### Known limitations

- **Next.js does not scan in a default Node heap.** 22,554 source files against React's 7,280; it
  needs `--max-old-space-size` well above the default and had not finished at the time of writing.
  The `#` defect above was found on the way there and is fixed; the memory ceiling is not, and it is
  a property of loading one whole-program TypeScript project rather than of anything added here.
- **Client calls are extracted for TypeScript and JavaScript only.** Python, Java and Go record no
  call arguments, so an outbound request in those languages has no literal path to read — a Python
  service calling another service is not linked.
- **A template-literal URL is not matched**, which is how most real client code builds a
  parameterised path. The seam finds fixed paths; `` `${base}/users/${id}` `` is skipped rather than
  guessed at.
- **Region classification does not read a manifest's `private` or `exports` fields**, which would
  separate a published library from an internal one.
- **`Technology` evidence is capped at twelve files per detection**, so a Vue application proves Vue
  with twelve components rather than four hundred.
- **Rust, C#, Kotlin, PHP, Ruby, Swift and Scala remain universal-discovery only**, by decision.

## Cross-Language Semantic Parity + Ground Truth

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web` clean;
**2,307 backend + 374 web** tests passing. All ten public repositories rescanned with zero analyser
failures, and every language validated in a real browser through the real API and the real Next app.

**The objective was not more languages.** It was making the five TraceIQ already supports answer the
same questions to the same depth — and, for the first time, being able to prove it.

### The finding that shaped the milestone

Measured before anything was written. The benchmark was run against all ten repositories and one
column decided the whole shape of the work:

| repository | language | `CALLS` reaching a named dependency |
|---|---|---|
| traceiq | TypeScript, dependencies installed | **12,851** |
| express | JavaScript | **0** |
| dash | polyglot | **0** |
| spring-petclinic | Java | **0** |
| commons-lang | Java | **0** |
| gin | Go | **0** |
| client-go | Go | **0** |
| flask | Python | **0** |
| fastapi | Python | **0** |

**Only one repository in the corpus could answer "which of my declarations use this dependency".**
Every other language dropped those calls into `unresolved`, and mostly under the wrong reason: gin
reported 4,082 `root-not-bound` for calls like `fmt.Println`, where the root is bound — to an import,
plainly, in the file's own header. The same rule was missing in the TypeScript path whenever the
checker could not help, which is every repository a user clones before running `npm install`.

**The fix is one rule shared by all five analysers.** A call rooted at a name the file imported from
outside the repository is a call into that dependency. The import statement is the evidence, the
external identity is the one the `IMPORTS` edge already mints, and the confidence is what each
language's own rules earn.

### Ground truth, which is the part that makes the rest checkable

Everything the benchmark measured before this milestone was a count of what the engine produced.
That distinguishes a scan that got bigger from one that got smaller and **cannot distinguish either
from one that is wrong** — a bind rate rises just as happily when calls start binding to the wrong
declarations.

`@traceiq/bench` now carries a ground-truth corpus: one small repository per language, hand-written
as translations of the same program, with **every** fact enumerated by reading the source. Precision
and recall are only meaningful against a complete expectation, which is why the cases are small on
purpose rather than pending expansion.

| case | precision | recall | facts | scan |
|---|---|---|---|---|
| typescript | **100.0%** | **100.0%** | 21 | 133 ms |
| javascript | **100.0%** | **100.0%** | 17 | 67 ms |
| python | **100.0%** | **100.0%** | 18 | 9 ms |
| java | **100.0%** | **100.0%** | 15 | 5 ms |
| go | **100.0%** | **100.0%** | 16 | 4 ms |

It earned its keep on the first run, at 85.7% / 94.7%. Four defects and three wrong expectations of
mine came out of it, and none of the four would have been visible in a bind rate:

- **Java's `this.save()` was `callee-not-addressable`.** `this` is a keyword rather than an
  identifier, so `leftmostIdentifier` returned null — for the call with the *most* determinable
  receiver in the language. The resolver had always had rules for `this` and `super`; nothing ever
  reached them.
- **Go's `inner := store.New()` gave `inner` no type.** The factory's result type was resolved in the
  *caller's* package. `func New() *Store` in package `store` writes `Store` unqualified because it is
  local there, and the caller's directory does not declare it.
- **`module.exports = { save, load }` published nothing.** The checker's symbol at a shorthand
  property is the property, not the local it reads. `getShorthandAssignmentValueSymbol` is the
  distinction, and TypeScript models it precisely because the two meanings differ.
- **`const path = require(\'node:path\'); path.join(…)` bound to nothing.** A CommonJS module binding
  is a variable *and* an import, and the variable was found first.

### Measured effect, on real repositories

| repository | language | CALLS bind rate | internal calls | → dependency |
|---|---|---|---|---|
| spring-petclinic | Java | 6.8% → **46.3%** | 106 → **226** | 0 → **498** |
| commons-lang | Java | 40.7% → **89.6%** | 34,106 → **40,196** | 0 → **34,938** |
| gin | Go | 21.2% → **64.7%** | 1,949 → **2,471** | 0 → **3,479** |
| client-go | Go | 31.6% → **52.7%** | 14,247 → **16,630** | 0 → **7,145** |
| flask | Python | 7.9% → **26.7%** | 312 → **334** | 0 → **723** |
| fastapi | Python | 9.2% → **28.2%** | 1,432 → **1,434** | 0 → **2,953** |
| express | JavaScript | 19.2% → **24.2%** | 2,249 → **2,271** | 0 → **571** |
| react | JS/TS | 45.0% → **49.8%** | 73,752 → **73,759** | 0 → **7,885** |
| zod | TypeScript | 50.2% → **73.5%** | 17,440 → 17,440 | 0 → **8,110** |
| dash | polyglot | 12.1% → **27.3%** | 5,151 → **5,159** | 0 → **6,444** |

The internal-call growth is the local-variable work; the dependency column is the shared external
rule. Both are visible in the browser: petclinic's Overview shows `maven 71 / stdlib 11`, gin's shows
`stdlib 45 / go 19`, flask's `stdlib 43 / python 27`.

### What each analyser gained

**Java.** Local variable type inference — declared type, `var x = new T()`, and a factory
`var x = T.make()` resolved through `make`'s declared return type. External calls through a local's
declared type, an imported type used statically, and a static import. `this.` and `super.` calls,
which had never bound at all.

**Go.** Local variable type inference — `var s T`, `s := T{}`, `s := &T{}`, and `s := New()` through
the function's first declared result, resolved in the *declaring* package. External calls through an
import alias, at `RESOLVED`, matching the confidence the internal package-qualified rule already
earned. **Route handlers are linked**, which the previous milestone recorded as a limitation: a bare
identifier argument is a package-level name and Go's package is a directory, so the lookup is exact.
gin reports 14 linked handlers and 194 honestly unlinked closures.

**Python.** Constructor inference: `store = Store()` in a function body gives `store.save()` a
target, resolved through the inheritance chain, and only when the callee is a *class* — a call to a
function keeps no entry, so `result.method()` stays honestly unbound. External calls through
`import requests` and `from flask import Flask` alike.

**JavaScript.** CommonJS exports, carried forward as a known limitation through two milestones.
`module.exports = X`, `module.exports = { a, b }`, `exports.x`, `module.exports.x`, aliased and
quoted keys, mixed CJS + ESM, and `module.exports = require(\'./x\')` as a star re-export. No new
`ExportKind` was needed: CommonJS states the same three things ES modules do. Express went from
**9 to 52** resolved exports, react from **10,526 to 10,896**. An exported function expression is now
a declaration, as its `export const` twin always was — express gained 28.

### Defects found by measuring, not by reading

- **`isExported()` is true without an `export` keyword in JavaScript.** TypeScript\'s binder marks
  `function Router() {}` exported when the file later writes `module.exports = Router`, so the IR
  recorded an export *named* `Router` for a module whose only export is the whole value. Suppressing
  every keyword-less inline export fixed it and cost React **189 correct edges**; the rule is now
  narrow — only a declaration the file assigns to `module.exports` wholesale.
- **Routing every CommonJS export through the checker lost 189 more.** The IR knows the link
  syntactically for a bare identifier and for a function expression it just recorded, which is
  exactly what `ExportIR.declarationId` means. Linking there and skipping the checker recovered all
  of them and added 370.
- **262 of React\'s config literals were reported as `no-symbol`.** `module.exports = { printWidth: 80 }`
  is a real export whose value is the number 80. Resolution did not fail; there is nothing
  addressable at the other end. A new reason, `value-is-not-a-declaration`, says so — a sibling of
  `type-parameter`, added for the same reason.
- **Flask\'s Overview said `LANGUAGE: Markdown`.** 85 markdown files against 83 Python ones, directly
  above a paragraph correctly calling it a Python project. The identity header now prefers a language
  some region reached `semantic` depth in, and falls back to file counts only when nothing was
  analysed. Found by opening the page — the same way the `TypeScript`-for-everything defect was.
- **"The TypeScript compiler read these sources"** was the capability reason a 141-file JavaScript
  repository got. True, and it reads as though the wrong analysis ran. It names the language now.

### TypeScript regression

| | baseline | now |
|---|---|---|
| IMPORTS bind rate | 100.0% | **100.0%** |
| `root-not-bound` | 64 | 67 |
| `callee-outside-analysis` | 6 | 8 |
| `callee-not-addressable` | 3 | 3 |
| `root-type-unknown` | 2 | 4 |
| `REFERENCES_TYPE type-parameter` | 56 | 56 |
| Internal call edges | 9,063 | **9,257** |
| External call edges | 12,851 | **13,139** |
| Scan time | 5,300 ms | 5,620 ms |

**Not identical input**: this milestone added 167 declarations to the repository being measured. The
three genuine unresolved reasons moved by 3, 2 and 2 — all attributable to the new source, all in
new files. Nothing bound differently. `opaque IMPORTS` moved 13 → 19, which is six more `bin/*.js`
launchers importing built output the scanner ignores by design.

zod, react and dash all *gained* on every relationship and lost on none.

### Repository validation

| repository | language | files | declarations | edges | calls | ext calls | routes | scan |
|---|---|---|---|---|---|---|---|---|
| facebook/react | TS/JS | 7,280 | 30,254 | 162,078 | 81,644 | 7,885 | 2 | 81.4 s |
| colinhacks/zod | TypeScript | 580 | 4,434 | 39,026 | 25,550 | 8,110 | 0 | 10.5 s |
| expressjs/express | JavaScript | 213 | 557 | 4,258 | 2,842 | 571 | 0 | 1.1 s |
| pallets/flask | Python | 236 | 1,833 | 4,120 | 1,057 | 723 | 310 | 0.2 s |
| fastapi/fastapi | Python | 3,137 | 8,382 | 18,314 | 4,387 | 2,953 | 1,305 | 1.1 s |
| spring-petclinic | Java | 131 | 310 | 1,840 | 724 | 498 | 17 | 0.1 s |
| apache/commons-lang | Java | 712 | 12,669 | 101,623 | 75,134 | 34,938 | 0 | 2.6 s |
| gin-gonic/gin | Go | 130 | 2,006 | 9,859 | 5,950 | 3,479 | 14 | 0.3 s |
| kubernetes/client-go | Go | 2,531 | 31,164 | 103,087 | 23,775 | 7,145 | 0 | 6.1 s |
| plotly/dash | polyglot | 1,230 | 8,490 | 28,284 | 11,603 | 6,444 | 3 | 5.2 s |

Zero analyser failures. Scan time is within noise of the baseline everywhere except react (+8.5 s on
73 s, for 7,892 more call edges and 370 more exports) and gin, which got *faster*.

### Browser validation

Verified in Chrome against Java, Go, Python and JavaScript graphs, each served through the real API
into the real production Next build. Every page renders, with **no console errors** on any of them:

- **petclinic** — "Java monorepo", `LANGUAGE: Java`, 16 routes, 71 packages, `maven 71 / stdlib 11`,
  the Java analyser\'s own capability reason, `CALLS 724` where the baseline showed 106, a real
  package dependency graph on Architecture with 25 packages and one edge.
- **gin** — "Go monorepo", 112 routes, `HANDLED_BY 14`, `stdlib 45 / go 19`.
- **flask** — "polyglot monorepo (Python and HTML)", `LANGUAGE: Python` after the fix, 134 routes,
  four regions each carrying the Python analyser\'s reason, `stdlib 43 / python 27`.
- **express** — "JavaScript monorepo", `npm 42 / node 11`, and the capability reason now naming
  JavaScript.

### Product consistency

Audited by hitting every published read endpoint against five graphs, one per language. Overview,
Architecture, Explorer, Health, Search, Routes, Cycles, Hotspots, Symbol, Impact, Dependencies and
File all answered `200` with content for all five. Impact reports `externalDependencies` for Python
and Java now, where it reported zero before, and each language gets its own limitation set.

### Known limitations

- **Java\'s remaining 517 `root-type-unknown` in petclinic** are chained expressions and lambda
  parameters. A local whose type is written down binds; one whose type Java infers from a stream
  pipeline does not.
- **Go\'s route handlers are linked only for a bare identifier.** A closure names nothing, and a
  method value `h.List` needs the receiver\'s type. gin\'s 194 unlinked handlers are almost all
  closures in its own tests, and each is recorded with its text rather than dropped.
- **A Go inline handler\'s text is the whole function literal**, newlines included, and it reaches the
  unresolved reference\'s identity string. The TypeScript route extractor has always behaved this way
  for an inline arrow; it is more visible in Go because Go registers imperatively.
- **`REFERENCES_TYPE no-declaration` dominates Go\'s unresolved references** — 1,190 in gin, 15,320 in
  client-go. These are builtins (`string`, `error`, `int`) and type parameters, which are correctly
  not declarations, but they share a reason with a genuine miss. The same split
  `value-is-not-a-declaration` just made for exports is available here and was not taken.
- **Python\'s constructor inference is first-assignment-wins.** A local rebound to a different class
  later in the same function keeps the first type.
- **No analyser resolves an interface call to its implementations.** Java\'s sole-implementor case is
  statically decidable within analysed source and was deliberately not implemented: a dependency may
  implement the interface too, and the edge would be a guess wearing a proof\'s clothing.
- **Kotlin, Rust, C, C++, C#, PHP, Ruby, Swift and Scala remain universal-discovery only.**
- **The ground-truth corpus is five small repositories.** It proves the rules are right on the shapes
  it covers and says nothing about the shapes it does not.

## Universal Foundation + Java + Go

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web`, `pnpm build:web` clean;
**2,270 backend + 372 web** tests passing. Java and Go validated against real public repositories and in a
real browser.

### Architecture before and after

| | before | after |
|---|---|---|
| Dependency ecosystems the graph could name | `npm` | every value in `ECOSYSTEMS`, shared from `@traceiq/types` |
| External origins | `package`, `node-builtin`, `typescript-lib` | `package`, `standard-library`, `language-builtin` |
| Framework field | `'express' \| null` | a free name the recognising analyser supplies |
| tree-sitter host | one copy inside `@traceiq/python` | `@traceiq/tree-sitter`, shared by three analysers |
| Analysers | TypeScript/JavaScript, Python | + Java, + Go |
| Languages reaching `semantic` or better | 3 | **5** |

**Adding an analyser now touches no infrastructure.** Java and Go were built against the existing
`LanguageAnalyzer` contract and integrate with Explorer, Impact, Architecture, Search, Health, Query, Ask
TraceIQ and the browser UI without one line of analyser-specific code in any of them.

### Root causes fixed

- **A Python, Java or Go import could not become an external node at all.** `EXTERNAL_ID_KINDS` was
  `npm | node | builtin | outside-analysis`, so there was no identity for a Maven coordinate or a Go
  module path to take and the reference was dropped. A reader saw the dependencies a manifest *declared*
  and never the ones a file actually *used*. The ecosystem now comes from the resolution; flask went from
  **0 to 70** external nodes, dash from **0 to 218**.
- **`node-builtin` and `typescript-lib` could not describe another language.** Python's `os`, Java's
  `java.util` and Go's `net/http` are the same kind of thing as Node's `fs`, and none is a Node builtin.
  Renamed to `standard-library` and `language-builtin`; `ext:node:*` identities are unchanged.
- **`FrameworkAnnotations.framework` was typed `'express' | null`.** Every framework after Express would
  have widened a shared type. It is a free name now — a label for a reader, never a key anything branches on.
- **Three UI surfaces hardcoded TypeScript, and only the browser found two of them.** The Overview profile
  said `languages: ['TypeScript']`; the identity header derived `Language: TypeScript` and
  `Framework: Express` from constants; the chip row led with `TypeScript` and counted only npm packages.
  The suite was green through all three. A Spring Boot repository introduced itself as a TypeScript/Express
  project above a paragraph correctly calling it a Java monorepo. Now derived from `capabilities`, with a
  new `repository-identity.test.ts` that changes the input.
- **A Java enum implementing an interface failed the whole scan.** `IMPLEMENTS` sourced only at `Class`,
  which is true of TypeScript enums and false of Java's. Apache Commons Lang lost all 12,669 declarations
  to one `enum ComparableComparator implements Comparator`.
- **An `@interface` was labelled a class.** A Java annotation type *is* an interface, and a type may
  implement it — so `class X implements Tag` produced IMPLEMENTS onto a Class and the graph rejected it.
- **A supertype's generic arguments were recorded as supertypes.** `implements Formatter<PetType>` said the
  class implemented `PetType`. Spring PetClinic lost its entire Java analysis to it. The arguments are type
  *references*, and are recorded as those.
- **Duplicate role rows failed the write.** `@Service` beside `@Component` both mean "service", and the
  store's primary key rejected the second. Deduped where identity is decided, as nodes, edges and
  unresolved references already were.

Every one of these was found by scanning a real repository, and every one degraded rather than crashing
once `buildTolerantly` was in place — the isolation built in the previous milestone earned itself here.

### Java

Packages, imports (single-type, wildcard, static, static-wildcard), classes, interfaces, enums, records,
annotation types, methods, constructors, fields, enum constants, nested and inner types, inheritance and
implementation, static members, generics including arguments inside supertypes, method calls, construction,
`super`/`this` delegation, Maven and Gradle manifests, Spring stereotype roles, Spring and Jakarta routes
with class-path composition, JUnit test roles.

**Confidence discipline.** A type resolved through an explicit import is `RESOLVED`; every call edge is
`INFERRED`, because Java dispatches on the runtime type and a field declared as an interface may hold any
implementation. No jar is opened, so a dependency's type is a *name* — recorded as an external named after
its package rather than a resolved declaration.

### Go

Packages, imports with aliases and blank imports, functions, methods attributed to their receiver's type,
structs, interfaces, embedded types with method promotion, constants, variables, generics, `go.mod` module
paths, `go.work` workspace layouts, Gin, Echo, Fiber and `net/http` route registration, `_test.go` files.

**Go reaches `RESOLVED` where the others cannot**, and the reason is Go's own design: an import path is the
module path plus a directory, with no search path to guess at. So imports, bare calls and
package-qualified calls are proven; a call through an interface value or on a local whose type Go infers
stays inferred or unbound. The standard library needs no list — a module path must contain a dot in its
first segment, which is a rule rather than an enumeration.

### Repository validation

| repository | language | files | declarations | edges | calls | routes | ext pkgs | depth | scan |
|---|---|---|---|---|---|---|---|---|---|
| facebook/react | TypeScript/JS | 7,280 | 30,254 | 153,796 | 73,752 | 11 | 323 | framework | 78.9 s |
| colinhacks/zod | TypeScript | 580 | 4,434 | 30,916 | 17,440 | 0 | 42 | semantic | 10.7 s |
| expressjs/express | JavaScript | 213 | 529 | 3,594 | 2,249 | 0 | 42 | semantic | 1.3 s |
| pallets/flask | Python | 236 | 1,833 | 3,375 | 312 | 134 | 27 | framework | 0.2 s |
| fastapi/fastapi | Python | 3,137 | 8,382 | 15,359 | 1,432 | 598 | 40 | framework | 1.2 s |
| spring-petclinic | Java | 131 | 310 | 1,222 | 106 | 16 | 69 | framework | 0.1 s |
| apache/commons-lang | Java | 712 | 12,669 | 60,595 | 34,106 | 0 | 17 | semantic | 2.3 s |
| gin-gonic/gin | Go | 130 | 2,006 | 5,844 | 1,949 | 111 | 19 | framework | 0.6 s |
| kubernetes/client-go | Go | 2,531 | 31,164 | 93,559 | 14,247 | 4 | 150 | framework | 6.3 s |
| plotly/dash | polyglot | 1,230 | 8,490 | 21,810 | 5,151 | 3 | 129 | framework | 4.5 s |

`ext pkgs` counts dependency-ecosystem externals only; standard-library externals are counted separately
(flask 70 external nodes in total, of which 27 are packages and 43 standard-library modules).

Zero analyser failures across all ten.

### TypeScript regression

| | previous milestone | now |
|---|---|---|
| IMPORTS bind rate | 100.0% | **100.0%** |
| `root-not-bound` / `callee-not-addressable` / `root-type-unknown` | 64 / 3 / 2 | **64 / 3 / 2** |
| Internal call edges | 8,575 | 9,025 |
| Opaque IMPORTS | 13 | 13 |

The three genuine unresolved reasons are byte-identical. Growth in the absolute counts is this milestone's
own new source files being scanned.

### Browser validation

Verified in Chrome against a Spring Boot graph and a Gin graph served through the real API and the real
Next app. Both render the same Overview as TypeScript — correct language, correct route count, correct
package counts, per-region analysis depth — with **no console errors or warnings**. Screenshots taken
before and after the three hardcoded-TypeScript fixes.

### Known limitations

- **Java has no classpath**, so a dependency's type is a package name rather than a resolved declaration,
  and a call on a local's inferred type is unbound. `root-type-unknown` dominates petclinic's unresolved
  calls for exactly this reason.
- **Go does not link a route to its handler.** `r.GET("/users", listUsers)` names the handler in an
  argument position, and binding it is resolver work this reader does not do. Routes exist; `HANDLED_BY`
  does not.
- **Java route paths are not property-substituted.** `@GetMapping("${api.base}/x")` is recorded as written.
- **Kotlin, Rust, C, C++, C#, PHP, Ruby, Swift and Scala remain universal-discovery only.**
- **CommonJS `module.exports` is still not extracted** — carried forward.
- **ts-morph throws on a non-literal module specifier**, from both `getModuleSpecifierValue` and
  `getModuleSpecifierSourceFile`. Guarded in one place now, but it is the third distinct ts-morph throw
  this project has had to catch — the compiler API is not total, and any new call into it needs the same
  treatment. React cost 30,254 declarations to this one before the guard.
- A Go package-level import edge anchors on the package's first exported declaration, chosen
  deterministically, because a package is a directory and a directory is not a node.

## Product Consistency — real-repository multi-language validation

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web` clean; **2,203 backend +
365 web** tests passing. Validated by scanning **seven real public repositories**, not fixtures.

### What was wrong

Measured, not assumed. Seven public repositories were cloned and scanned through the real pipeline.
**Four of the seven failed the scan outright** and a fifth silently lost its analysis:

| Repository | Before |
|---|---|
| pallets/flask | `GraphConstraintError: two nodes share sym:src/flask/cli.py#locate_app` |
| fastapi/fastapi | `InvalidNodeIdError: route path "{$callback_url}/invoices/…" must start with "/"` |
| plotly/dash | `InvalidNodeIdError: route path "POST" must start with "/"` |
| colinhacks/zod | `GraphConstraintError: DECLARES may not be sourced at a TypeAlias` |
| axios/axios | scanned, but the TypeScript analyser crashed — 209 JS + 27 TS files, **0 declarations** |
| expressjs/express | scanned, but **0 IMPORTS edges** across 141 CommonJS files |

Every one of these is a repository a user would plausibly point TraceIQ at first.

### Root causes

- **Python duplicate identifiers.** `@t.overload` declares one name three times. The extractor emitted a
  declaration per syntactic site, so three nodes claimed one identifier. The TypeScript IR had solved
  this years of milestones ago with `DeclarationCollector`; Python was not using it. Now it is, and the
  collector is exported so every future analyser folds sites the same way.
- **A route path that cannot be addressed failed the whole scan.** FastAPI's OpenAPI callbacks register
  `"{$callback_url}/invoices/{$request.body.id}"` — a real endpoint whose path is deliberately not
  absolute. The environment-variable path in the same file already caught `InvalidNodeIdError` and
  recorded the reference as unresolved; routes simply had no such guard.
- **A keyword tuple read as a route path.** `@hooks.route(methods=("POST",))` has no positional path,
  and the extractor took the first quoted string *anywhere* in the decorator — yielding `"POST"`.
  Anchored to the call's own opening parenthesis; a route by keyword now yields nothing rather than
  something wrong.
- **A merged type alias and namespace.** zod declares `type StandardSchemaV1` beside
  `declare namespace StandardSchemaV1`. Folding took the first kind in source order, so the namespace's
  members were parented to a `TypeAlias`, which cannot declare anything. A site that *can* contain
  declarations now wins the merge.
- **`REFERENCES_TYPE` refused a merged value/type symbol.** `type BENCH` beside `const BENCH: BENCH` is
  one node wearing both meanings, because an identifier is a symbol path with no room to say which
  space it belongs to. `EXTENDS` and `IMPLEMENTS` already admitted `Function` and `Variable` for exactly
  this reason; this row had just never met the case.
- **A checker crash cost a repository its analysis.** TypeScript's own `getImmediateAliasedSymbol`
  throws `Cannot read properties of undefined (reading 'flags')` on an alias it cannot follow — reachable
  from ordinary published JavaScript, in axios and in dash. Every checker call in the Resolver now goes
  through `symbolAt`, and a fault is reported under its own reason, `checker-failed`, so it is never
  confused with the checker answering "nothing here".
- **CommonJS was invisible.** `extractImports` read `getImportDeclarations()` — ES syntax only — so a
  `require` produced nothing, and resolution walked the syntax tree by the same rule.
- **`allowJs` was never enabled.** `applyJavaScriptSupport` returned early on
  `options.allowJs !== undefined`, but `DEFAULT_COMPILER_OPTIONS` sets `allowJs: false`, so the value was
  *always* defined and the function always returned immediately. JavaScript was only ever read when a
  repository's own tsconfig said so. Declarations still appeared, because those come from the syntax
  tree; module resolution did not, because it will not consider a `.js` extension without `allowJs`.

### Measured effect

| | before | after |
|---|---|---|
| Public repositories scanning at all | **3 of 7** | **7 of 7**, zero analyser failures |
| express — IMPORTS bind rate | 58.8% | **98.2%** |
| express — IMPORTS reaching a file in the repository | **0** | **300** |
| express — External nodes | 0 | 53 |
| axios — declarations | **0** | 1,756 |
| dash — declarations | 0 (TS analyser crashed) | 3,587 from TS/JS, 8,490 total |
| flask / fastapi / dash / zod | **failed** | 236 / 3,137 / 1,230 / 580 files |

### TypeScript regression

Measured on TraceIQ itself, and the movement was attributed rather than assumed: the CommonJS work was
temporarily disabled and the benchmark re-run, which changed **2 call edges and nothing else**.

| | baseline (538 files) | now (560 files) |
|---|---|---|
| IMPORTS bind rate | 100.0% | **100.0%** |
| Internal call edges | 8,101 | **8,575** |
| External dependency call edges | 11,590 | **12,437** |
| Calls reaching an internal declaration | 64.8% | 63.9% |
| `root-not-bound` / `callee-not-addressable` / `root-type-unknown` | 60 / 3 / 1 | 64 / 3 / 2 |
| Scan time | 4.70 s | 5.55 s |

**Not identical input** — the tree carries 22 files the baseline did not. The 13 new opaque IMPORTS were
traced individually: all are `bin/*.js` launchers importing `../dist/*.js`, build output the scanner
ignores by design. They were `module-not-resolved` before only because `allowJs` was off; resolving to
ignored output is the more accurate answer.

### Consistency, where the evidence was already there

- **Search reached no `Dependency` or `Manifest` node.** For a region with no semantic analyser those are
  the *only* dependency evidence in the graph, so a Python user searching `fastapi` was told nothing
  matched while the graph held a node of that name. Both kinds are now searchable; flask answers
  `click` with 4 dependencies.
- **Ask TraceIQ carried no language, region or depth facts at all.** It could not answer "what is this
  written in" about *any* repository, and had no way to say that a Go worker's absence of callers was
  never measured rather than measured and empty. `RepositoryContext` now carries `capabilities` for
  every context kind, and the projection emits `written-in`, `is-polyglot`, `analysis-depth` and one
  `region-depth` fact per region. dash grounds 16 regions across three languages.
- **The web UI said every repository was TypeScript.** `repository-profile.ts` hardcoded
  `languages: ['TypeScript']` with the evidence "the analysis reads TypeScript projects only" — true when
  written, false since discovery became universal. A Flask repository was described to the reader, on the
  first page they see, as a TypeScript project. Languages and shape now come from `capabilities`, and the
  Overview shows analysis depth per region with the API's own reason for it.
- **The analysis/import flow reported no language or depth**, so a Python service showed its declarations
  beside zero routes and zero packages with nothing saying what it was written in.

### Capability honesty

Depth reasons were fixed sentences: the TypeScript analyser claimed "declarations, imports, calls and
types are resolved" for every region it covered, whatever it found. Express's region said imports were
resolved while the graph held none. Reasons are now derived from the evidence actually produced, and
name what is absent as well as what is present — with an `omit` list so an analyser's own gaps are not
reported as the repository's (Python has no export statement; saying "no exports were found" would blame
the source).

The same fixed sentence appeared a second time, in the framework-to-semantic downgrade branch, where it
overwrote the analyser's reason for **8 of dash's 16 regions**. The downgrade is now appended to the
analyser's own reason rather than replacing it.

### Failure isolation

`runAnalyzers` already caught an analyser that *throws*. An analyser that returns facts the graph
refuses was still fatal to the entire scan — including the universal layer no analyser produced.
`buildTolerantly` now retries: everything, then dropping one contributing analyser at a time, then
discovery alone. A dropped analyser becomes a `rejected` outcome, so its regions fall back to
`universal` depth with the rejection as the reason rather than keeping a depth whose evidence was
discarded. Three tests cover it with an analyser that returns a duplicate identifier.

### Performance

Per-stage timings, which is what decides whether the flagged Python scaling risks are worth acting on:

| repository | files | regions | analyse | capability assessment |
|---|---|---|---|---|
| flask | 236 | 4 | 211 ms | 0.2 ms |
| fastapi | 3,137 | 1 | 1,431 ms | 0.7 ms |
| dash | 1,230 | 16 | 8,557 ms | 12.3 ms |
| zod | 580 | 8 | 22,800 ms | 2.5 ms |
| TraceIQ | 560 | 28 | 12,008 ms | 20.9 ms |

The deepest-region lookup is visibly O(regions² × files) — TraceIQ's 28 regions cost more than dash's 16
over twice the files — but at 0.17% of the scan **the measurement does not justify changing it**, and it
has not been changed. `ownerIdOf`'s declaration scan is likewise invisible next to parsing. The one
quadratic path that *was* replaced, `isClassChain`'s scan over every declaration so far, was replaced as
part of the duplicate-identifier fix rather than speculatively.

### Known limitations

- **CommonJS `module.exports` is not extracted.** Imports were the structural half — they carry the
  dependency graph, Impact traversal and Architecture — and are done. Express therefore reports 9 EXPORTS
  (its ES ones) and its region honestly says no exports were found, which understates the source.
- **Python third-party imports produce no `External` node**, only the `Dependency` the manifest declares.
  So Impact reports `externalDependencies: 0` for a Python declaration where a JavaScript one reports 19.
  The evidence exists — `import fastapi` names it — but `EXTERNAL_ID_KINDS` is npm-shaped (`npm`, `node`,
  `builtin`, `outside-analysis`) with no `pypi`, and widening a closed vocabulary is a schema decision.
- **`externalPackages` counts only `externalKind === 'npm'`** in the scan summary and in Health, so a
  non-npm ecosystem reads as zero.
- **A region's primary language is its most common one by file count**, so flask's `examples/javascript`
  is reported as an HTML region whose reason describes Python analysis. Both statements are true; together
  they read oddly.
- **`DEFAULT_ANALYZERS` is a stale export** that omits Python while its comment calls it the default. No
  caller uses it.
- A small local model (`qwen2.5:7b-instruct`) often answers the composition question correctly while
  omitting `[fN]` markers, so the guard reports `unverifiable` — correctly, there being nothing to check
  against. Same question, same facts, `grounded` with 8 citations on express.

## Polyglot Repository Foundation — universal discovery and capabilities

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web` clean; **2,133 backend +
363 web** tests passing. All seven mandated repository shapes verified by test.

### What was wrong

Measured, not assumed. Four of five non-TypeScript fixtures were rejected outright — `ProjectHost` threw
when `inventory.language !== 'typescript'`, and `RepositoryAnalyzer` string-matched that message into
`unsupported-repository`.

**The polyglot case was worse: it "succeeded".** A repository of 21 files across TypeScript, Java, Python,
Go, Terraform and Compose produced a graph of **1 file, 1 declaration, 2 nodes** — only
`frontend/src/app.tsx` — and Overview then reported "files 1". Misleading success is worse than the honest
rejection the other cases gave. The cause was one line: the scanner globbed `**/*.{ts,tsx,mts,cts}`, so no
other file was ever discovered.

### What was built

**Discovery became universal; analysis stayed layered.** The scanner now finds every file and classifies
each by language (extension) and role (source, test, documentation, configuration, manifest, build,
infrastructure). It reads manifests for nine ecosystems and derives **technology regions** anchored on
dependency manifests — the one signal available without parsing that marks where a project begins.

**TypeScript became an enrichment stage.** `enrichWithTypeScript` is the whole boundary: compiler host, IR,
resolver, call graph and framework extractor sit behind it, and it returns `null` when there is no
TypeScript. A future Python analyser becomes a sibling of that function. Nothing above it changes shape.

**No new relationship types.** The frozen vocabulary already sufficed: `DEPENDS_ON` was reserved and unused,
and now carries manifest to declared dependency. Only node kinds were added — `Manifest` and `Dependency` —
which the schema explicitly permits (`nodes.kind` is an open vocabulary by design).

**A capability model, in the graph.** `getCapabilities()` reports per-region depth: `universal`,
`structural`, `semantic`, `framework`. Depth records **what ran**, not what the graph happens to contain,
because only the pipeline knows a region's calls were never looked at rather than looked at and absent.
Regions live in tables, not as nodes: a region describes the analysis, not the code, and making it a node
would surface it in search results.

### TypeScript regression

| | before | after |
|---|---|---|
| IMPORTS bind rate | 100.0% | **100.0%** |
| Opaque IMPORTS | 0 | **0** |
| Internal call edges | 8,024 | **8,101** |
| External dependency call edges | 11,564 | **11,590** |
| Calls reaching an internal declaration | 65.6% | 64.8% |
| `root-not-bound` / `callee-not-addressable` / `root-type-unknown` | 60 / 3 / 1 | **60 / 3 / 1** |
| Scan time | 4.40 s | 4.70 s |

**The comparison is not on identical input** — this milestone added 21 TypeScript files to the repository
being measured, so the ratios move even with the engine unchanged. The regression evidence is the last row:
the three *genuine* unresolved-call reasons are identical at 60 / 3 / 1. The only growth is
`callee-is-language-builtin` (4,141 to 4,335), which is new string-handling code calling `split`, `replace`
and `startsWith` — correctly excluded from the graph, and correctly sitting in the denominator.

### Fixture results

| Case | Before | After |
|---|---|---|
| TraceIQ (TS monorepo) | 402 files, semantic | 538 files, 26 regions, depth `semantic` |
| JavaScript | **rejected** | 3 files, 1 manifest, 1 dependency, depth `universal` |
| Python | **rejected** | 4 files, 2 dependencies from `pyproject.toml`, depth `universal` |
| Java | **rejected** | 3 files, Maven manifest, depth `universal` |
| Polyglot | **1 file, "success"** | 11 files, **5 regions**, 4 manifests, `isPolyglot` |
| Docs/config | **rejected** | 4 files, no primary language, depth `universal` |
| Empty | rejected | rejected — `empty-repository`, "contains no files" |

### Defects found by testing

- **Rescans were not idempotent.** Universal discovery found the graph database a previous scan had written.
  Fixed twice over: `.traceiq/` is ignored, and the pipeline passes the database path to the scanner as
  `excludeFiles` so files, languages *and* regions all agree.
- **`[tool.poetry.dependencies]` was read as a requirements list**, because the TOML probe required `]`
  immediately after `tool.poetry`. It reported `python` and `line-length` as dependencies.
- **`uvicorn[standard]` truncated a PEP 621 dependency array**, because a non-greedy `]` match stopped at
  the bracket inside the requirement. Replaced with depth counting.

### Known limitations

- **No `Directory` nodes.** Structure is carried by file paths and regions, which is what Explorer already
  groups by. A node per directory would add hundreds of nodes for no question it can answer.
- **Language and role are conventions, not proofs.** A repository with sources in `test/` is described
  wrongly. Both are `INFERRED` with the rule that fired named in the provenance.
- **Framework depth is repository-wide.** The Framework Extractor reports per repository, so `framework` is
  claimed for a TypeScript region only when routes were found anywhere; a monorepo with routes in one
  package over-claims for its siblings.
- **`.csproj` dependencies are not read** — they are XML attributes, and the Maven reader would miss them.
  The manifest is still reported present.
- **Region depth follows the primary language**, so a Python service holding one `.ts` script is `universal`
  even though that file was compiled. Deliberate: the opposite error is worse.
- **Downstream is capability-aware, not capability-driven.** Overview carries `capabilities` and Impact
  reports `region-has-no-semantic-analysis`, but no UI was changed — as instructed.

## Analysis Quality — workspace resolution and compiler-backed calls

**Status:** complete. `pnpm build`, `pnpm typecheck:tests`, `pnpm typecheck:web` clean; **2,038 backend +
363 web** tests passing. Every number below is measured by `@traceiq/bench` scanning TraceIQ itself.

### Measured effect

| | before | after |
|---|---|---|
| **Calls reaching a declaration in this repository** | **20.6%** | **65.6%** |
| Internal call edges | 4,753 | 8,024 |
| Call edges onto a named dependency | 0 | 11,564 |
| IMPORTS bind rate | 85.6% | 100.0% |
| IMPORTS resolving to a nameless sentinel | 1,110 | 0 |
| REFERENCES_TYPE bind rate | 94.2% | 98.6% |
| Scan time | 2.67 s | 4.40 s |

### What was wrong

Two defects, both found by measuring rather than by reading.

**Every `@traceiq/*` import resolved to `ext:outside-analysis`.** A sibling import resolves through
node_modules to that package's *published types* — `packages/ir/dist/index.d.ts` — and `dist` is on the
scanner's ignore list. The reference therefore landed outside the analysed file set and collapsed into the
one nameless external. There were **zero** edges from any package into `packages/ir`: in a monorepo, the
structure a reader most wants to see was precisely the structure the graph could not show.

**The root tsconfig configured nothing.** TraceIQ's root is a solution file — `"files": []` plus
`references` — so it declares no `compilerOptions` at all. `new Project({ tsConfigFilePath })` on it yields
`{}`, and the whole repository was analysed under TypeScript's own defaults: no `paths`, no `jsx`. All 484
unresolved imports in the repository were `apps/web`'s `@/*` aliases.

**The call graph was the only compiler-backed stage that was not compiler-backed.** A live `TypeChecker`
existed in the pipeline at the moment `CallGraphResolver.resolve` ran — it is disposed in the `finally`
afterwards — and the resolver's signature simply excluded it.

### What was built

**`@traceiq/bench`** — the milestone's premise. Quality was previously unmeasurable except by hand-querying
SQLite, so it was measured first and every change judged against a recorded baseline. Reads only through
`RepositoryGraphApi`; computes no verdict, just counts and ratios of counts.

It reports `internalCallBindRate` separately from the CALLS bind rate, and that separation caught a real
problem: once calls into packages became edges, the headline CALLS rate read 99.7% while the number that
matters — calls reaching a declaration *in this repository* — was 68%. A bind rate that external edges can
inflate measures the wrong thing.

**Workspace-aware resolution.** The scanner discovers workspace packages (`pnpm-workspace.yaml`, or
package.json `workspaces`) by matching globs against directories the walk already found, so it can never
reach into an ignored directory. The Project Host turns them into path mappings — `@traceiq/ir` and
`@traceiq/ir/*` onto source — and layers built-in defaults beneath the root tsconfig, merges `jsx`, `lib`
and `paths` from each package's own tsconfig, and records `configurationNotes` saying what it did.

**The one-Program invariant is intact.** Per-package options are merged into a single program rather than
split across several, so the whole-program type checker still sees the whole repository.

**A checker tier above the name rules.** `CallGraphResolver` takes an optional `ProjectContext`. When given
one it asks `getResolvedSignature` first and emits `RESOLVED`; the five name rules run for whatever the
checker declines and still emit `INFERRED`. The tiers are additive — the checker correctly declines a
dynamic callee, and a name rule may still offer the one declaration in scope, at the weaker confidence.

**Calls that leave the repository became edges.** `CALLS` may now target an `External`, as every other
outward relationship already could; it was excluded only because a name binder cannot tell a package's
function from an unbound local. `IMPORTS` is file-scoped, so this is the only thing that can answer which
*declaration* uses `ts-morph` — 51 of them, as it turns out.

**Language builtins are deliberately excluded.** `JSON.stringify`, `Map`, `items.map` — 4,141 of them. The
repository did not choose the language it is written in, and an edge per `map` call would bury the packages
it did choose. Reported unresolved with `callee-is-language-builtin`, which also stops a name rule claiming
`JSON.parse` for a local function called `parse`.

### Defects found by testing

**Chained calls bound to the wrong target.** `make().run()` and its inner `make()` begin at the same
character, so keying the call index by start position alone collided and the outer call silently bound to
`make`. Fixed by keying on the full range. Caught by the first test written for it.

**Impact reported limitations that had become false.** `call-coverage-partial` claimed the call graph
"binds names rather than symbols"; `no-interface-or-dynamic-dispatch` claimed an interface call "produces
no edge at all". Both were true when written and are not now. Rewritten to state what remains true — an
interface call binds to the interface method and never to the implementations, which is the caveat that
actually matters. `calls-are-inferred` already fired only when inferred calls existed, but said "every".

### Known issues

- **Scan time is up 65%** (2.67 s → 4.40 s). `getResolvedSignature` on ~24,000 call sites is the cost. It
  buys 3,271 internal edges and 11,564 dependency edges, but nothing here is incremental or cached.
- **`@vitest/expect` and `@vitest/runner` account for 9,515 of the 11,564 external call edges** — every
  `expect` and `describe` in the suite. True, and arguably noise; a scan that excluded test files, or an
  interface that ranked dependencies by distinct callers rather than call count, would read better.
- **An interface call binds to the interface, not to implementations.** Genuine dynamic dispatch is still
  unresolved, as it should be.
- **The pnpm-workspace.yaml parser handles a narrow YAML subset** — `packages:` with `- item` entries. A
  flow sequence yields no globs, degrading to single-package behaviour rather than guessing.
- **The benchmark covers one repository: TraceIQ itself.** Fixture repositories for other shapes — a Next.js
  app, a yarn workspace, a no-tsconfig repository — are the obvious next step, and would likely find more.
- 60 calls still report `root-not-bound` and 54 type references `type-parameter`; both are small and were
  not investigated.

## Release Engineering — v1.0.0 deployment layer

**Status:** complete. `git clone && cd traceiq && docker compose up` brings up the whole stack and opens on a
dashboard with real data. Verified from a clean slate — no images, no volumes — on Docker 29.4.3 / linux
aarch64, twice: once with chat disabled (the default) and once with a model configured.

### What was added

Two production Dockerfiles, a Compose file, `.env.example`, a `.dockerignore`, and two small init scripts.
**No application logic changed.**

| Service | Image | Role |
|---|---|---|
| `ollama` | `ollama/ollama:0.32.5` | the model provider; healthchecked with `ollama list` |
| `ollama-pull` | same | one-shot; pulls the configured model, or exits 0 when none is set |
| `api` | built from `apps/api/Dockerfile` | the REST API; healthchecked on `GET /ping` |
| `seed` | `node:22-trixie-slim` | one-shot; scans the repository through `POST /scan`, idempotent |
| `web` | built from `apps/web/Dockerfile` | the Next.js app; healthchecked on `/` |

Both images are multi-stage and run as the unprivileged `node` user. The API stage produces a self-contained
bundle with `pnpm deploy --prod --legacy`; the web stage ships Next's `standalone` output. 419 MB each.

Volumes: `traceiq-graph` (the SQLite graph) and `ollama-models` (gigabytes, and worth keeping). Both survive
`docker compose down`; `down -v` discards them. Every port binds to `127.0.0.1` — nothing in the stack
authenticates.

### Defects found, all by running it

| Defect | Fix |
|---|---|
| **`better-sqlite3` failed on every scan.** Its prebuilt `linux-arm64.node` is linked against GLIBC 2.38 and the loader prefers it over the locally compiled build; Debian bookworm ships 2.36. The API built, started and passed its health check, then answered `invalid-repository` — "the database could not be opened" — naming neither glibc nor the prebuild. | Both stages moved to `node:22-trixie-slim` (glibc 2.41). |
| **`@traceiq/ai-ollama` was a devDependency** of `apps/api`, but `bin/traceiq-api.js` — the production entry point — imports it. Any `--prod` install produced an image that could not start. | Moved to `dependencies`. `apps/api/src` still never imports it, so the boundary test is unaffected. |
| **`tsc -b apps/api` did not build `ai-ollama`**, because it was absent from the project references — `src/` deliberately does not import it. The bundle shipped without its `dist`. | Added the project reference, so the build graph matches the dependency graph. |
| **The web README claimed `TRACEIQ_API_URL` is read at request time.** A standalone build compiles `rewrites()` into `routes-manifest.json`, so it is a **build-time** value. The claim was written before the app had a production build. | Corrected in the README and in `next.config.mjs`; the image takes it as a build argument. |
| A guessed `ollama/ollama:0.12.12` tag does not exist. | Pinned `0.32.5`, from the registry. |

### Decisions

**Chat is opt-in.** `TRACEIQ_MODEL` is empty by default. A model is several gigabytes and a first
`docker compose up` should not begin with a download nobody requested; everything else works and the chat page
already renders `ai-not-configured` with what to do. Set it in `.env` and `up` again — the pull runs to
completion *before* the API starts, because the API resolves its model at startup and exits if it is absent.

**The stack scans itself on first run.** Without it, a fresh `up` yields an API with nothing in it and a UI
showing its empty state — correct, but a poor first impression when the repository is right there. The `seed`
service goes through the published `POST /scan`, so it contains no analysis and opens no database, and it
skips itself when a graph already exists.

**Health checks use Node's `fetch`, not curl.** The slim images have no curl, and adding one to serve a health
check would be a package in a runtime image for no other purpose.

**`/ping`, not `/health`, for the API's liveness.** `/ping` answers without opening a graph, so an unscanned
API is reported healthy — which it is. `/health` is the repository health report and would mark it broken.

### Verified

Clean-slate `docker compose up`: all services healthy, `ollama-pull` and `seed` exited 0. The seed scanned
TraceIQ itself — 330 files, 4,009 declarations, 4,416 nodes, 16,845 edges — and the dashboard rendered it in a
browser. `GET /overview` through the API and through the web proxy agree.

With `TRACEIQ_MODEL=qwen2.5:0.5b`: the pull completed, the API logged `chat enabled`, `POST /chat` answered
`grounded` with a citation and usage, and `POST /chat/stream` delivered `open → grounding → delta ×12 →
complete` in order through the proxy.

Across `docker compose down` then `up`: the graph and the model both persisted, and `seed` correctly skipped.

### Files Created

`apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore`,
`docker/pull-model.sh`, `docker/seed-graph.mjs`.

### Files Modified

- `apps/api/package.json` — `@traceiq/ai-ollama` moved to `dependencies` (packaging correctness).
- `apps/api/tsconfig.json` — the matching project reference.
- `apps/web/next.config.mjs` — `output: 'standalone'`, `outputFileTracingRoot`, corrected comment.
- `README.md` — a "Running it" quickstart, requirements, deployment commands.
- `apps/web/README.md` — the build-time correction.

### Known Issues

- **`TRACEIQ_API_URL` is build-time for the web image.** Changing it needs `docker compose build web`. Making
  it runtime would mean replacing the rewrite with a route handler, which is an application change.
- **No CI job builds the images.** The workflow runs build, typecheck and tests; a `docker build` step would
  catch a broken Dockerfile before a release rather than at one.
- Images are 419 MB each. The API's bundle carries each package's `src/` and `tsbuildinfo`, which `pnpm deploy`
  copies wholesale; a `files` field per package would trim it but would touch twenty manifests.
- Single-architecture builds only — whatever the host is. No `buildx` multi-arch manifest.
- No production concerns beyond local use: no TLS, no authentication, no resource limits, no log shipping.

## Repository Chat — Web UI

**Status:** complete. The Repository Chat milestone is now finished across all three consumers. `pnpm build`
clean, `pnpm typecheck:tests` clean, web typecheck and `next build` clean, `pnpm test` 1,868 backend + **260
web** passing. Verified in a real browser against Ollama 0.31.1 / `qwen2.5:7b-instruct` over a live scan.

### What was built

`/chat` — an eighth page, and the only one that renders model prose. Sidebar with an in-session conversation
list, streaming answers, Stop, Retry, Clear, subject selection through `GET /search`, citations, grounding
badge, projection summary, omission summary, model information, token usage, dark mode, responsive layout,
error boundary and loading states.

```
page → useChat → chat-service → fetch POST /api/chat/stream → SSE frames
```

**The frontend still consumes only the REST API.** No `@traceiq` dependency and no `@traceiq` import anywhere
under `apps/web/src` — the only matches are comments and provenance *strings* that arrive in a payload.

### Markdown, as approved

Hand-written in `src/lib/markdown.ts`: paragraphs, headings, inline code, fenced code, bullet and numbered
lists, emphasis, strong emphasis. Nothing else, and **no raw HTML** — `<script>alert(1)</script>` renders as
those characters, asserted by test. No markdown library, no sanitiser, no `dangerouslySetInnerHTML` anywhere
in the app.

The parser emits a token tree, not a string, so every piece of model output is a text node React escapes.
Used by chat messages only; repository pages remain plain rendered data.

Two decisions worth recording: an unterminated fence closes at the end of the input, because half a fenced
block is exactly what arrives mid-stream and must read as code; and a heading inside a message renders as a
styled paragraph rather than an `h2`–`h6`, because the page already owns its `h1` and emitting headings from
model output would corrupt the landmark structure a screen reader navigates by.

### Defects found and fixed

| Defect | Fix |
|---|---|
| **Stop could hang against a body that ignores its abort signal.** `reader.read()` would block forever and the model would keep generating while the UI showed nothing changing. Found because a test that stubbed a `Response` — which is not linked to an `AbortController` — hung. The same class of bug as the one in the Ollama NDJSON reader. | The read is raced against the abort. Cancellation is now the reader's own guarantee rather than the platform's. |
| **Plain text was wrapped in a `span`**, putting a node between `<strong>` and its content — so `getByText` found the wrapper, not the emphasis. Harmless visually, wrong semantically. | A `Fragment`: plain text needs no element. |
| **jsdom implements no `scrollIntoView`**, so every chat page test failed on the streaming follow. | Stubbed in the test setup, beside the existing `matchMedia` and `ResizeObserver` shims. Guarding in the component would have been the test shaping the source. |
| The command palette asserted a fixed count of six nav sections; Chat made seven. | Asserts against `NAV_ITEMS.length`, so the next page does not break it either. |

### Browser verification, against a real model

Asked "How large is this repository and what limits the analysis?" — streamed live, rendered as markdown with
bold labels and a bullet list (no raw asterisks), reported 64 facts / 1,920 tokens / tier standard / digest
`c0a8bdfbb1fe2e3f`, listed both omissions (`externalPackages` 15 of 51, `cycles` 15 of 18), showed the
`grounded` badge, `qwen2.5:7b-instruct`, `stop-sequence`, `2005 prompt / 197 output tokens`, and six citations
each with its provenance.

Also verified: Stop mid-answer (button reverts, "Stopped." appears, caret clears, Retry enables), Retry, Clear,
dark mode, the mobile overlay sidebar with **no horizontal overflow** at 414px, subject search resolving
`RepositoryExplorer` through `GET /search` with its `impact` variant, and **no console errors**.

### Files Created

`apps/web/src/`: `lib/markdown.ts`, `services/chat-service.ts`, `store/chat-store.ts`, `hooks/use-chat.ts`,
`components/domain/chat/{markdown,grounding,subject-picker,turn,sidebar}.tsx`, `app/chat/page.tsx`; tests
`lib/markdown.test.ts`, `services/chat-service.test.ts`, `store/chat-store.test.ts`, `app/chat-page.test.tsx`.

### Files Modified

- `apps/web/src/types/api.ts` — the chat wire types, hand-written like the rest of the file.
- `apps/web/src/components/layout/nav.tsx` — Chat added to `NAV_ITEMS`.
- `apps/web/src/lib/routes.ts` — `routes.chat()`.
- `apps/web/src/test/setup.ts` — `scrollIntoView` shim.
- `apps/web/src/components/layout/command-palette.test.tsx` — asserts against `NAV_ITEMS.length`.
- `apps/web/src/lib/markdown.test.ts` — two `readonly` casts for `exactOptionalPropertyTypes`.
- `README.md`, `apps/web/README.md`, `docs/progress.md`.

**No backend package was modified in this part.**

### Known Issues

- **Conversations do not persist.** Deferred by approval; a conversation restored after a rescan would carry
  answers grounded in facts that no longer hold.
- Only `symbol`, `impact`, `file` and `repository` subjects are reachable from the picker. `package` and
  `route` are valid over the wire and in the CLI, but the picker offers no path to them yet.
- A weak model still produces weak answers; the badge reports the verdict rather than hiding it.
- No linter, here as elsewhere.

## Repository Chat — REST API and CLI

**Status:** REST API and CLI complete. Web UI not started. `pnpm build` clean, `pnpm typecheck:tests`
clean, `pnpm test` 1,866 backend + 170 web passing (97 in `apps/api`, 113 in `apps/cli`). Verified end to
end against Ollama 0.31.1 with `qwen2.5:7b-instruct` over a real scan of TraceIQ.

### One strictly-required change to a completed package

`Answer` did not carry token usage: the provider reports it in the `end` event and `RepositoryAnswerer`
discarded it. "Preserve token usage" cannot be satisfied downstream of a layer that threw it away, so one
additive field was added, read from the event already being handled. Nothing else in `packages/ai` changed.

### REST API

`POST /chat` and `POST /chat/stream`, both in the endpoint table so routing, validation and the OpenAPI
document keep a single source of truth. `Endpoint` gained an optional `stream` beside `handle`; a test
asserts every endpoint has exactly one.

`createApp({ databasePath, model })` takes a `LanguageModel`. **No registry**, and nothing under
`apps/api/src` names a vendor — `bin/traceiq-api.js` is the composition root and a test asserts the rest.
Without a model both endpoints answer `503 ai-not-configured` and every other endpoint is unaffected.

The wire answer carries the verdict, citations flattened to the fact each points at, the omissions, the
usage and the model — and no AI internal. A test asserts no `REPOSITORY-FACTS`, no fact array and no prompt
appears in a response.

`/chat` is `/chat/stream` drained rather than a second code path, and a test asserts the two bodies are
equal. The AI error codes are surfaced verbatim with one HTTP status each.

### CLI

`traceiq chat` — an interactive REPL with `--model`, `--provider`, `--subject`, streaming output, coloured
citations, the grounding verdict and graceful Ctrl+C. It is dispatched before the command table because a
`Command` returns one string when it finishes and a REPL writes as it goes.

`CommandSession` gained `context()`, so `chat.ts` receives a `ContextSource` — one method — and imports no
graph type at all. `src/providers.ts` is the single file that names a vendor.

**Colour is a deliberate reversal.** The CLI milestone said "no colours"; this one requires coloured
citations. Colour is therefore on for a terminal and off for a pipe or `NO_COLOR`, so redirected output
stays plain and diffable and every existing command's output is unchanged.

### Defects found and fixed — all four by running it, none by a first test run

| Defect | Fix |
|---|---|
| **The REPL hung after its first answer.** The interrupt watcher drained an `AsyncIterable` of interrupts, which never ends, so the `await` releasing it never settled: the answer printed, the footer printed, and then nothing. Node's "unsettled top-level await" warning was the only symptom. | `onInterrupt(handler) => unsubscribe`. A subscription can be released synchronously, which is what a per-answer watcher needs. Guarded by a test that asks three questions in one session. |
| **Every chat POST cancelled itself instantly.** The abort listener was on the request; `close` on an `IncomingMessage` fires when that readable is destroyed — as soon as the body is consumed — so every answer failed `generation-aborted`. | Listen on the **response**, and abort only when `writableFinished` is false, which distinguishes "the client left" from "we finished answering". |
| **A malformed body on `/chat/stream` returned `200` carrying an error frame.** The stream opened before the handler validated anything, fixing the status. | The sink opens the stream **lazily on its first write**, so every failure raised before the first frame — bad body, unknown subject, no model — is an ordinary JSON error with a real status. |
| **The vendor name leaked out of `providers.ts` into `cli.ts`** through the `--provider` default and the help text. | `DEFAULT_PROVIDER` and `EXAMPLE_MODEL` exported from `providers.ts`; a grep now finds the vendor in exactly one CLI file. |

### Verification performed

Build, typecheck, 1,866 + 170 tests, boundary audit, and by hand against a live provider: SSE frame order
and content over `curl`; three consecutive CLI prompts with `/clear` between them and a clean `bye`;
Ctrl+C mid-answer cancelling and the session surviving to answer again (exit 0); Ctrl+C while idle exiting
130; `NO_COLOR` producing byte-plain output; and each of the four error paths with its own exit status
(`2` wrong flag, `3` provider down, `4` no such model, `5` nothing answerable).

### Boundary audit

`packages/ai`'s compiled closure is still exactly one external import, `node:crypto`. `apps/api/src`
contains no vendor name and no `@traceiq/ai-ollama` import. `apps/cli/src/chat.ts` imports only
`@traceiq/ai`, `@traceiq/context` (types) and `@traceiq/types` — no graph, no capability, no vendor.

### Files Created

`apps/api/src/`: `chat.ts`, `sse.ts`, `chat.test.ts`.
`apps/cli/src/`: `chat.ts`, `providers.ts`, `chat.test.ts`.

### Files Modified

- `packages/ai/src/answer.ts` — `usage` on `Answer` (strictly required, above).
- `apps/api/src/`: `endpoints.ts` (two endpoints, `RequestContext.model`/`signal`, `answererFor`, optional
  `stream`), `app.ts` (streaming route, abort wiring, `AppOptions.model`), `errors.ts` (AI codes and
  statuses), `graph-holder.ts` (`context()`), `openapi.ts` (event-stream responses), `server.ts`,
  `index.ts`, `api.test.ts`, `package.json`, `tsconfig.json`, `bin/traceiq-api.js`.
- `apps/cli/src/`: `cli.ts` (chat dispatch, three flags, help), `errors.ts` (four codes), `session.ts`
  (`context()`), `types.ts` (three options), `index.ts`, `cli.test.ts`, `package.json`, `tsconfig.json`,
  `bin/traceiq.js`.
- `README.md`, `apps/api/README.md`, `apps/cli/README.md`, `docs/progress.md`.

### Known Issues

- **The web UI is not started.** See the next milestone.
- A weak model still produces weak answers; the layer reports the verdict rather than hiding it. On the
  live CLI run, questions about repository scale were `grounded` with correct citations, while an open
  question about a symbol came back `unverifiable`.
- `generation-aborted` maps to `400`, which is effectively unobservable on `/chat`: by the time it is
  raised the client has gone.
- No linter, here as elsewhere.

### Next Milestone

**Repository Chat — Web UI.** Not started. Continuation point is recorded in the implementation report.

## AI Layer

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test` 1,800 backend + 170 web
passing (128 in `@traceiq/ai`, 28 in `@traceiq/ai-ollama`, one of those opt-in against a live provider).

Two packages: `packages/ai`, provider-agnostic; `packages/ai-ollama`, the first provider. Verified end to
end against Ollama 0.31.1 with `qwen2.5:7b-instruct` over a real scan of TraceIQ.

### The finding that shaped the milestone

`RepositoryContext` cannot go in a prompt. Measured before any code was written:

| Kind | context | ≈ tokens | vs 128k window |
|---|---|---|---|
| `search` | 197 KB | 56,146 | 0.4× |
| `file` | 288 KB | 81,899 | 0.6× |
| `symbol` | 621 KB | 176,712 | 1.3× |
| `package` | 834 KB | 237,286 | 1.8× |
| `repository` | 1,450 KB | 412,508 | 3.1× |
| `impact` | 4,201 KB | **1,194,962** | **9.1×** |

An `impact` context is 1.2 million tokens, 146× an 8k window. The Context Builder deliberately stopped short
of solving this — choosing what fits a budget needs a tokeniser. So the **projection is the milestone**, and
the provider is the small part.

Two other audit findings drove decisions. `@traceiq/context` imports every capability as **types only**; its
compiled output contains no `@traceiq` import at all, so the AI layer's runtime closure can be genuinely
empty. And the read API exposes **no graph revision**, which is why grounding identity is a digest of the
projection rather than of the repository.

### Architecture as approved and amended

```
question + resolved subject
   │  ContextSource.build()      ← the one inbound path, one method
RepositoryContext   [≤1.2M tokens]
   │  project()                  fixed priority, capped, counted, deduplicated
ContextProjection   [facts · closed identifier set · omissions · digest]
   │  assemble()                 deterministic, fenced, declared to be data
   │  LanguageModel.generate()   streaming is the only primitive
   │  checkGrounding()           every identifier must be in the closed set
AnswerEvent stream
```

`RepositoryAnswerer(source, model)` — **constructor injection is the entire configuration surface**. No
registry (removed on amendment), no provider name, no vendor anywhere in `packages/ai`. Conversation is
**types only**; no store, no persistence. **No subject resolution**: turning free text into a subject is
repository search and stays in the Explorer. **No synthetic repository fingerprint**: dropped on amendment,
pending a real revision identifier.

### Defects found and fixed — every one by probing, none by a first test run

| Defect | Fix |
|---|---|
| **40 of 276 facts in a real symbol projection were exact duplicates.** The context mirrors some edges by design — `references` is documented as "a kind-independent view, not additional data" — so a type reference arrives twice. 15% of a scarce budget paid twice, and apparent evidence inflated. | Deduplication by (subject, predicate, object); the earlier, higher-priority extractor wins. Omission totals count only facts nothing earlier had said. |
| **A real 7B model wrote `[f8, f10]` and two of three citations were silently dropped.** The pattern matched only `[f12]`. Losing evidence an answer really provided is the worst direction to fail in. | The pattern accepts the combined form; `citationIds` splits it. Confirmed live: citations on one question went from 1 to 9. |
| **The identifier set contained `sym:… at depth 1`** as though it were an identifier, so a model citing the bare name would have been accused of inventing it. | The depth suffix is stripped; the set holds identifiers only. |
| **A stalled provider could never time out.** `readNdjson` checked the abort flag only *between* reads, so a body that opens and then sends nothing left the reader blocked *inside* `read()`. Found by a test that hung. | The read is raced against the abort, and the reader is cancelled so the connection is not held open. |
| **The caps always bound before the token budget**, so a larger context window bought nothing and a long question cost nothing. | Caps raised so both are real constraints; each has a test. |
| **The vendor name leaked into a published `.d.ts`** through a doc comment in the provider-agnostic package. | Reworded, and the leak test now covers the published types, not only source. |
| **Three source files contained a literal NUL byte** where a separator was intended. Nothing failed — the NUL worked, every test passed — but `file` reported them as binary and **`grep` skipped them entirely**, which silently defeated the boundary audits: a grep that matches nothing looks identical to a grep that finds nothing wrong. I nearly reported "no external imports" on that basis. | Separators written as `\u0000` escapes. A test now rejects any control byte in source or build output. |

### Self-review — probed before the tests were written

| Criterion | Finding |
|---|---|
| Duplicate facts | **Found and fixed**, above. Now zero across all six kinds. |
| Empty or nullish facts | None across all kinds: no `undefined`, `null`, `NaN` or `[object …]` reaches a fact. |
| Prompt actually fits | Measured, not assumed: `symbol` 4,791 tokens, `impact` 5,897, against a declared 6,000 and an 8k window. |
| Source code leakage | None. `export class`, `export function`, `=>`, `return` all absent from the fact region. Asserted by test. |
| One fact eating the budget | Longest are limitation details at ~270 characters — long, but they are the honesty guarantee and there are ten. |
| Duplicated repository intelligence | None. The extractors read the context's kind-independent parts; only one small switch looks inside a capability result, and it reads the subject's identity. |
| Hidden second inbound path | Impossible: `ContextSource` has one method. Asserted by test. |
| Ordering / determinism | Same context and tier produce byte-identical facts and prompts, over fakes and over a real graph. |

### Performance on TraceIQ — 228 files, 3,148 declarations, 12,911 edges

| Kind | context tokens | projected | reduction | facts | cold | warm |
|---|---|---|---|---|---|---|
| `repository` | 412,508 | 1,920 | **215×** | 64 | 0.74 ms | 0.10 ms |
| `symbol` | 176,712 | 5,995 | 29× | 166 | 0.27 ms | 0.16 ms |
| `impact` | 1,194,962 | 5,989 | **200×** | 152 | 0.20 ms | 0.12 ms |
| `file` | 81,899 | 3,176 | 26× | 81 | 0.09 ms | 0.06 ms |
| `package` | 237,286 | 1,428 | 166× | 47 | 0.07 ms | 0.05 ms |
| `search` | 56,146 | 907 | 62× | 30 | 0.03 ms | 0.02 ms |

The projection is sub-millisecond and never the bottleneck. Generation dominates completely: against a local
7B model, first token ~4 s, a 200-token answer ~10 s.

### Live verification

Three questions over a real scan, real capabilities, real Context Builder, real Ollama. One answer
`grounded` with nine resolved citations and correct figures. One `unverifiable` — the model wrote plausible
prose and cited nothing. One `ungrounded` — the model mangled a real identifier and the guard named it. The
layer reported all three accurately rather than presenting any of them as grounded, which is the intended
behaviour and the reason the verdict is part of the answer.

### Files Created

`packages/ai`: `package.json`, `tsconfig.json`, `README.md`; `src/` — `answer.ts`, `budget.ts`,
`context-source.ts`, `conversation.ts`, `errors.ts`, `facts.ts`, `grounding.ts`, `index.ts`, `model.ts`,
`projection.ts`, `prompt.ts`, `stream.ts`, `testing.ts`; 7 test files plus `fixtures.test-helper.ts`.

`packages/ai-ollama`: `package.json`, `tsconfig.json`, `README.md`; `src/` — `index.ts`, `ndjson.ts`,
`ollama-model.ts`, `ollama-provider.ts`; 1 test file plus `stub.test-helper.ts`.

### Files Modified

- `tsconfig.json`, `tsconfig.tests.json` — two project references.
- `vitest.config.ts` — three aliases, including `@traceiq/ai/testing` mirroring the package's `exports` map.
- `README.md` — both packages listed; the AI layer named in the stack.

**No previously completed package was modified.**

### Runtime dependencies

**None**, in either package. `@traceiq/context` is type-only; Ollama is reached with Node's own `fetch` and
streams. The repository's total external runtime surface stays `better-sqlite3`, `ts-morph`, `fast-glob`,
`express`.

Precisely: the only external import in `@traceiq/ai`'s compiled output is `node:crypto`, a platform builtin
used for the projection digest. `@traceiq/ai-ollama` imports only `@traceiq/ai`.

### Known Issues

- **The token counter is an estimate** — 3.6 chars/token, the measured ratio. The tier step-down exists
  because it can be wrong; a provider that can count exactly supplies its own counter.
- **The guard checks identifiers, not claims.** "f12 proves X" when f12 proves Y passes.
- **Prompt injection is mitigated, not solved.** Repository content reaches the prompt.
- **No graph revision**, so staleness cannot be detected. Pending an additive `revision()` on the read API.
- **Answer quality is not tested.** That is model evaluation and needs labelled data.
- No linter, here as elsewhere.

### Next Milestone

Exposing answers through `apps/api` (SSE) and `apps/cli`, and conversation persistence. **Not started.**
Each touches a frozen app and needs its own approval.

## TraceIQ Web

**Status:** complete. `pnpm --filter @traceiq/web build` clean,
`pnpm --filter @traceiq/web typecheck` clean, `pnpm test` 1,645 backend + 170 web passing.

### Completed Work

New `apps/web`: Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui over Radix, TanStack Query,
Zustand, React Flow, Monaco. Seven pages — Dashboard, Explorer, Symbol, Impact, Architecture, Health,
Search — plus a command palette, dark mode, a responsive shell and error boundaries.

**The frontend imports no backend package.** There is no `@traceiq/*` dependency, no
`transpilePackages` entry and no path mapping into `packages/`; the only contract is the REST surface.
`src/types/api.ts` is a hand-written *projection* of the wire format, verified against a live API
response for every endpoint before being written down.

The layering is one direction only: page → hook → service → api-client → `fetch`. No component builds a
URL or calls `fetch`; no service holds state or renders. Graph drawing, the one place logic could have
leaked into a component, is a pure function in `src/lib/graph-models.ts` with its own unit tests.

### Defects Found and Fixed — all found by probing, none by a test suite

| Defect | Fix |
|---|---|
| **The browser blocked every request.** The API sends no `Access-Control-Allow-Origin`, so a cross-origin call from the app's origin fails with `net::ERR_FAILED` before it is sent. Nothing in the test suite could see this — the tests stub `fetch`, which has no CORS. | The backend is frozen, so the app calls `/api/…` same-origin and a Next rewrite forwards to the upstream. Only the host changes. Verified that `%23`, slashes and query strings survive the proxy. |
| **React Flow drew 59 edges as zero edges.** A custom node without `Handle` children silently drops every edge attached to it, so the impact graph rendered as a field of unconnected boxes while the count beside it read "59 edges". | Added a target and a source `Handle` to the node. A regression test asserts both are present, since nothing else in the suite would notice. |
| **`Most coupled files` was labelled wrongly and showed the wrong column.** `HotspotReport.mostCoupled` holds *declarations* ordered by fan-in plus fan-out; the page called them files and displayed fan-out, which was 0 for most rows. | One shared `MetricList` showing fan-in, fan-out and both edge counts. Displaying a single column silently claims that column was the ordering; showing all four states what was measured. |
| **A 22-node package graph drew as one unreadable vertical strip**, then `fitView` shrank it until nothing was legible — and gave no hint why there were no edges. | `place` wraps a layer past ten rows into sub-columns; `GraphCanvas` takes a `noEdgesNote` and the Architecture page explains that a pnpm sibling import resolves through built output, so no package-to-package edge exists. |
| **`pluralise(20, 'entry')` produced "20 entrys".** | `ListingNote` takes an optional plural. |
| **Root `pnpm test` would have swept the web `.test.ts` files into the Node suite**, running them with no DOM. | The backend config excludes `apps/web`, and the root `test` script runs both configs in turn. A `test.projects` delegation was tried first and rejected: it dropped the JSX transform, failing all nine `.tsx` files. |

### Build configuration — three forced deviations

Next 15.5 does not support TypeScript 7, which the rest of the repository uses.

1. `next.config.mjs` rather than `.ts` — the TS config loader fails with
   `Cannot read properties of undefined (reading 'fileExists')`.
2. `typescript@^6` pinned **in `apps/web` only**. Next refuses to build otherwise: *"The TypeScript 7
   native compiler does not provide the JavaScript compiler API that Next.js requires."* pnpm's isolation
   keeps this local; no backend package changed. The alternative was Next 16, which the milestone did not
   specify.
3. The `@/…` alias is declared in `next.config.mjs` as well as `tsconfig.json`, because Next reads
   `paths` through that same loader and the alias otherwise never reaches the bundler.

`typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds` are set for the same reason. Types are
still fully checked by `pnpm typecheck` under `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, as a separate script that must pass.

### Performance on TraceIQ — 228 files, 3,148 declarations, 12,911 edges

| Page | Requests | Payload | Slowest request |
|---|---|---|---|
| Search | 1 | 16 KB | 2 ms |
| Symbol | 1 | 197 KB | 6 ms |
| Explorer | 3 | 366 KB | 4 ms |
| Dashboard | 3 | 403 KB | 8 ms |
| Architecture | 2 | 443 KB | 27 ms |
| Health | 3 | 981 KB | 19 ms |
| Impact | 2 | 2,024 KB | 18 ms |

First-load JS 103 KB shared plus 2–14 KB per page. React Flow only on the two graph pages; Monaco loaded
on demand and in no initial bundle. `staleTime: Infinity` because a graph is one immutable revision until
the next scan; a 4xx is never retried.

### Files Created

`apps/web`: `package.json`, `next.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `vitest.config.ts`,
`README.md`; `src/app/` (layout, providers, globals.css, error, loading, not-found and seven pages);
`src/components/ui/` (button, card, badge, input, table, skeleton, separator, tabs, dialog, scroll-area,
resizable); `src/components/layout/` (app-shell, nav, theme-toggle, command-palette, error-boundary);
`src/components/domain/` (states, node-pill, stat, listing-note, limitations, charts, metric-list, trees,
graph-canvas, json-inspector); `src/hooks/` (queries, use-theme, use-debounced); `src/services/`
(api-client, repository-service); `src/store/ui-store.ts`; `src/lib/` (utils, format, routes, theme,
graph-layout, graph-models); `src/types/` (api, assets); `src/test/` (setup, fixtures, harness);
15 test files.

### Files Modified

- `vitest.config.ts` — excludes `apps/web` from the backend suite, which now has a name.
- `package.json` — `test` runs both suites; `test:backend`, `test:web`, `typecheck:web`, `build:web` added.
- `pnpm-workspace.yaml` — `esbuild` and `sharp` added to `allowBuilds`.
- `README.md` — `apps/web` marked implemented; TraceIQ Web added to the stack diagram.

**No backend package was modified.**

### Known Issues

- **No source code is displayed.** No REST endpoint returns file contents, so Monaco is a read-only
  payload inspector instead. This is the one place the specified stack and the available API disagree.
- **`GET /route` has no page.** It is wired in the service and hook layers, but TraceIQ registers no
  route, so there was nothing to build a page against. Routes are reached through the declarations that
  serve them.
- **`POST /scan` is not exposed.** It is a long write-shaped operation and the API offers no progress
  reporting; the UI shows the API's own hint to run `traceiq scan`.
- Graphs are capped at 60 nodes. The cap and the true total are always reported.
- No linter is configured, here as elsewhere in the repository.

### Next Milestone

Repository Chat / the AI layer. **Not started, and not to be started without approval.**

## Context Builder

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,645 passing across 55 files (79 in this package).

### Completed Work

New `packages/context`: `RepositoryContextBuilder.build(request)` → `RepositoryContext`, over all seven
request kinds — symbol, impact, file, package, route, repository, search.

**The package cannot reach anything.** The constructor takes the five capabilities; there is no
`RepositoryGraphApi`, no store, no compiler, no filesystem and no HTTP anywhere in its surface, so the
boundary is enforced by the type rather than by discipline. The unit suite builds every kind from
fabricated answers with no graph in the file at all.

One envelope for every kind, with `kind` saying which parts are populated. Every value is a capability
result carried unchanged; nothing is recomputed, reshaped, ranked, scored or written in words.

`RepositoryNavigator` is deliberately absent — not in the permitted reuse set, and not needed, since
`QueryEngine.explainRoute` already splits a route's chain.

### Divergence from the reserved design, worth recording

The placeholder README written at workspace setup described **ranking results** and **loading source to
fit a token budget**. This milestone excludes both explicitly. Selecting source text for a budget needs a
model's tokeniser and is a judgement, so it belongs above a package that must stay deterministic. The
README now states this rather than leaving the two descriptions to contradict each other.

### Self Review — probed before the tests were written

| Criterion | Finding |
|---|---|
| Duplicate assembly | **Found:** `references.references` was literally the `callers` array again for the impact kind. Fixed to the union of calls, type positions and imports. |
| Duplicate traversal | None. The builder performs none; a per-build call counter proves each capability is called once per part. |
| Duplicate queries | **Found:** `explain` was called on `File` nodes, which always return `null` — one wasted capability call per file among affected nodes. Now only declaration kinds are explained. |
| Hidden graph access | None possible: no graph type appears in the package. Asserted by a test that builds a whole context from fakes. |
| Ordering issues | Limitations are deduplicated and sorted by code; related nodes keep the capability's order, which is depth-major for impact and alphabetical for search. |
| Storage leakage | `better-sqlite3` absent from the runtime closure; no context contains a path, connection or the string `sqlite`. |
| Capability overlap | **Found and resolved by design:** `browseSymbol` runs the impact analyser internally, so a symbol context carries impact as counts rather than running it a second time. The `impact` kind exists for the whole analysis, and `impact-summary-only` says so on every symbol context. |

### Defects Found and Fixed

| Defect | Fix |
|---|---|
| **`references.references` duplicated `incomingCalls`** for the impact kind — the same array under two names. | The union of `callers`, `typeReferences` and `imports`, which is what Explain Symbol means by references. |
| **`explain` was called on nodes that cannot be explained.** An affected set contains files; `explain` returns `null` for one, so five explanations cost six calls and `explainedNodes` disagreed with the call count. | Only declaration kinds are explained. Call count and explained count now agree. |
| **A package context labelled its imports as `outgoingCalls`.** An import is not a call, and a package is a grouping with no calls of its own. | `references` is empty for the package kind; imports stay on the package view where they belong. |
| **An impact context was 3 MB**, of which 1.7 MB was twenty explanations at ~85 KB each. A context exists to be consumed whole. | `EXPLAIN_LIMIT` is five, with the reasoning and the measurement recorded. Every affected node is still listed by identifier. Context dropped to 2.1 MB. |

### Performance on TraceIQ — 202 files, 2,594 declarations, 2,822 nodes, 11,185 edges

| Kind | Cold | Warm | Payload |
|---|---|---|---|
| `search` | 46.4 ms | **0.3 ms** | 78 KB |
| `impact` | 19.2 ms | **1.4 ms** | 2.1 MB |
| `symbol` | 72.1 ms | **2.6 ms** | 198 KB |
| `package` | 51.9 ms | 4.8 ms | 808 KB |
| `file` | 55.5 ms | 7.4 ms | 249 KB |
| `repository` | 161.3 ms | 11.4 ms | 1.4 MB |

**`health.analyze` at 4.9 ms warm is the bottleneck**, and it explains the ranking exactly: every kind
that calls it is slower than every kind that does not. Next is `hotspots` 1.4 ms, `cycles` 0.9 ms,
`browseSymbol` 0.7 ms, `impact.analyze` 0.3 ms, `overview` 0.1 ms, `architecture` 0.0 ms.

**Cold is the shared index build**, ~45 ms, paid once by whichever kind builds first — `search` cold at
46.4 ms is essentially the index and nothing else.

**The `repository` kind computes health twice**: `explorer.overview` derives a summary internally while
`health.analyze` produces the report. About 4.9 ms of its 11.4 ms, or 43%, reported as
`repository-health-computed-independently` rather than hidden.

### Files

Created: `packages/context/src/` — `types.ts`, `capabilities.ts`, `limitations.ts`, `builders.ts`,
`repository-context-builder.ts`, `index.ts`, `fake-capabilities.test-helper.ts`,
`repository-context-builder.test.ts`, `pipeline.test.ts`; `package.json`, `tsconfig.json`.

Modified: `packages/context/README.md` (replacing the not-implemented placeholder), root `README.md`,
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`. **No completed package changed.**

### Decisions

| Decision | Reason |
|---|---|
| The constructor takes capabilities, never a graph | Makes traversal, storage and filesystem access unrepresentable rather than merely absent, and lets the unit suite hold no graph at all. |
| One envelope for every kind | A consumer renders one object. A part that does not apply is `null` or empty rather than absent, so no field has to be probed. |
| `references` mirrors edges that also live in `primary` | A kind-independent accessor is worth modest repetition; the alternative is every consumer learning where each kind keeps its edges. Stated in the type so it is not mistaken for extra data. |
| A symbol context carries impact as counts | `browseSymbol` already ran the analyser; asking again would run it twice for one request. |
| `provenance` names the capability and operation per part | The risk of a composition layer is that a consumer cannot tell where a fact came from. |
| Explanations capped at five | One explanation is ~85 KB. Twenty made a context 3 MB of mostly bulk. Every related node is still listed, so more is one request away. |
| `ContextNotFoundError` rather than an empty context | An empty context reads as "nothing is recorded", not "this does not exist". A search matching nothing is not an error. |
| The repository kind carries three results as its subject | It has no single subject, and the milestone names the overview, architecture and hotspots together. |
| Per-build call counting | Makes "no duplicated assembly" measurable rather than asserted. |

### Known Limitations

- **Payloads are large** — impact 2.1 MB, repository 1.4 MB — because capability results are carried
  whole. There is no field selection.
- **A package context embeds the whole health report**, ~517 KB of its 808 KB. Many package contexts pay
  for the same report each time.
- **The repository kind computes health twice.**
- **At most five related nodes are explained**, with the unexplained count reported.
- Everything inherited from below: uncomposed route prefixes, partial call coverage, `INFERRED` calls, no
  interface or dynamic dispatch, path-derived packages, cross-package imports outside the analysed set.

### Approval Items

1. **Whether the explorer should expose the health report it already computes.** It would remove the
   duplicate computation from the repository kind and take ~43% off its warm time. It is a one-accessor
   addition to a completed package, so it is not done unilaterally.
2. **Whether a context should support field selection**, so a consumer can ask for a symbol context
   without 2 MB of explanations, or a package context without the health report.
3. **A `getNodesWithRole(role)` accessor on the Graph API.** Still the reason `health.analyze` is the
   bottleneck of this package, the CLI and the API alike.
4. **Whether the CLI and REST API should adopt this package** for their multi-capability commands. Both
   compose capabilities themselves today; routing them through the builder would give one definition of
   what belongs together, at the cost of touching two completed applications.
5. Carried forward: scan out of process; incremental scanning; response caching headers; asynchronous
   scan; four narrow Query Engine operations; a batch node accessor; `SourceRange` to `@traceiq/types`; a
   property or member-access relationship; interface dispatch as a relationship; a multi-link `this`
   unresolved reason; property-initializer constructions; mount annotations for route prefixes; whether
   the scanner should read sibling workspace packages' sources.

### Next Milestone

Awaiting instruction. The frontend, AI and Repository Chat are all explicitly not started.

## TraceIQ REST API

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,566 passing across 53 files (70 in the API).

### Completed Work

New `apps/api` — the HTTP interface — with all seventeen endpoints plus a generated
`GET /openapi.json`. Express 5, which the milestone approved; no other dependency was added, and the
HTTP tests use Node's built-in `fetch` rather than an unapproved testing library.

**The API contains zero repository intelligence.** Each endpoint validates its parameters, calls one
capability and returns that capability's result unchanged.

`ENDPOINTS` is the single source of truth for routing, validation and the OpenAPI document, so the
document cannot drift from the server. Tests assert both directions: every documented path is routed,
and no routed path is undocumented.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | Plain array of endpoints, `createApp(options)` takes its dependencies. No decorators, no DI framework, no ORM. |
| Performance | Scan 1,385 ms; every warm read 0.7–23.7 ms. Graph opened once, cache shared across requests. |
| Validation | Eleven codes over five statuses. A missing graph is 409, not 404. |
| Error handling | One shape for everything, including a body Express itself rejected. |
| Code reuse | Every payload is a capability result; the API adds only the envelope. |
| Duplicate logic | None. The endpoint table drives routing, validation and documentation from one place. |
| API consistency | `success`/`data`/`meta` everywhere; wildcards for every slash-bearing parameter; `null`-free errors. |
| Documentation | README covers architecture, request lifecycle, endpoint reference, identifier encoding, examples, performance and limitations. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **`GET /symbol/{id}` returned 404 for every valid identifier.** A declaration id contains `#`, which starts a URL fragment — the client strips everything after it, so the server received a truncated id. Found by calling the endpoint against TraceIQ, not by a test. | The endpoint was correct; the *documentation* was wrong — it told clients to send it unencoded. Fixed the OpenAPI parameter descriptions and examples to require `%23`. |
| **A truncated identifier gave a puzzling 404.** `sym:x/y.ts` with no `#` names no declaration, yet was reported as "the graph holds nothing named that". | Added a validation step: a `sym:` identifier must carry a `#`. It now returns **400** with a hint naming `%23`, so the encoding trap is diagnosed rather than mistaken for a missing symbol. |
| **A request identifier and a duration in `meta` would have made every body vary.** | Both moved to headers — `x-request-id`, `x-response-time` — leaving `meta` deterministic. Asserted: repeated requests return byte-identical bodies while their identifiers differ. |

### Real Repository Validation — every endpoint over HTTP

202 files, 2,594 declarations, 2,822 nodes, 11,185 edges, 2,906 call edges.

| Endpoint | Cold | Warm | Payload |
|---|---|---|---|
| `POST /scan` | **1,385 ms** | — | 372 B |
| `/ping` · `/version` · `/routes` | 1.3–2.2 ms | 0.7–1.7 ms | 107–163 B |
| `/overview` | 2.0 ms | 1.9 ms | 5 KB |
| `/packages` | 1.8 ms | 1.6 ms | 1.9 KB |
| `/files/{path}` | 1.9 ms | 1.8 ms | 82 KB |
| `/search?q=` | 2.0 ms | 1.7 ms | 15 KB |
| `/packages/{name}` | 2.5 ms | 2.3 ms | 276 KB |
| `/cycles` | 3.1 ms | 2.7 ms | 36 KB |
| `/impact/{id}` | 3.3 ms | 4.1 ms | **871 KB** |
| `/hotspots` | 4.0 ms | 3.7 ms | 398 KB |
| `/symbol/{id}` | 6.1 ms | 2.9 ms | 84 KB |
| `/health` | 9.2 ms | 7.9 ms | 517 KB |
| `/architecture` | 24.8 ms | 9.6 ms | 363 KB |
| `/dependencies/{id}` | 28.4 ms | 23.7 ms | 276 KB |

Largest response **871 KB** (`/impact`). Memory **165 MB before a scan, 502 MB after, 570 MB** after
every endpoint — the jump is the in-process scan retaining the compiler's program.

### Files

Created: `apps/api/src/` — `errors.ts`, `graph-holder.ts`, `respond.ts`, `endpoints.ts`, `app.ts`,
`openapi.ts`, `server.ts`, `index.ts`, `api.test.ts`, `http.test.ts`; `apps/api/bin/traceiq-api.js`;
`apps/api/package.json`, `tsconfig.json`.

Modified: `apps/api/README.md` (replacing the not-implemented placeholder from workspace setup), root
`README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`. **No analysis package
changed.**

### Decisions

| Decision | Reason |
|---|---|
| Observability in headers, determinism in the body | A request identifier and an elapsed time vary between identical requests, and a body that varies cannot be compared, cached or snapshot-tested. |
| One endpoint table for routing, validation and OpenAPI | Three uses of one declaration cannot drift; a hand-written spec would be the thing that rots. |
| Wildcards rather than `%2F` for slash-bearing parameters | A percent-encoded slash is mangled by proxies, and a path is what a client actually holds. |
| `#` must be `%23`, enforced with a 400 | It is a URL fragment delimiter. Diagnosing it beats a 404 that looks like a missing symbol. |
| 409 for a missing graph | The request was fine; the server has nothing to answer from yet. A client can tell "scan first" from "not there". |
| No locking around the graph | Every read capability is synchronous, so a request never yields while holding it; a scan swaps in one synchronous step. Stated in code rather than assumed. |
| `GraphHolder` on the app instance, not at module scope | Two apps in one process — as two tests are — must not see each other's graph. |
| A capability result is returned unchanged | Reshaping it would invent information and create a second definition of a payload. |
| OpenAPI describes payloads as objects | The shapes are defined by each capability's published types; copying them here would make the copy the stale one. |
| Fixed revision timestamp for a scan | Two scans of one repository write identical databases. |
| No HTTP testing library | Node's `fetch` against a real ephemeral-port server exercises more and adds no unapproved dependency. |

### Known Limitations

- **A scan is a full rebuild, in-process**: ~1.4 s blocking, ~320 MB retained afterwards.
- **One repository per server.**
- **Large payloads** — `/impact` 871 KB, `/health` 517 KB. No field selection, no pagination.
- **No authentication**, as specified.
- **No caching headers**; `etag` is explicitly disabled.
- **`GET /health` is the report, not a liveness probe** — `/ping` is.
- Everything inherited from below, each present in the payload's own `limitations` field.

### Approvals Needed Before the Frontend

1. **Whether a scan should run out of process.** It blocks the event loop for ~1.4 s and leaves ~320 MB
   of compiler state resident. A worker or subprocess would fix both, and matters as soon as anything
   re-scans while serving.
2. **Whether the API should support field selection or pagination.** A frontend rendering a tree does
   not need 871 KB, and `/impact`, `/health`, `/hotspots` and `/architecture` are all over 350 KB.
3. **Whether responses should carry `ETag` and `Cache-Control`.** Bodies are already byte-identical per
   revision, so conditional requests would be nearly free — but caching correctness across a rescan
   needs a revision identifier a client can see.
4. **Whether `/scan` should be asynchronous**, returning a job identifier a client polls, rather than
   holding the connection for the whole build.
5. **A `getNodesWithRole(role)` accessor on the Graph API.** Still ~2,300 of the first read's reads.
6. **Whether the scanner should read sibling workspace packages' sources**, so package dependencies stop
   being empty on every monorepo.
7. Carried forward: incremental scanning; four narrow Query Engine operations; a batch node accessor;
   `SourceRange` to `@traceiq/types`; a property or member-access relationship; interface dispatch as a
   relationship; a multi-link `this` unresolved reason; property-initializer constructions; mount
   annotations for route prefix composition.

### Next Milestone

Context Builder.

## TraceIQ CLI

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,496 passing across 51 files (74 in the CLI).

### Completed Work

New `apps/cli` — the `traceiq` command — with all fifteen subcommands, and new `@traceiq/pipeline`,
which owns the write path.

**The CLI contains zero analysis logic.** It parses a command line, opens a graph, calls one
capability and renders the result. Every number it prints was computed below it.

### The conflict this milestone opened with, and how it was resolved

`traceiq scan` must build and store the graph, which needs the scanner, project host, IR, resolver,
framework extractor, call graph, graph builder and store — all of which the CLI was forbidden to
import. Worse, **every read command** needs to open the stored graph, and the only
`RepositoryGraphApi` implementation lives in `@traceiq/graph`, also forbidden. The conflict covered all
fifteen commands, not just one.

Resolved by asking, and by the answer chosen: a new `@traceiq/pipeline` package owns `scan` and `open`
and hands back an abstract `RepositoryGraphApi`. It clears the two-future-consumer bar — the REST API
and the AI Context Builder both need exactly this, and neither should re-wire nine packages either.

### Self Review

| Criterion | Finding |
|---|---|
| API design | `run(argv, io)` is a function returning an exit status. No `process.exit`, no globals, so the whole CLI is testable by calling it. |
| Code reuse | Every command delegates. The CLI's only contribution is rendering. |
| Performance | Cold scan 1.45 s; every read command 0.13–0.24 s, one graph read per invocation. |
| Error handling | Eight codes, three exit statuses, fixed wording, stderr only. A usage error opens no graph. |
| Output consistency | One `Listing` shape renders one way everywhere; every cap prints its true total; every result's limitations are printed. |
| Documentation | README covers architecture, a command reference, examples, output rules, errors, performance and limitations. |
| Boundary violations | None in code. `better-sqlite3` and `ts-morph` are in the installed closure through the pipeline and must be — stated rather than glossed. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **The profile reported a meaningless `cache hits: 0`.** Each capability keeps its own cache under the CLI's shared one, so repeats are absorbed a level down and never reach the outer counter. A zero read as "the cache is not working". | Report distinct database reads only, and say in the code why a hit rate cannot be measured at that layer. |
| **The reuse test asserted an unobservable property** — that hits exceed reads. | Replaced with one that is observable and meaningful: `symbol` drives three capabilities and costs fewer reads than running them as separate commands. |

### Real Repository Validation — every command against TraceIQ

190 files, 2,448 declarations, 2,662 nodes, 10,492 edges, 2,674 call edges.

| Command | Wall clock | Reads | Result |
|---|---|---|---|
| `scan` | **1.45 s** | — | 190 files, 2,448 declarations, 9,608 unbound calls |
| `overview` | 0.20 s | 2,484 | coverage 0.2177, max depth 4, 685 isolated declarations |
| `architecture` | 0.20 s | 2,868 | Class 47, Interface 196, Function 367, Method 264, Variable 428 |
| `packages` | 0.18 s | 2,484 | **19 packages**, largest `packages/explorer` at 363 declarations |
| `package` | 0.22 s | 2,484 | `packages/health`: 14 files, 308 declarations |
| `file` | 0.20 s | 2,487 | per-file declarations, imports, externals |
| `symbol` | 0.24 s | 3,357 | `format.ts#table`: 23 callers, 2 callees, 27 references |
| `impact` | 0.18 s | 886 | `format.ts#heading`: 27 direct, 3 indirect, 136 unknown |
| `routes` | **0.13 s** | **1** | 0 — TraceIQ registers no Express routes |
| `route` | — | — | covered by the pipeline fixture, which has a real chain |
| `health` | 0.20 s | 2,484 | full metrics and findings |
| `search` | 0.21 s | 2,484 | `render` → 21 declarations |
| `dependencies` | 0.25 s | 2,588 | `packages/explorer`: closure 80, component 100 |
| `cycles` | 0.19 s | 2,484 | 17 call cycles, largest 2 |
| `hotspots` | 0.20 s | 2,484 | largest fan-in 63 — `explorer/src/types.ts#Listing` |

Largest output: `health` at 7.2 KB. Every read command is a fresh process paying its own start-up.

### Files

Created: `packages/pipeline/` — `types.ts`, `repository-pipeline.ts`, `index.ts`, `package.json`,
`tsconfig.json`. `apps/cli/` — `types.ts`, `errors.ts`, `format.ts`, `render.ts`, `session.ts`,
`commands.ts`, `cli.ts`, `index.ts`, `bin/traceiq.js`, `cli.test.ts`, `pipeline.test.ts`,
`package.json`, `tsconfig.json`, `README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`. **No analysis
package changed.**

### Decisions

| Decision | Reason |
|---|---|
| `@traceiq/pipeline` owns scan and open | The only way the CLI can build and read a graph without importing nine forbidden packages. Reused by the REST API and the context builder next. |
| `run(argv, io)` returns a status | A function, not a script: nothing exits the process, nothing is global, and the whole CLI is testable by calling it. |
| One `CachingGraph` per invocation, capabilities built lazily | A command driving three capabilities reads the database once; a command needing none of them reads nothing. |
| A fixed revision timestamp | Two scans of one repository produce identical databases. Nothing reads it back, so reproducibility costs nothing. |
| Three exit statuses, not one | A script can tell "I typed it wrong" from "it is not there". |
| Hand-written argument parsing | The grammar is two options and a verb; a dependency for that would be a larger surface than the thing it parses. |
| Profile reports reads, not a hit rate | The inner caches make a hit rate unmeasurable at this layer; reporting one would mislead. |
| No timing in any output | Output must be byte-identical for identical input. |

### Known Limitations

- **A scan is a full rebuild**; there is no incremental update.
- **One repository per database**, selected with `--db`.
- **Terminal lists cap at 20 rows** with the true total shown; the CLI does not page.
- **`better-sqlite3` and `ts-morph` are in the installed closure** through the pipeline, and must be.
  No SQLite or compiler concept reaches CLI code.
- Everything inherited from below — uncomposed route prefixes, partial call coverage, `INFERRED`
  calls, no interface dispatch, path-derived packages, cross-package imports outside the analysed set
  — each printed in the `Limitations` section of the command it affects.

### Approvals Needed Before the REST API

1. **Whether `@traceiq/pipeline` should gain incremental scanning.** A full rebuild is 1.45 s here and
   will not stay that way; an HTTP surface will want to re-scan without blocking.
2. **Whether the scanner should read sibling workspace packages' sources**, so package dependencies
   stop being empty on every monorepo. Carried forward and now visible in `traceiq packages`.
3. **A `getNodesWithRole(role)` accessor on the Graph API.** About 2,300 of every command's 2,484
   baseline reads are `getRoles`.
4. **Whether the CLI should gain `--json`.** An HTTP surface will need the same results as data, and
   the capability results are already plain JSON-safe objects — but it doubles the output surface, so
   it is not added unilaterally.
5. **Whether the Framework Extractor should emit mount annotations**, the only route to composed paths.
6. Carried forward: four narrow Query Engine operations; a batch node accessor; `SourceRange` to
   `@traceiq/types`; a property or member-access relationship; interface dispatch as a relationship; a
   multi-link `this` unresolved reason; property-initializer constructions.

### Next Milestone

TraceIQ REST API.

## Repository Navigation

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,422 passing across 49 files (101 in this package).

### Completed Work

New `@traceiq/navigation`: `RepositoryNavigator` with four operations — `explainRoute`, `routes`,
`architecture`, `dependencies` — plus `profile`. It combines Explain Route, Architecture Explorer and
Dependency Explorer into one layer that every future interface consumes.

**Explain Route** takes a method and path — `{ method: 'GET', path: '/users/:id' }` — or an identifier,
composes the frozen `route:<METHOD>:<path>` identity and **looks it up** rather than trusting it. It
returns the chain in running order with the whole `ExplainSymbolResult` per handler, the controller,
service and repository reached with their depths, dependencies, environment variables, external
packages, impact, call-graph and health summaries, the handlers that could not be linked, and the path
composition state.

**Architecture navigation** adds four trees: `architectureTree` (roles then kinds), `packageTree`
(package → file → declaration), `roleTree` (role → package → declaration) and `dependencyTree`
(package → package with edge counts).

**Dependency navigation** accepts a package, a file, a declaration or a route, adds the three
relationship graphs separated by type, and merges per-node answers rather than re-walking.

### Architecture decision requiring note

**One graph read for the whole layer.** `RepositoryExplorer` is constructed over navigation's own
`CachingGraph`, so the explorer's cache delegates here on a miss and only the explorer builds a
whole-graph index. Navigation never builds a second one — asserted: `getNodes` is called 16 times and
`getEdges` 13 times, not twice that.

**Impact Analysis and Repository Health are reused through Repository Explorer, not directly**, which
is why they are not direct dependencies. Constructing either here would build a second cache and a
second index over the same revision.

No new infrastructure package was introduced, and no frozen package changed.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | Four operations, five runtime dependencies, all repository intelligence packages. |
| Reuse | Verified by test: a repeated operation reads **nothing** from the database, and the index is built once. |
| Performance | 72 ms cold for the first operation, 5.45 ms warm; every other operation 0.04–22.9 ms. |
| API consistency | Every list is a `Listing` with `total` and `truncated`; `null` for a subject the graph lacks; identifier-or-name selectors throughout. |
| Duplicate traversals | None. Navigation performs no traversal of its own — it asks the explorer, which owns the closures. |
| Duplicate assembly | **Found and fixed:** the architecture response embedded the explorer's `ArchitectureView` *and* restated it as `architectureTree`. |
| Documentation | README covers the public API, architecture, route model, architecture model, dependency model, performance, examples and limitations. |
| Edge cases | Empty repository, no routes at all, a route whose whole chain is unlinked, a single-package repository — all covered. |
| Large repositories | A 12-package monorepo with a dependency ring and a 400-symbol file for cap behaviour. |
| Monorepos | The package unit is path-derived; cross-package edges are recovered wherever an import targets an in-repository declaration, and reported as a limitation where it cannot be. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **A role sat on a container while reach landed on its members**, so `repositories` was empty for a route that plainly calls `UserRepository.load` — the role is on the class, the reach on the method. Found by a failing test asserting the obvious. | A role-bearing declaration counts as reached when any of its own members is, at that member's depth, read from the frozen `sym:<path>#<chain>` identity. |
| **Wrapping an already-capped explorer list lost its true total.** The architecture tree reported 100 functions for a 400-function repository, and the role tree reported 100 tests where the repository has 177. | Added `mapListing`, which transforms entries while keeping `total` and `truncated`. Both trees now report true totals. |
| **The architecture response duplicated itself** — the explorer's `ArchitectureView` embedded alongside `architectureTree`, which carries the same declarations. 766 KB on this repository. | The explorer's grouping is used to build the trees and not re-emitted. Response dropped to **343 KB**. |
| **A route's environment variables covered only the immediate handlers**, so a handler delegating to a service reading `JWT_SECRET` reported none — inconsistent with `services` and `repositories` being reach-based. | Environment variables are now reach-based too. |
| **The same role→nodes mapping was written three times** across the route explanation, the architecture tree and the role tree. | One `roleGroupsOf` helper, written as a literal so a new role in the vocabulary is a compile error rather than a silently missing group. |
| **`@traceiq/health` and `@traceiq/impact` were declared as runtime dependencies but never imported.** | Removed. They are reused through the explorer, which is the correct direction. |

### Real Repository Validation — TraceIQ itself

| | Value |
|---|---|
| Largest package | `packages/explorer` — 13 files, **363 declarations** |
| Largest dependency graph | 518 nodes, 2,291 `IMPORTS`/`EXPORTS` edges |
| Largest route chain | **0** — TraceIQ registers no Express routes; the pipeline fixture covers a real 2-link chain |
| Largest middleware chain | 0, same reason |
| Largest architecture group | `Variable` — **414** declarations; then `Function` 321, `Method` 249, `Interface` 186, `Test` 177 |
| Largest dependency closure | `packages/explorer` — **112** nodes |
| Largest navigation tree | `packageTree` — 268 KB over 17 packages |
| Largest response | `architecture` — **343 KB** (was 766 KB before the duplication fix) |
| Cold `architecture` | **72.1 ms**, 2,703 graph reads, 215 explorer calls |
| Warm `architecture` | **5.45 ms** |
| `dependencies` | declaration 7.67 ms · file 1.87 ms · package 22.9 ms |
| Cross-package edges | **0** — every inter-package import resolves outside the analysed set |
| Determinism | byte-identical across calls and across instances |

### Files

Created: `packages/navigation/` — `types.ts`, `limitations.ts`, `navigation-context.ts`,
`route-explanation.ts`, `trees.ts`, `dependency-navigation.ts`, `repository-navigator.ts`,
`index.ts`, `fake-graph.test-helper.ts`, `repository-navigator.test.ts`, `pipeline.test.ts`,
`package.json`, `tsconfig.json`, `README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| One `CachingGraph`, with the explorer built over it | The database is read once for the whole layer and only one whole-graph index exists. |
| Impact Analysis and Repository Health reached through the explorer | Constructing them here would duplicate the cache and the index over one immutable revision. |
| A route is looked up, never trusted | Composing an identity is not evidence a route exists. An unregistered path yields `null` rather than an invented answer. |
| Prefix composition reported, never guessed | `effectivePath` equals the written path and `composed` is `false`, with a limitation naming it. |
| A role counts as reached through its members | Roles annotate containers; reach lands on whichever member is called. Requiring the container itself made the field silently empty. |
| Role reach follows coupling, not calls alone | A dependency wired by construction rather than an immediate call would otherwise be missed, and call coverage is itself partial. Stated as a limitation. |
| Trees carry `TreeRef`, not whole nodes | A tree is a navigation index; carrying every field would multiply a repository-wide tree into hundreds of kilobytes the caller has not asked for. |
| The explorer's grouping builds the trees and is not re-emitted | Embedding it would state the same declarations twice in one response. |
| A route subject covers its handlers | A route has no dependencies of its own — what it depends on is what its chain depends on. |
| A package subject covers its files | A package is a derived grouping rather than a node. |
| Merging, not re-walking | Shortest depth wins where two files reach the same node, and a shared cycle is reported once. |
| No timing in any response | Responses must be byte-identical for identical input. |

### Known Limitations

- **Route prefix composition is unsupported**, always reported.
- **A member-expression handler cannot be linked**, so a chain can be shorter than the code registers;
  the unlinked handlers are listed rather than omitted.
- **Role reach follows coupling**, and **roles are judgements**.
- **Call coverage is partial** with no interface or dynamic dispatch, so chains, closures and cycles are
  lower bounds.
- **The package boundary is derived from paths.**
- **Cross-package imports resolve outside the analysed set** on this repository, so `dependencyTree`
  reports zero cross-package edges.
- **Lists cap at 100**, with true totals alongside.
- **`architecture` is 343 KB**, dominated by `packageTree` over 1,993 declarations.

### Approvals Needed Before the Next Milestone

1. **Whether the scanner should read sibling workspace packages' sources**, or the Resolver map a
   workspace specifier to the in-repository package. Without one, `dependencyTree` and package
   dependencies are empty on every monorepo — now the most visible gap, since it is a headline field of
   this milestone.
2. **A `getNodesWithRole(role)` accessor on the Graph API.** Still the dominant cold-start cost.
3. **Whether the Framework Extractor should emit mount annotations**, which is the only way route prefix
   composition can ever work. Until then every route path is reported local.
4. **Whether a response-shape option belongs on the read layer** — identifiers instead of full nodes —
   to bring the largest responses down.
5. Carried forward and still open: four narrow Query Engine operations; a batch node accessor; moving
   `SourceRange` to `@traceiq/types`; a property or member-access relationship; interface dispatch as a
   relationship; a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this` chain; property-initializer
   construction tracking.

### Next Milestone

TraceIQ CLI.

## Repository Explorer

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,321 passing across 47 files (142 in this package).

### Completed Work

New `@traceiq/explorer`: `RepositoryExplorer` with ten navigation operations — `overview`,
`browseFile`, `browseSymbol`, `browsePackages`, `browsePackage`, `dependencies`, `architecture`,
`cycles`, `hotspots`, `search` — plus `profile` for measurement. This is the read layer every future
interface consumes.

**It reuses rather than reimplements.** Explain Symbol assembles a symbol and is carried **whole** on
`SymbolView.explain` rather than re-flattened. Impact Analysis supplies the dependents closure.
Repository Health supplies the whole-graph index, coupling metrics, components and algorithms. The
Query Engine supplies routes, references, callers and callees, and `parseRouteId` reads route
identity. The only traversal written here is the **forward** closure, which no existing capability
performs.

**One memoising graph adapter.** `CachingGraph` wraps the Graph API, and all four reused capabilities
are constructed over that one instance — so three capabilities reading the same node cost one read.
Caching is sound because every wrapped operation is a pure read of one immutable revision.

### Architectural decision requiring note

**The package unit is derived, and every response that uses it says so.** The graph records no package
boundary — the specification omits `Repository` and `Directory`, and `packageJsonPath` never reaches
the graph — so a package is the first two segments of a file path, one fixed rule with no hardcoded
directory names and no configuration. Chosen in answer to a question put before implementation.

No new infrastructure package was introduced, and no frozen package's responsibilities moved.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | Ten operations, one class, six runtime dependencies — exactly the allowed layers. |
| Correctness | **A NUL byte in a composite key silently broke package dependency detection.** See below. |
| Duplication | `mostCoupled` and `mostConnectedDeclarations` computed the **same measure**; they now count distinct neighbours and total relationships respectively. Dead code — `void` placeholders, unused re-exports and needlessly nested functions — removed from `views.ts`. |
| Performance | 40 ms cold for the first operation, then 0.06–2.34 ms. The whole graph is read once per instance, never once per operation. |
| Determinism | Byte-identical across repeated calls and across two explorers over one database. No timing in any response. |
| Documentation | README covers purpose, public API, architecture, navigation model, package unit, performance, examples, determinism, limitations and testing. |
| API consistency | Every list is a `Listing` with `total` and `truncated`; every "not that kind of thing" is `null`; every node carries its full `GraphNode` so any result navigates to any operation. |
| Code reuse | Verified by test: `browseSymbol` drives three capabilities and a second call adds zero graph reads. |
| Dead code | Removed as above. |
| Boundary violations | None. `better-sqlite3` absent from the runtime closure; no Project Host, Resolver or Graph Builder import. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **A literal NUL byte in five source lines**, from my own authoring. In `explorer-context.ts` the package key was built as `` `${from}\0${to}` `` and split on `' '`, so **every package dependency and dependent silently read zero**. The other four were opaque cache keys where NUL is harmless — but a NUL makes the file binary to `grep`, which is how it stayed invisible. | The composite string key is gone: `crossingEdges` is now a nested `from → to → edges` map, so there is nothing to encode or split. The remaining separators are written as the `\u0000` escape, keeping the files text while retaining a separator that cannot occur in a path. Verified no source file in the workspace contains a NUL. |
| **Two hotspot measures were identical.** `mostCoupled` and `mostConnectedDeclarations` both ordered by `fanIn + fanOut`. | `mostCoupled` counts distinct neighbours; `mostConnected*` counts total relationships. They now give genuinely different answers — the second surfaces files with many repeated relationships. |
| **Dead code in `views.ts`** — `void` placeholders, an unused re-export line, and section builders needlessly nested inside `overviewOf`. | Removed; the four summary builders are now top-level functions taking the health report. |
| **Package dependency zeros looked like a bug.** On TraceIQ every inter-package import resolves to `ext:outside-analysis`, because sibling packages resolve through `dist/` which the scanner excludes. | Added `cross-package-imports-resolve-outside-analysis` as a reported limitation carrying the count, so a zero reads as an explained fact. A fixture test proves the mechanism works when an import targets an in-repository declaration. |

### Real Repository Validation — TraceIQ itself

| | Value |
|---|---|
| Overview | 163 files, 1,993 declarations, 2,180 nodes, 8,328 edges |
| Packages | **16** derived, largest `packages/health` and `packages/explorer` at 308 and 320 declarations |
| Largest dependency graph | 518 nodes, 2,291 `IMPORTS`/`EXPORTS` edges |
| Largest call graph | 464 nodes, 1,808 `CALLS` edges, coverage 21.5% |
| Largest SCC | **2** nodes — the repository has no large tangle |
| Cycles | 16 call cycles (14 of them one-node), 0 import, 0 reference, 0 inheritance |
| Largest fan-in | **63** — `explorer/src/types.ts#Listing` |
| Largest fan-out | **13** — `explorer/src/search.ts#searchOf` |
| Most connected file | `graph/src/graph-builder.test.ts`, 25 relationships |
| Largest file | `health/src/graph-index.ts`, 43 declarations |
| Largest declaration | `health/src/graph-index.ts#GraphIndex`, fan-in 29 |
| Largest search result | `role: 'Test'` → 164 declarations; `path: 'packages/health'` → 308 |
| Largest explorer response | `architecture` 420 KB, `hotspots` 412 KB; `overview` 4.6 KB |
| Cold first operation | 40.4 ms, 2,078 Graph API calls |
| Every later operation | 0.06–2.34 ms |
| Determinism | byte-identical across calls and across instances |

### Files

Created: `packages/explorer/` — `types.ts`, `caching-graph.ts`, `explorer-context.ts`, `listing.ts`,
`views.ts`, `search.ts`, `limitations.ts`, `repository-explorer.ts`, `index.ts`,
`fake-graph.test-helper.ts`, `repository-explorer.test.ts`, `search.test.ts`, `pipeline.test.ts`,
`package.json`, `tsconfig.json`, `README.md`.

Modified: `packages/health/src/graph-index.ts` (two literal NUL bytes replaced by the `\u0000`
escape — no behaviour change, and a frozen package left textually greppable); root `README.md`,
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| One memoising Graph API adapter shared by every reused capability | Reuse would otherwise cost one full graph read per capability. Sound because every wrapped operation is a pure read of one immutable revision. |
| Reuse Repository Health's index and algorithms rather than writing a second copy | The alternative is duplicated traversal logic, which the milestone forbids and which would drift. |
| `SymbolView` carries the whole `ExplainSymbolResult` | Re-flattening it would duplicate assembly and let the two answers diverge. The explorer adds only what Explain Symbol does not: children, impact and health summaries, and the package. |
| Shared state is lazy and per-instance | An operation that needs no index pays for none; an instance is a snapshot of one revision, so repeated calls are identical by construction. |
| A composite key is a nested map, never an encoded string | The one encoded key in this package silently returned zeros for a whole section. Nested maps cannot be mis-split. |
| Every list is a `Listing` with `total` and `truncated` | A cap must never be silent, and one shape across every operation makes the API predictable. |
| `null` for the wrong kind of identifier | A hollow response would claim nothing is recorded when the truth is that this is not that kind of thing. |
| `profile` wraps rather than instruments | Keeps ten operations free of profiling concerns, and measures what reached the graph after caching rather than what was asked for. |
| No timing in any response | Elapsed time differs between runs; responses must be byte-identical. |
| Search is case-sensitive | Case folding is a second rule to get wrong, and the milestone asks for exact and prefix only. |
| An empty query matches nothing | Returning the whole repository for `{}` would be an accident, not a search. |

### Known Limitations

- **The package boundary is derived from paths**, not recorded.
- **Cross-package imports may resolve outside the analysed set**, so package dependency counts are
  zero on TraceIQ. Reported as a limitation with its count.
- **A call cycle may be false self-recursion** — the multi-link `this` chain defect, carried forward.
- **The connected component can span the repository**: 1,662 of 2,180 nodes here. It says what is
  reachable, not what is cohesive.
- **A file rarely has incoming relationships**, since `IMPORTS` targets declarations.
- **Lists cap at 100**, with the true total alongside.
- **`architecture` and `hotspots` responses are ~420 KB**, dominated by capped lists of full nodes.
- Everything inherited from below: partial call coverage, `INFERRED` calls, no interface or dynamic
  dispatch, no property or member-access relationship.

### Approvals Needed Before the Next Milestone

1. **A `getNodesWithRole(role)` accessor on the Graph API.** About 1,900 of the explorer's 2,078
   cold-start calls are `getRoles`, one per declaration. This is now the dominant cost of the read
   layer as well as of Repository Health.
2. **Whether the scanner should read sibling workspace packages' sources**, or the Resolver should map
   a workspace specifier to the in-repository package. Without one of these, no monorepo can report
   package-to-package dependencies — the single largest gap in the explorer's output.
3. **Whether a response-shape option belongs on the explorer** — for example returning identifiers
   instead of full nodes — to bring `architecture` and `hotspots` below ~420 KB. It would make the API
   larger, so it is not done unilaterally.
4. **Four narrow Query Engine operations**, carried forward and still open.
5. **A batch node accessor on the Graph API**, carried forward.
6. **Moving `SourceRange` to `@traceiq/types`**, carried forward — `ts-morph` remains in the runtime
   closure of every graph reader, including this one.
7. **A property or member-access relationship**, carried forward.
8. **Interface dispatch as a graph relationship**, carried forward.
9. Carried forward: a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this` chain — which is what
   produces the false self-recursion above — and whether property-initializer constructions should be
   tracked.

### Next Milestone

Repository Navigation.

## Repository Health

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,179 passing across 44 files (131 in this package).

### Completed Work

New `@traceiq/health`: `new RepositoryHealthAnalyzer(graphApi).analyze()` →
`RepositoryHealthReport`. One method, no arguments. Ten sections — summary, architecture,
dependency health, call graph health, routing, environment, findings, metrics, limitations and
analysis statistics — every one derived from the graph as it stands.

**One pass over the graph.** `buildGraphIndex` is the only code that touches it: `getNodes` per node
kind, `getEdges` per relationship type, `getRoles` per declaration, `getUnresolved` once. Everything
after is a function of that index plus a `Derived` bundle of shared values, so no section can
re-traverse. Graph API calls are `16 + 13 + 1 + declarations` — fixed in the vocabularies and linear
in declarations, never in edges or findings.

**No Query Engine operation was added, and no existing module changed.**

### Architectural decision requiring note

**Health reads the Graph API, not the Query Engine.** It is the one capability that must read the
*whole* graph — a count of classes, a fan-in distribution and a dependency cycle are statements about
every node and every edge — and no Query Engine operation enumerates. The Graph API is the abstract
read model, explicitly designed so a reader depends on it without SQLite entering its dependency
tree, and it is not in the milestone's forbidden list. Consumed through a four-operation
`HealthGraph` interface. `@traceiq/query` is used for exactly one thing: `parseRouteId`.

No new infrastructure package was introduced. `graph-algorithms.ts` stays local because nothing else
in the workspace needs strongly connected components today.

### Self Review

| Criterion | Finding |
|---|---|
| Correctness | **Two defects found by running against TraceIQ itself** — see below. |
| Architecture | One package, one class, one method; four-operation consumed interface. |
| Determinism | Identifier-ordered reads, documented sorts with identifier tiebreaks, no timing in the report. Byte-identical across runs. |
| Duplicate work | `Derived` exists for this: call components, coupling metrics, module dependency graph and call depth each had two consumers and were being computed twice. Fixed during implementation. |
| Repeated traversals | None after the index. Asserted by a call-counting fake. |
| API simplicity | `analyze()`. No options, no thresholds to configure. |
| Unnecessary abstractions | `metricOf` was duplicated between `sections.ts` and `derived.ts`; removed. |
| Documentation | README covers architecture notes, analysis strategy, category descriptions, metric definitions, cycle handling, duplicate elimination, complexity and limitations. |
| Naming | `REFERENCE_TYPES` names the containment exclusion rather than hiding it in a filter. |
| Test quality | 131 tests: algorithms directly, sections against a known-shape graph, stress, determinism, five unusual repositories, and a pipeline test over a deliberately unhealthy fixture. |
| Edge cases | Empty repository, single file, all-isolated, pure cycle, file with no declarations — all covered, all returning zeroes rather than `NaN`. |
| Cycle handling | Iterative Tarjan; 50,000-node stress tests. |
| Performance | ~37 ms on this repository. The one inefficiency is `getRoles` — see below. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **Containment counted as a reference.** `DECLARES` was in the coupling index, so every member had an incoming edge from its own container: `isolated` was 0, `withoutIncoming` was 0 and `fanIn.min` was 1 across the entire repository — nothing could ever read as unreferenced. Every file's fan-out was also inflated by its declaration count. Found by running against TraceIQ and disbelieving the numbers, not by a test. | Added `REFERENCE_TYPES`, excluding `DECLARES` from coupling and from every reference-based finding while keeping it in the relationship totals. `isolated` went 0 → 464, `fanIn.min` 1 → 0, `fanOut.max` 22 → 13. |
| **Findings carried uncapped node lists**, making the report 1.5 MB — one finding held 1,058 nodes. | Capped at `SAMPLE_LIMIT` with `nodeCount` and `truncated` alongside, so the cap is never silent. Report is now 438 KB. |
| **Unreferenced counts were misleading without a caveat.** 1,079 of 1,685 declarations have no incoming reference, dominated by the 689 `Property` nodes — no relationship records a property or member access, so a property can *never* appear referenced. | Added the `property-references-not-recorded` limitation, carrying the count of unreferenced properties. |
| **`metricOf` and the SCC computation were duplicated** across `sections.ts` and `findings.ts`. | Consolidated into `derived.ts`, computed once. |

### Real Repository Validation — TraceIQ itself

| | Value |
|---|---|
| Execution time | **~37 ms** |
| Graph API calls | 1,715 — of which 1,685 are `getRoles`, one per declaration |
| Graph size | 1,864 nodes, 7,254 edges, 6,969 unresolved references |
| Files / declarations | 155 / 1,685 |
| Declaration kinds | 689 Property, 335 Variable, 231 Function, 182 Method, 135 Interface, 46 TypeAlias, 37 Class, 24 Constructor, 6 Accessor |
| Relationships | `CALLS` 1,808, `IMPORTS` 1,704, `DECLARES` 1,685, `REFERENCES_TYPE` 1,454, `EXPORTS` 587, `EXTENDS` 11, `IMPLEMENTS` 5 |
| Call graph | 464 nodes, 1,808 edges, **coverage 20.6%**, 115 entry points, max depth 4 |
| Call clusters | 41 components, largest 65, 2 singletons |
| Cycles | 6 — four self-recursive functions and two mutual pairs, 8 declarations in total |
| Largest fan-in | 29 — `health/src/graph-index.ts#GraphIndex` |
| Largest fan-out | 13 — `RepositoryHealthAnalyzer.analyze` and a test fixture |
| Most coupled file | `health/src/index.ts`, fan-out 45 |
| Isolated declarations | 464 |
| No incoming reference | 1,079 — dominated by 689 properties, which cannot be referenced in this model |
| Metrics | 10.87 declarations per file, 2.00 references per declaration, density 0.0021, reference coverage 51% |
| Externals | 7 npm, 12 TypeScript built-ins, 4 Node builtins; `vitest` imported by 45 files |
| Determinism | byte-identical across runs; report 438 KB |

The largest connected call cluster covering 65 of 464 call-graph nodes, against 41 components,
matches a workspace of independent packages joined by a shared core.

### Files

Created: `packages/health/` — `types.ts`, `graph-index.ts`, `graph-algorithms.ts`, `derived.ts`,
`sections.ts`, `findings.ts`, `limitations.ts`, `statistics.ts`, `repository-health-analyzer.ts`,
`index.ts`, `fake-graph.test-helper.ts`, `graph-algorithms.test.ts`,
`repository-health-analyzer.test.ts`, `pipeline.test.ts`, `package.json`, `tsconfig.json`,
`README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| Reads the Graph API rather than the Query Engine | No Query Engine operation enumerates nodes or edges, and health is a statement about all of them. The Graph API is the read abstraction and carries no storage concept. |
| One index, then pure computation | Makes re-traversal impossible rather than merely discouraged, and gives every section one consistent snapshot. |
| Containment excluded from coupling | A class declaring a method is not a reference to it. Including it made every declaration look referenced. |
| No overall health score | A single number would be a judgement dressed as a measurement, and the milestone forbids scoring. |
| "High" fan-in is the repository's own p90 | A fixed threshold would be a guess. A percentile of the measured distribution is a fact, and a uniformly connected repository correctly produces no such findings. |
| `maxCallDepth` is shortest-from-a-root, maximised | Longest path is not polynomial on a cyclic graph. A metric that cannot be computed exactly should not be reported as if it were. |
| Percentiles use nearest-rank | Every reported figure is a value that actually occurs, rather than an interpolation between two. |
| Module dependency graph is projected through `fileId` | `IMPORTS` targets declarations, so file cycles are almost never `File → File` edges. The projection recovers the graph engineers mean without inventing a relationship. |
| A finding's confidence is the weakest observed among the relationship types it rests on | A finding about calls can be no stronger than the call graph. Nothing is aggregated per edge, which the graph specification forbids. |
| Aggregated findings for many comparable nodes, per-occurrence for specific ones | A thousand "never referenced" findings would bury the report; one cycle per finding is exactly right. |
| `statistics` carries no timing | Elapsed time differs between runs and the report must be byte-identical. Timing is measured around `analyze`. |
| Iterative Tarjan | A health analyser meets the worst case; recursion would overflow on a deep chain. Stress-tested at 50,000 nodes. |

### Known Limitations

- **A reference absence is not proof of disuse** — dynamic access, framework entry points and
  unresolved references all leave no edge.
- **No property or member-access relationship exists**, so a property can never appear referenced.
  689 property nodes dominate any unreferenced count on this repository.
- **Call coverage is 20.6%** and every `CALLS` edge is `INFERRED`, so every call-graph figure is a
  lower bound; clusters and depth understate how the code connects.
- **Duplicate route identities collapse**; a duplicate is visible only as two handler edges at one
  position.
- **Module-level calls are attributed to files**, so files appear among callers.
- **No history**, so no trend can be reported.
- **`getRoles` is called once per declaration** — 1,685 of 1,715 Graph API calls — for want of a role
  index.

### Approvals Needed Before the Next Milestone

1. **A `getNodesWithRole(role)` accessor on the Graph API.** 1,685 of 1,715 calls in a health run are
   `getRoles`, to find 150 annotations. This is now the dominant cost of two capabilities — health
   and the Query Engine's `findByRole` — and is the clearest remaining performance item.
2. **Four narrow Query Engine operations**, carried forward and still open: `findRoutesFor(id)`,
   `findEnvironmentVariablesFor(id)`, `findDependenciesFor(fileId)` and `findUnresolvedFor(id)`, the
   last needing an optional source filter on `getUnresolved()`. Worth ~48 ms per Explain Symbol and
   per Impact Analysis call.
3. **Whether a batch node accessor belongs on the Graph API.**
4. **Whether `SourceRange` should move from `@traceiq/ir` to `@traceiq/types`**, removing `ts-morph`
   from the runtime closure of every graph reader.
5. **Whether a property or member-access relationship should be recorded.** Without one, 689 of this
   repository's declarations can never appear referenced, which limits health, impact and explain
   alike. The IR already records `memberAccesses`; nothing turns them into edges.
6. **Whether interface dispatch should become a graph relationship**, carried forward.
7. Carried forward: a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this` chain, and whether
   property-initializer constructions should be tracked.

### Next Milestone

Repository Explorer.

## Impact Analysis

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
1,048 passing across 41 files (80 in this package).

### Completed Work

New `@traceiq/impact`: `new ImpactAnalyzer(queryEngine).analyze(id)` →
`ImpactAnalysisResult | null`. Every requested field is present — target, directly and
indirectly affected, callers, callees, type references, imports, routes affected, environment
variables, external dependencies, unresolved relationships, confidence, provenance, known
limitations — plus `statistics`, so a caller can see the shape and cost of the closure it got.

**No Query Engine operation was added.** The traversal is one breadth-first walk along incoming
edges using `findReferences` as the only primitive, which covers `CALLS`, `REFERENCES_TYPE`,
`IMPORTS`, `EXPORTS`, `EXTENDS`, `IMPLEMENTS` and `HANDLED_BY` in one call per node. The four
whole-collection queries are issued **once each** however large the closure grows, and
`findRoutes` only when the walk actually passed a `HANDLED_BY` edge.

**Direction.** The closure follows dependents. Callees are reported at depth 1 and never
expanded: a callee does not break when the target changes, so its own callees are not affected.

### Self Review

| Criterion | Finding |
|---|---|
| Architecture | One package, one class, one method. Runtime deps are `query`, `graph-api`, `types`. |
| Traversal correctness | Asserted against a fixture with a known closure — five nodes at depth 1, three at depth 2, one at depth 3. Inheritance and re-export propagation were **missing from the tests and were added** during review. |
| Duplicate paths | Eliminated per node at shortest depth; edge-level fields keep every edge. Asserted. |
| Cycle handling | Self-call, two-node cycle and import cycle all terminate; a node joins `visited` on discovery. Asserted. |
| Deterministic ordering | Breadth-first FIFO, nothing sorted. 100 declarations analysed twice: 100 byte-identical. |
| Explainability | Every affected node carries the edge that reached it, and `via.targetId` walks the path back to the target without storing paths. |
| Performance | ~43 ms per analysis, of which the traversal is under 1 ms. Itemised below. |
| API simplicity | `analyze(id)`. The consumed surface is an explicit seven-operation interface. |
| Documentation | README covers traversal strategy, why DIRECT, why INDIRECT, why UNKNOWN, cycle handling and duplicate elimination, as specified. |
| Missing tests | Inheritance (`EXTENDS`/`IMPLEMENTS`) and re-export (`EXPORTS`) propagation were absent. Added, four tests. |

### Defects Found and Fixed During Review

| Defect | Fix |
|---|---|
| **`UNKNOWN` was dominated by irrelevant noise.** Analysing `QueryEngine` produced 522 unresolved entries against a 7-node closure: a file joins the closure by importing the target and then contributes every unbound top-level call in it, which on a test-heavy repository is hundreds of `expect(...)` calls. Found by measuring against the real repository, not by the tests. | Added `scope: 'declaration' \| 'file'` to every entry, so the 6 that matter are separable from the 71 that do not, and a `file-level-unresolved-dominates` limitation that fires when files outnumber declarations. Nothing is dropped and no heuristic is applied. |
| **The genuinely important `UNKNOWN` fact was missing entirely.** Unresolved references *elsewhere* in the repository could each have been an edge into the closure had they bound — that is what makes the affected set possibly incomplete — and nothing reported it. | Added `closure-may-miss-hidden-dependents`, carrying the repository-wide count. It cannot be attributed to a target without guessing, so it is a count rather than entries. |
| **`filesOf` was computed twice** and the file set was rebuilt inside `#externalDependencies`. | Computed once in `analyze` and passed to both consumers. |

### Measured on this repository

| | Value |
|---|---|
| Per `analyze` | ~43 ms, ~6,220 Graph API calls |
| `findUnresolved` share | 5,291 `getNode` calls, ~42 ms |
| `findDependencies` share | ~833 calls, ~7 ms |
| Closure traversal | 1 `findReferences` per node; under 1 ms |
| Closure size over 200 declarations | min 1, median 3, max 19–30 |
| Determinism | 100 analysed twice, 100 identical |

Example — `AuthService.verify` three deep: DIRECT 10, INDIRECT 5, depths {1: 10, 2: 4, 3: 1}.

### Files

Created: `packages/impact/` — `types.ts`, `limitations.ts`, `dependents-closure.ts`,
`impact-analyzer.ts`, `index.ts`, `fake-queries.test-helper.ts`, `impact-analyzer.test.ts`,
`pipeline.test.ts`, `package.json`, `tsconfig.json`, `README.md`.

Modified: root `README.md`, `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

**No existing module changed.** No Query Engine operation was added, and no completed milestone
was touched.

### Decisions

| Decision | Reason |
|---|---|
| The closure follows dependents only | A caller breaks when the target changes; a callee does not. Expanding callees would fill the result with declarations a change cannot reach. Callees are still reported at depth 1, as an edge list rather than as affected nodes, so the two ideas are not merged. |
| `findReferences` is the only traversal primitive | It returns every incoming edge except `DECLARES`, so one call per node covers all seven propagating relationship types. Asking per-type would multiply queries for the same rows. |
| A `File` is expanded like a declaration | A module-level call is attributed to its file, so a file really does depend on what those calls reach. Stopping at files would silently lose every top-level invocation's impact. Reported as the `file-level-attribution` limitation, since it is coarse. |
| A `Route` is diverted, never expanded | Nothing references a route, so expanding one always finds nothing, and the category vocabulary puts every route reaching the declaration in `INDIRECT`. Keeping routes out of the affected-declaration lists is what stops the categories merging. |
| `DECLARES` is not traversed | A class does not depend on its own member, so changing a method should not report its class as affected. Containment is a different question, answered by `findEnclosingDeclaration`. |
| Depth is the shortest distance | Breadth-first gives it for free, and it is the only non-arbitrary choice when several paths reach a node. |
| Duplicates eliminated per node, kept per edge | One affected node with the first edge that reached it; but "where are the call sites" needs every edge, so the edge-level fields keep them all. |
| No confidence is aggregated along a path | The graph specification forbids recomputing confidence. Each edge carries its own, and the result carries the target's — combining them would invent a fact. |
| `via` instead of a stored path | `via.targetId` is the node it was reached through, so a path back to the target is walkable at zero storage cost and with no risk of a stale copy. |
| Its own limitation vocabulary, not shared with `@traceiq/explain` | The two report different things. One table serving both would grow codes that only ever apply to one, and coupling two capabilities to make nine strings shared is the wrong trade. |
| No Query Engine operation added | The traversal needs none: `findReferences` suffices, and the whole-collection queries are reused rather than repeated. The 43 ms is inside the Query Engine, not in repeated traversal. |

### Known Limitations

- **No interface or dynamic dispatch.** An interface method with three implementations yields no
  edge to any of them, so changing the interface method does not report them. The largest
  correctness boundary, and no traversal can fix it — reported as a limitation on every result.
- **~43 ms per analysis**, dominated by two Query Engine operations that hydrate the whole
  repository before this package scopes them.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED`, so the closure can be
  narrower than the code.
- **No signature awareness.** Every dependent is reported for any change; the graph records no
  parameter or return type, so "this change is source-compatible" cannot be expressed.
- **Files are affected as a whole**, even when one top-level statement depends on the target.
- **`externalDependencies` is file-scoped.**
- **Containment is not followed**, deliberately.
- **Route prefixes are not composed.**

### Approvals Needed Before the Next Milestone

1. **Four narrow Query Engine operations** — re-raised, and now the more pressing of the two
   capabilities, since impact analysis is the natural thing to run over many declarations.
   `findRoutesFor(id)`, `findEnvironmentVariablesFor(id)`, `findDependenciesFor(fileId)` — all
   already supported by the Graph API — and `findUnresolvedFor(id)`, which additionally needs an
   optional source filter on `getUnresolved()`. Takes one analysis from ~43 ms to about 1 ms.
2. **Whether a batch node accessor belongs on the Graph API.** One `getNode` per edge is what
   makes `findUnresolved` cost 5,291 reads.
3. **Whether `SourceRange` should move from `@traceiq/ir` to `@traceiq/types`**, removing
   `ts-morph` from the runtime closure of every graph reader.
4. **Whether interface dispatch should become a graph relationship.** Today an interface method
   call produces no edge, so impact analysis cannot report implementations. Recording candidate
   implementations — as an `AMBIGUOUS` candidate group, which the vocabulary already supports —
   would be the single largest improvement to impact accuracy. It is a Resolver change and well
   outside this milestone.
5. Carried forward, still open: a new `UNRESOLVED_CALL_REASONS` value for a multi-link `this`
   chain, and whether property-initializer constructions should be tracked.

### Next Milestone

Repository Health.

## Explain Symbol

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
968 passing across 39 files (69 in this package).

### Completed Work

New `@traceiq/explain`: `new SymbolExplainer(queryEngine).explain(id)` →
`ExplainSymbolResult | null`. Every requested field is present — declaration, kind, source
file, source locations, enclosing declaration, incoming and outgoing `CALLS`, references,
type references, routes reaching the declaration, environment variables read, external
dependencies, confidence, provenance, unresolved relationships, known limitations.

**Query Engine gained one operation, approved in advance:** `findEnclosingDeclaration(id)`.
`findReferences` deliberately excludes `DECLARES`, so containment had no accessor at all. It
returns the container **with the `DECLARES` edge**, so containment can be justified rather
than asserted, and it costs one `getIncoming` plus one `getNode`.

**No other module changed.** `pnpm why better-sqlite3 --prod` against `@traceiq/explain`
returns nothing, so SQLite, the Graph Builder, the Graph Store and the Project Host are all
absent from the runtime closure. `ts-morph` **is** in it — `@traceiq/graph-api` takes
`SourceRange` from `@traceiq/ir` — which is stated rather than glossed: no file here imports
it, and the coupling predates this milestone. See approval item 4.

### Self Review

| Criterion | Finding |
|---|---|
| API simplicity | One class, one method. The consumed surface is an explicit nine-operation interface rather than the concrete `QueryEngine`. |
| Duplicate queries | None. `incomingCalls` and `typeReferences` are projections of one `findReferences` rather than calls to `findCallers`/`findTypeReferences`, which would re-read the same edges. Asserted by a call-counting stub. |
| Unnecessary traversal | `explainRoute` is asked only about a route that matched. Three whole-collection scans remain and are unavoidable through the current Query Engine — see performance. |
| Performance | **One explain costs ~49 ms, and 98% of it is two Query Engine operations.** Measured and itemised below. |
| Documentation | README covers purpose, non-goals, the interface decision, the limitation table, determinism, the query budget, the measured cost, edge cases and testing. |
| Edge cases | `null` for a file, route, external or unknown identifier; empty lists plus general limitations for a declaration nothing refers to; two entries when a declaration appears twice in one route chain. |
| Explainability | Every relationship carries its `GraphEdge`. `enclosingDeclaration` carries the `DECLARES` edge. `unresolved` labels each entry `declaration` or `file`. |

### Measured on this repository

Per-query cost of one explain, against real SQLite:

| Query | Time | Graph API calls |
|---|---|---|
| `findDeclaration` | 0.24 ms | 2 |
| `findEnclosingDeclaration` | 0.11 ms | 2 |
| `findReferences` | 0.28 ms | 13 |
| `findCallees` | 0.10 ms | 6 |
| `findRoutes` | 0.04 ms | 1 |
| `findEnvironmentVariables` | 0.02 ms | 1 |
| **`findDependencies`** | **6.96 ms** | **833** |
| **`findUnresolved`** | **42.42 ms** | **5,292** |

The five questions about *this node* cost 0.77 ms combined; assembly is essentially free.
`findUnresolved` hydrates the source node of all 5,291 unresolved references and
`findDependencies` all 1,358 `IMPORTS` edges, after which the explainer discards all but a
handful. The narrow reverse lookups already exist on the Graph API and cost 0.012–0.020 ms
each.

Determinism verified over 150 declarations explained twice each: 150 byte-identical.

### Files

Created: `packages/explain/` — `types.ts`, `limitations.ts`, `source-file.ts`,
`symbol-explainer.ts`, `index.ts`, `fake-queries.test-helper.ts`,
`symbol-explainer.test.ts`, `source-file.test.ts`, `pipeline.test.ts`, `package.json`,
`tsconfig.json`, `README.md`.

Modified: `packages/query/src/query-engine.ts`, `types.ts`, `index.ts` and its test;
`packages/query/README.md`; root `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`.

### Decisions

| Decision | Reason |
|---|---|
| A new package | One capability, one package, as every prior milestone. It consumes the Query Engine's output, so it cannot live inside it. |
| It consumes `ExplainSymbolQueries`, not `QueryEngine` | Writing the consumed surface down makes it reviewable and countable, and no name in the interface could carry a database — storage leakage becomes inexpressible rather than merely absent. `QueryEngine` satisfies it structurally and is what production passes. |
| `incomingCalls` and `typeReferences` are projections of `findReferences` | Calling `findCallers` and `findTypeReferences` would re-read the same incoming edges. A projection also guarantees they are subsets of `references`, in the same order, instead of leaving a consumer to trust it. |
| `limitations` comes from a closed table with fixed wording | The requested output includes prose, and this milestone must not generate language. A limitation is *selected*, never composed; counts live in `affected` rather than being interpolated. So the field is deterministic and matchable on `code`. |
| `explain` returns `null` for a non-declaration | A hollow result would say "nothing is recorded about this" when the truth is "this is not a symbol". Consistent with `findDeclaration`. |
| Nothing is sorted | Every list keeps the Query Engine's order, which is itself defined. Re-ordering would be this layer inventing a presentation, and ranking is forbidden. |
| `externalDependencies` is file-scoped and says so | `IMPORTS` is recorded at a file. Claiming declaration scope would overstate what the graph knows; narrowing it needs import-usage analysis no stage performs. |
| Unresolved references are labelled by scope | A file-scoped unresolved import may be why something here did not bind, but it is not this declaration's own. Labelling lets a consumer decide instead of being told. |
| `explainRoute` is asked only about matching routes | The middleware/handler split is the Query Engine's rule. Re-deriving it here would let the two disagree, and the cost is one query per matching route — none for almost every declaration. |

### Known Limitations

- **One explain costs ~49 ms**, for the reason itemised above. Nothing is wrong in the
  result; it is a cost, and it matters most for Impact Analysis, which would call this per
  node.
- **`externalDependencies` is file-scoped**, not declaration-scoped.
- **Call coverage is partial** and every `CALLS` edge is `INFERRED`; both are reported in
  `limitations` rather than left implicit.
- **No transitive reach** — one step each way, the Query Engine being bounded by design.
- **Route prefixes are not composed**, so a reported path may sit under a mount.
- **The `File` node is not reachable**, so `sourceFile` is an identifier and path.
- **A route's `HANDLED_BY` edge appears in `references` as well as in `routes`**, since it
  is an incoming edge that is not `DECLARES`. Consistent, not duplicated.

### Approvals Needed Before Impact Analysis

1. **Four narrow Query Engine operations, to take one explain from ~49 ms to about 1 ms.**
   `findRoutesFor(id)` over `getIncoming(id, 'HANDLED_BY')`,
   `findEnvironmentVariablesFor(id)` over `getOutgoing(id, 'READS')`,
   `findDependenciesFor(fileId)` over `getOutgoing(fileId, 'IMPORTS')` — all three already
   supported by the Graph API — and `findUnresolvedFor(id)`, which additionally needs an
   optional source filter on the Graph API's `getUnresolved()`. Impact Analysis will call
   these per node, so the cost multiplies there.
2. **Whether a batch node accessor belongs on the Graph API.** Edge hydration is one
   `getNode` per edge, which is what makes `findUnresolved` cost 5,291 reads. This is the
   same gap `@traceiq/query` already recorded.
3. **Whether `SourceRange` should move from `@traceiq/ir` to `@traceiq/types`.** Because
   `@traceiq/graph-api` takes that one type from the IR package, `ts-morph` is installed in
   the runtime closure of every graph reader, including this one. Moving it removes the
   coupling for all of them and touches three files.
4. Carried forward, still open from IR Expansion: a new `UNRESOLVED_CALL_REASONS` value for
   a multi-link `this` chain, and whether property-initializer constructions should be
   tracked.

### Next Milestone

Impact Analysis.

## IR Expansion

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
894 passing across 36 files.

### Completed Work

**IR — construction is an invocation.** `new Service()` is now a `CallSiteIR` carrying
`isConstruction: true`, not a separate collection. It has a callee, arguments, a position
and it invokes a constructor, so every field a call site already has means the same thing
for it, and a consumer that ignores the flag still sees the invocation. A construction is
no longer double-recorded as a member access either: `isOutermostAccess` excludes the
callee of a `new` the same way it excludes the callee of a call.

**IR — declaration traversal enters bodies.** New `nested-declaration-extractor.ts` decides
what a body contributes; `declaration-extractor.ts` gained `extractBody`, called after
recording a function, variable, constructor, method or accessor. Recorded:

| Nested form | Kind | Why |
|---|---|---|
| `function inner() {}` | `function` | invocable by name |
| `const f = () => {}`, `const f = function () {}` | `variable` | invocable by name |
| `const svc = new Service()` | `variable` | holds an instance whose methods are invocable |
| `const n = 5`, `class Local {}` | not recorded | no call site can address it |
| `() => {}` passed inline | not recorded | anonymous, so no chain can name it |

Nesting is unbounded — `outer.deeper.deepest` — and bodies inside methods, constructors,
accessors and module-level arrows are entered.

**Call Graph — two new rules and scope-aware lookup.** `CALL_KINDS` gained `construction`
and `instance-member`. `binding-index.ts` replaced the `topLevel` map with
`declarationByPath` keyed by dotted chain, plus `chainOf` and `fileOf`, and a `lookupScoped`
helper that walks outwards from the declaration containing the call. A pre-pass over the
constructions builds a variable-to-class map, which is what binds `svc.run()`.

**Resolver: no change required.** It consumes the expanded IR unmodified. More declarations
reach it, which is additive; nothing about how a reference resolves depends on nesting.

**Graph Builder, Graph API, Query Engine: no logic change.** One constraint had to widen —
see the decision table.

### Before and after, measured on this repository

Measured on one tree with the expansion reverted in the harness, so the comparison isolates
the change rather than the repository having grown:

| | Sites | Bound | Of repository-addressable |
|---|---|---|---|
| Before | 5,953 | 1,108 (18.6%) | 28.3% |
| After | 6,157 | **1,321 (21.5%)** | **32.3%** |

| Rule | Before | After |
|---|---|---|
| `local` | 531 | 533 |
| `imported` | 489 | 489 |
| `instance-member` | — | **112** |
| `construction` | — | **99** |
| `static-member` | 57 | 57 |
| `this-member` | 31 | 31 |

| Unresolved reason | Before | After |
|---|---|---|
| `root-is-external` | 2,034 | 2,066 |
| `callee-not-addressable` | 1,249 | 1,249 |
| `root-not-bound` | 926 | 939 |
| `root-type-unknown` | 525 | **471** |
| `member-not-found` | 111 | 111 |

The 213 new edges came from 54 sites previously `root-type-unknown`, 60 previously
`root-not-bound` (a nested variable was not a declaration at all, so its root could not
bind) and 99 constructions that were not call sites. Call sites attributed to a declaration
rather than a file rose from 1,339 to 1,469. Declarations rose from 1,041 to 1,087, of which
46 are nested inside a body. Binding takes about 5 ms; the whole pipeline still writes to
SQLite and answers `findCallers`/`findCallees`.

Against the figures recorded before this milestone (5,718 sites, 1,063 bound, 18.6%), the
denominator also changed because the repository gained this milestone's tests. The table
above is the like-for-like comparison.

### Files

Created: `packages/ir/src/nested-declaration-extractor.ts`, `packages/ir/src/nesting.test.ts`.

Modified: `packages/ir/src/types.ts`, `expression-extractor.ts`, `declaration-extractor.ts`,
`declarations.test.ts`; `packages/call-graph/src/types.ts`, `binding-index.ts`,
`call-graph-resolver.ts`, `call-graph-resolver.test.ts`; `packages/graph/src/constraints.ts`
and its test; `docs/04-graph-spec.md`; `packages/ir/README.md`,
`packages/call-graph/README.md`, `packages/graph/README.md`, `packages/query/README.md`.

Not modified: any Resolver source, `graph-builder.ts`, the Graph API, the Query Engine.

### Decisions

| Decision | Reason |
|---|---|
| Construction is a flag on `CallSiteIR`, not a new collection | Construction *is* a call: same callee, arguments, position, and it invokes a constructor. A separate collection would duplicate the shape and let a consumer miss half the invocations in the repository. |
| A nested declaration takes the **same** kind as its top-level equivalent | `const f = () => {}` is a `variable` wherever it is written. Kinding it `function` when nested would make the IR's own nesting an observable property of a declaration, and would have changed nothing for any consumer. |
| Only the invocable and the instance-holding are recorded | A body can contain a great deal that no call site can address. `const n = 5` and a local `class` stay out; recording every local would multiply the IR for no consumer's benefit. |
| An anonymous function is not recorded at all | `sym:<path>#<chain>` needs a name. Inventing one would create an identity that no second run could reproduce from the source alone. |
| A construction is attributed to the variable it initialises | That attribution is the entire mechanism for `instance-member`: it links `svc` to `Service` with no type checker. It follows from the existing "nearest recorded declaration" rule rather than being a special case. |
| A construction with no declared constructor points at the class | The construction happens either way. Naming the class says more than reporting nothing, and the evidence string states which case fired. |
| Bare-name lookup became scope-aware | With nested declarations, a top-level-only lookup would bind an inner call to an outer declaration of the same name. Walking outwards from the innermost scope is both more correct and what recovers calls to nested functions. |
| **`DECLARES` may now be sourced at `Function`, `Method`, `Constructor`, `Accessor` or `Variable`** | Strictly required by the new IR: the graph validator rejected the expanded IR outright, since a nested declaration's parent is a body. The derivation in spec §2.1 is unchanged — the same upward walk finds the new parents — so only the endpoint matrix in §2.3 widened. `Property`, `EnumMember` and `TypeAlias` stay excluded, having no body. **This edits the frozen specification and needs approval.** |
| Instances are keyed by declaration, not by assignment | Modelling the last write would need flow analysis. The map is a fact about which class a name was constructed from, and reassignment is recorded as a limitation instead of guessed at. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **The graph rejected the expanded IR.** `DECLARES may not be sourced at a Function` — found by running the full pipeline into SQLite, not by the unit suite, which had no nested-declaration fixture reaching the Graph Builder. | Widened the endpoint matrix in spec §2.3 and `constraints.ts`, and added a test asserting the kinds that stay excluded. |
| **Nested arrows were kinded `function` while identical top-level arrows were `variable`.** Caught by a test written against the top-level behaviour. The nested extractor had invented its own two-value vocabulary and mapped it back inconsistently. | `NESTED_KINDS` is now a subset of `DECLARATION_KINDS`, checked by `satisfies`, so the mapping cannot drift again. |

### Known Limitations

- **A callee containing a call is still unbindable** — `new Service().run()`,
  `chain.slice(0, -1).join('.')`. 1,249 sites, unchanged, and 1,216 of them contain a call
  in the callee. Binding them needs the type of an intermediate expression, which no
  name-based rule can supply. This is the largest remaining group and it is a type-checker
  problem, not a missing IR feature.
- **A `this` chain longer than one link is reported as `member-not-found`**, which blames
  the wrong thing. All 111 such entries are this shape and 110 are multi-link chains
  (`this.callGraph.calls.find`). Listed for approval below.
- **A construction in a property initializer is not tracked**, so `private svc = new
  Service()` does not make `this.svc.run()` bindable.
- **Reassignment is not tracked**: `let svc = new A(); svc = new B(); svc.run()` binds to
  `A`.
- **4,688 of 6,157 call sites still attribute to a file**, because test suites are built
  from anonymous callbacks and no anonymous function can be a declaration.
- No inheritance, no `super.method()`, no interface dispatch — all deliberate.
- Every `CALLS` edge remains `INFERRED`. Scope-aware lookup narrows shadowing but an
  unrecorded local or a parameter can still shadow a match.

### Approvals Needed Before Explain Symbol

1. **The frozen Graph Specification was edited** — §2.3 `DECLARES` sources widened, plus a
   sentence in §2.1 stating the derivation is unchanged. This was forced: without it the
   validator rejects the expanded IR. Please confirm the edit rather than the alternative,
   which would have been to reparent every nested declaration to its file and discard the
   containment the IR now knows.
2. **A new unresolved reason for a multi-link `this` chain.** `member-not-found` is the
   wrong label for `this.callGraph.calls.find()`. Fixing it adds one value to
   `UNRESOLVED_CALL_REASONS`; it changes no edge, only a reason. Not done, being outside
   this milestone.
3. **Whether property-initializer constructions should be tracked**, which together with
   item 2 would make `private svc = new Service(); this.svc.run()` bindable.

### Next Milestone

Explain Symbol.

## Call Graph

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
859 passing across 35 files (29 in this package).

### Completed Work

- New `@traceiq/call-graph`: `CallGraphResolver.resolve({ ir, resolved })` → `CallGraph`.
  Five binding rules — `local`, `imported`, `this-member`, `static-member`,
  `namespace-member` — each a constant-time lookup against indexes built in one pass.
- Every call site produces exactly one outcome: a relationship or an entry in `unresolved`
  with a reason. There is a test asserting `calls + unresolved === callSites`.
- Graph Builder accepts a fourth input and translates `CALLS` edges plus unbound calls;
  `CALLS` added to the endpoint matrix, with `File` as a legal source for a module-level
  call.
- Query Engine gains `findCallers` and `findCallees`, each one step.
- **Graph API needed no change**: `CALLS` was already in the frozen relationship
  vocabulary, so `getEdges('CALLS')` and the type-filtered accessors worked as they stood.
- Spec updated: `CALLS` moved from reserved to produced, endpoints added, the fourth input
  recorded.

### Measured on this repository

5,718 call sites, **1,063 bound** in ~2 ms (`local` 494, `imported` 482, `static-member`
56, `this-member` 31); 1,057 `CALLS` edges reached SQLite. Five self-calls, so recursion is
represented. `findCallees` on `GraphBuilder.build` returns exactly the functions it calls.

Of 4,655 unbound, **1,949 correctly leave the repository**. Of the 3,769 sites that could
point at repository code, 28% bind.

### Files

Created: `packages/call-graph/` (`types.ts`, `binding-index.ts`, `call-graph-resolver.ts`,
`index.ts`, fixture helper, test, package files, README);
`packages/graph/src/call-translator.ts`.

Modified: `packages/graph/src/graph-builder.ts`, `constraints.ts` and its test;
`packages/query/src/query-engine.ts`, `types.ts`, `index.ts` and its test;
`docs/04-graph-spec.md`; root `tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`,
`README.md`; `packages/graph/README.md`, `packages/query/README.md`.

### Decisions

| Decision | Reason |
|---|---|
| A separate package, after the Resolver | It consumes the Resolver's *output*, so it cannot live inside it. |
| Every relationship is `INFERRED` | The stage binds names, not symbols: it has no `ProjectContext`. A local of the same name could shadow the declaration matched, and nothing here can rule that out. |
| A module-level call is attributed to its file | Top-level invocation is real. Dropping it because there is no enclosing declaration would lose it entirely. |
| A member lookup requires a container kind | `svc.run()` on a variable is reported as needing a type, not as a missing member. Blaming the member would point at the wrong thing. |
| `root-is-external` is a distinct reason | Conflating "the call leaves the repository" with "we could not bind it" blames the analysis for something it got right. Worth 1,949 call sites here. |
| External roots detected by two signals | A bare or `node:` specifier is external by syntax, which holds even when the package is not installed and the Resolver bound nothing; a resolved external target catches the rest. |
| One rule fires per call site | The rules are disjoint on the shape of the callee, so no site produces competing candidates and no deduplication is needed. |
| A self-call is bound like any other | Recursion is a fact about the code. Nothing traverses, so there is no loop to guard. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`svc.run()` reported `member-not-found`**, blaming a missing member when the real problem was an undeterminable type. Found by reading the probe output rather than the tests. | Member lookup now requires a container kind; a value root reports `root-type-unknown`. |
| **Calls leaving the repository were reported as unbound names.** 1,949 sites on this repository — including every `expect` and `it` — read as analysis failures. | Added `root-is-external`. |
| **The first external-root implementation relied only on the Resolver**, so it failed in a fixture with no `node_modules`, where the binding resolves to nothing. Caught by a test written against a fixture that has none. | Added the syntactic signal alongside it. |

### Known Limitations

- **No type checker**, so every edge is `INFERRED`.
- **`new C()` is invisible to the IR**, which blocks the most common object-oriented shape
  and accounts for most of `callee-not-addressable` (1,203) and `root-type-unknown` (498).
  *Addressed by IR Expansion.*
- No inheritance, no `super.method()`, no interface dispatch — all deliberate.
- **Local functions are unbindable**: the IR records no declaration for a function nested
  inside another. *Addressed by IR Expansion.*
- A call inside an arrow at module level attributes to its file, which is why test-file
  calls attribute to files.
- `findCallers`/`findCallees` are one step; there are no transitive queries.

The figures in this section are those measured at the end of the Call Graph milestone and
are left as recorded. The IR Expansion section supersedes them.

### Next Milestone

IR Expansion.

## Query Engine

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
820 passing across 34 files (68 in this package).

### Graph API additions applied first

| Approved addition | Applied |
|---|---|
| `getRoles(nodeId)` | Per-node roles, ordered by role name, each with its confidence and evidence. |
| `getUnresolved()` | Every unresolved reference, ordered by identifier. |
| Optional `relationshipType` on `getIncoming` / `getOutgoing` | Served by a **separate prepared statement** rather than a nullable predicate, so each stays a plain indexed lookup SQLite plans once. |

Eight operations now, still each a direct lookup. No predicate, range or ordering option
was added.

### Completed Work

- `QueryEngine`, constructed from a `RepositoryGraphApi` and nothing else. Runtime
  dependencies are `@traceiq/graph-api` and `@traceiq/types` — verified, no SQLite.
- All eleven listed operations, plus `findByRole` as the general form the three named
  role queries delegate to.
- Every result carries the graph node or edge it came from, so confidence, provenance and
  locations are never flattened away.
- Route path composition performed per query and never materialised.
- Verified against both an in-memory Graph API and a real SQLite graph built by the full
  pipeline, answering the same way.

### Files

Created: `packages/query/` (`types.ts`, `query-engine.ts`, `route-identity.ts`,
`hydrate.ts`, `index.ts`, `fake-graph.test-helper.ts`, `query-engine.test.ts`,
`pipeline.test.ts`, package files, README).

Modified: `packages/graph-api/src/graph-api.ts` and README;
`packages/graph/src/sqlite-graph-api.ts` and its test; root `tsconfig.json`,
`tsconfig.tests.json`, `vitest.config.ts`, `README.md`.

### Decisions

| Decision | Reason |
|---|---|
| Results carry the node or edge, not selected fields | Confidence, provenance and locations live on those objects. Copying a few fields out is precisely how explainability is lost. |
| `findReferences` excludes `DECLARES` | Containment is not a reference. Including it would make every member look referenced by its own container. |
| `findByRole` is the real operation; the three named queries delegate | One implementation instead of three near-duplicates, and roles beyond the three requested stay reachable. |
| Only `Class`, `Function` and `Variable` are scanned for roles | Those are the kinds the Framework Extractor annotates, so the scan is complete and much cheaper than every declaration kind. |
| Route identity is parsed on the first two colons | A path keeps its parameter colons: `route:GET:/users/:id` has three. |
| Composition reports `composed: false` rather than returning a bare path | A caller must be able to tell a complete path from one that may sit under a prefix. Silence would imply the former. |
| Unit tests run against an in-memory Graph API | If the engine works with no database present, it provably depends on the interface alone. The fake also counts calls, so bounded traversal is asserted rather than trusted. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`@traceiq/ir` was declared as a runtime dependency of the Query Engine and never imported by any source.** An unused runtime dependency in the one package whose dependency set is the milestone's main constraint. | Removed from `dependencies`. `typecheck:tests` then failed with `TS2307` because the pipeline test does import it, so it was declared as a **dev** dependency — the infrastructure fix catching exactly what it was built for. |
| **Stale documentation** in `graph-api`'s README, which still said roles and unresolved references were not exposed and that no edge filtering existed. | Corrected. |

### Known Limitations

- **Route prefixes are not composed, and this is the largest gap.** `app.use('/api/auth',
  authRoutes)` puts the mount path in the IR's `callSites`, but the Framework Extractor
  keeps only the middleware it names and discards the path, so nothing in the graph
  records where a router is mounted. A route reported as `/login` may really be
  `/api/auth/login`. Every route says so explicitly rather than implying completeness.
- `findByRole` scans, there being no role index on the Graph API.
- Edge hydration is one `getNode` per edge, there being no batch accessor.
- `findDependencies` returns every external, including TypeScript built-ins and
  `ext:outside-analysis`; callers filter on `externalKind`.
- No transitive queries: "what eventually calls this" needs recursion and `CALLS` edges,
  and neither exists.
- `findReferences` does not distinguish a type-only import from a value import; the IR
  knows, the graph edge does not carry it.
- One revision only, so no revision parameter.

### Next Milestone

Context Builder.

## Graph API

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
742 passing across 32 files (36 in `graph-api`'s consumer, `graph`, which now holds 156).

### Contract update applied first

| Approved decision | Applied |
|---|---|
| `FrameworkAnnotations` contains roles, routes, environmentVariables | The Graph Builder now consumes the **producer's own type** from `@traceiq/framework`, so writer and producer cannot drift. Its private duplicate was deleted. `environmentUsages` renamed to `environmentVariables` throughout. |
| Graph Builder consumes the complete annotation model | `Route` and `EnvironmentVariable` nodes, `HANDLED_BY` and `READS` edges, and `node_roles` rows are all produced. |
| Freeze `env:<NAME>` | `environmentVariableId()` added to `@traceiq/shared`; `env` and the previously-approved `ext` added to `NODE_ID_KINDS`, closing a gap where `ext:` was in use but never in the vocabulary. |
| No route prefix composition | Paths are stored as written. Recorded as a Query Engine responsibility in the spec. |

Spec amendments: §1.1/§1.3, §2.1–2.3, §4 (`ordinal` no longer reserved), §5.1
(`env:<NAME>` frozen, route-merge semantics), §6.2, §8.8, §10 (the Graph API layer),
§11.5.

### Completed Work

- New `@traceiq/graph-api`: the `RepositoryGraphApi` interface and the graph read model,
  depending on **no database at all**. This is what lets the Query Engine depend on an
  abstraction rather than on SQLite.
- The read model moved there from `@traceiq/graph`, which now imports it — one definition
  for reader and writer rather than two that can drift.
- `SqliteGraphApi` in `@traceiq/graph`: all six operations, prepared once, opened
  `readonly` so a read bug cannot corrupt a graph.
- `annotation-translator.ts`: routes, environment variables and roles into rows.
- Verified end to end: a fixture Express app produced `route:GET:/health`,
  `route:POST:/login` with ordinals 0 and 1 preserving middleware order, `env:PORT`
  merged from two reads, and `route:GET:/` correctly merged across two files with a null
  `file_id`.

### Files

Created: `packages/graph-api/` (`types.ts`, `graph-api.ts`, `index.ts`, `package.json`,
`tsconfig.json`, `README.md`); `packages/graph/src/annotation-translator.ts`,
`identity.ts`, `sqlite-graph-api.ts`, `sqlite-graph-api.test.ts`.

Modified: `packages/types/src/node-id.ts` and its vocabulary test;
`packages/shared/src/node-id.ts`, `index.ts` and its test; `packages/framework/src/`
(rename); `packages/graph/src/types.ts`, `graph-builder.ts`, `constraints.ts`,
`index.ts`, `graph-fixture.test-helper.ts` and three test files;
`docs/04-graph-spec.md`; root `tsconfig.json`, `tsconfig.tests.json`,
`vitest.config.ts`, `README.md`; `packages/graph/README.md`, `packages/ir/README.md`.

### Decisions

| Decision | Reason |
|---|---|
| The interface and read model live in a package with no driver | The stated reason for this milestone is that the Query Engine must never depend directly on SQLite. Putting the interface beside the implementation would have left the driver in its dependency tree. |
| The implementation stays in `@traceiq/graph`, beside the store | Every SQL statement in the system is then in one of two files, which makes "no SQL outside the Graph API" checkable rather than aspirational. |
| Exactly six operations, no filters | A type filter or depth limit is the beginning of a query language, and that is the Query Engine's. Adding one later is easy; removing it would not be. |
| The API opens the database `readonly` | A reader that cannot write is a stronger guarantee than a reader that merely does not. |
| The Graph Builder imports the producer's annotation type | A private duplicate would drift. Depending on `@traceiq/framework` for a type does not teach the graph what Express is. |
| A route identity carries no file, so registrations merge | The identity is frozen as `route:<METHOD>:<path>`. Merging is what that identity means; the alternative would be failing on `GET /` in two routers. |
| `getNodes` fetches locations in one query | Two statements regardless of how many nodes match, rather than one per node. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`ext:` was in use since the Graph Builder but never in `NODE_ID_KINDS`** — the vocabulary and the code disagreed. | Both `ext` and `env` added, with a conformance test. |
| **`edgeIdentity` and `strongerConfidence` would have been duplicated** into the annotation translator. | Extracted into `identity.ts` before the second use existed. |
| **The same declaration listed twice as a route handler** would have produced one edge identity twice and failed the build. | Deduplicated per route, keeping the first position. |
| **An environment name the frozen identity cannot carry** — `process.env['MY-VAR']` — would have thrown mid-build. | Recorded as an unresolved reference instead, visible and never mangled. |
| **Stale documentation**: the graph README claimed it "creates no Route nodes" and that `Route` was "still to come". | Corrected. |

### Known Limitations

- No accessor exposes roles or unresolved references; both are stored and neither is in
  the six operations.
- `getOutgoing`/`getIncoming` take no type filter, so a caller filters in memory.
- No batch accessor: fetching many nodes by identifier means one call each.
- A route merged across files has a `null` `file_id`, and paths are local — both
  consequences of prefix composition being deferred.
- `DatabaseTable` identities are still undefined, so that node type is not produced.
- Still one revision, `revision_id = 1`, hashes `NULL`.

### Next Milestone

Query Engine — traversal on top of the Graph API. Route prefix composition is now
explicitly its responsibility.

## Framework Extractor

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
689 passing across 31 files (78 in this package, plus 24 new IR tests).

### Blocking conflict found before implementation

The milestone named `RepositoryIR` and `ResolvedRepository` as the only inputs, but two
of the four extraction responsibilities were **unachievable** from them. Verified
empirically before writing code: on an Express fixture, `/login` and `process` appeared
nowhere in either structure. Route registration is a call expression and `process.env.X`
is a member access, and the IR recorded neither.

Options were put to you rather than guessed at. **Approved: extend the IR first**, so the
Framework Extractor stays a pure IR consumer with no compiler. The rejected alternative —
giving this package a `ProjectContext` — would have put ts-morph inside a framework
package and created a second AST traversal whose rules could drift from the IR's.

### IR extension (approved reopening of a completed milestone)

`RepositoryIR` gains two collections. Additive, so no consumer needed changing beyond
synthetic test constructors.

| Added | Contents |
|---|---|
| `callSites[]` | fileId, enclosingDeclarationId, calleeText, calleeRootName, calleeMemberName, arguments, location |
| `memberAccesses[]` | fileId, enclosingDeclarationId, text, rootName, path, location |

- A string-literal argument (or a template literal with no substitution) carries its
  **value**, which is what lets a consumer read a route path without parsing text.
- `memberAccesses` records only **outermost** identifier-rooted chains, never a callee —
  measured: this cut 1,958 records to 890 by removing prefixes and duplicates of call
  sites.
- **Expression traversal enters function bodies**; declaration traversal still does not.
  A local `class` is still not a declaration, while a call inside it is still a call site.
- Attribution uses declaration **node identity**, so it never restates which nodes the IR
  chose to record.
- Cost on this repository: 4,351 call sites and 1,067 member accesses across 86 files.

### Completed Work

- `FrameworkExtractor.extract({ ir, resolved })` → `FrameworkAnnotations`.
- Express detection anchored on the import, with the Resolver confirming the specifier
  resolved to the express *package* rather than a local module of that name.
- Router variables traced through a complete syntactic chain: express binding → call →
  variable.
- Routes for all eight HTTP methods, with literal and template-literal paths, ordered
  handler chains, and handler-to-declaration linking where the IR establishes it.
- Middleware attributed from **use-site evidence** — a non-final handler in a chain, or a
  `use` mount — in preference to any naming convention.
- Roles for Controller, Service, Repository, Middleware, Model and Test, by name suffix or
  directory segment, on top-level classes, functions and variables only.
- `process.env` reads including string-literal element access, attributed to the enclosing
  declaration.
- Verified on this repository: 60 roles, 0 routes, 0 env reads in ~1 ms — correct, since
  TraceIQ uses no Express.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | The annotation contract |
| `src/framework-extractor.ts` | Orchestration |
| `src/express-detection.ts` | Express anchoring and router tracing |
| `src/route-extractor.ts` | Routes and mounted middleware, in one pass |
| `src/role-extractor.ts` | Role conventions and use-site evidence |
| `src/environment-extractor.ts` | `process.env` reads |
| `src/index.ts` | Public surface |
| `src/framework-fixture.test-helper.ts` | Real pipeline fixtures |
| `src/routes.test.ts`, `src/roles.test.ts`, `src/environment.test.ts` | 78 tests |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Added to `@traceiq/ir`: `src/access-chain.ts`, `src/expression-extractor.ts`,
`src/expressions.test.ts`. Modified: `packages/ir/src/types.ts`,
`declaration-extractor.ts`, `ir-builder.ts`, `index.ts`, `README.md`; synthetic IR
constructors in `packages/resolver/src/declaration-index.test.ts` and
`packages/graph/src/graph-fixture.test-helper.ts`; root `tsconfig.json`,
`tsconfig.tests.json`, `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Extend the IR rather than give this package a compiler | Keeps one AST walk and one set of rules, keeps ts-morph out of a framework package, and is the prerequisite for `CALLS` edges. |
| Every annotation is `INFERRED` | Express has no base class, decorator or interface. Every claim rests on a convention or on a chain a reassignment could break. `CERTAIN` would overstate; `RESOLVED` is unavailable without a resolver. Strength lives in the evidence text. |
| A route requires a *traced* router variable | Without it every `foo.get(...)` in the repository looks like a route. It costs recall, which is recorded as the largest limitation. |
| Use-site evidence beats naming for Middleware | `router.get('/x', authGuard, handle)` makes `authGuard` middleware whatever it is called — a fact about the code, not a guess about its name. |
| `use` produces no route | It carries no HTTP method. Its path composes a prefix onto routes elsewhere, which this milestone does not resolve. |
| Roles attach only to top-level classes, functions and variables | A method plays no architectural role; its class does. |
| No framework abstraction | One framework cannot show what a second would need. A plugin seam invented now would be a guess. |
| The `ResolvedRepository` is genuinely used | Confirming the express *package* rather than the specifier text. An unused parameter satisfying a contract would have been dead weight. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **`readExpressFacts` was O(files × callSites)** — it re-scanned every call site once per express-importing file. | Call sites grouped by file once and shared by every annotator. |
| **Route and `use` extraction each rebuilt the same declaration index and repeated the same router check.** | Merged into one pass over each file's call sites. |
| **`ResolvedRepository` was accepted and never used**, a dead parameter dressed as a contract. | Now supplies express package confirmation, which appears in every route's provenance. |
| **The IR's own file header claimed it recorded "no call sites"** after the extension made that false. | Header corrected; the IR is now described as purely *syntactic* rather than *structural*. |
| **An unused import in the route extractor** passed Vitest and failed the build. | Removed — caught by `pnpm build`, with `typecheck:tests` covering the test files. |

### Pending Tasks

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. Confirm `ext:outside-analysis`.
5. Per-package tsconfig in a monorepo.
6. Job orchestration — still unowned.
7. Incremental indexing and content hashes.
8. **Route prefix composition** — `app.use('/api', router)` is unresolved, so reported
   paths are as written locally. *(New.)*
9. **Whether the Graph Builder should consume these annotations now** — it accepts a
   `FrameworkAnnotations` input with a `roles` field only, and this package produces a
   richer type including routes. They need reconciling before routes reach the graph.
   *(New.)*
10. Evaluation strategy — still nothing measures accuracy, and this is the milestone
    where it would bite hardest: role and route detection are heuristic by nature.
11. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Two packages and both apps remain documentation only.
- No linter or formatter is configured.
- A router arriving by import is not traced, so its routes are missed.
- Convention-based roles fire on any repository: on this one, `mountedMiddleware` is
  annotated `Middleware` purely by name.
- `Test` is broad — every top-level declaration in a test file receives it.
- `CALLS` edges still do not exist; the IR records call sites but nothing binds them.

### Next Milestone

Query Engine — the only read path to the graph. Item 9 above should be settled first: the
Graph Builder's annotation input and this package's output type are not yet the same
shape, so routes cannot reach the graph until they are.

## Graph Builder

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
585 passing across 27 files (118 of them in this package).

### Approved decisions applied to the specification

`docs/04-graph-spec.md` was amended before implementation, and the amendments are the
contract now:

| Decision | Applied |
|---|---|
| External identities `ext:npm:` / `ext:node:` / `ext:builtin:`, versions never in identities | §5.2 rewritten |
| Keep the revision schema; `revision_id = 1`, hashes `NULL` | §8.3; both hash columns made nullable, `file_revisions` now has a writer |
| `better-sqlite3` | §11.6 |
| Unresolved references stay in their own table | §11.4 |
| `EnvironmentVariable` / `DatabaseTable` deferred | §11.5 |

### Completed Work

- `GraphBuilder.build({ ir, resolved, annotations })` → `RepositoryGraph`, a pure
  translation with no filesystem, compiler or database.
- `GraphStore.open(path)` / `write(graph, createdAt)` / `close()`, owning the schema,
  pragmas and transactions as the single writer.
- 14 node kinds, 6 edge types, the full legal endpoint matrix, and the `DECLARES`
  derivation with its upward walk.
- External nodes in all four identity forms, with the permitted confidence maximum.
- Every table populated, including `file_revisions` with null hashes.
- Validation in the builder *and* in SQLite: foreign keys plus `CHECK` constraints.
- Verified on this repository: 659 nodes, 1930 edges, 3 unresolved, 22 external nodes;
  translation ~2 ms, write ~30 ms; `integrity_check` ok and `foreign_key_check` empty.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | Graph data contract, node kinds, `FrameworkAnnotations` |
| `src/graph-builder.ts` | The pure translation |
| `src/graph-store.ts` | SQLite ownership, transactions, prepared statements |
| `src/schema.ts` | DDL, `CHECK` constraints, delete order |
| `src/constraints.ts` | Legal endpoint matrix and pre-write validation |
| `src/declares.ts` | The `DECLARES` derivation |
| `src/external-identity.ts` | The approved `ext:` scheme |
| `src/index.ts` | Public surface |
| `src/graph-fixture.test-helper.ts` | Synthetic IR and resolved inputs |
| `src/graph-builder.test.ts` | Nodes, edges, enrichment, determinism, constraints |
| `src/graph-store.test.ts` | Schema, rows, integrity, transactions, determinism |
| `src/declares.test.ts` | The keystone derivation, including the dotted-namespace case |
| `src/constraints.test.ts` | Endpoint matrix conformance |
| `src/external-identity.test.ts` | All four identity forms |
| `src/pipeline.test.ts` | Real TypeScript through all five stages into SQLite |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `docs/04-graph-spec.md`, `pnpm-workspace.yaml` (native build approval), root
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Builder and Store are separate modules | The builder is pure and testable without SQLite; the store owns schema and transactions. Neither leaks into the other. |
| `createdAt` is supplied by the caller | The graph is deterministic; a clock read inside the store would make identical writes differ. The one time-dependent value belongs to the caller. |
| Validation in the builder *and* in SQLite | The builder's check names the edge and the rule; SQLite is the backstop that stops a defect reaching disk. |
| `edges.type` constrained, `nodes.kind` not | The relationship vocabulary is frozen so a `CHECK` is free; node kinds are open, so a `CHECK` would force a migration. |
| `nodes` emptied in two statements | `nodes.file_id` is self-referential, so declarations must be deleted before the `File` rows they reference. Avoids deferring enforcement. |
| Store sorts files first rather than trusting builder order | Removes an implicit coupling; the store does not depend on how the builder ordered its output. |
| A declaration with no location fails the build | The IR guarantees one. Substituting a placeholder would persist a fiction. |
| No read API on the store | A shortcut here would let features bypass the Query Engine and freeze the storage decision. |
| Native build script approved explicitly in `pnpm-workspace.yaml` | pnpm blocks build scripts by default; `better-sqlite3` ships a native addon and needs it. Recorded rather than silently enabled. |

### Defects Discovered and Fixed

| Defect | Fix |
|---|---|
| **Deleting all nodes in one statement could violate a foreign key.** `nodes.file_id` is self-referential, so a `File` row could be deleted while declarations still referenced it — depending on row order. | Two statements: non-`File` nodes first. |
| **The store invented a timestamp**, which broke determinism between otherwise identical writes and contradicted the spec's "supplied by the caller". | `write` takes `createdAt`. |
| **A defensive location fallback would have persisted a fabricated 1:1 position** for a declaration with no site. | Fails fast instead. |
| **Test files had four type errors and an unused import**, passing at runtime while being type-broken. | Caught by `pnpm typecheck:tests` — the infrastructure fix from this milestone finding a real defect in its own milestone. |

### Pending Tasks

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. **Confirm `ext:outside-analysis`** — the fourth identity form the approved scheme
   does not name. *(New.)*
5. Per-package tsconfig in a monorepo — still caps cross-package edges.
6. Job orchestration — still unowned.
7. Incremental indexing and content hashes — the columns exist and are null.
8. `EXPOSES_ROUTE` and `Route` identities — due at the Framework Extractor.
9. Evaluation strategy — still nothing measures accuracy.
10. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Three packages and both apps remain documentation only.
- No linter or formatter is configured.
- No migrations: a database with a different `schema_version` is refused.
- A write replaces the previous graph; there is no history.
- `DEPENDS_ON` is not producible — no `Repository` node, and the dependency list is
  not an input.

### Next Milestone

Query Engine — the only read path to the graph. Items 4 and 7 are worth settling
first: item 4 affects 14% of external references, and item 7 decides whether queries
must filter by revision.

## Resolver

**Status:** complete. `pnpm build` clean, `pnpm typecheck:tests` clean, `pnpm test`
467 passing across 21 files (108 of them in this package).

### Infrastructure Fix — test typechecking

Requested before this milestone, and the reason it was requested: the IR audit found
an undeclared dependency that survived because test files were never typechecked.

`tsconfig.tests.json` at the workspace root now owns every test file and nothing
else. It **references** the package projects rather than including their sources, so
a source file is still compiled exactly once by its own project and is consumed here
through declaration output — no duplicate compilation. Emit is off; the only product
is the typecheck. Strict mode is inherited unchanged from `tsconfig.base.json`.

Module resolution still starts from each test file's own directory, so pnpm's strict
isolation continues to apply and an undeclared dependency still fails.

Verified by introducing both faults deliberately: an import of a non-existent package
(`TS2307`) and a type error (`TS2322`) were both caught, while `pnpm build` still
passed with them present — which proves the two projects are disjoint. `vitest.config.ts`
is included too, since it was also unchecked.

Run as `pnpm typecheck:tests`, wired into CI between `build` and `test`.

### Completed Work

- `Resolver.resolve({ ir, context })` returning a `ResolvedRepository` of echoed
  metadata, enriched declarations, resolved relationships and unresolved references.
- Five sub-resolvers: declarations, imports, exports, heritage, type references.
- Import resolution at two granularities — the statement's module, and each binding —
  with aliases followed to the declaring symbol.
- Export resolution covering inline modifiers (CERTAIN), export specifiers,
  re-exports, star and named-star re-exports, and `export =`.
- `extends` and `implements`, plus heritage type arguments.
- Type references in property, variable, parameter, return and type-alias positions,
  including nested type arguments.
- Every relationship carries source identifier, target, confidence, provenance with
  human-readable evidence, and source location.
- Verified end to end on this repository: 434 declarations, 1164 relationships, 3
  unresolved, in ~50 ms. Every relationship source and declaration target is one the
  IR recorded, and the result survives a JSON round trip.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | The output contract. No ts-morph type appears in it |
| `src/resolver.ts` | `Resolver`, the single-pass orchestration |
| `src/declaration-index.ts` | Position-based correlation back to IR declarations |
| `src/symbol-target.ts` | Symbol to target, alias following, candidate collection |
| `src/resolution-collector.ts` | Accumulation and ambiguous-candidate expansion |
| `src/import-resolver.ts` | Modules and bindings |
| `src/export-resolver.ts` | Inline exports, specifiers, stars, `export =` |
| `src/heritage-resolver.ts` | `extends` and `implements` |
| `src/type-reference-resolver.ts` | Named types in declaration signatures |
| `src/declaration-enricher.ts` | Checker-confirmed facts per declaration |
| `src/external-classification.ts` | Package, builtin and lib classification |
| `src/source-position.ts` | Node position to IR range |
| `src/index.ts` | Public surface |
| `src/resolver-fixture.test-helper.ts` | Whole-pipeline fixtures |
| `src/resolver.test.ts` | Integration across every resolution path |
| `src/resolution-collector.test.ts` | Ambiguity expansion and collection |
| `src/declaration-index.test.ts` | Correlation keystone, on plain data |
| `src/external-classification.test.ts` | Specifier and path classification |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: root `package.json` (script), `.github/workflows/ci.yml`, root
`tsconfig.json`, `tsconfig.tests.json` (new), `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Unresolved references live in their own collection, not as a null target | They have no target and therefore no honest confidence. The four levels describe how much a resolution is trusted; stretching one to mean "failed" would make the vocabulary useless. Nothing is dropped. |
| Relationship types are an `Extract` of the frozen vocabulary | A name outside the contract fails to compile instead of quietly inventing vocabulary. |
| No `ALIASES` relationship | Following an alias is how an `IMPORTS`/`EXPORTS` target is reached, not a separate fact. The provenance records the hop. |
| Correlation by source position, not by recomputing identifiers | The IR already decided which declarations exist and which names it could address. Re-deriving that would duplicate the rules and let them drift. |
| Position match plus a declaration-kind guard | An `export` keyword shares its start position with the declaration it modifies, so position alone matches the wrong node. |
| `source-position.ts` duplicated rather than shared | Exporting it from `@traceiq/ir` would put a ts-morph type in that package's public API. Correlation tests are the canary against divergence. |
| Walk every descendant per file | Costs one traversal and restates none of the IR's traversal rules; correctness comes from the position match rather than two modules agreeing where to look. |
| `external` is a successful resolution | Knowing `express` comes from a package is what a consumer needs. Only genuine failures are unresolved. |
| `typescript-lib` carries no name | `Promise` is declared across five lib files; naming the file made one type look like five ambiguous candidates. |
| `node:` specifiers are CERTAIN node-builtins | The prefix is reserved, so the text alone identifies a builtin. TypeScript never resolves one to a file, so this is the only path that sees them. Distinguished from an inferred uninstalled package. |
| Star re-exports resolve to the module, not expanded | The forwarded set is derived rather than written; materialising it is closer to organising than enriching. |
| Declarations carry provenance but no confidence | They are observations, not resolutions of a reference. |
| Candidate groups derived from the reference site | Deterministic, so repeated runs are comparable. |

### Defects Discovered and Fixed

All found by probing the implementation before writing tests, or during self-review.

| Defect | Fix |
|---|---|
| **False ambiguity on every TypeScript built-in.** `Promise` produced five AMBIGUOUS candidates, one per `lib.*.d.ts` declaring it. Genuine ambiguity would have been buried in the noise. | `typescript-lib` targets carry no file name, so they collapse to one. |
| **Heritage type arguments were silently lost.** The `Repo` in `extends Base<Repo>` resolved nowhere, and the heritage resolver's comment claimed the type reference resolver covered it — it did not. | Heritage type arguments are now collected as type references, and the comment is true. |
| **Type parameters reported as `declaration-not-in-ir`**, which reads like an IR defect when a type parameter simply is not an IR declaration. | Added the distinct `type-parameter` reason. |
| **`node:` specifiers reported as npm packages.** All 26 in this repository were labelled `origin: 'package'` with names like `node:path`. | Added the `node-builtin` origin, classified as CERTAIN. |
| **Namespace imports recorded as resolution failures.** `import * as ns` binds the module, which is a legitimate target. | The namespace binding is recorded against the module target. |
| **Vacuous ambiguity tests.** The fixture asserted over an empty set: two same-named interfaces in separate modules do not merge, so no AMBIGUOUS relationship was ever produced. | Replaced with direct unit tests of the collector, plus an explicit assertion that this fixture produces none, and the limitation documented. |
| Duplicated bare-specifier handling between the import and export resolvers. | Factored into `classifyUnresolvedSpecifier`. |
| Dead logic in `moduleExportNameOf` — an unreachable branch and a meaningless guard. | Reduced to declaration-node identity, which is what actually settles it. |

### Pending Tasks

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. ~~Test files are never typechecked.~~ **Resolved** by the infrastructure fix above.
5. **Per-package tsconfig in a monorepo.** Now has a measured cost: 169 of 1164
   relationships on this repository resolve to `outside-analysis` because a
   workspace sibling resolves to its `dist` declaration output rather than its
   source. Cross-package edges therefore do not reach declarations. Deliberately
   not addressed, per instruction.
6. Job orchestration — still unowned.
7. Revision handling and incremental refresh — due at the Knowledge Graph.
8. `EXPOSES_ROUTE` — due at the Framework Extractor.
9. Evaluation strategy — still nothing measures accuracy.
10. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Four packages and both apps remain documentation only.
- No linter or formatter is configured.
- `AMBIGUOUS` is currently unreachable; see the package README for why.
- Star re-exports are not expanded to the symbols they forward.
- Type parameter constraints are not examined.
- A bare Node builtin without the `node:` prefix is classified as a package.

### Next Milestone

Graph Builder — turn resolved facts into nodes and relationships in SQLite. Items 5,
7 and 9 above matter most before it: item 7 shapes the schema and is expensive to
retrofit, and item 5 caps how much of a monorepo the graph can connect.

## IR Builder

**Status:** complete. `pnpm build` clean, `pnpm test` 364 passing across 17 files
(141 of them in this package).

### Completed Work

- `IrBuilder.build(context)` returning a `RepositoryIR` of repository, files,
  declarations, imports and exports.
- Twelve declaration kinds, each with a stable `sym:` identifier, source locations,
  visibility where applicable, and six syntactic modifiers.
- Identifier folding for sites that legitimately share a symbol path: overload
  signatures, getter/setter pairs, merged interfaces.
- Import statements with default, named and namespace bindings, and type-only flags
  at both statement and specifier level.
- Export statements — named, re-export, star, star-as, default, equals — plus
  exports written as a declaration modifier, linked to their declaration.
- Verified against this repository: 53 files, 294 declarations, 131 imports, 139
  exports in ~450 ms, identifiers unique, and the whole IR survives a JSON round
  trip. The 7 ECMAScript private fields in TraceIQ's own code are addressed
  correctly.

### Files Created

| File | Purpose |
|---|---|
| `src/types.ts` | The IR contract. No TypeScript or ts-morph type appears in it |
| `src/ir-builder.ts` | `IrBuilder`, `IrBuildError` |
| `src/declaration-extractor.ts` | Syntax-tree walk over structural declarations |
| `src/declaration-collector.ts` | Identifier-keyed accumulation and site folding |
| `src/import-extractor.ts` | Import statements and bindings |
| `src/export-extractor.ts` | Export statements |
| `src/modifiers.ts` | Modifier defaults and scope-to-visibility mapping |
| `src/addressable-name.ts` | Which names the identifier format admits |
| `src/source-range.ts` | Node position to IR range |
| `src/index.ts` | Public surface |
| `src/ir-fixture.test-helper.ts` | Temporary repositories loaded through the Project Host |
| `src/declarations.test.ts` | Kinds, identity, locations, visibility, modifiers, folding, boundaries |
| `src/imports-exports.test.ts` | Every import and export form |
| `src/ir-builder.test.ts` | Metadata, files, determinism, language independence, failures |
| `src/declaration-collector.test.ts` | Folding and merge semantics in isolation |
| `src/addressable-name.test.ts` | Addressable and unaddressable names |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `packages/shared/src/node-id.ts` and its tests (defect fix, below), root
`tsconfig.json`, `vitest.config.ts`, root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| The identifier is the unit; sites sharing one are folded into a declaration with several `locations` | The contract's format is a symbol path, so overloads, getter/setter pairs and merged interfaces genuinely share one. Emitting duplicate identifiers would collide the moment the graph keyed a node on one. **Needs approval — this shapes the contract every later module reads.** |
| The type checker is never consulted | Everything recorded is visible in the syntax tree, which keeps the IR cheap and makes it safe to treat as stable. A file that does not type-check yields the same IR. |
| No type information at all | Annotation text, signatures and parameters are absent. Type references are the Resolver's work, and storing annotation text would invite consumers to parse strings. |
| No references and no call sites | The milestone specifies declarations, imports and exports. Both are the natural next addition and disturb nothing here. |
| Flat collections carrying `fileId` | Matches the specified IR shape, and the common case — iterating every declaration — needs no traversal. |
| Function bodies are not entered | A declaration local to a function is not repository structure. Consistent with the scanner's decision not to persist locals. |
| Only `namespace` module declarations are entered | An ambient `declare module 'x'` or `declare global` describes external or global shape, and its quoted, dot-containing name is not a valid chain segment. |
| Unaddressable names are skipped | Destructuring patterns, computed members and string-literal members have no stable representation in the identifier format. Skipping is silent; recording a count would change the IR's specified shape. |
| A dotted namespace becomes nested segments | `namespace A.B {}` means exactly that. Its export names `A`, with no `declarationId`, because the source declares no `A`. |
| Anonymous default exports are named `default` | They still need a stable path, and TypeScript calls the symbol `default`. |
| Inline exports are emitted once, on first collection | Emitting per site exported an overload set three times. TypeScript requires merged declarations to agree on `export`. |
| `declarationId` only for an inline `export` modifier | For `export { local }`, matching the name needs scope analysis, which is resolution. |
| `@traceiq/scanner` is a dev dependency | The test helper needs `RepositoryInventory` to construct one. No source file imports it. |

### Defects Discovered and Fixed

| Defect | Where | Fix |
|---|---|---|
| **`symbolId` rejected every ECMAScript private field.** `#` was forbidden anywhere in a chain segment, so `#secret` threw and TraceIQ could not represent private state at all. | `@traceiq/shared` (approved milestone) | Allow `#` as a leading private-name marker; still reject `.` and any interior or trailing `#`. Parsing splits on the first `#`, which always ends the path, so later ones are unambiguous. Three tests added. **Genuine defect in a completed milestone.** |
| **Duplicate export entries.** A merged interface appeared twice in `exports` and a three-signature overload set three times, because an inline export was pushed per syntactic site. | `declaration-extractor.ts` | `DeclarationCollector.add` now reports `isNew`; the export is recorded only on first collection. |
| **Exported namespaces produced no export entry.** `export namespace Outer {}` was missing from `exports` entirely, because namespace extraction bypassed the path that records inline exports. | `declaration-extractor.ts` | Namespace extraction routes through the same recording path, which takes multiple name segments. |
| **A dotted namespace exported the wrong name.** `export namespace Deep.Nested {}` reported `Nested`; the module exports `Deep`. | `declaration-extractor.ts` | The exported name is the first chain segment, and `declarationId` is null when there is more than one. |
| **Undeclared dependency.** The test helper imported `@traceiq/scanner`, which pnpm never linked. It resolved only through the vitest alias and was never typechecked. | `packages/ir/package.json` | Declared as a dev dependency. |

Found during self-review and removed: `groupByFile`, a helper exported for a future
milestone with no current consumer.

### Pending Tasks

Carried forward, unchanged except where noted:

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach.
4. **Test files are never typechecked.** *(New.)* Every package excludes
   `**/*.test.ts` from `tsc`, and Vitest only transpiles, so test code can contain
   type errors indefinitely — which is how the undeclared dependency above survived.
   The IR's tests were verified clean with a throwaway config, but the structural
   fix touches all five completed packages and is therefore not applied.
5. Per-package tsconfig in a monorepo — still open, and now due: the Resolver's
   accuracy depends on module resolution using the repository's real options.
6. Job orchestration — still unowned.
7. Representation of `AMBIGUOUS` — due at the Resolver.
8. Revision handling and incremental refresh — due at the Knowledge Graph.
9. `EXPOSES_ROUTE` — due at the Framework Extractor.
10. Evaluation strategy — still nothing measures accuracy. The IR is the first
    output a fixture repository could be labelled against precisely.
11. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Five packages and both apps remain documentation only.
- No linter or formatter is configured.
- Declarations whose names the identifier format cannot address are skipped
  silently.
- The identifier cannot distinguish a static from an instance member of the same
  name.
- `import x = require('y')` is not captured.
- The repository name comes from the root directory, not package.json.

### Next Milestone

Resolver — bind the references the IR records to the declarations they reach. Items
5 and 7 above should be settled first, and item 10 matters most here: resolution
accuracy caps every downstream feature and nothing currently measures it.

## Project Host

**Status:** complete. `pnpm build` clean, `pnpm test` 221 passing across 12 files.

### Completed Work

- `ProjectHost.load(inventory)` returning a `ProjectContext`.
- One ts-morph `Project` per context, created from the inventory's file set.
- Compiler options read from the repository's `tsconfig.json`, with documented
  defaults when it has none.
- `Program` created eagerly; `TypeChecker`, `sourceFiles` and `compilerOptions`
  exposed, plus lookup by repository-relative path.
- Explicit lifecycle: `dispose()` releases every reference, and all accessors then
  throw `ProjectContextDisposedError`.
- Verified end to end against this repository through the real scanner: 37 source
  files, 34 ms to load, ~180 MB heap, and the checker resolved a method's return
  type across a package boundary to the actual `RepositoryInventory` declaration.
- Verified that a symbol imported from a hand-built `node_modules` package resolves
  to its real type while its declaration file stays out of `sourceFiles`.

### Files Created

| File | Purpose |
|---|---|
| `src/project-host.ts` | `ProjectHost`, `ProjectHostError` |
| `src/project-context.ts` | `ProjectContext`, `ProjectContextDisposedError` |
| `src/compiler-options.ts` | `DEFAULT_COMPILER_OPTIONS`, frozen-copy helper |
| `src/index.ts` | Public surface |
| `src/project-fixture.test-helper.ts` | Temporary projects and hand-built inventories |
| `src/project-host.test.ts` | Loading, options, checker, scope, lifecycle, failures |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `packages/scanner/tsconfig.json` and `packages/scanner/package.json`
(see the `@types/node` decision below), root `tsconfig.json`, `vitest.config.ts`,
root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| `types: ["node"]` and an explicit `@types/node` devDependency per package that uses Node builtins | Automatic `@types` acquisition does not reach leaf packages under pnpm's isolated layout, so `node:path` had no ambient declaration. **This also fixed a latent bug in the approved scanner:** it compiled only because `fast-glob`'s declarations import from `'fs'` and `'stream'`, which dragged `@types/node` into its program by accident. Removing fast-glob would have broken it. Explicit is also what the contract asks for over magic. |
| The inventory decides scope; tsconfig supplies options only | `include`/`exclude` answer "what to compile", not "what to analyse". Letting them decide would let the analysed set disagree with the inventory that produced it. `skipAddingFilesFromTsConfig` is set. |
| `load` is synchronous | Creating the `Program` is CPU-bound and cannot yield. A promise would imply otherwise. Progress and cancellation belong to a layer above, which does not exist by decision. |
| One `Project` per context, not per process | A process-wide singleton would be global state, which the architecture forbids. The two constraints together only resolve this way. The host is stateless. |
| Emission prevented by API shape, not by forcing `noEmit` | The `Project` is never exposed, so nothing can call `emit`. Overriding options would risk conflicting with a repository's own settings — `composite` and `noEmit` interact — for no added guarantee. |
| Compiler options leave as a frozen copy | The compiler's options object is mutable and shared with the `Program`; handing it out would let a consumer change how the checker behaves. |
| Files added individually, not by batch glob | The batch call takes globs, so a path containing glob syntax would be misinterpreted and a failure would name the batch rather than the file. |
| A stale inventory fails the load | Silently skipping a missing file would make the analysed set differ from the inventory with nothing saying so. |
| Contexts are immutable snapshots | A checker that could be invalidated underneath a consumer mid-analysis would be unusable. |
| Explicit `dispose` with throwing accessors | The context holds the compiler's memory for a whole repository. A stale context should fail loudly rather than serve results from a program meant to be released. |
| `SourceFile` and `TypeChecker` re-exported | Lets a consumer type what it receives without declaring its own ts-morph dependency. |
| No diagnostics exposed | Nothing downstream consumes them yet. Adding them later is a one-line change. |

### Pending Tasks

Carried forward, unchanged except where noted:

1. Confirm the `shared` / `types` boundary.
2. Confirm `esModuleInterop` in the shared base config.
3. Confirm the `types: ["node"]` / `@types/node` approach, which modified the
   already-approved scanner package. *(New.)*
4. **Per-package tsconfig in a monorepo.** *(New, and the most consequential.)* A
   root solution tsconfig — `files: []` plus `references` — carries no real
   compiler options, so analysis runs under compiler defaults instead of the
   repository's actual settings, losing `paths` mappings among others. This
   repository is itself such a case. Honouring per-package configuration requires
   more than one `Project`, which is an architectural decision. Due before the
   Resolver, whose accuracy depends directly on module resolution being correct.
5. Job orchestration — deliberately excluded from this milestone. Still unowned.
6. Representation of `AMBIGUOUS` — due at the Resolver.
7. Revision handling and incremental refresh — due at the Knowledge Graph.
8. `EXPOSES_ROUTE` — due at the Framework Extractor.
9. Evaluation strategy — still nothing measures accuracy.
10. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Six packages and both apps remain documentation only.
- No linter or formatter is configured.
- Memory is proportional to the whole program rather than the analysed set: 37
  files here cost ~180 MB, because every declaration file reached through
  resolution is part of the program.
- `dispose` releases references only; reclamation depends on the garbage collector.
- Whether a repository type-checks is not reported.

### Next Milestone

IR Builder — convert TypeScript syntax into the language-independent
representation. Item 4 above is worth settling first: the IR records references
that the Resolver must later bind, and binding accuracy depends on the compiler
options being the repository's real ones.

## Repository Scanner

**Status:** complete. `pnpm build` clean, `pnpm test` 190 passing across 11 files.
*(Total is now 221 across 12 files, including the Project Host.)*

### Completed Work

- `RepositoryScanner.scan(path)` returning a `RepositoryInventory` with every
  field the milestone specifies.
- Source discovery via `fast-glob` for `.ts`, `.tsx`, `.mts`, `.cts`, ignoring the
  seven specified directories at any depth.
- Directory partitioning via an explicit pruning walk, so an ignored directory can
  be reported without being entered.
- Language, framework and package manager detection, each in its own module.
- `package.json` interpretation: name, dependency names across all four sections,
  and entry targets from `main`, `module`, `bin` and `exports` including nested
  condition maps and fallback arrays.
- Entry point resolution against discovered sources, recording whether each entry
  was declared or guessed.
- Error handling for a missing path, a file, an unreadable root and a malformed
  manifest.
- Verified against this repository: 31 sources, 21 directories, and all seven
  ignored directories located at depth including each package's `dist` and
  `node_modules`, without descending into any of them.

### Files Created

| File | Purpose |
|---|---|
| `src/repository-scanner.ts` | `RepositoryScanner`, `RepositoryScanError` |
| `src/types.ts` | `RepositoryInventory` and its supporting types |
| `src/ignore.ts` | Ignored directory names, glob patterns, membership test |
| `src/directory-walk.ts` | Pruning walk partitioning directories |
| `src/manifest.ts` | `package.json` reading, `MalformedManifestError` |
| `src/detect-language.ts` | Language detection |
| `src/detect-framework.ts` | Framework detection |
| `src/detect-package-manager.ts` | Lockfile precedence and selection |
| `src/entry-points.ts` | Entry point resolution |
| `src/index.ts` | Public surface |
| `src/repository-fixture.test-helper.ts` | Temporary repositories for tests |
| `src/repository-scanner.test.ts` | End-to-end scans against real directories |
| `src/directory-walk.test.ts` | Partitioning, pruning, symlink safety |
| `src/manifest.test.ts` | Manifest parsing and failure modes |
| `src/entry-points.test.ts` | Resolution, ordering, deduplication |
| `src/ignore.test.ts` | Ignore vocabulary conformance |
| `src/detect-language.test.ts`, `src/detect-framework.test.ts`, `src/detect-package-manager.test.ts` | Detection rules |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

Modified: `tsconfig.base.json` (added `esModuleInterop`), `tsconfig.json` and
`vitest.config.ts` (registered the package), root `README.md`.

### Architecture Decisions

| Decision | Reason |
|---|---|
| Directory partitioning uses `fs.readdir`, not glob ignores | `**/name/**` also matches the bare `name` entry, because the trailing `/**` matches zero segments. Glob ignores therefore cannot express "report the directory but do not enter it", which `ignoredPaths` requires. Found by a failing test, not by inspection. `fast-glob` still performs source discovery. |
| `esModuleInterop: true` added to `tsconfig.base.json` | `fast-glob` is published as CommonJS with `export =`, so it cannot otherwise be default-imported. Standard for a Node TypeScript project, but it changes shared config. **Flagged for confirmation.** |
| Scanner-local types, not `@traceiq/types` | The contract does not enumerate languages, frameworks or package managers as domain vocabulary. Promoting them would be an architectural decision. |
| Symlinks are never followed | Keeps the walk inside the repository and immune to cycles. A symlinked file or directory appears in no list. |
| Sources include `.d.ts` | The Project Host needs declaration files for resolution. Deciding what to do with one is a downstream concern, not a discovery one. |
| Entry points carry an `origin` | A declared entry and a conventional guess have different trustworthiness, and every inference must be explainable. |
| Declared targets pointing at build output are dropped | Build output is ignored and therefore never discovered. Mapping `dist/index.js` back to its source requires reading `tsconfig.json`, which belongs to the Project Host. |
| Malformed `package.json` throws; missing does not | Degrading would report language and framework as unknown for a repository that declares both, and the failure would be invisible. A repository with no manifest is still scannable. |
| Lockfile precedence rather than reporting ambiguity | Repositories accumulate lockfiles after migrations. `lockfile.path` records which file produced the answer. |
| Inventories are sorted | Walk order is not guaranteed; an unstable inventory would destabilise everything downstream. |
| Tests use real temporary directories | The scanner's job is to observe a filesystem; a mock would only prove it matches our model of one. |
| Sequential walk | Pruned at every ignored directory, so it covers the source tree only. Concurrency would trade a real file-descriptor risk for an unmeasured gain. |

### Pending Tasks

Carried forward from Workspace Setup, unchanged except where noted:

1. ~~Confirm the milestone sequence.~~ **Resolved** — milestones are named, not
   numbered.
2. Confirm the `shared` / `types` boundary.
3. Confirm `esModuleInterop` in the shared base config. *(New.)*
4. Job orchestration — still unowned; due at the Project Host milestone.
5. Representation of `AMBIGUOUS` — due at the Resolver.
6. Revision handling and incremental refresh — due at the Knowledge Graph.
7. `EXPOSES_ROUTE` — due at the Framework Extractor.
8. Evaluation strategy — nothing yet measures graph accuracy. The scanner is the
   first module producing output a fixture repository could be labelled against.
9. UI milestone — `apps/web` remains reserved and empty.

### Known Issues

- Seven packages and both apps remain documentation only.
- No linter or formatter is configured.
- A source file whose name contains `#` is discovered but cannot become a symbol
  identifier. The scan is not failed over it; `@traceiq/shared` rejects it later.
- Only root-level `tsconfig.json` is located. A monorepo whose packages each carry
  one reports `tsconfigPath: null`.
- Conventional entry points are reported even when the file is a barrel that
  re-exports everything. `origin` marks the guess; nothing judges significance.

### Next Milestone

Project Host — construct and own the ts-morph `Project` from an inventory. Item 4
above should be settled first: the whole-program type checker makes analysis a
long-running single-threaded job, and run state, progress and cancellation
currently have no owner.

## Milestone 0 — Workspace Setup

**Status:** complete. `pnpm build` clean, `pnpm test` 50 passing across 3 files.

### Completed Work

- pnpm workspace over `apps/*` and `packages/*`.
- Strict TypeScript base configuration, with `tsc -b` project references so
  packages build in dependency order and typechecking is the build.
- Vitest at the workspace root, aliased to package sources so tests never depend
  on a prior build.
- `@traceiq/types` — the domain vocabulary from the engineering contract:
  confidence levels, roles, relationship types, the `NodeId` type and its
  prefixes. Conformance tests assert the exact contents of each closed set.
- `@traceiq/shared` — repository path normalisation and the `file:`, `sym:` and
  `route:` identifier builders, with validation that refuses input which cannot
  produce a stable identifier.
- Documentation for every package in the architecture, including the eight not
  yet implemented, so module boundaries are recorded before code exists.
- CI running install, build and test.

### Files Created

**Workspace root**

| File | Purpose |
|---|---|
| `package.json` | Workspace root, scripts, dev dependencies |
| `pnpm-workspace.yaml` | Workspace globs |
| `tsconfig.base.json` | Shared strict compiler options |
| `tsconfig.json` | Solution file referencing built packages |
| `vitest.config.ts` | Test discovery and package source aliases |
| `.npmrc` | `engine-strict=true` |
| `.gitignore` | Excludes build output and generated `.db` graphs |
| `README.md` | Project overview, layout, commands |
| `.github/workflows/ci.yml` | Install, build, test |
| `docs/progress.md` | This file |

**`packages/types`**

| File | Purpose |
|---|---|
| `src/confidence.ts` | The four confidence levels |
| `src/roles.ts` | The six architectural roles |
| `src/relationships.ts` | The thirteen relationship types |
| `src/node-id.ts` | Branded `NodeId`, permitted prefixes |
| `src/index.ts` | Public surface |
| `src/vocabulary.test.ts` | Contract conformance tests |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

**`packages/shared`**

| File | Purpose |
|---|---|
| `src/repo-path.ts` | Canonical repository path normalisation |
| `src/node-id.ts` | `fileId`, `symbolId`, `routeId` |
| `src/index.ts` | Public surface |
| `src/repo-path.test.ts` | Normalisation and rejection cases |
| `src/node-id.test.ts` | Identifier construction and rejection cases |
| `package.json`, `tsconfig.json`, `README.md` | Package setup and documentation |

**Documentation-only placeholders**

`packages/scanner`, `packages/project-host`, `packages/ir`,
`packages/resolver`, `packages/framework`, `packages/graph`,
`packages/query`, `packages/context`, `apps/api`, `apps/web` — each a
`README.md` recording purpose, responsibilities and non-responsibilities.

### Architecture Decisions

Decisions taken during this milestone, all approved before implementation except
where noted.

| Decision | Reason |
|---|---|
| pnpm workspaces | Strict dependency isolation: a package cannot import what it did not declare, so boundary violations fail at build time rather than at review. |
| Vitest | Runs TypeScript directly, so tests need no build step. |
| `tsc -b` project references | Correct build ordering across packages, and one command that is both build and typecheck. |
| Graph Builder inside `packages/graph` | The architecture names two stages, the package structure names one package. They are separate internal modules, Builder depending on Store. Open for revision when the schema exists. |
| `types` holds vocabulary, `shared` holds behaviour | `types` depends on nothing and contains no logic; `shared` depends on `types`. Declaration-only vocabularies would have no runtime representation and would be restated by every consumer that needs to validate one. **Not explicitly approved — flagged for confirmation.** |
| Only `types` and `shared` initialised | Both are fully specified by the contract. Initialising the other eight would be implementing future milestones early; documenting them keeps the boundaries recorded. |
| Express not installed | No endpoint exists to serve. Will be requested when `apps/api` is built. |
| `NodeId` is a branded string | Prevents an arbitrary string being used where an identifier is expected, at no runtime cost. |
| CI created | `.github/` is in the specified structure and this is the obvious reason for it. Runs install, build, test only. **Not explicitly approved — flagged for confirmation.** |

Resolved dependency versions: TypeScript 7.0.2, Vitest 4.1.10, `@types/node`
26.1.2. Local toolchain Node 26.4.0, pnpm 11.15.0. CI pins Node 22 to keep the
declared `engines` floor honest.

### Pending Tasks

Ordered by the milestone that needs each answer.

1. **Confirm the milestone sequence.** The engineering contract does not restate
   the roadmap, so no milestone numbering has been assumed anywhere in this
   repository.
2. **Confirm the `shared` / `types` boundary** described above.
3. **Job orchestration** — deferred by decision to the Project Host milestone,
   when analysis first becomes slow. Run state, progress reporting and
   cancellation currently have no owner, and `apps/api` cannot own them without
   violating the rule that business logic must not depend on Express.
4. **Representation of `AMBIGUOUS`** — the confidence level exists but the shape
   for storing several candidate targets does not. Needed by the Resolver.
5. **Revision handling and incremental refresh** — whether nodes and
   relationships carry revision ranges, how content hashes drive invalidation,
   and whether a relationship records the files it was derived from. All three
   shape the graph schema and are expensive to retrofit. Needed by the Knowledge
   Graph milestone.
6. **`EXPOSES_ROUTE`** — absent from the contract's relationship list. Without
   it, a `Route` has no relationship to the file that registered it. Needed by
   the Framework Extractor.
7. **Evaluation strategy** — nothing currently measures graph accuracy, which
   caps the quality of every feature. Unit tests cannot answer whether resolution
   improved or regressed. Needs fixture repositories with hand-labelled expected
   relationships, reporting precision and recall per extractor.
8. **UI milestone** — `apps/web` is reserved and empty because the roadmap
   contains no phase in which anything becomes visible.

### Known Issues

- Eight packages and both apps are documentation only. They have no
  `package.json` and are absent from the build, so `pnpm build` covers two
  packages. *(Superseded by the Repository Scanner milestone: seven packages
  remain documentation only.)*
- No linter or formatter is configured. Style is currently maintained by hand.
- The identifier scheme is derived from location, so a rename or file move reads
  as a delete plus a create. Accepted for Version 1; rename detection is out of
  scope.
- CI pins pnpm to major version 11 and Node to 22 without a lockfile-verified
  toolchain pin.

### Next Milestone

Repository Scanner — repository walk, inventory, project type, framework and
package manager detection, ignore rules. Blocked on nothing above; item 1 should
be confirmed first so this file can name milestones consistently.
