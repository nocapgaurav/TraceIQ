import type { SourceRange } from '@traceiq/ir';
import type { Node } from 'ts-morph';

/**
 * Converts a compiler node's position into an IR range.
 *
 * This must stay identical to the IR Builder's own conversion, because positions
 * are what correlate a node back to an IR declaration. It is duplicated rather
 * than shared because exporting it from `@traceiq/ir` would put a ts-morph type in
 * that package's public API.
 *
 * The correlation is covered by tests asserting that every relationship's source
 * is a declaration the IR actually recorded, which fails loudly if the two
 * definitions ever diverge.
 */
export function sourceRangeOf(node: Node): SourceRange {
  const file = node.getSourceFile();
  const start = file.getLineAndColumnAtPos(node.getStart());
  const end = file.getLineAndColumnAtPos(node.getEnd());

  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}
