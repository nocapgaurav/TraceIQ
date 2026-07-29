import type { NodeId } from '@traceiq/types';

export interface RouteIdentity {
  readonly method: string;
  readonly path: string;
}

const PREFIX = 'route:';

/**
 * Reads a route identity, or `null` when the value is not one.
 *
 * `route:<METHOD>:<path>` is split on the **first two** colons only, because a path keeps
 * its parameter colons: `route:GET:/users/:id` has three.
 */
export function parseRouteId(id: NodeId): RouteIdentity | null {
  if (!id.startsWith(PREFIX)) {
    return null;
  }

  const remainder = id.slice(PREFIX.length);
  const separator = remainder.indexOf(':');

  if (separator <= 0) {
    return null;
  }

  const path = remainder.slice(separator + 1);

  if (path.length === 0) {
    return null;
  }

  return { method: remainder.slice(0, separator), path };
}
