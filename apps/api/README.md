# api

**Status: not implemented.** No HTTP layer exists yet, and no dependency has been
added — Express is not installed.

## Purpose

Expose repository intelligence over HTTP.

## Responsibilities

- Translate HTTP requests into calls on the engine packages.
- Serialise results, including their confidence and provenance.

## Non-responsibilities

- Contains no business logic. Anything worth unit-testing belongs in a package,
  because business logic must not depend on Express.
- Does no analysis, and does not read SQLite directly.

## Note

Adding Express requires approval, per the contract. It will be requested when
there is an endpoint to serve rather than installed speculatively now.
