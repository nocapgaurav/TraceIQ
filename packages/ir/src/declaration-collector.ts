import { symbolId } from '@traceiq/shared';
import type { NodeId } from '@traceiq/types';

import { compareSourceRanges } from './source-range.js';
import type {
  DeclarationIR,
  DeclarationKind,
  DeclarationModifiers,
  SourceRange,
  Visibility,
} from './types.js';

export interface DeclarationInput {
  readonly repoRelativePath: string;
  readonly fileId: NodeId;
  readonly kind: DeclarationKind;
  readonly name: string;
  /** Containers outermost first, ending in `name`. */
  readonly containerChain: readonly string[];
  readonly visibility: Visibility | null;
  readonly modifiers: DeclarationModifiers;
  /** At least one site. */
  readonly locations: readonly SourceRange[];
}

interface CollectedDeclaration {
  readonly id: NodeId;
  readonly fileId: NodeId;
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly containerChain: readonly string[];
  visibility: Visibility | null;
  modifiers: DeclarationModifiers;
  readonly locations: SourceRange[];
}

/**
 * Accumulates declarations keyed by their stable identifier.
 *
 * The identifier format is a symbol path, so several syntactic sites can share
 * one. Rather than emit duplicate identifiers — which would collide the moment
 * the graph keyed a node on one — the collector treats the identifier as the unit
 * and folds the sites into a single declaration with several locations.
 *
 * This is correct for the cases that actually occur: overload signatures, a
 * getter and setter pair, and a merged interface are all one symbol declared more
 * than once. Merging across files never happens, because the identifier contains
 * the file path.
 *
 * When sites disagree, the first in source order wins for `kind`, the first
 * non-null wins for `visibility`, and modifiers are unioned — an overload set
 * whose `export` sits only on the first signature is exported.
 */
export interface CollectedDeclarationRef {
  readonly id: NodeId;
  /**
   * False when this site merged into a declaration already collected.
   *
   * Callers use it to avoid recording a consequence once per site. An exported
   * declaration with three overload signatures is one export, not three.
   */
  readonly isNew: boolean;
}

export class DeclarationCollector {
  readonly #byId = new Map<NodeId, CollectedDeclaration>();

  add(input: DeclarationInput): CollectedDeclarationRef {
    const id = symbolId(input.repoRelativePath, input.containerChain);
    const existing = this.#byId.get(id);

    if (existing === undefined) {
      this.#byId.set(id, {
        id,
        fileId: input.fileId,
        kind: input.kind,
        name: input.name,
        containerChain: [...input.containerChain],
        visibility: input.visibility,
        modifiers: input.modifiers,
        locations: [...input.locations],
      });

      return { id, isNew: true };
    }

    existing.locations.push(...input.locations);
    existing.modifiers = unionModifiers(existing.modifiers, input.modifiers);
    existing.visibility ??= input.visibility;

    return { id, isNew: false };
  }

  /** Declarations in first-encounter order, each with its sites in source order. */
  toArray(): readonly DeclarationIR[] {
    return [...this.#byId.values()].map((declaration) => ({
      id: declaration.id,
      fileId: declaration.fileId,
      kind: declaration.kind,
      name: declaration.name,
      containerChain: declaration.containerChain,
      visibility: declaration.visibility,
      modifiers: declaration.modifiers,
      locations: [...declaration.locations].sort(compareSourceRanges),
    }));
  }
}

function unionModifiers(
  left: DeclarationModifiers,
  right: DeclarationModifiers,
): DeclarationModifiers {
  return {
    isExported: left.isExported || right.isExported,
    isStatic: left.isStatic || right.isStatic,
    isAbstract: left.isAbstract || right.isAbstract,
    isReadonly: left.isReadonly || right.isReadonly,
    isOptional: left.isOptional || right.isOptional,
    isAsync: left.isAsync || right.isAsync,
  };
}
