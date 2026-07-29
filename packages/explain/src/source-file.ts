import type { NodeId } from '@traceiq/types';

import type { SourceFileReference } from './types.js';

const PREFIX = 'file:';

/**
 * Reads a file identifier, or `null` when the value is not one.
 *
 * `file:<repository-relative path>` is the frozen identity format, and the path is the whole
 * remainder — a path contains no delimiter to get wrong. Reading it here rather than storing
 * a second copy keeps the identifier authoritative.
 */
export function sourceFileOf(id: NodeId | null): SourceFileReference | null {
  if (id === null || !id.startsWith(PREFIX)) {
    return null;
  }

  const path = id.slice(PREFIX.length);

  return path.length === 0 ? null : { id, path };
}
