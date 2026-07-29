import type { NodeId } from '@traceiq/types';

import { normalizeRepoPath } from './repo-path.js';

export class InvalidNodeIdError extends Error {
  constructor(reason: string) {
    super(`Cannot build node identifier: ${reason}`);
    this.name = 'InvalidNodeIdError';
  }
}

const HTTP_METHOD = /^[A-Za-z]+$/;

// Shell-style names. Deliberately excludes ':' and '|', which delimit identifiers.
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Identifies a source file.
 *
 *   file:src/auth/auth.service.ts
 */
export function fileId(repoPath: string): NodeId {
  return `file:${normalizeRepoPath(repoPath)}` as NodeId;
}

/**
 * Identifies a declaration by its container chain within a file, outermost
 * first, so a method is addressed through the class that declares it.
 *
 *   symbolId('src/auth/auth.service.ts', ['AuthService', 'login'])
 *   → sym:src/auth/auth.service.ts#AuthService.login
 *
 * The identifier is unchanged by edits to the symbol's body, which is what lets
 * two revisions of the same repository be compared.
 */
export function symbolId(repoPath: string, containerChain: readonly string[]): NodeId {
  if (containerChain.length === 0) {
    throw new InvalidNodeIdError('a symbol needs at least one container segment');
  }

  for (const segment of containerChain) {
    if (segment.trim().length === 0) {
      throw new InvalidNodeIdError('container segments cannot be empty');
    }

    if (segment.includes('.')) {
      throw new InvalidNodeIdError(
        `container segment ${JSON.stringify(segment)} cannot contain ".", which separates chain segments`,
      );
    }

    // A leading '#' is an ECMAScript private name and is part of the declared
    // name, so it must be representable. Parsing splits on the first '#', which
    // always ends the path, so later ones are unambiguous. Anywhere other than
    // the first character it is meaningless and rejected.
    if (segment.lastIndexOf('#') > 0) {
      throw new InvalidNodeIdError(
        `container segment ${JSON.stringify(segment)} may only contain "#" as a leading private-name marker`,
      );
    }
  }

  return `sym:${normalizeRepoPath(repoPath)}#${containerChain.join('.')}` as NodeId;
}

/**
 * Identifies an environment variable by name.
 *
 *   environmentVariableId('DATABASE_URL') → env:DATABASE_URL
 *
 * An environment variable belongs to the process rather than to a file, so its
 * identity carries no path: every read of `DATABASE_URL` names the same thing.
 */
export function environmentVariableId(name: string): NodeId {
  const trimmed = name.trim();

  if (!ENVIRONMENT_VARIABLE_NAME.test(trimmed)) {
    throw new InvalidNodeIdError(
      `${JSON.stringify(name)} is not a usable environment variable name`,
    );
  }

  return `env:${trimmed}` as NodeId;
}

/**
 * Identifies an HTTP route by method and fully composed path.
 *
 *   routeId('post', '/api/auth/login') → route:POST:/api/auth/login
 *
 * Route paths keep their parameter colons, so `route:GET:/users/:id` contains
 * three colons. Anything parsing this form must split on the first two only.
 */
export function routeId(method: string, routePath: string): NodeId {
  const trimmedMethod = method.trim();

  if (!HTTP_METHOD.test(trimmedMethod)) {
    throw new InvalidNodeIdError(`${JSON.stringify(method)} is not a valid HTTP method`);
  }

  return `route:${trimmedMethod.toUpperCase()}:${normalizeRoutePath(routePath)}` as NodeId;
}

/**
 * Route paths are absolute by definition, so they normalise differently from
 * repository paths: duplicate and trailing slashes collapse, and `/` is valid.
 */
function normalizeRoutePath(rawPath: string): string {
  const trimmed = rawPath.trim();

  if (!trimmed.startsWith('/')) {
    throw new InvalidNodeIdError(`route path ${JSON.stringify(rawPath)} must start with "/"`);
  }

  const segments = trimmed.split('/').filter((segment) => segment.length > 0);

  return `/${segments.join('/')}`;
}
