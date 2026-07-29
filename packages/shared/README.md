# @traceiq/shared

## Purpose

Small, framework-free runtime utilities used across packages. At Milestone 0 that
means the construction of stable node identifiers.

## Responsibilities

- Normalise repository-relative paths into one canonical form.
- Build `file:`, `sym:` and `route:` identifiers exactly as the contract defines
  them.
- Reject input that cannot produce a stable identifier, rather than guessing.

## Non-responsibilities

- No filesystem access. Paths are treated as strings; discovering them is the
  Repository Scanner's job.
- No knowledge of TypeScript syntax, SQLite, Express or the graph schema.
- Not a general utility dumping ground. Anything belonging to one package stays
  in that package.

## Inputs

Repository-relative path strings, container chains, HTTP methods and route paths.

## Outputs

Canonical path strings and branded `NodeId` values.

## Extension Points

Identifier prefixes beyond `file:`, `sym:` and `route:` will be needed for
environment variables, external packages and database tables. Each new prefix is
a contract addition and gets its own builder here.

## Known Limitations

- Identifiers are derived from location, so a rename or a file move reads as a
  delete plus a create. Rename detection is not part of Version 1.
- `normalizeRepoPath` does not consult the filesystem, so it cannot detect
  case-only collisions on case-insensitive volumes.
- Route path normalisation is intentionally private. Composing Express router
  prefixes is the Framework Extractor's problem, and exporting a helper before
  that code exists would be guessing at its needs.

## Design Notes

`NodeId` is a branded string so an arbitrary string cannot be passed where an
identifier is expected. The brand costs nothing at runtime and catches the class
of bug where a raw path is used as a node key.
