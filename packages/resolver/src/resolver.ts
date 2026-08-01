import type { RepositoryIR } from '@traceiq/ir';
import type { ProjectContext } from '@traceiq/project-host';
import type { NodeId } from '@traceiq/types';
import { Node, type SourceFile } from 'ts-morph';

import { DeclarationIndex } from './declaration-index.js';
import { enrichDeclaration } from './declaration-enricher.js';
import { resolveExports } from './export-resolver.js';
import { resolveHeritage } from './heritage-resolver.js';
import { resolveImports } from './import-resolver.js';
import { ResolutionCollector } from './resolution-collector.js';
import { sourceRangeOf } from './source-position.js';
import { resolveTypeReferences } from './type-reference-resolver.js';
import type { ResolvedDeclaration, ResolvedRepository } from './types.js';

/**
 * Enriches a `RepositoryIR` using the TypeScript type checker.
 *
 * The IR is read and never modified: the result is a separate structure that
 * refers to IR declarations by identifier.
 *
 * Nothing here organises facts. Each resolver states what one reference points at,
 * with provenance that explains itself; assembling those into a graph belongs to
 * the Graph Builder.
 *
 * **`index` is what makes bounded compilation lossless.** The IR being resolved covers one unit's
 * files, but a reference in it may reach a declaration another unit owns — a monorepo importing
 * `@traceiq/ir` is the ordinary case. Given only this unit's IR, that target sits outside the
 * indexed set and is classified as an external: measured on TraceIQ, opaque IMPORTS went from 19 to
 * **1,581** and cross-package call edges collapsed. Passing an index built from every unit's IR
 * restores it exactly, because a declaration index is plain data keyed by source position and needs
 * no compiler to build.
 */
export class Resolver {
  resolve(input: {
    readonly ir: RepositoryIR;
    readonly context: ProjectContext;
    /**
     * The declaration index to resolve against. Defaults to one built from `ir` alone.
     *
     * Supplied when this IR is one unit of several, so a reference reaching another unit's
     * declaration finds it rather than falling out of the analysed set.
     */
    readonly index?: DeclarationIndex;
  }): ResolvedRepository {
    const index = input.index ?? DeclarationIndex.fromIr(input.ir);
    const collector = new ResolutionCollector();
    const declarations: ResolvedDeclaration[] = [];

    for (const file of input.context.sourceFiles) {
      const fileId = index.fileIdOf(file.getFilePath());

      // A file the IR did not record cannot be attributed to, so it is skipped
      // rather than resolved against a made-up identifier.
      if (fileId === undefined) {
        continue;
      }

      resolveImports({ file, fileId, index, collector });
      resolveExports({ file, fileId, ir: input.ir, index, collector });

      this.resolveDeclarations({ file, fileId, index, collector, declarations });
    }

    return {
      repository: input.ir.repository,
      declarations,
      relationships: collector.relationships,
      unresolved: collector.unresolved,
    };
  }

  /**
   * Walks the file once, acting on nodes the IR recorded a declaration at.
   *
   * Correlation is by position, which is why the kind guard matters: an `export`
   * keyword shares its start position with the declaration it modifies, so
   * position alone would match the wrong node. Requiring a declaration kind leaves
   * exactly one candidate per position.
   *
   * Walking every descendant is deliberate. It costs a full tree traversal but
   * needs none of the IR's traversal rules restated here, and correctness comes
   * from the position match rather than from agreeing about where to look.
   */
  private resolveDeclarations(input: {
    readonly file: SourceFile;
    readonly fileId: NodeId;
    readonly index: DeclarationIndex;
    readonly collector: ResolutionCollector;
    readonly declarations: ResolvedDeclaration[];
  }): void {
    input.file.forEachDescendant((node) => {
      if (!isStructuralDeclaration(node)) {
        return;
      }

      const range = sourceRangeOf(node);
      const declaration = input.index.declarationAt(
        input.fileId,
        range.startLine,
        range.startColumn,
      );

      if (declaration === undefined) {
        return;
      }

      const shared = {
        node,
        declarationId: declaration.id,
        fileId: input.fileId,
        index: input.index,
        collector: input.collector,
      };

      input.declarations.push(
        enrichDeclaration({ node, declarationId: declaration.id, fileId: input.fileId }),
      );

      resolveHeritage(shared);
      resolveTypeReferences(shared);
    });
  }
}

/**
 * The node kinds the IR records declarations for.
 *
 * Used only to disambiguate a position match, never to decide what to visit — the
 * IR has already decided that.
 */
function isStructuralDeclaration(node: Node): boolean {
  return (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isEnumMember(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isModuleDeclaration(node)
  );
}
