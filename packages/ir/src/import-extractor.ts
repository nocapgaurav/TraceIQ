import type { NodeId } from '@traceiq/types';
import type { SourceFile } from 'ts-morph';

import { sourceRangeOf } from './source-range.js';
import type { ImportBindingIR, ImportIR } from './types.js';

/**
 * Records a file's import statements.
 *
 * Module specifiers are kept exactly as written. Turning `'./greeting'` into a
 * file is resolution and belongs to the Resolver; recording the text is the whole
 * job here.
 *
 * One entry per statement rather than per binding, which keeps the statement's
 * `import type` flag and its location attached to the bindings it governs. A
 * side-effect-only import has no bindings.
 *
 * `import x = require('y')` is not captured — ts-morph exposes no accessor for it
 * on a source file.
 */
export function extractImports(file: SourceFile, fileId: NodeId): ImportIR[] {
  return file.getImportDeclarations().map((declaration) => {
    const isStatementTypeOnly = declaration.isTypeOnly();
    const bindings: ImportBindingIR[] = [];

    const defaultImport = declaration.getDefaultImport();

    if (defaultImport !== undefined) {
      bindings.push({
        kind: 'default',
        importedName: 'default',
        localName: defaultImport.getText(),
        isTypeOnly: isStatementTypeOnly,
      });
    }

    const namespaceImport = declaration.getNamespaceImport();

    if (namespaceImport !== undefined) {
      bindings.push({
        kind: 'namespace',
        importedName: null,
        localName: namespaceImport.getText(),
        isTypeOnly: isStatementTypeOnly,
      });
    }

    for (const specifier of declaration.getNamedImports()) {
      const importedName = specifier.getName();
      const alias = specifier.getAliasNode()?.getText();

      bindings.push({
        kind: 'named',
        importedName,
        localName: alias ?? importedName,
        isTypeOnly: isStatementTypeOnly || specifier.isTypeOnly(),
      });
    }

    return {
      fileId,
      moduleSpecifier: declaration.getModuleSpecifierValue(),
      isTypeOnly: isStatementTypeOnly,
      bindings,
      location: sourceRangeOf(declaration),
    };
  });
}
