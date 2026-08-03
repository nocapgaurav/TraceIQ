import type { LanguageName } from './languages.js';
import type { LanguageCount, ManifestFile, RepositoryFile, TechnologyRegion } from './types.js';

/**
 * Divides a repository into the technology regions it is actually made of.
 *
 * A polyglot repository is not one project in one language with some stray files; it is
 * several projects sharing a checkout. `frontend/` is a TypeScript application,
 * `backend/` is a Maven module, `ml/` is a Python package — each with its own manifest,
 * its own dependencies and, eventually, its own analyser. Reporting a single "primary
 * language" for such a repository throws away most of what it is.
 *
 * **A region is anchored on a dependency manifest.** That is the one signal available
 * without parsing that reliably marks "a project starts here": it names the project,
 * usually declares its dependencies, and is placed deliberately by whoever built the
 * repository. Guessing regions from directory names or language clustering instead would
 * invent boundaries nobody declared.
 *
 * The repository root is a region whenever files belong to it directly — either because
 * it holds a manifest, or because it holds files no nested manifest claims. A repository
 * with no manifest anywhere is therefore still one region, which is the right answer for
 * a documentation repository.
 *
 * Every file belongs to exactly one region: the **deepest** whose directory contains it.
 * A monorepo root manifest therefore does not swallow the packages beneath it, and file
 * counts across regions sum to the repository total.
 */
export function deriveTechnologyRegions(input: {
  readonly files: readonly RepositoryFile[];
  readonly manifests: readonly ManifestFile[];
}): readonly TechnologyRegion[] {
  const anchors = anchorDirectories(input.manifests);

  // The root always participates, so that files under no manifest still have a home. It
  // is dropped again below if nothing lands in it.
  anchors.add('');

  const sorted = [...anchors].sort();
  const manifestsByAnchor = groupManifests(input.manifests);
  const filesByAnchor = new Map<string, RepositoryFile[]>(sorted.map((path) => [path, []]));

  for (const file of input.files) {
    const anchor = deepestAnchor(sorted, file.path);

    filesByAnchor.get(anchor)?.push(file);
  }

  const regions: TechnologyRegion[] = [];

  for (const path of sorted) {
    const files = filesByAnchor.get(path) ?? [];
    const manifests = manifestsByAnchor.get(path) ?? [];

    // An anchor that ended up with nothing is not a region. That happens when a manifest
    // sits in a directory whose every file belongs to a deeper one.
    if (files.length === 0 && manifests.length === 0) {
      continue;
    }

    const languages = countLanguages(files);

    regions.push({
      path,
      manifests: manifests.map((manifest) => manifest.path).sort(),
      ecosystems: [...new Set(manifests.map((manifest) => manifest.ecosystem))].sort(),
      languages,
      primaryLanguage: primaryLanguageOf(files),
      fileCount: files.length,
      sourceFileCount: files.filter((file) => file.role === 'source').length,
    });
  }

  return regions;
}

/**
 * The directory each manifest anchors.
 *
 * A manifest in a directory that is *itself* only a build directory — `gradle/` holding a
 * `settings.gradle` for the project above — would anchor a region of its own, which is
 * accepted: it is what the repository states, and second-guessing it would need
 * knowledge of each build system's conventions.
 */
function anchorDirectories(manifests: readonly ManifestFile[]): Set<string> {
  return new Set(manifests.map((manifest) => directoryOf(manifest.path)));
}

function groupManifests(
  manifests: readonly ManifestFile[],
): ReadonlyMap<string, readonly ManifestFile[]> {
  const byDirectory = new Map<string, ManifestFile[]>();

  for (const manifest of manifests) {
    const directory = directoryOf(manifest.path);
    const bucket = byDirectory.get(directory);

    if (bucket === undefined) {
      byDirectory.set(directory, [manifest]);
    } else {
      bucket.push(manifest);
    }
  }

  return byDirectory;
}

/**
 * The deepest anchor containing this file.
 *
 * `anchors` is sorted, so the last match is the longest — no length comparison needed,
 * and ties are impossible because anchors are unique directory paths.
 */
/**
 * The region a path belongs to: the deepest whose directory contains it.
 *
 * Exported so that anything attributing a file to a region uses the *same* rule the regions were
 * built with. A second implementation of "which region is this file in" is a second chance for a
 * file to be counted in one region and its technologies attributed to another.
 *
 * `anchors` must be sorted, which is how the deepest match ends up last.
 */
export function regionOf(anchors: readonly string[], filePath: string): string {
  return deepestAnchor(anchors, filePath);
}

function deepestAnchor(anchors: readonly string[], filePath: string): string {
  let deepest = '';

  for (const anchor of anchors) {
    if (anchor === '' || filePath.startsWith(`${anchor}/`)) {
      deepest = anchor;
    }
  }

  return deepest;
}

/** Languages present, by file count descending, then by name so ties are stable. */
function countLanguages(files: readonly RepositoryFile[]): readonly LanguageCount[] {
  const counts = new Map<LanguageName, number>();

  for (const file of files) {
    if (file.language !== null) {
      counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([language, files_]) => ({ language, files: files_ }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

/**
 * The region's dominant language, counting **source files only**.
 *
 * Counting every file would name most repositories after their configuration: a Java
 * service with forty XML files and twelve `.java` files is a Java service. A region whose
 * files are all documentation or configuration has no primary language, and `null` says
 * so rather than naming Markdown.
 */
function primaryLanguageOf(files: readonly RepositoryFile[]): LanguageName | null {
  const sourceCounts = countLanguages(files.filter((file) => file.role === 'source'));

  return sourceCounts[0]?.language ?? null;
}

/** `'a/b/c.ts'` → `'a/b'`; a root-level file → `''`. */
function directoryOf(repoRelativePath: string): string {
  const index = repoRelativePath.lastIndexOf('/');

  return index === -1 ? '' : repoRelativePath.slice(0, index);
}

/** Language totals across the whole repository, by file count descending. */
export function repositoryLanguages(files: readonly RepositoryFile[]): readonly LanguageCount[] {
  return countLanguages(files);
}
