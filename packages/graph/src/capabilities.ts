import {
  ANALYSIS_DEPTHS,
  type AnalysisDepth,
  type LanguageFileCount,
  type RegionCapability,
  type RepositoryCapabilities,
} from '@traceiq/graph-api';

/**
 * Fixed text for why a region reached the depth it did.
 *
 * A table rather than composed strings, for the same reason the limitation vocabularies
 * are tables: the same repository always produces the same words, and a consumer can show
 * them verbatim without a language analyser having to write prose.
 */
export const DEPTH_REASON: Readonly<Record<string, string>> = {
  'typescript-analysed':
    'TypeScript sources were compiled and resolved, so declarations, imports, calls and types are available',
  'typescript-analysed-with-framework':
    'TypeScript sources were compiled and resolved, and Express conventions were recognised, so routes and roles are available too',
  'no-analyser-for-language':
    'no semantic analyser exists for this language yet, so structure, languages, manifests and declared dependencies are available but declarations, calls and types are not',
  'no-source-files':
    'this region holds no source files, so there is nothing for a semantic analyser to read; its documentation, configuration and manifests are still described',
};

/** The reason code a region carries when TypeScript analysis covered it. */
export const TYPESCRIPT_REASON = 'typescript-analysed';
export const TYPESCRIPT_FRAMEWORK_REASON = 'typescript-analysed-with-framework';
export const NO_ANALYSER_REASON = 'no-analyser-for-language';
export const NO_SOURCE_REASON = 'no-source-files';

/**
 * Rolls a set of regions up into the repository's overall capability.
 *
 * The repository depth is the **deepest** any region reached, not the shallowest and not
 * an average. A polyglot repository with a fully analysed TypeScript frontend and an
 * unanalysed Go worker genuinely does offer semantic answers — about the frontend — and
 * reporting `universal` for the whole thing would hide analysis that was actually done.
 * Which parts those answers cover is exactly what `regions` is for, and any consumer
 * making a claim about a specific file must consult the region rather than this summary.
 */
export function summariseCapabilities(
  regions: readonly RegionCapability[],
): RepositoryCapabilities {
  const languages = new Map<string, number>();

  for (const region of regions) {
    for (const entry of region.languages) {
      languages.set(entry.language, (languages.get(entry.language) ?? 0) + entry.files);
    }
  }

  const primaryLanguages = new Set(
    regions
      .map((region) => region.primaryLanguage)
      .filter((language): language is string => language !== null),
  );

  return {
    depth: deepest(regions.map((region) => region.depth)),
    regions: [...regions].sort((a, b) => a.path.localeCompare(b.path)),
    languages: [...languages]
      .map(([language, files]): LanguageFileCount => ({ language, files }))
      .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
    // Two regions of the same language — a frontend and a backend both in TypeScript —
    // is a monorepo, not a polyglot repository. The claim is about languages, not regions.
    isPolyglot: primaryLanguages.size > 1,
  };
}

/** The capability of a repository with no regions at all: an empty checkout. */
export const NO_CAPABILITIES: RepositoryCapabilities = Object.freeze({
  depth: 'universal',
  regions: Object.freeze([]),
  languages: Object.freeze([]),
  isPolyglot: false,
});

function deepest(depths: readonly AnalysisDepth[]): AnalysisDepth {
  let best: AnalysisDepth = 'universal';

  for (const depth of depths) {
    if (ANALYSIS_DEPTHS.indexOf(depth) > ANALYSIS_DEPTHS.indexOf(best)) {
      best = depth;
    }
  }

  return best;
}
