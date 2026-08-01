import { moduleSourceFileOf, moduleSpecifierOf } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';
import { Node, SyntaxKind, type CallExpression, type ImportDeclaration, type SourceFile, type StringLiteral } from 'ts-morph';

import { symbolAt } from './checker-symbol.js';
import type { DeclarationIndex } from './declaration-index.js';
import { classifyExternalFile, classifyUnresolvedSpecifier } from './external-classification.js';
import type { ResolutionCollector } from './resolution-collector.js';
import { sourceRangeOf } from './source-position.js';
import { resolveSymbol } from './symbol-target.js';
import type { ResolutionTarget } from './types.js';

interface ImportContext {
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}

/** A resolved module, or `null` when the specifier could not be resolved at all. */
export interface ModuleResolution {
  readonly target: ResolutionTarget;
  readonly confidence: ConfidenceLevel;
  readonly evidence: string;
}

/**
 * Resolves import statements and their bindings.
 *
 * Two granularities are recorded, distinguishable by target kind:
 *
 * - the statement's module, whose target is a file or an external package;
 * - each named or default binding, whose target is the declaration it names.
 *
 * Both are needed. A side-effect-only import has no bindings, and a resolved
 * binding no longer says which module it came from.
 *
 * A namespace import binds the module itself, so it is recorded against the module
 * target rather than a declaration — it is not a failure to resolve.
 */
export function resolveImports(input: {
  readonly file: SourceFile;
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}): void {
  for (const declaration of input.file.getImportDeclarations()) {
    const module = resolveModule(declaration, input);

    recordModule(declaration, module, input);
    recordBindings(declaration, module, input);
  }

  resolveRequires(input);
}

/**
 * Resolves CommonJS `require` calls, which the IR records as imports for the same reason.
 *
 * **The gap this closes was total, not partial.** The IR now emits an `ImportIR` per `require`, but
 * resolution walks the syntax tree rather than the IR, and it walked `getImportDeclarations()` only.
 * Against express that left 400 recorded imports resolving to nothing: the graph had no IMPORTS edge
 * anywhere, so a JavaScript user saw an empty dependency graph, an Architecture page with no edges,
 * and an Impact analysis that could not leave a file — while a TypeScript user saw all three.
 *
 * The module target is resolved through the compiler, exactly as the ES path does. Bindings are the
 * part CommonJS makes harder: for `import { R } from 'm'` the checker resolves `R` straight to the
 * export, but for `const { R } = require('m')` the symbol at `R` is the destructuring binding itself,
 * so the export has to be looked up on the resolved module instead. Where that lookup fails the
 * binding is reported unresolved with the reason, never guessed at.
 */
function resolveRequires(context: {
  readonly file: SourceFile;
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}): void {
  for (const call of context.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const literal = requireArgumentOf(call);

    if (literal === null) {
      continue;
    }

    const specifier = literal.getLiteralValue();
    const module = resolveRequiredModule(literal, specifier, context);

    // The statement's own module edge, which is what answers "what does this file depend on".
    if (module === null) {
      context.collector.addUnresolved(
        siteFor(null, call, context),
        'module-not-resolved',
        specifier,
        `the required specifier '${specifier}' does not resolve to a file`,
      );
    } else {
      context.collector.addRelationship(
        siteFor(null, call, context),
        module.target,
        module.confidence,
        module.evidence,
      );
    }

    recordRequireBindings({ call, literal, specifier, module, context });
  }
}

/** The string-literal argument of a `require('…')` call, or `null` when this is not one. */
function requireArgumentOf(call: CallExpression): StringLiteral | null {
  const callee = call.getExpression();

  if (!Node.isIdentifier(callee) || callee.getText() !== 'require') {
    return null;
  }

  const args = call.getArguments();
  const argument = args.length === 1 ? args[0] : undefined;

  return argument !== undefined && Node.isStringLiteral(argument) ? argument : null;
}

/**
 * The module a `require` specifier names.
 *
 * The checker puts a module symbol on the specifier literal itself, which is how a `require` gets the
 * same module resolution — `paths`, workspace mappings, `node_modules` — as an `import`. Without that
 * the two forms would disagree about where `'./router'` points, in the same repository.
 */
export function resolveRequiredModule(
  literal: StringLiteral,
  specifier: string,
  context: { readonly index: DeclarationIndex },
): ModuleResolution | null {
  const resolvedFile = moduleFileOf(literal);

  if (resolvedFile === undefined) {
    return classifyUnresolvedSpecifier(specifier);
  }

  const absolutePath = resolvedFile.getFilePath();
  const targetFileId = context.index.fileIdOf(absolutePath);

  if (targetFileId !== undefined) {
    return {
      target: { kind: 'file', fileId: targetFileId },
      confidence: 'RESOLVED',
      evidence: `'${specifier}' is required and resolves to an analysed file`,
    };
  }

  const external = classifyExternalFile(absolutePath);

  return {
    target: { kind: 'external', origin: external.origin, name: external.name, ecosystem: external.ecosystem },
    confidence: 'RESOLVED',
    evidence: `'${specifier}' is required and resolves outside the analysed set, to ${external.name ?? external.origin}`,
  };
}

/** The source file a specifier literal's module symbol declares, or `undefined`. */
function moduleFileOf(literal: StringLiteral): SourceFile | undefined {
  const lookup = symbolAt(literal);

  if (lookup.outcome === 'failed' || lookup.symbol === undefined) {
    return undefined;
  }

  return lookup.symbol.getDeclarations()[0]?.getSourceFile();
}

function recordRequireBindings(input: {
  readonly call: CallExpression;
  /** The already-matched specifier literal, so the module is resolved once rather than re-matched. */
  readonly literal: StringLiteral;
  readonly specifier: string;
  readonly module: ModuleResolution | null;
  readonly context: ImportContext;
}): void {
  const { call, literal, specifier, module, context } = input;
  const parent = call.getParent();

  if (parent === undefined || !Node.isVariableDeclaration(parent)) {
    return;
  }

  const name = parent.getNameNode();

  // `const m = require('x')` binds the whole exports object, so the module is the target — the same
  // treatment `import * as m from 'x'` gets, because it is the same fact.
  if (Node.isIdentifier(name)) {
    const localName = name.getText();
    const site = siteFor(localName, name, context);

    if (module === null) {
      context.collector.addUnresolved(
        site,
        'module-not-resolved',
        specifier,
        `'${localName}' binds the whole of '${specifier}', which does not resolve`,
      );
    } else {
      context.collector.addRelationship(
        site,
        module.target,
        module.confidence,
        `'${localName}' binds the whole required module: ${module.evidence}`,
      );
    }

    return;
  }

  if (!Node.isObjectBindingPattern(name)) {
    return;
  }

  const moduleFile = module === null ? undefined : moduleFileOf(literal);
  const moduleSymbol = moduleFile === undefined ? undefined : symbolAt(moduleFile);

  for (const element of name.getElements()) {
    const local = element.getNameNode();

    if (!Node.isIdentifier(local) || element.getDotDotDotToken() !== undefined) {
      continue;
    }

    const exportedName = element.getPropertyNameNode()?.getText() ?? local.getText();
    const site = siteFor(local.getText(), element, context);

    if (moduleSymbol === undefined || moduleSymbol.outcome === 'failed' || moduleSymbol.symbol === undefined) {
      context.collector.addUnresolved(
        site,
        'module-not-resolved',
        specifier,
        `'${exportedName}' is destructured from '${specifier}', whose module the checker did not resolve`,
      );

      continue;
    }

    // The export on the resolved module, rather than the symbol at the binding name — which would be
    // the destructuring element and would resolve to itself.
    const exported = moduleSymbol.symbol.getExport(exportedName);

    context.collector.addSymbolResolution(
      site,
      resolveSymbol(exported, context.index),
      `${exportedName} destructured from '${specifier}'`,
    );
  }
}

function resolveModule(
  declaration: ImportDeclaration,
  context: ImportContext,
): ModuleResolution | null {
  const specifier = moduleSpecifierOf(declaration) ?? '';
  const resolvedFile = moduleSourceFileOf(declaration);

  if (resolvedFile === undefined) {
    return classifyUnresolvedSpecifier(specifier);
  }

  const absolutePath = resolvedFile.getFilePath();
  const targetFileId = context.index.fileIdOf(absolutePath);

  if (targetFileId !== undefined) {
    return {
      target: { kind: 'file', fileId: targetFileId },
      confidence: 'RESOLVED',
      evidence: `'${specifier}' resolves to an analysed file`,
    };
  }

  const external = classifyExternalFile(absolutePath);

  return {
    target: { kind: 'external', origin: external.origin, name: external.name, ecosystem: external.ecosystem },
    confidence: 'RESOLVED',
    evidence: `'${specifier}' resolves outside the analysed set, to ${external.name ?? external.origin}`,
  };
}

function recordModule(
  declaration: ImportDeclaration,
  module: ModuleResolution | null,
  context: ImportContext,
): void {
  const specifier = moduleSpecifierOf(declaration) ?? '';
  const site = siteFor(null, declaration, context);

  if (module === null) {
    context.collector.addUnresolved(
      site,
      'module-not-resolved',
      specifier,
      `the relative specifier '${specifier}' does not resolve to a file`,
    );

    return;
  }

  context.collector.addRelationship(site, module.target, module.confidence, module.evidence);
}

function recordBindings(
  declaration: ImportDeclaration,
  module: ModuleResolution | null,
  context: ImportContext,
): void {
  const specifier = moduleSpecifierOf(declaration) ?? '';
  const defaultImport = declaration.getDefaultImport();

  if (defaultImport !== undefined) {
    recordBinding({
      site: siteFor(defaultImport.getText(), defaultImport, context),
      resolution: resolveSymbol(symbolAt(defaultImport), context.index),
      module,
      label: `default from '${specifier}'`,
      binding: 'default',
      specifier,
      context,
    });
  }

  const namespaceImport = declaration.getNamespaceImport();

  if (namespaceImport !== undefined) {
    const localName = namespaceImport.getText();
    const site = siteFor(localName, namespaceImport, context);

    if (module === null) {
      context.collector.addUnresolved(
        site,
        'module-not-resolved',
        specifier,
        `'${localName}' binds the whole of '${specifier}', which does not resolve`,
      );
    } else {
      context.collector.addRelationship(
        site,
        module.target,
        module.confidence,
        `'${localName}' binds the whole module: ${module.evidence}`,
      );
    }
  }

  for (const named of declaration.getNamedImports()) {
    const nameNode = named.getNameNode();
    const localName = named.getAliasNode()?.getText() ?? nameNode.getText();

    recordBinding({
      site: siteFor(localName, named, context),
      resolution: resolveSymbol(symbolAt(nameNode), context.index),
      module,
      label: `${nameNode.getText()} from '${specifier}'`,
      binding: nameNode.getText(),
      specifier,
      context,
    });
  }
}

/**
 * Records one import binding, falling back to the module when the binding names nothing readable.
 *
 * **A named import from a package that is not installed has no declaration anywhere**, and the
 * checker says so by handing back a symbol with zero declaration sites. Reporting that as
 * `no-declaration` is true of the symbol and misleading about the repository: the module *did*
 * resolve — to an external — and `import { useState } from 'react'` is a dependency on react
 * whichever binding it names. React carried **5,226** of these, one per named import of an
 * uninstalled package, in the same bucket as an import that genuinely names something absent.
 *
 * A namespace import already behaved this way, because it has no name to look up. This makes a
 * named and a default binding agree with it.
 *
 * The fallback is deliberately narrow: only when the module is external, and only when the failure
 * was `no-declaration`. A relative import naming an export the target file does not have is a real
 * dead end and still reported as one.
 */
function recordBinding(input: {
  readonly site: ReturnType<typeof siteFor>;
  readonly resolution: ReturnType<typeof resolveSymbol>;
  readonly module: ModuleResolution | null;
  readonly label: string;
  readonly binding: string;
  readonly specifier: string;
  readonly context: ImportContext;
}): void {
  const { site, resolution, module, label, binding, specifier, context } = input;

  if (
    resolution.outcome === 'unresolved' &&
    resolution.reason === 'no-declaration' &&
    module !== null &&
    module.target.kind === 'external'
  ) {
    context.collector.addRelationship(
      site,
      module.target,
      // The module's own confidence, not a stronger one: what is known is where the binding comes
      // from, which is exactly what the statement edge already established.
      module.confidence,
      `'${binding}' is imported from '${specifier}', which resolves outside the analysed set, so the dependency is what this binding names`,
    );

    return;
  }

  context.collector.addSymbolResolution(site, resolution, label);
}

function siteFor(name: string | null, node: Node, context: ImportContext) {
  return {
    type: 'IMPORTS' as const,
    sourceId: context.fileId,
    name,
    location: sourceRangeOf(node),
    resolver: 'imports' as const,
    fileId: context.fileId,
  };
}
