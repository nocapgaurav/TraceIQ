declare const nodeIdBrand: unique symbol;

/**
 * A stable Knowledge Graph node identifier.
 *
 * Identifiers are derived from repository structure, never randomly generated,
 * and must survive an edit to a symbol's body so that later revisions can be
 * compared against earlier ones. The brand exists so an arbitrary string cannot
 * be passed where an identifier is expected; construct values through the
 * builders in `@traceiq/shared`.
 *
 * Known limitation: a rename or a file move changes the derived identifier, so
 * it reads as a delete plus a create. Rename detection is not part of Version 1.
 */
export type NodeId = string & { readonly [nodeIdBrand]: true };

/**
 * Identifier prefixes defined by the engineering contract.
 *
 *   file   file:src/auth/auth.service.ts
 *   sym    sym:src/auth/auth.service.ts#AuthService.login
 *   route  route:POST:/api/auth/login
 *   env    env:DATABASE_URL
 *   ext    ext:npm:express, ext:node:fs, ext:builtin:Promise
 *   art    art:.github/workflows/ci.yml#job:jobs:build
 *
 * `art` is its own prefix rather than a reuse of `sym`, and the distinction is load-bearing. A `sym`
 * identifier names a declaration a language analyser parsed; an `art` identifier names a piece of a
 * configuration file a line reader recognised. They carry different confidence, they are produced by
 * different capabilities, and a consumer showing "declarations in this file" must not be handed a
 * workflow step. Sharing a prefix would make that distinction unrecoverable from the identifier, which is
 * the one place every layer can still read it.
 */
export const NODE_ID_KINDS = ['file', 'sym', 'route', 'env', 'ext', 'art'] as const;

export type NodeIdKind = (typeof NODE_ID_KINDS)[number];
