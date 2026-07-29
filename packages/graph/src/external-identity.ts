import type { ResolutionTarget } from '@traceiq/resolver';
import type { NodeId } from '@traceiq/types';

import type { ExternalIdKind } from './types.js';

export interface ExternalIdentity {
  readonly id: NodeId;
  readonly kind: ExternalIdKind;
  /** `null` when no name is recoverable. */
  readonly name: string | null;
}

const NODE_PREFIX = 'node:';

/**
 * Derives an external node identity, per the approved scheme in spec §5.2.
 *
 * ```
 * ext:npm:<package-name>       ext:npm:express, ext:npm:@types/node
 * ext:node:<module-name>       ext:node:fs, ext:node:fs/promises
 * ext:builtin:<symbol-name>    ext:builtin:Promise
 * ext:outside-analysis         a single nameless sentinel
 * ```
 *
 * A package version never appears in an identity: it is metadata, and including it
 * would make every upgrade look like a different dependency.
 *
 * `referenceName` is the *relationship's* name, needed only for a TypeScript
 * built-in. Such a target deliberately carries no name of its own, because a
 * built-in is declared across several lib files and naming one would make a single
 * type look like several ambiguous candidates.
 */
export function externalIdentityOf(
  target: Extract<ResolutionTarget, { kind: 'external' }>,
  referenceName: string | null,
): ExternalIdentity {
  switch (target.origin) {
    case 'package':
      return external('npm', target.name);

    case 'node-builtin':
      // The reserved prefix is what identifies a builtin, so it is stripped from the
      // name rather than repeated: `node:fs` becomes `ext:node:fs`.
      return external('node', stripNodePrefix(target.name));

    case 'typescript-lib':
      // A name is never fabricated. Without one the identity is the bare kind, which
      // is defined behaviour rather than an accident.
      return external('builtin', referenceName);

    case 'outside-analysis':
      // No package or symbol name is recoverable: the Resolver records no path for
      // these, so they collapse to one sentinel node.
      return external('outside-analysis', null);
  }
}

function external(kind: ExternalIdKind, name: string | null): ExternalIdentity {
  const trimmed = name === null || name.trim().length === 0 ? null : name.trim();

  return {
    id: (trimmed === null ? `ext:${kind}` : `ext:${kind}:${trimmed}`) as NodeId,
    kind,
    name: trimmed,
  };
}

function stripNodePrefix(name: string | null): string | null {
  if (name === null) {
    return null;
  }

  return name.startsWith(NODE_PREFIX) ? name.slice(NODE_PREFIX.length) : name;
}
