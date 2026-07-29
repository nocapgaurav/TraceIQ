import type { NodeId } from '@traceiq/types';
import type { Node } from 'ts-morph';

import type { ResolvedDeclaration } from './types.js';

/**
 * Records what the checker knows about one IR declaration.
 *
 * `isExportedFromModule` is the enrichment the IR could not perform. The IR sees
 * only an `export` modifier; the checker also accounts for a declaration exported
 * by a separate `export { … }` statement.
 *
 * A declaration with no symbol is reported rather than omitted, so the gap stays
 * visible.
 */
export function enrichDeclaration(input: {
  readonly node: Node;
  readonly declarationId: NodeId;
  readonly fileId: NodeId;
}): ResolvedDeclaration {
  const symbol = input.node.getSymbol();

  if (symbol === undefined) {
    return {
      declarationId: input.declarationId,
      hasSymbol: false,
      isExportedFromModule: false,
      provenance: {
        resolver: 'declarations',
        fileId: input.fileId,
        evidence: 'the type checker reports no symbol at this declaration',
      },
    };
  }

  const exportedName = moduleExportNameOf(input.node);

  return {
    declarationId: input.declarationId,
    hasSymbol: true,
    isExportedFromModule: exportedName !== null,
    provenance: {
      resolver: 'declarations',
      fileId: input.fileId,
      evidence:
        exportedName === null
          ? `'${symbol.getName()}' is not among its module's exports`
          : `'${symbol.getName()}' is exported from its module as '${exportedName}'`,
    },
  };
}

/**
 * The name a declaration is exported under, or `null` when it is module-local.
 *
 * Settled by declaration identity rather than by name, because a default export's
 * symbol is called `default` while the declaration keeps its own name. A class
 * member never appears among a module's exports, so members return `null` without
 * needing a special case.
 */
function moduleExportNameOf(node: Node): string | null {
  const moduleSymbol = node.getSourceFile().getSymbol();

  if (moduleSymbol === undefined) {
    return null;
  }

  for (const exported of moduleSymbol.getExports()) {
    const declarations = (exported.getAliasedSymbol() ?? exported).getDeclarations();

    if (declarations.includes(node)) {
      return exported.getName();
    }
  }

  return null;
}
