# @traceiq/framework

## Purpose

The first framework-specific package. Reads Express conventions out of a repository's
syntax and reports them as **annotations** — claims about existing facts, each carrying
the syntax it was read from.

Version 1 supports Express only.

## Responsibilities

- Detect whether Express is present.
- Extract Express routes: method, path, handler chain, location, confidence, provenance.
- Extract `process.env` reads.
- Attribute architectural roles: Controller, Service, Repository, Middleware, Model, Test.

## Non-responsibilities

- Writes no SQLite and builds no graph nodes.
- Queries no graph.
- Modifies neither the `RepositoryIR` nor the `ResolvedRepository`.
- Performs no call graph analysis. It reads call *sites* the IR recorded; it does not
  connect callers to callees.
- Performs no AI reasoning.
- **Contains no compiler.** `ts-morph` is neither imported nor exported here — a
  checkable invariant, and the reason this package could be written at all.

## Inputs

```
RepositoryIR          @traceiq/ir
ResolvedRepository    @traceiq/resolver
```

The IR supplies the syntax. The `ResolvedRepository` supplies one thing the IR cannot:
whether a specifier reading `'express'` actually resolved to the express *package*
rather than to a local module of that name. That distinction appears in the provenance
of every route.

### Why the IR had to be extended first

Route registration is a call expression and `process.env.PORT` is a member access.
Neither existed in the IR, which recorded declarations, imports and exports only —
`/login` and `process` appeared nowhere in it.

The alternative was to give this package a `ProjectContext` and let it walk the AST
itself. That was rejected: it would put the compiler inside a framework package and
create a second traversal whose rules could drift from the IR's. Extending the IR with
`callSites` and `memberAccesses` instead keeps one AST walk, one set of rules, and no
compiler below the IR — and is the prerequisite for `CALLS` edges later.

## Outputs

```ts
const annotations = new FrameworkExtractor().extract({ ir, resolved });
```

```
framework           'express' | null
roles[]             declarationId, role, confidence, provenance, location
routes[]            method, path, handlers[], registeredInDeclarationId,
                    confidence, provenance, location
environmentUsages[] name, usedInDeclarationId, confidence, provenance, location
```

Plain data throughout, JSON-round-trippable. Deterministic: the same inputs produce
identical annotations, and there are tests asserting it.

## Confidence

**Every annotation is `INFERRED`.** Not one is `CERTAIN`, and that is deliberate.

Express offers no base class, no decorator and no interface to key on. Every claim
rests either on a naming or directory convention, or on a syntactic chain that a later
reassignment could invalidate — and the IR records no assignments. `RESOLVED` is
unavailable because this package has no resolver of its own.

Strength of evidence therefore lives in the **provenance text**, which is where an
explanation belongs. A route traced to a confirmed express package says so; one traced
only through the specifier text says that instead.

## How a route is found

```ts
import { Router } from 'express';     // 1. a binding from express
const router = Router();             // 2. a call on it, initialising a variable
router.post('/login', authGuard, handle);   // 3. an HTTP method on that variable
```

All three links come from the IR. Requiring step 2 — a *traced* router variable — is
what stops every `foo.get(...)` in the repository from looking like a route. It is also
the main source of missed routes; see the limitations.

The first argument must be a string literal, which the IR already carries as a value, so
no expression text is parsed. Remaining arguments are the handler chain **in source
order**, so middleware order survives.

A handler is linked to a declaration only where the IR already establishes it: a bare
identifier naming a top-level declaration in the same file. `controller.login` stays
text, because binding it is resolution.

## How a role is attributed

| Role | Evidence |
|---|---|
| `Middleware` | **Used as middleware** — a non-final handler in a route chain, or mounted with `use`. Preferred over any convention. |
| `Controller`, `Service`, `Repository`, `Model` | Name suffix, or a directory segment |
| `Middleware` (fallback) | Name suffix or directory, when no use-site evidence exists |
| `Test` | The file is a test by name or directory |

Use-site evidence is the interesting one: `router.get('/x', authGuard, handle)` makes
`authGuard` middleware regardless of what it is called. That is a fact about the code,
not a guess about its name.

Roles attach to top-level classes, functions and variables. A class member never
receives one — a method plays no architectural role; its class does.

`use` produces no route: it carries no HTTP method, and the path it may take composes a
prefix onto routes registered elsewhere, which this milestone does not resolve.

## Known Limitations

- **A router that arrives by import is not traced.** `import router from './routes'`
  then `router.get(...)` yields no route, because the trace to an express binding lives
  in the other file. This is the largest gap, and the price of not resolving.
- **A computed path is skipped.** `router.get(BASE + '/x', h)` produces no route rather
  than a guessed one.
- **Prefix composition is not resolved.** `app.use('/api', router)` means the routes in
  `router` are really `/api/...`, and the paths reported here are as written locally.
- **Dynamically registered routes are invisible.** A loop over a config array, or
  glob-based auto-loading, registers routes no static reading can enumerate.
- **A member-expression handler is unlinked.** `controller.login` stays text.
- **Convention-based roles fire on any repository.** On this one — which uses no Express
  — the function `mountedMiddleware` is annotated `Middleware` purely because of its
  name. That is the honest cost of a naming convention, which is why the evidence names
  the suffix that matched so a reader can dismiss it in one glance.
- **`process` is not proven to be the global.** Every environment read is `INFERRED`,
  and the evidence states whether anything in the file declares or imports that name.
- **A computed environment key is skipped.** `process.env[key]` names no variable, and
  reporting `process.env` would claim a different read from the one written.
- **`Test` is broad.** Every top-level declaration in a test file receives it.
- **No framework abstraction exists.** There is no plugin interface and no `Framework`
  type. One framework cannot show what a second would need, and inventing the seam now
  would be guessing — a second framework is the right time to design it.

## Performance

Extraction over this repository — 86 files, 4,351 call sites, 1,067 member accesses —
takes about 1 ms. Call sites are grouped by file once and shared by every annotator, and
routes and mounted middleware are found in a single pass.

## Testing Notes

Fixtures run real TypeScript through the Project Host, IR Builder and Resolver before
annotating, because the extraction depends on details of what the IR actually records
and how it attributes expressions. A hand-rolled IR could disagree with the real one.

The suites cover every HTTP method, template-literal paths, handler ordering, use-site
middleware, each role convention by both suffix and directory, and — as much as the
positive cases — what is deliberately *not* annotated: `use`, computed paths, handlerless
registrations, and method calls on a root never traced to Express.
