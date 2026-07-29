import { Node, type VariableDeclaration } from 'ts-morph';

import type { DeclarationKind } from './types.js';

/**
 * The declaration kinds a body can contribute.
 *
 * A function body can contain a great deal that is purely local. The IR records only what
 * later stages can address: something invocable, or something whose members are invocable.
 * A local holding a number is still not a declaration.
 *
 * The kinds are the **same** ones the top-level walk uses, deliberately: `const f = () => {}`
 * is a `variable` wherever it is written. Describing the same syntax differently by depth
 * would make the IR's own nesting an observable property of a declaration.
 */
export const NESTED_KINDS = ['function', 'variable'] as const satisfies readonly DeclarationKind[];

export type NestedKind = (typeof NESTED_KINDS)[number];

export interface NestedDeclaration {
  readonly name: string;
  readonly kind: NestedKind;
  /** The node to record the declaration at. */
  readonly node: Node;
  /** The body to descend into for further nesting, when there is one. */
  readonly body: Node | null;
}

/**
 * Reads a nested function declaration, or `null` when the statement declares nothing the
 * IR can address.
 *
 * An **anonymous** function cannot be recorded at all: the identifier format needs a name,
 * and a callback passed inline — `it('…', () => { … })` — has none. Only a named function
 * declaration, or a function assigned to a named variable, can be addressed.
 */
export function nestedFunctionOf(node: Node): NestedDeclaration | null {
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName();

    return name === undefined
      ? null
      : { name, kind: 'function', node, body: node.getBody() ?? null };
  }

  return null;
}

/**
 * Reads a nested variable declaration worth recording.
 *
 * Two initializers qualify:
 *
 * - a function or arrow, because the name is then invocable;
 * - a construction, because the name then holds an instance whose methods are invocable,
 *   which is what lets `const svc = new Service(); svc.run()` be bound later.
 *
 * Anything else — a number, a string, a plain object — stays unrecorded. Recording every
 * local would multiply the IR for no consumer's benefit.
 */
export function nestedVariableOf(declaration: VariableDeclaration): NestedDeclaration | null {
  const name = declaration.getName();
  const initializer = declaration.getInitializer();

  if (initializer === undefined) {
    return null;
  }

  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return { name, kind: 'variable', node: declaration, body: initializer.getBody() ?? null };
  }

  if (Node.isNewExpression(initializer)) {
    return { name, kind: 'variable', node: declaration, body: null };
  }

  return null;
}
