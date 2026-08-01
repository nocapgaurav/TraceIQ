import type { AnalyzerOutcome } from '@traceiq/analyzer';
import { summariseCapabilities } from '@traceiq/graph';
import type { AnalysisDepth, RegionCapability, RepositoryCapabilities } from '@traceiq/graph-api';
import type { RepositoryInventory, TechnologyRegion } from '@traceiq/scanner';

const NO_SOURCE =
  'this region holds no source files, so there is nothing for a semantic analyser to read; its documentation, configuration and manifests are still described';

const NO_ANALYSER =
  'no semantic analyser exists for this language yet, so structure, languages, manifests and declared dependencies are available but declarations, calls and types are not';

/**
 * Decides how deeply each technology region was actually analysed.
 *
 * **Depth is derived from files an analyser reported reading, never from a region's language.** That
 * distinction is the whole point: a Python region is not `semantic` because a TypeScript region
 * elsewhere in the repository is, and a region whose analyser threw is not `semantic` because its
 * language usually would be. Both were the old behaviour, and both told the reader something untrue.
 *
 * A region takes the **deepest** depth among the analysers that covered any of its source files. In
 * practice one analyser covers a region, but a mixed JS/TS region is covered by one analyser twice
 * over and a region could in principle be shared; taking the deepest is right because depth
 * describes what is available, and an available fact is not made unavailable by another analyser
 * having stopped short.
 */
export function assessCapabilities(input: {
  readonly inventory: RepositoryInventory;
  readonly outcomes: readonly AnalyzerOutcome[];
}): RepositoryCapabilities {
  const coverage = buildCoverage(input.outcomes);
  const frameworkFiles = frameworkFilesOf(input.outcomes);
  const owns = ownershipTest(input.inventory.regions.map((region) => region.path));

  return summariseCapabilities(
    input.inventory.regions.map((region) =>
      assessRegion({ region, coverage, frameworkFiles, outcomes: input.outcomes, owns }),
    ),
  );
}

/**
 * Which region a file belongs to: the **deepest** whose directory contains it.
 *
 * The same rule the scanner used to assign files to regions, and it matters here for the same
 * reason. The root region's path is `''`, which is a prefix of every path, so a naive containment
 * test would hand the root every file in the repository — and a root holding a README would then
 * inherit the semantic depth of a nested TypeScript package it has nothing to do with.
 */
function ownershipTest(regionPaths: readonly string[]): (regionPath: string, file: string) => boolean {
  const sorted = [...regionPaths].sort();

  const deepestFor = (file: string): string => {
    let deepest = '';

    for (const candidate of sorted) {
      if (candidate === '' || file.startsWith(`${candidate}/`)) {
        deepest = candidate;
      }
    }

    return deepest;
  };

  return (regionPath, file) => deepestFor(file) === regionPath;
}

/** Every covered file, mapped to the outcomes that covered it. */
function buildCoverage(
  outcomes: readonly AnalyzerOutcome[],
): ReadonlyMap<string, readonly AnalyzerOutcome[]> {
  const coverage = new Map<string, AnalyzerOutcome[]>();

  for (const outcome of outcomes) {
    for (const file of outcome.coveredFiles) {
      const bucket = coverage.get(file);

      if (bucket === undefined) {
        coverage.set(file, [outcome]);
      } else {
        bucket.push(outcome);
      }
    }
  }

  return coverage;
}

/**
 * The files framework facts were actually found in.
 *
 * This is the fix for the repository-wide over-claim. Framework depth used to be a single boolean:
 * if Express routes existed *anywhere*, every analysed TypeScript region was reported as reaching
 * `framework` depth — including the five packages in a monorepo that contain no route at all. Depth
 * is now claimed only for the regions holding the files those routes came from.
 */
function frameworkFilesOf(outcomes: readonly AnalyzerOutcome[]): ReadonlySet<string> {
  const files = new Set<string>();

  for (const outcome of outcomes) {
    const contribution = outcome.contribution;

    if (contribution === null) {
      continue;
    }

    const pathById = new Map(contribution.ir.files.map((file) => [file.id, file.path]));

    // The route's provenance names the file its registration was read from, which is exactly the
    // file that must belong to a region for that region to claim framework depth.
    for (const route of contribution.annotations.routes) {
      const filePath = pathById.get(route.provenance.fileId);

      if (filePath !== undefined) {
        files.add(filePath);
      }
    }
  }

  return files;
}

function assessRegion(input: {
  readonly region: TechnologyRegion;
  readonly coverage: ReadonlyMap<string, readonly AnalyzerOutcome[]>;
  readonly frameworkFiles: ReadonlySet<string>;
  readonly outcomes: readonly AnalyzerOutcome[];
  readonly owns: (regionPath: string, file: string) => boolean;
}): RegionCapability {
  const { region } = input;

  const base = {
    path: region.path,
    primaryLanguage: region.primaryLanguage,
    languages: region.languages.map((entry) => ({
      language: entry.language,
      files: entry.files,
    })),
    ecosystems: [...region.ecosystems],
    fileCount: region.fileCount,
    sourceFileCount: region.sourceFileCount,
  };

  if (region.sourceFileCount === 0) {
    return { ...base, depth: 'universal', reason: NO_SOURCE };
  }

  const covering = coveringOutcomes(region, input.coverage, input.owns);

  if (covering.length === 0) {
    return { ...base, depth: 'universal', reason: reasonForUncovered(region, input.outcomes) };
  }

  const deepest = covering.reduce((best, outcome) =>
    depthRank(outcome.depth) > depthRank(best.depth) ? outcome : best,
  );

  // Framework depth is a claim about *this* region, so it survives only if a route was found in a
  // file that belongs to it.
  if (deepest.depth === 'framework' && !hasFrameworkFile(region, input.frameworkFiles, input.owns)) {
    return {
      ...base,
      depth: 'semantic',
      // The analyser's own reason is kept and the downgrade appended to it. Substituting a fixed
      // sentence here — as this did — re-introduced precisely the claim the evidence-derived reasons
      // exist to prevent: it told 8 of dash's 16 regions that "imports, calls and types are resolved"
      // without consulting whether any of them were. A downgrade is one extra fact about a region,
      // not a licence to restate everything else about it.
      reason: `${deepest.reason}; no framework routes were found in this region, so its depth is reported as semantic rather than framework`,
    };
  }

  return { ...base, depth: deepest.depth, reason: deepest.reason };
}

/**
 * The outcomes covering at least one file in this region.
 *
 * A region owns a file when the file sits beneath its directory. The root region owns everything no
 * deeper region claimed, which mirrors how the scanner assigned files to regions in the first place.
 */
function coveringOutcomes(
  region: TechnologyRegion,
  coverage: ReadonlyMap<string, readonly AnalyzerOutcome[]>,
  owns: (regionPath: string, file: string) => boolean,
): readonly AnalyzerOutcome[] {
  const found = new Map<string, AnalyzerOutcome>();

  for (const [file, outcomes] of coverage) {
    if (!owns(region.path, file)) {
      continue;
    }

    for (const outcome of outcomes) {
      found.set(outcome.analyzer, outcome);
    }
  }

  return [...found.values()];
}

/**
 * Why a region with sources was covered by nobody.
 *
 * Two very different situations, and a reader needs to know which. An analyser that *claims* this
 * language and still covered nothing has failed — its message is reported. Otherwise no analyser
 * exists for the language yet, which is a gap rather than a fault.
 */
function reasonForUncovered(
  region: TechnologyRegion,
  outcomes: readonly AnalyzerOutcome[],
): string {
  const language = region.primaryLanguage;

  if (language === null) {
    return NO_ANALYSER;
  }

  const failedClaimant = outcomes.find(
    (outcome) => outcome.failure !== null && outcome.languages.includes(language),
  );

  return failedClaimant === undefined ? NO_ANALYSER : failedClaimant.reason;
}

function hasFrameworkFile(
  region: TechnologyRegion,
  frameworkFiles: ReadonlySet<string>,
  owns: (regionPath: string, file: string) => boolean,
): boolean {
  for (const file of frameworkFiles) {
    if (owns(region.path, file)) {
      return true;
    }
  }

  return false;
}

const RANKS: Readonly<Record<AnalysisDepth, number>> = {
  universal: 0,
  structural: 1,
  semantic: 2,
  framework: 3,
};

function depthRank(depth: AnalysisDepth): number {
  return RANKS[depth];
}
