import type { ExportIR, RepositoryIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';
import { Node, type SourceFile } from 'ts-morph';

import type { DeclarationIndex } from './declaration-index.js';
import { classifyExternalFile, classifyUnresolvedSpecifier } from './external-classification.js';
import type { ResolutionCollector } from './resolution-collector.js';
import { sourceRangeOf } from './source-position.js';
import { resolveSymbol } from './symbol-target.js';

interface ExportContext {
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}

/**
 * Resolves exports.
 *
 * Three shapes are handled separately because they carry different certainty:
 *
 * - An `export` modifier on a declaration is already linked by the IR. It needs no
 *   checker, so it is recorded as CERTAIN.
 * - An export specifier — `export { a }`, `export { a as b } from '…'` — is what
 *   the IR deliberately left unresolved, because matching a local name to a
 *   declaration requires scope analysis. The checker resolves it here.
 * - A star re-export resolves to the module it forwards, not to the individual
 *   symbols flowing through it.
 */
export function resolveExports(input: {
  readonly file: SourceFile;
  readonly fileId: NodeId;
  readonly ir: RepositoryIR;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}): void {
  recordInlineExports(input);
  recordExportSpecifiers(input);
  recordExportAssignments(input);
}

/**
 * The IR already established these syntactically, so they are echoed as CERTAIN
 * rather than re-derived. This is the one place the Resolver adds a relationship
 * without consulting the checker.
 */
function recordInlineExports(input: Parameters<typeof resolveExports>[0]): void {
  const inline = input.ir.exports.filter(
    (entry: ExportIR) =>
      entry.fileId === input.fileId &&
      entry.declarationId !== null &&
      (entry.kind === 'declaration' || entry.kind === 'default'),
  );

  for (const entry of inline) {
    if (entry.declarationId === null) {
      continue;
    }

    input.collector.addRelationship(
      {
        type: 'EXPORTS',
        sourceId: input.fileId,
        name: entry.exportedName,
        location: entry.location,
        resolver: 'exports',
        fileId: input.fileId,
      },
      { kind: 'declaration', declarationId: entry.declarationId },
      'CERTAIN',
      `'${entry.exportedName ?? 'default'}' is exported by a modifier on its own declaration, which needs no resolution`,
    );
  }
}

function recordExportSpecifiers(input: Parameters<typeof resolveExports>[0]): void {
  for (const declaration of input.file.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();

    if (declaration.isNamespaceExport()) {
      recordStarExport(declaration.getNamespaceExport()?.getName() ?? null, specifier, {
        node: declaration,
        ...input,
      });

      continue;
    }

    for (const named of declaration.getNamedExports()) {
      const nameNode = named.getNameNode();
      const exportedName = named.getAliasNode()?.getText() ?? nameNode.getText();

      input.collector.addSymbolResolution(
        {
          type: 'EXPORTS',
          sourceId: input.fileId,
          name: exportedName,
          location: sourceRangeOf(named),
          resolver: 'exports',
          fileId: input.fileId,
        },
        resolveSymbol(nameNode.getSymbol(), input.index),
        nameNode.getText(),
      );
    }
  }
}

/**
 * A star re-export forwards a module rather than naming symbols, so the module is
 * the target. Expanding it into one relationship per forwarded symbol is left
 * undone deliberately: the set is derived rather than written, and materialising
 * it is closer to organising facts than to enriching them.
 */
function recordStarExport(
  exportedName: string | null,
  specifier: string | undefined,
  input: ExportContext & { readonly node: Node },
): void {
  const site = {
    type: 'EXPORTS' as const,
    sourceId: input.fileId,
    name: exportedName,
    location: sourceRangeOf(input.node),
    resolver: 'exports' as const,
    fileId: input.fileId,
  };

  if (specifier === undefined) {
    input.collector.addUnresolved(
      site,
      'module-not-resolved',
      '*',
      'a star export with no module specifier',
    );

    return;
  }

  const resolvedFile = Node.isExportDeclaration(input.node)
    ? input.node.getModuleSpecifierSourceFile()
    : undefined;

  if (resolvedFile === undefined) {
    const classified = classifyUnresolvedSpecifier(specifier);

    if (classified === null) {
      input.collector.addUnresolved(
        site,
        'module-not-resolved',
        specifier,
        `the relative specifier '${specifier}' does not resolve to a file`,
      );

      return;
    }

    input.collector.addRelationship(
      site,
      classified.target,
      classified.confidence,
      `re-exports the whole of ${classified.evidence}`,
    );

    return;
  }

  const targetFileId = input.index.fileIdOf(resolvedFile.getFilePath());

  if (targetFileId !== undefined) {
    input.collector.addRelationship(
      site,
      { kind: 'file', fileId: targetFileId },
      'RESOLVED',
      `re-exports the whole of '${specifier}', which resolves to an analysed file; the forwarded names are not expanded`,
    );

    return;
  }

  const external = classifyExternalFile(resolvedFile.getFilePath());

  input.collector.addRelationship(
    site,
    { kind: 'external', origin: external.origin, name: external.name },
    'RESOLVED',
    `re-exports the whole of '${specifier}', which resolves outside the analysed set`,
  );
}

function recordExportAssignments(input: Parameters<typeof resolveExports>[0]): void {
  for (const assignment of input.file.getExportAssignments()) {
    const expression = assignment.getExpression();
    const isExportEquals = assignment.isExportEquals();

    input.collector.addSymbolResolution(
      {
        type: 'EXPORTS',
        sourceId: input.fileId,
        name: isExportEquals ? null : 'default',
        location: sourceRangeOf(assignment),
        resolver: 'exports',
        fileId: input.fileId,
      },
      resolveSymbol(expression.getSymbol(), input.index),
      expression.getText(),
    );
  }
}
