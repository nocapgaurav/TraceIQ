/**
 * The Python grammar and node helpers, from the shared tree-sitter host.
 *
 * This file used to carry its own grammar loading, named-children helper and zero-to-one-based
 * position conversion. Java needed all three unchanged and Go needed them again, so they moved to
 * `@traceiq/tree-sitter`. What remains is the one line that says *which* grammar this analyser reads.
 */
import { parserFor, type Parser } from '@traceiq/tree-sitter';

export function pythonParser(): Promise<Parser> {
  return parserFor('python');
}

export {
  children,
  childrenOfType,
  fieldNode,
  fieldText,
  firstOfType,
  leftmostIdentifier,
  rangeOf,
  type SyntaxNode,
  type Tree,
} from '@traceiq/tree-sitter';
