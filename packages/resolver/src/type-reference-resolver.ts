import type { NodeId } from '@traceiq/types';
import { Node, type TypeNode, type TypeReferenceNode } from 'ts-morph';

import type { DeclarationIndex } from './declaration-index.js';
import type { ResolutionCollector } from './resolution-collector.js';
import { sourceRangeOf } from './source-position.js';
import { resolveSymbol } from './symbol-target.js';

/**
 * Resolves the named types a declaration mentions in its signature.
 *
 * Only written type annotations are examined — property and variable types,
 * parameter and return types, and a type alias's right-hand side. Types are never
 * inferred and function bodies are never entered, which keeps this to the same
 * structural surface the IR recorded.
 */
export function resolveTypeReferences(input: {
  readonly node: Node;
  readonly declarationId: NodeId;
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}): void {
  for (const typeNode of annotatedTypeNodesOf(input.node)) {
    for (const reference of typeReferencesWithin(typeNode)) {
      const name = reference.getTypeName();

      input.collector.addSymbolResolution(
        {
          type: 'REFERENCES_TYPE',
          sourceId: input.declarationId,
          name: name.getText(),
          location: sourceRangeOf(reference),
          resolver: 'type-references',
          fileId: input.fileId,
        },
        resolveSymbol(name.getSymbol(), input.index),
        name.getText(),
      );
    }
  }
}

/**
 * The type annotations written on a declaration.
 *
 * Each check is independent rather than exclusive: a method contributes both its
 * return type and its parameter types.
 */
function annotatedTypeNodesOf(node: Node): TypeNode[] {
  const typeNodes: (TypeNode | undefined)[] = [];

  if (
    Node.isTypeAliasDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node) ||
    Node.isVariableDeclaration(node)
  ) {
    typeNodes.push(node.getTypeNode());
  }

  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isGetAccessorDeclaration(node)
  ) {
    typeNodes.push(node.getReturnTypeNode());
  }

  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    for (const parameter of node.getParameters()) {
      typeNodes.push(parameter.getTypeNode());
    }
  }

  // Type arguments of a heritage clause: the `Repo` in `extends Base<Repo>`. The
  // heritage resolver records only `Base` itself, so without this the arguments
  // would be lost.
  if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
    for (const clause of node.getHeritageClauses()) {
      for (const heritageType of clause.getTypeNodes()) {
        typeNodes.push(...heritageType.getTypeArguments());
      }
    }
  }

  return typeNodes.filter((typeNode): typeNode is TypeNode => typeNode !== undefined);
}

/**
 * Every type reference in a type annotation, including the annotation itself.
 *
 * `Map<string, Shape[]>` is a type reference whose own descendants contain another,
 * and `forEachDescendant` does not visit the node it is called on — so the root has
 * to be checked separately or the outer name is missed.
 */
function typeReferencesWithin(typeNode: TypeNode): TypeReferenceNode[] {
  const references: TypeReferenceNode[] = [];

  if (Node.isTypeReference(typeNode)) {
    references.push(typeNode);
  }

  typeNode.forEachDescendant((descendant) => {
    if (Node.isTypeReference(descendant)) {
      references.push(descendant);
    }
  });

  return references;
}
