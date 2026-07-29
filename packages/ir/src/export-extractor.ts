import type { NodeId } from '@traceiq/types';
import { Node, type SourceFile } from 'ts-morph';

import { sourceRangeOf } from './source-range.js';
import type { ExportIR } from './types.js';

/**
 * Records a file's export statements.
 *
 * Covers `export { … }`, `export … from '…'`, `export *`, `export * as ns`,
 * `export default …` and `export = …`. Exports written as a modifier on a
 * declaration are recorded by the declaration extractor, which is the only place
 * that knows the declaration's identifier.
 *
 * Re-export specifiers are kept as written. `declarationId` stays `null` here:
 * even for `export { local }`, matching the name to a declaration in the same file
 * requires scope analysis, which is resolution.
 */
export function extractExports(file: SourceFile, fileId: NodeId): ExportIR[] {
  const exports: ExportIR[] = [];

  for (const declaration of file.getExportDeclarations()) {
    const moduleSpecifier = declaration.getModuleSpecifierValue() ?? null;
    const location = sourceRangeOf(declaration);
    const isStatementTypeOnly = declaration.isTypeOnly();

    if (declaration.isNamespaceExport()) {
      const namespaceExport = declaration.getNamespaceExport();

      exports.push({
        fileId,
        kind: namespaceExport === undefined ? 'star' : 'star-as',
        exportedName: namespaceExport?.getName() ?? null,
        localName: null,
        moduleSpecifier,
        declarationId: null,
        isTypeOnly: isStatementTypeOnly,
        location,
      });

      continue;
    }

    for (const specifier of declaration.getNamedExports()) {
      const localName = specifier.getName();
      const alias = specifier.getAliasNode()?.getText();

      exports.push({
        fileId,
        kind: 'named',
        exportedName: alias ?? localName,
        localName,
        moduleSpecifier,
        declarationId: null,
        isTypeOnly: isStatementTypeOnly || specifier.isTypeOnly(),
        location,
      });
    }
  }

  for (const assignment of file.getExportAssignments()) {
    const expression = assignment.getExpression();
    const isExportEquals = assignment.isExportEquals();

    exports.push({
      fileId,
      kind: isExportEquals ? 'equals' : 'default',
      exportedName: isExportEquals ? null : 'default',
      // Only a plain identifier is recorded. `export default { a: 1 }` exports an
      // expression with no local name, and storing its source text would invite a
      // consumer to parse it.
      localName: Node.isIdentifier(expression) ? expression.getText() : null,
      moduleSpecifier: null,
      declarationId: null,
      isTypeOnly: false,
      location: sourceRangeOf(assignment),
    });
  }

  return exports;
}
