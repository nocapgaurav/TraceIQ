import type { NodeId } from '@traceiq/types';
import { Node, type ExpressionWithTypeArguments } from 'ts-morph';

import { symbolAt } from './checker-symbol.js';
import type { DeclarationIndex } from './declaration-index.js';
import type { ResolutionCollector } from './resolution-collector.js';
import { sourceRangeOf } from './source-position.js';
import { resolveSymbol } from './symbol-target.js';
import type { ResolvedRelationshipType } from './types.js';

/**
 * Resolves `extends` and `implements` clauses on a declaration.
 *
 * Only the heritage expression is resolved. Its type arguments — the `Repo` in
 * `extends Base<Repo>` — are type references and are resolved by the type
 * reference resolver, so nothing is recorded twice.
 */
export function resolveHeritage(input: {
  readonly node: Node;
  readonly declarationId: NodeId;
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}): void {
  if (Node.isClassDeclaration(input.node)) {
    const base = input.node.getExtends();

    if (base !== undefined) {
      record(base, 'EXTENDS', input);
    }

    for (const implemented of input.node.getImplements()) {
      record(implemented, 'IMPLEMENTS', input);
    }

    return;
  }

  if (Node.isInterfaceDeclaration(input.node)) {
    // An interface may extend several others; TypeScript has no `implements` here.
    for (const base of input.node.getExtends()) {
      record(base, 'EXTENDS', input);
    }
  }
}

function record(
  heritage: ExpressionWithTypeArguments,
  type: ResolvedRelationshipType,
  input: Parameters<typeof resolveHeritage>[0],
): void {
  const expression = heritage.getExpression();

  input.collector.addSymbolResolution(
    {
      type,
      sourceId: input.declarationId,
      name: expression.getText(),
      location: sourceRangeOf(heritage),
      resolver: 'heritage',
      fileId: input.fileId,
    },
    resolveSymbol(symbolAt(expression), input.index),
    expression.getText(),
  );
}
