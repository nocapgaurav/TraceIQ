import { readFile } from 'node:fs/promises';

import { readManifestWorkspaceGlobs, type WorkspaceGlobs } from './workspace-globs.js';

/** A declared entry point target, before it is checked against discovered files. */
export interface ManifestEntryField {
  /** The declaring field, e.g. `main`, `bin.cli`, `exports["."].import`. */
  readonly field: string;
  /** The raw target as written in package.json. */
  readonly target: string;
}

/**
 * The parts of package.json the scanner needs. Everything else is deliberately
 * ignored: the scanner reports repository structure, not package metadata.
 */
export interface PackageManifest {
  readonly name: string | null;
  /** Every declared dependency name across all four sections, sorted. */
  readonly dependencyNames: readonly string[];
  readonly entryFields: readonly ManifestEntryField[];
  /**
   * The globs declared in `workspaces`, empty when the field is absent.
   *
   * Read here rather than by the workspace discovery, so that package.json is parsed
   * in exactly one place and a caller never has to hold the raw JSON to ask a second
   * question of it.
   */
  readonly workspaceGlobs: WorkspaceGlobs;
}

export class MalformedManifestError extends Error {
  constructor(absolutePath: string, reason: string, options?: { cause: unknown }) {
    super(`Malformed package manifest at ${absolutePath}: ${reason}`, options);
    this.name = 'MalformedManifestError';
  }
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * Reads package.json.
 *
 * Returns `null` when the file does not exist, since a repository without a
 * manifest is still scannable. Throws when the file exists but cannot be
 * interpreted: silently treating a malformed manifest as absent would report
 * language and framework as unknown for a repository that clearly declares both,
 * and that failure would be invisible.
 */
export async function readPackageManifest(absolutePath: string): Promise<PackageManifest | null> {
  let raw: string;

  try {
    raw = await readFile(absolutePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new MalformedManifestError(absolutePath, 'the file could not be read', { cause });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MalformedManifestError(absolutePath, 'the file is not valid JSON', { cause });
  }

  if (!isRecord(parsed)) {
    throw new MalformedManifestError(absolutePath, 'the top level value is not an object');
  }

  return {
    name: readName(parsed),
    dependencyNames: readDependencyNames(parsed),
    entryFields: readEntryFields(parsed),
    workspaceGlobs: readManifestWorkspaceGlobs(parsed),
  };
}

function readName(manifest: Record<string, unknown>): string | null {
  const name = manifest['name'];

  if (typeof name !== 'string' || name.trim().length === 0) {
    return null;
  }

  return name.trim();
}

function readDependencyNames(manifest: Record<string, unknown>): readonly string[] {
  const names = new Set<string>();

  for (const section of DEPENDENCY_SECTIONS) {
    const value = manifest[section];

    if (isRecord(value)) {
      for (const name of Object.keys(value)) {
        names.add(name);
      }
    }
  }

  return [...names].sort();
}

function readEntryFields(manifest: Record<string, unknown>): readonly ManifestEntryField[] {
  const entries: ManifestEntryField[] = [];

  for (const field of ['main', 'module'] as const) {
    const value = manifest[field];

    if (typeof value === 'string') {
      entries.push({ field, target: value });
    }
  }

  collectTargets(manifest['bin'], 'bin', entries);
  collectTargets(manifest['exports'], 'exports', entries);

  return entries;
}

/**
 * Walks a package.json value that may be a string, an array of fallbacks or a
 * nested condition map, collecting every string target with the field path it
 * was found at. Handles `bin` and the several shapes `exports` permits.
 */
function collectTargets(value: unknown, field: string, out: ManifestEntryField[]): void {
  if (typeof value === 'string') {
    out.push({ field, target: value });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectTargets(item, `${field}[${index}]`, out);
    });
    return;
  }

  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      collectTargets(nested, appendFieldSegment(field, key), out);
    }
  }
}

function appendFieldSegment(field: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${field}.${key}` : `${field}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
