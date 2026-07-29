import type { ConfidenceLevel, NodeId } from '@traceiq/types';
import type { ImportDeclaration, Node, SourceFile } from 'ts-morph';

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
interface ModuleResolution {
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
}

function resolveModule(
  declaration: ImportDeclaration,
  context: ImportContext,
): ModuleResolution | null {
  const specifier = declaration.getModuleSpecifierValue();
  const resolvedFile = declaration.getModuleSpecifierSourceFile();

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
    target: { kind: 'external', origin: external.origin, name: external.name },
    confidence: 'RESOLVED',
    evidence: `'${specifier}' resolves outside the analysed set, to ${external.name ?? external.origin}`,
  };
}

function recordModule(
  declaration: ImportDeclaration,
  module: ModuleResolution | null,
  context: ImportContext,
): void {
  const specifier = declaration.getModuleSpecifierValue();
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
  const specifier = declaration.getModuleSpecifierValue();
  const defaultImport = declaration.getDefaultImport();

  if (defaultImport !== undefined) {
    context.collector.addSymbolResolution(
      siteFor(defaultImport.getText(), defaultImport, context),
      resolveSymbol(defaultImport.getSymbol(), context.index),
      `default from '${specifier}'`,
    );
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

    context.collector.addSymbolResolution(
      siteFor(localName, named, context),
      resolveSymbol(nameNode.getSymbol(), context.index),
      `${nameNode.getText()} from '${specifier}'`,
    );
  }
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
