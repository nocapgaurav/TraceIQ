import type { ConfidenceLevel } from '@traceiq/types';
import { Node, type Symbol as TsSymbol } from 'ts-morph';

import type { DeclarationIndex } from './declaration-index.js';
import { classifyExternalFile } from './external-classification.js';
import { sourceRangeOf } from './source-position.js';
import type { ResolutionTarget, UnresolvedReason } from './types.js';

export type SymbolResolution =
  | {
      readonly outcome: 'resolved';
      readonly targets: readonly ResolutionTarget[];
      readonly confidence: ConfidenceLevel;
      readonly evidence: string;
    }
  | {
      readonly outcome: 'unresolved';
      readonly reason: UnresolvedReason;
      readonly evidence: string;
    };

/**
 * Resolves a symbol to everything it could point at.
 *
 * Aliases are followed once: the checker's `getAliasedSymbol` resolves an import
 * or export indirection all the way to the declaring symbol, so a chain of
 * re-exports needs no manual walking.
 *
 * A symbol may declare in several places. Sites belonging to one IR declaration —
 * overload signatures, a merged interface within a file — collapse to a single
 * target, so they are correctly reported as unambiguous. Genuinely distinct
 * targets are all returned and reported as AMBIGUOUS; none is dropped.
 */
export function resolveSymbol(
  symbol: TsSymbol | undefined,
  index: DeclarationIndex,
): SymbolResolution {
  if (symbol === undefined) {
    return {
      outcome: 'unresolved',
      reason: 'no-symbol',
      evidence: 'the type checker reports no symbol at this reference',
    };
  }

  const aliased = symbol.getAliasedSymbol();
  const resolved = aliased ?? symbol;
  const aliasNote = aliased === undefined ? '' : ` after following the alias '${symbol.getName()}'`;
  const declarations = resolved.getDeclarations();

  if (declarations.length === 0) {
    return {
      outcome: 'unresolved',
      reason: 'no-declaration',
      evidence: `symbol '${resolved.getName()}' has no declaration${aliasNote}`,
    };
  }

  const targets = new Map<string, ResolutionTarget>();
  let skippedInAnalysedFile = 0;
  let typeParameterSites = 0;

  for (const declaration of declarations) {
    const absolutePath = declaration.getSourceFile().getFilePath();
    const fileId = index.fileIdOf(absolutePath);

    if (fileId === undefined) {
      const external = classifyExternalFile(absolutePath);

      targets.set(`external:${external.origin}:${external.name ?? ''}`, {
        kind: 'external',
        origin: external.origin,
        name: external.name,
      });

      continue;
    }

    const range = sourceRangeOf(declaration);
    const irDeclaration = index.declarationAt(fileId, range.startLine, range.startColumn);

    if (irDeclaration === undefined) {
      if (Node.isTypeParameterDeclaration(declaration)) {
        typeParameterSites += 1;
      } else {
        skippedInAnalysedFile += 1;
      }

      continue;
    }

    targets.set(`declaration:${irDeclaration.id}`, {
      kind: 'declaration',
      declarationId: irDeclaration.id,
    });
  }

  if (targets.size === 0) {
    if (typeParameterSites > 0 && skippedInAnalysedFile === 0) {
      return {
        outcome: 'unresolved',
        reason: 'type-parameter',
        evidence: `'${resolved.getName()}' is a type parameter, which the IR does not record as a declaration`,
      };
    }

    return {
      outcome: 'unresolved',
      reason: 'declaration-not-in-ir',
      evidence:
        `symbol '${resolved.getName()}' declares only at positions the IR did not record` +
        `${aliasNote}; the name is likely one the identifier format cannot address`,
    };
  }

  const skippedNote =
    skippedInAnalysedFile === 0
      ? ''
      : `; ${skippedInAnalysedFile} further declaration site(s) were not recorded by the IR`;

  if (targets.size === 1) {
    return {
      outcome: 'resolved',
      targets: [...targets.values()],
      confidence: 'RESOLVED',
      evidence: `the type checker bound '${resolved.getName()}' to one target${aliasNote}${skippedNote}`,
    };
  }

  return {
    outcome: 'resolved',
    targets: [...targets.values()],
    confidence: 'AMBIGUOUS',
    evidence:
      `the type checker bound '${resolved.getName()}' to ${targets.size} distinct targets` +
      `${aliasNote}${skippedNote}`,
  };
}
