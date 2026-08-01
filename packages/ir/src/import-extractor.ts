import type { NodeId } from '@traceiq/types';
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';

import { moduleSpecifierOf } from './module-specifier.js';
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
 *
 * **CommonJS `require` is captured too**, by `extractRequires` below. Both forms produce the same
 * `ImportIR`, because both state the same fact: this file depends on that module, binding these
 * names. The Resolver therefore needs no CommonJS branch at all.
 */
export function extractImports(file: SourceFile, fileId: NodeId): ImportIR[] {
  return [...extractEsImports(file, fileId), ...extractRequires(file, fileId)];
}

function extractEsImports(file: SourceFile, fileId: NodeId): ImportIR[] {
  return file.getImportDeclarations().flatMap((declaration) => {
    const specifier = moduleSpecifierOf(declaration);

    // Not a string literal, so there is no module name to record. Skipped rather than thrown: the throw
    // escaped the whole analyser and cost React all 7,280 of its files their analysis.
    if (specifier === null) {
      return [];
    }

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

    return [{
      fileId,
      moduleSpecifier: specifier,
      isTypeOnly: isStatementTypeOnly,
      bindings,
      location: sourceRangeOf(declaration),
    }];
  });
}

/**
 * Records a file's CommonJS `require` calls as imports.
 *
 * **Why this exists.** Measured against express — 141 JavaScript files, the framework most likely to
 * be the first thing a JavaScript user points TraceIQ at — the graph held **zero** IMPORTS edges.
 * Every dependency in the repository was invisible, so Explorer showed no dependencies, Architecture
 * showed an empty dependency graph, Impact could not traverse, and Search found no externals. The
 * cause was this extractor reading `getImportDeclarations()` only, which is ES syntax. The compiler
 * understands `require` perfectly well; the IR simply never asked.
 *
 * The four forms, each mapped to the binding kind that says what it actually binds:
 *
 * ```js
 * const express = require('express');           // namespace: the module's exports object
 * const { Router, json } = require('express');  // named: two of its exports
 * const { json: parse } = require('express');   // named, aliased
 * require('./side-effect');                     // no bindings
 * ```
 *
 * `namespace` for the plain form is the honest choice: `const x = require('m')` binds the whole
 * exports object, exactly as `import * as x from 'm'` does, and `x.foo()` must resolve through the
 * module rather than to a single exported `x`.
 *
 * **Requires inside a function body are recorded.** A lazy `require` is still a dependency of the
 * file, which is the fact an `ImportIR` states — it carries a `fileId`, not a scope.
 *
 * Only a literal specifier is taken. `require(name)` and `require('./' + part)` name no module a
 * reader could follow, so nothing is recorded rather than a guess.
 */
export function extractRequires(file: SourceFile, fileId: NodeId): ImportIR[] {
  const imports: ImportIR[] = [];

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const specifier = requireSpecifierOf(call);

    if (specifier === null) {
      continue;
    }

    imports.push({
      fileId,
      moduleSpecifier: specifier,
      // CommonJS has no type-only import. `require` is a value call by construction.
      isTypeOnly: false,
      bindings: requireBindingsOf(call),
      location: sourceRangeOf(call),
    });
  }

  return imports;
}

/** The literal module specifier of a `require('…')` call, or `null` when this is not one. */
function requireSpecifierOf(call: CallExpression): string | null {
  const callee = call.getExpression();

  // `require` and nothing else. A member call such as `require.resolve('x')` does not load a module
  // into a binding, and `mod.require('x')` is somebody else's function.
  if (!Node.isIdentifier(callee) || callee.getText() !== 'require') {
    return null;
  }

  const args = call.getArguments();

  if (args.length !== 1) {
    return null;
  }

  const argument = args[0];

  return argument !== undefined && Node.isStringLiteral(argument) ? argument.getLiteralValue() : null;
}

/**
 * What a `require` call binds, read from the declaration it initialises.
 *
 * A call that is not a variable initialiser — a bare `require('./x')`, or one whose result is passed
 * straight into another call — binds nothing nameable, so it yields no bindings and stays a
 * side-effect import.
 */
function requireBindingsOf(call: CallExpression): readonly ImportBindingIR[] {
  const parent = call.getParent();

  if (parent === undefined || !Node.isVariableDeclaration(parent)) {
    return [];
  }

  const name = parent.getNameNode();

  if (Node.isIdentifier(name)) {
    return [
      { kind: 'namespace', importedName: null, localName: name.getText(), isTypeOnly: false },
    ];
  }

  if (!Node.isObjectBindingPattern(name)) {
    // An array pattern destructures by position, which module exports do not have. Nothing here can
    // be named, so nothing is claimed.
    return [];
  }

  const bindings: ImportBindingIR[] = [];

  for (const element of name.getElements()) {
    const local = element.getNameNode();

    // A nested or computed pattern has no addressable name, the same rule the declaration extractor
    // applies. `...rest` binds the remaining exports, which is not one of them.
    if (!Node.isIdentifier(local) || element.getDotDotDotToken() !== undefined) {
      continue;
    }

    const propertyName = element.getPropertyNameNode()?.getText();

    bindings.push({
      kind: 'named',
      importedName: propertyName ?? local.getText(),
      localName: local.getText(),
      isTypeOnly: false,
    });
  }

  return bindings;
}
