import path from 'node:path';

import type { DeclarationIR, RepositoryIR, SourceRange } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';

/**
 * Correlates compiler nodes back to IR declarations by source position.
 *
 * Position is used rather than recomputing identifiers because the IR already
 * decided which declarations exist, what they are called and which names it could
 * address. Re-deriving that here would duplicate those rules and let the two
 * drift apart. Looking up "which declaration did the IR record at this position"
 * keeps the IR the single source of truth.
 *
 * A declaration with several sites — overloads, a getter/setter pair, a merged
 * interface — is reachable from every one of them.
 *
 * This module holds no compiler types; it takes positions and paths.
 */
export class DeclarationIndex {
  readonly #fileIdByAbsolutePath: ReadonlyMap<string, NodeId>;
  readonly #declarationBySite: ReadonlyMap<string, DeclarationIR>;
  readonly #declarationById: ReadonlyMap<NodeId, DeclarationIR>;

  private constructor(
    fileIdByAbsolutePath: ReadonlyMap<string, NodeId>,
    declarationBySite: ReadonlyMap<string, DeclarationIR>,
    declarationById: ReadonlyMap<NodeId, DeclarationIR>,
  ) {
    this.#fileIdByAbsolutePath = fileIdByAbsolutePath;
    this.#declarationBySite = declarationBySite;
    this.#declarationById = declarationById;
  }

  static fromIr(ir: RepositoryIR): DeclarationIndex {
    const fileIdByAbsolutePath = new Map<string, NodeId>();

    for (const file of ir.files) {
      fileIdByAbsolutePath.set(path.join(ir.repository.rootPath, file.path), file.id);
    }

    const declarationBySite = new Map<string, DeclarationIR>();
    const declarationById = new Map<NodeId, DeclarationIR>();

    for (const declaration of ir.declarations) {
      declarationById.set(declaration.id, declaration);

      for (const location of declaration.locations) {
        declarationBySite.set(siteKey(declaration.fileId, location), declaration);
      }
    }

    return new DeclarationIndex(fileIdByAbsolutePath, declarationBySite, declarationById);
  }

  /** `undefined` when the file is not part of the analysed set. */
  fileIdOf(absolutePath: string): NodeId | undefined {
    return this.#fileIdByAbsolutePath.get(absolutePath);
  }

  /** The declaration the IR recorded at this exact position, if any. */
  declarationAt(fileId: NodeId, startLine: number, startColumn: number): DeclarationIR | undefined {
    return this.#declarationBySite.get(`${fileId}@${startLine}:${startColumn}`);
  }

  declarationById(id: NodeId): DeclarationIR | undefined {
    return this.#declarationById.get(id);
  }
}

function siteKey(fileId: NodeId, location: SourceRange): string {
  return `${fileId}@${location.startLine}:${location.startColumn}`;
}
