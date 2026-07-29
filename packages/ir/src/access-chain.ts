import { Node } from 'ts-morph';

export interface AccessChain {
  /** The identifier the chain is rooted at. */
  readonly rootName: string;
  /** The names after the root, outermost last. Empty for a bare identifier. */
  readonly path: readonly string[];
}

/**
 * Reads a property or element access chain, or `null` when it is not rooted at a
 * plain identifier.
 *
 * `process.env.PORT` yields root `process` and path `['env', 'PORT']`. A bare
 * identifier yields an empty path, which is what makes this usable for a callee as
 * well as for a standalone access.
 *
 * Returns `null` for a chain rooted at anything else — `this.x`, a call result, a
 * parenthesised or non-null-asserted expression. Those describe local structure
 * rather than a cross-cutting reference, and a consumer cannot act on them.
 *
 * An element access contributes its key only when that key is a string literal.
 * `config['name']` is readable; `config[key]` is not addressable at all, so the whole
 * chain is rejected rather than silently truncated into a different chain.
 */
export function accessChainOf(node: Node): AccessChain | null {
  const path: string[] = [];
  let current: Node = node;

  for (;;) {
    if (Node.isPropertyAccessExpression(current)) {
      path.unshift(current.getName());
      current = current.getExpression();
      continue;
    }

    if (Node.isElementAccessExpression(current)) {
      const argument = current.getArgumentExpression();

      if (argument === undefined || !Node.isStringLiteral(argument)) {
        return null;
      }

      path.unshift(argument.getLiteralValue());
      current = current.getExpression();
      continue;
    }

    if (Node.isIdentifier(current)) {
      return { rootName: current.getText(), path };
    }

    return null;
  }
}
