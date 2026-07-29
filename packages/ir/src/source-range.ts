import type { Node } from 'ts-morph';

import type { SourceRange } from './types.js';

/**
 * Converts a compiler node's position into an IR range.
 *
 * `getStart()` deliberately excludes leading trivia, so a range begins at the
 * first token of the declaration rather than at its documentation comment.
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

/** Orders ranges by position, so merged declaration sites read in source order. */
export function compareSourceRanges(left: SourceRange, right: SourceRange): number {
  return left.startLine - right.startLine || left.startColumn - right.startColumn;
}
