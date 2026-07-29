# @traceiq/types

## Purpose

Holds the domain vocabulary shared by every TraceIQ package: the closed sets
fixed by the engineering contract, plus the types derived from them.

## Responsibilities

- Define the four confidence levels.
- Define the six architectural roles.
- Define the thirteen relationship types.
- Define the `NodeId` type and its permitted prefixes.
- Fail loudly if any of those closed sets is edited, via conformance tests.

## Non-responsibilities

- No logic. Vocabularies are declared, never interpreted here.
- No knowledge of TypeScript syntax, SQLite, Express or the graph schema.
- No identifier construction — that belongs to `@traceiq/shared`.

## Inputs

None. This package depends on nothing.

## Outputs

Constant vocabularies and the union types derived from them.

## Extension Points

New vocabulary entries are architectural changes, not implementation details.
Adding one requires updating the engineering contract first; the conformance
tests in `vocabulary.test.ts` exist to force that conversation.

## Known Limitations

- Node types are deliberately absent. The contract does not enumerate them, so
  they will be defined when the graph schema is designed.
- The vocabularies carry no legality rules. Which node types may sit at each end
  of which relationship is a graph-schema concern, not a vocabulary concern.

## Design Notes

The vocabularies are `as const` arrays with union types derived from them rather
than type-only declarations. A type-only definition would have no runtime
representation, forcing every consumer that needs to validate or enumerate a
vocabulary to restate the list — and duplicated closed sets drift.
