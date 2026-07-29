# @traceiq/call-graph

## Purpose

Bind the IR's call sites into `CALLS` relationships.

Consumes a `RepositoryIR` and a `ResolvedRepository`, and returns a `CallGraph`. A pure
function of its inputs: no filesystem, no compiler, no database, no graph, and neither
input is modified.

## Responsibilities

Seven binding rules, one per call shape:

| Rule | Shape | Bound via |
|---|---|---|
| `local` | `helper()` | a declaration in scope in the same file |
| `imported` | `helper()` | an import the Resolver bound to a declaration |
| `this-member` | `this.helper()` | a member of the container enclosing the call |
| `static-member` | `Service.make()` | a member of the class the root names |
| `namespace-member` | `ns.helper()` | an export of a module a namespace import names |
| `construction` | `new Service()` | the constructor of the class the root names |
| `instance-member` | `svc.run()` | a member of the class `svc` was constructed from |

**Scope, not top level.** `local` resolves a bare name by walking outwards from the
declaration containing the call — innermost first, then each enclosing declaration, then
the file. That is what binds a call to a function nested inside the caller, and it means
an inner name correctly wins over an outer one of the same name.

**Instance members without a type checker.** `const svc = new Service()` is a call site
whose enclosing declaration *is* `svc`, so one pass over the constructions yields a
variable-to-class map, and `svc.run()` binds through it. No types are consulted: the link
is a fact about which declaration the IR attributed the construction to.

A construction whose class declares no constructor points at **the class**. The
construction happens either way, and naming the class says more than reporting nothing.

## Non-responsibilities

- **Infers no runtime dispatch.** An interface method with three implementations yields no
  edge to any of them.
- **Analyses no inheritance.** `super.method()` and a method inherited from a base class
  are not bound.
- **Analyses no dynamic call.** A callee held in a variable, passed as a parameter, or
  produced by an expression is reported rather than guessed.
- Builds no execution graph. `CALLS` is a static relationship; ordering an execution path
  through it is a later concern.
- Performs no AI reasoning.
- Contains no compiler and no database.

## Confidence

**Every relationship is `INFERRED`**, and the reason is structural: this stage receives a
`RepositoryIR` and a `ResolvedRepository`, not a `ProjectContext`, so it binds *names*
rather than *symbols*. A local of the same name could shadow the declaration matched, and
without a checker there is no way to rule that out.

Which rule fired is recorded in the provenance, where the strength of the evidence belongs.

## What does not bind, and why

Nothing is dropped. Every call site produces either a relationship or an entry in
`unresolved`, with a reason:

| Reason | Meaning |
|---|---|
| `root-is-external` | The root names a package or Node builtin. **Not a failure** — the call leaves the repository, so no repository declaration exists to point at. |
| `callee-not-addressable` | The callee is not rooted at an identifier: `getSvc().run()`, `new Service().run()`, a chained call. |
| `root-not-bound` | The root matches no declaration, import or namespace binding — usually a local, a parameter, or a language global. |
| `root-type-unknown` | The root names a value whose type is not recoverable, so binding the member would need a checker: `const svc = getService(); svc.run()`. |
| `member-not-found` | The root bound to a container that has no such member. |
| `no-enclosing-container` | `this.x()` where the enclosing declaration has no container. |

`root-is-external` exists because conflating "the call leaves the repository" with "we
could not bind it" blames the analysis for something it got right. On this repository that
distinction reclassifies 2,066 call sites.

## Measured on this repository

6,157 call sites: **1,321 bound** (`local` 533, `imported` 489, `instance-member` 112,
`construction` 99, `static-member` 57, `this-member` 31), 4,836 unbound — of which 2,066
correctly leave the repository. Binding takes about 5 ms. Five self-calls, so recursion is
present and represented.

Of the 4,091 sites that *could* point at repository code, **32.3%** bind.

**Before and after the IR Expansion**, measured on the same tree with the expansion
reverted, so the comparison isolates the change:

| | Sites | Bound | Of repository-addressable |
|---|---|---|---|
| Before | 5,953 | 1,108 (18.6%) | 28.3% |
| After | 6,157 | 1,321 (21.5%) | **32.3%** |

The 213 new edges are 99 `construction`, 112 `instance-member` and 2 `local`. They came
from 54 sites previously `root-type-unknown`, 60 previously `root-not-bound` (a nested
variable was not a declaration at all, so its root could not bind), and 99 constructions
that were not call sites.

The largest remaining group is **`callee-not-addressable` (1,249, unchanged)**. 1,216 of
those contain a call inside the callee — `new ProjectHost().load()`,
`chain.slice(0, -1).join('.')`. Binding them needs the *type of an expression*, not the
resolution of a name, so no name-based rule can reach them. That is a type-checker
problem, not a missing IR feature.

## Recursion and duplicates

A self-call is bound like any other: `function f() { f() }` yields a relationship whose
source and target are both `f`. Recursion is a fact about the code, and nothing here
traverses, so there is no loop to guard against.

Two calls to the same target from the same source are two relationships, distinguished by
location — which is what a caller wants when asking where the calls are. One call site
never produces two relationships: exactly one rule fires per site.

## Performance

Linear in the number of call sites. Every binding lookup is constant time against indexes
built in a single pass over the IR's declarations and the resolved relationships.

## Testing Notes

Fixtures run real TypeScript through the Project Host, IR Builder and Resolver before
binding, because the rules depend on details of what the IR records — which expressions,
how they are attributed, how a callee splits into root and member. A hand-rolled IR could
disagree with the real one.

The suite covers all five rules, recursion, module-level attribution, and every failure
reason. One test asserts the invariant that matters most: every call site produces exactly
one outcome, so `calls.length + unresolved.length` equals the number of recorded sites.

## Known Limitations

- **No type checker**, so every edge is `INFERRED` and shadowing cannot be ruled out.
  Scope-aware lookup narrows this — an inner name now wins — but a parameter or a local
  the IR does not record can still shadow a match.
- **A callee containing a call is unbindable.** `new Service().run()` and
  `chain.slice(0, -1).join('.')` need the type of an intermediate expression. 1,249 sites,
  the largest remaining group.
- **A `this` chain longer than one link is unbindable**, and — a labelling defect — is
  reported as `member-not-found`. The `this-member` rule takes the *last* member of the
  chain and looks it up on the enclosing container, so `this.callGraph.calls.find()` asks
  whether the container has a `find`. All 111 `member-not-found` entries on this repository
  are this shape, and 110 of them are chains of more than one link. Most would not become
  repository edges even when bound correctly — the far end is usually an array or a package
  type — but the reason they carry today blames the wrong thing. Fixing it needs a new
  reason in the vocabulary, so it is listed for approval in `docs/progress.md` rather than
  changed here.
- **A construction in a property initializer is not tracked.** `private svc = new Service()`
  makes `this.svc.run()` bindable in principle: the construction is attributed to the
  property. Only variables are mapped today, and extending it needs the chain-aware `this`
  rule above to be useful.
- **Reassignment is not tracked.** `let svc = new A(); svc = new B(); svc.run()` binds to
  `A`, because the map is keyed by declaration and the last write is not modelled.
- **No inheritance**, so a call to an inherited method binds to nothing, and a construction
  of a subclass points at the subclass's own constructor or the subclass itself.
- **No interface dispatch**, deliberately: an interface method call has no static target.
- **A call inside an anonymous callback attributes to the nearest named declaration** or to
  the file, since the IR can record no declaration for an unnamed arrow. This is why
  test-file calls are attributed to their file.
- **`super.method()`** is not bound.
