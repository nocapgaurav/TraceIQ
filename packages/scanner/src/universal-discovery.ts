import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { readDeclaredDependencies, readDeclaredName } from './declared-dependencies.js';
import { languageOf, manifestEcosystemOf, roleOf } from './languages.js';
import type { ManifestFile, RepositoryFile } from './types.js';

/**
 * Classifies every file the repository contains, and reads what its manifests declare.
 *
 * This is the part of the scan that runs for **every** repository, whatever it is written
 * in. Nothing here is TypeScript-specific and nothing here parses source: a file is
 * identified by its path, and only manifests have their contents read.
 *
 * The classification is honest about being conventional. Extension identifies language,
 * directory and filename conventions identify role, and both are recorded in the graph as
 * `INFERRED` with the rule that fired. A repository that puts its tests in `src/` and its
 * sources in `test/` is described wrongly, and no amount of scanning short of parsing
 * would fix that.
 */
export interface UniversalDiscovery {
  readonly files: readonly RepositoryFile[];
  readonly manifests: readonly ManifestFile[];
}

/**
 * A manifest larger than this is not read for dependencies.
 *
 * A generated `requirements.txt` or a vendored `pom.xml` can be megabytes, and the
 * regular-expression readers are linear in input size. The manifest is still reported as
 * present — only its dependency list is left empty, which is the same outcome as one that
 * declares none.
 */
const MANIFEST_BYTE_LIMIT = 512 * 1024;

export async function discoverUniversalFacts(input: {
  readonly rootPath: string;
  /** Every file path the walk found, repository-relative. */
  readonly filePaths: readonly string[];
}): Promise<UniversalDiscovery> {
  const files: RepositoryFile[] = [];
  const manifestPaths: string[] = [];

  for (const filePath of input.filePaths) {
    const language = languageOf(filePath);
    const role = roleOf(filePath, language);

    files.push({
      path: filePath,
      language,
      role,
      bytes: await sizeOf(path.join(input.rootPath, filePath)),
    });

    if (role === 'manifest') {
      manifestPaths.push(filePath);
    }
  }

  const manifests: ManifestFile[] = [];

  for (const manifestPath of manifestPaths) {
    const ecosystem = manifestEcosystemOf(manifestPath);

    if (ecosystem === null) {
      continue;
    }

    const read = await readManifest({
      absolutePath: path.join(input.rootPath, manifestPath),
      ecosystem,
      bytes: files.find((file) => file.path === manifestPath)?.bytes ?? 0,
    });

    manifests.push({ path: manifestPath, ecosystem, ...read });
  }

  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    manifests: manifests.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * A file whose size cannot be read is reported at zero rather than dropped.
 *
 * It exists — the walk just found it — and losing it from the inventory over an
 * unreadable `stat` would understate the repository. A symlink or a permission error is
 * the usual cause.
 */
async function sizeOf(absolutePath: string): Promise<number> {
  try {
    return (await stat(absolutePath)).size;
  } catch {
    return 0;
  }
}

async function readManifest(input: {
  readonly absolutePath: string;
  readonly ecosystem: ManifestFile['ecosystem'];
  readonly bytes: number;
}): Promise<{ readonly declaredDependencies: readonly string[]; readonly declaredName: string | null }> {
  const nothing = { declaredDependencies: [] as readonly string[], declaredName: null };

  if (input.bytes > MANIFEST_BYTE_LIMIT) {
    return nothing;
  }

  try {
    // One read for both facts, rather than opening every manifest in the repository twice.
    const contents = await readFile(input.absolutePath, 'utf8');

    return {
      declaredDependencies: readDeclaredDependencies({ ecosystem: input.ecosystem, contents }),
      declaredName: readDeclaredName({ ecosystem: input.ecosystem, contents }),
    };
  } catch {
    // Unreadable is reported as declaring nothing. The manifest's presence is the fact
    // that matters most, and it is already recorded.
    return nothing;
  }
}
