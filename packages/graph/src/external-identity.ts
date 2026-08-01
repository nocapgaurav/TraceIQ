import type { ResolutionTarget } from '@traceiq/resolver';
import type { Ecosystem, NodeId } from '@traceiq/types';

import type { ExternalIdKind } from './types.js';

export interface ExternalIdentity {
  readonly id: NodeId;
  readonly kind: ExternalIdKind;
  /** `null` when no name is recoverable. */
  readonly name: string | null;
}

const NODE_PREFIX = 'node:';

/**
 * Derives an external node identity.
 *
 * ```
 * ext:<ecosystem>:<package>    ext:npm:express, ext:maven:org.apache.commons:commons-lang3,
 *                              ext:go:github.com/gin-gonic/gin, ext:python:fastapi
 * ext:node:<module>            ext:node:fs, ext:node:fs/promises
 * ext:stdlib:<module>          ext:stdlib:java.util, ext:stdlib:net/http, ext:stdlib:os
 * ext:builtin:<symbol>         ext:builtin:Promise
 * ext:outside-analysis         a single nameless sentinel
 * ```
 *
 * **The ecosystem is what made this universal.** A package identity used to be `ext:npm:<name>` and
 * nothing else, so a Maven coordinate or a Go module path had no identity to take and was dropped —
 * a Python or Java reader saw the dependencies a manifest *declared* and never the ones a file
 * actually *used*. The ecosystem now comes from the resolution itself, and a new language reuses a
 * value from `ECOSYSTEMS` rather than adding anything here.
 *
 * `node` is retained alongside `stdlib` deliberately rather than folded into it. It is the *more
 * specific* statement — the module comes from Node's library, not merely from some standard library —
 * and it keeps every JavaScript and TypeScript identity byte-identical to what is already stored.
 *
 * A standard-library name must be unambiguous on its own, which every language's own convention
 * already makes it: `java.util`, `net/http`, `os`. Nothing here qualifies it further, because
 * inventing a prefix the source never wrote would be fabrication of exactly the kind this layer exists
 * to prevent.
 *
 * A package version never appears in an identity: it is metadata, and including it would make every
 * upgrade look like a different dependency.
 *
 * `referenceName` is the *relationship's* name, needed only for a language built-in. Such a target
 * deliberately carries no name of its own, because a built-in may be declared across several files and
 * naming one would make a single type look like several ambiguous candidates.
 */
export function externalIdentityOf(
  target: Extract<ResolutionTarget, { kind: 'external' }>,
  referenceName: string | null,
): ExternalIdentity {
  switch (target.origin) {
    case 'package':
      // `npm` only as a last resort, for an analyser that resolved a package without saying where
      // from. Every analyser in the tree names its ecosystem.
      return external(ecosystemKind(target.ecosystem), target.name);

    case 'standard-library':
      // Node keeps its own kind, and the reserved prefix that identifies a builtin is stripped rather
      // than repeated: `node:fs` becomes `ext:node:fs`.
      return target.ecosystem === 'npm'
        ? external('node', stripNodePrefix(target.name))
        : external('stdlib', target.name);

    case 'language-builtin':
      // A name is never fabricated. Without one the identity is the bare kind, which is defined
      // behaviour rather than an accident.
      return external('builtin', referenceName);

    case 'outside-analysis':
      // No package or symbol name is recoverable: the Resolver records no path for these, so they
      // collapse to one sentinel node.
      return external('outside-analysis', null);
  }
}

/**
 * The identity kind for a package's ecosystem.
 *
 * Every `Ecosystem` is also an `ExternalIdKind`, by construction — `EXTERNAL_ID_KINDS` is built from
 * `ECOSYSTEMS` — so this is a narrowing rather than a mapping, and a new ecosystem needs no entry.
 */
function ecosystemKind(ecosystem: Ecosystem | null): ExternalIdKind {
  return ecosystem ?? 'npm';
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
