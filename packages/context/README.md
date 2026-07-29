# @traceiq/context

**Status: not implemented.** Reserved by the architecture; initialised at the
Context Builder milestone. Full seven-section documentation lands with the
implementation.

## Purpose

Assemble the minimal context needed to answer a question, using the graph to
decide which source code is worth reading.

## Responsibilities

- Query the Query Engine to identify relevant symbols.
- Load source only for the symbols selected.
- Rank and truncate to fit a token budget, and report what was dropped.

## Non-responsibilities

- Never searches the repository. If this package is scanning files, the graph has
  failed at its job.
- Calls no model. Prompting belongs to the AI Layer.
- Reads no SQLite directly.

## Design Constraint

A graph query can return far more nodes than any prompt can hold, so the token
budget is a real constraint rather than a formatting concern. Silent truncation
would make an incomplete answer indistinguishable from a complete one, so what
was dropped has to be reported.
