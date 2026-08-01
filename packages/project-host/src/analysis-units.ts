import { regionOf, type RepositoryInventory } from '@traceiq/scanner';

/**
 * One bounded compilation.
 *
 * **A unit owns files; a program contains rather more.** The files listed here are the roots the
 * compiler is pointed at and the only ones whose declarations are extracted. Whatever those roots
 * import — a sibling package through a path mapping, a relative file in another region, a `.d.ts`
 * in `node_modules` — TypeScript's own module resolution pulls into the program, so a boundary here
 * costs no resolution accuracy. What it saves is everything nothing in the unit reaches.
 *
 * That distinction is the whole design. Measured on React: the whole-repository program cost 501 MB
 * for 4,505 roots, while the largest single region cost **69 MB** for 1,967 of them. Cost tracks the
 * *type surface reached*, not the file count — `packages/react-dom` is 224 files and costs 97 MB,
 * more than the 1,967-file compiler package — and a region reaches far less of it than a repository.
 */
export interface AnalysisUnit {
  /** Stable identifier, used in evidence and in the incremental record. */
  readonly id: string;
  /** The region this unit belongs to. `''` is the repository root. */
  readonly regionPath: string;
  /**
   * Repository-relative source paths this unit extracts declarations from.
   *
   * **Disjoint across units, and that is a correctness requirement rather than a tidiness one.** A
   * file extracted twice would produce the same declaration identifier twice, which the graph
   * refuses outright. A file may appear in several *programs* — it is pulled in wherever something
   * imports it — but it is owned by exactly one unit.
   */
  readonly ownedFiles: readonly string[];
  /**
   * The region this unit was split out of, when the region was too large to compile at once.
   *
   * `null` for the overwhelming majority of units, which are whole regions. Set only above the file
   * budget, and carried so capability reporting can say so rather than quietly analysing less.
   */
  readonly partitionedFrom: string | null;
}

/**
 * How many roots one program may be pointed at before a region is split.
 *
 * **Chosen from measurement, and deliberately above every repository that works today.** The
 * largest single region across the validation corpus is React's `babel-plugin-react-compiler` at
 * 1,967 roots; TraceIQ's is 129, zod's 287, dash's 204. None reaches this, so no repository that
 * analyses correctly now changes behaviour at all — which is what "preserve behaviour" requires.
 *
 * What does reach it is Next.js's root region: **13,151 roots**, of which 6,715 are under
 * `test/e2e/app-dir` — hundreds of independent fixture applications that share no manifest and
 * import nothing of each other's. That region is a leftovers bucket rather than a semantic unit,
 * and compiling it as one program is the ceiling this milestone exists to remove.
 */
export const DEFAULT_FILE_BUDGET = 4_000;

/**
 * How many sources a repository may hold before compilation is bounded at all.
 *
 * **Below this, the whole repository is one unit — byte-for-byte the behaviour that shipped before
 * bounding existed.** That is not timidity, it is what the measurements say. Bounding costs real
 * time: a unit's program re-parses every shared dependency it reaches, so a source imported by
 * thirty packages is parsed thirty times. Measured on TraceIQ, building the IR took **1.8 s as one
 * program and 8.4 s across 32 units** — the same files, 4.8× the work — while program construction
 * itself was near-free either way (118 ms against 219 ms).
 *
 * So the trade is: bounding buys a memory ceiling and costs parse time. A repository that already
 * analyses comfortably should not pay for a ceiling it never reaches, and one that cannot be
 * analysed at all should pay whatever it takes.
 *
 * The number comes from measurement at both ends. React is 4,505 sources and peaks at 1.5 GB as one
 * program — comfortable. Next.js is 22,400 and exhausts a 12 GB heap. Peak scales roughly with the
 * source count, putting the edge of a default heap near 12,000; 8,000 sits below that with room,
 * and above every repository in the validation corpus.
 */
export const DEFAULT_WHOLE_PROGRAM_LIMIT = 8_000;

/**
 * Divides a repository's sources into bounded compilations.
 *
 * **One unit per region, which is the boundary the repository itself declared.** A region is
 * anchored on a dependency manifest — the one signal available without parsing that marks where a
 * project begins — so "compile a region at a time" is compiling a project at a time. A frontend
 * does not load the backend's symbols because nothing in the frontend imports them; where something
 * *does*, module resolution brings exactly that in and nothing more.
 *
 * A region above `fileBudget` is split further, by directory, until each part fits. This is the one
 * place accuracy can be affected: a relative import crossing two parts of a split region will not
 * resolve, and is reported unresolved rather than silently dropped. It applies to no repository in
 * the validation corpus except Next.js, whose alternative is not analysing at all.
 */
export function planAnalysisUnits(
  inventory: RepositoryInventory,
  options?: {
    readonly fileBudget?: number;
    /** Below this many sources the repository is one unit. See `DEFAULT_WHOLE_PROGRAM_LIMIT`. */
    readonly wholeProgramLimit?: number;
  },
): readonly AnalysisUnit[] {
  const budget = options?.fileBudget ?? DEFAULT_FILE_BUDGET;
  const wholeProgramLimit = options?.wholeProgramLimit ?? DEFAULT_WHOLE_PROGRAM_LIMIT;

  // One unit for a repository that fits, which is the same single program as before bounding
  // existed — same speed, same accuracy, same graph. Bounding is for repositories that need it.
  if (inventory.sourceFiles.length <= wholeProgramLimit) {
    return inventory.sourceFiles.length === 0
      ? []
      : [
          {
            id: '<repository>',
            regionPath: '',
            ownedFiles: inventory.sourceFiles,
            partitionedFrom: null,
          },
        ];
  }

  const anchors = inventory.regions.map((region) => region.path).sort();
  const byRegion = new Map<string, string[]>();

  // The scanner's own rule, not a second one: a file counted in one region must be compiled with
  // that region, or the two views of the repository disagree.
  for (const file of inventory.sourceFiles) {
    const region = anchors.length === 0 ? '' : regionOf(anchors, file);
    const bucket = byRegion.get(region);

    if (bucket === undefined) {
      byRegion.set(region, [file]);
    } else {
      bucket.push(file);
    }
  }

  const units: AnalysisUnit[] = [];

  // Sorted so two scans of one repository plan identical units, which is what lets the incremental
  // record match them up.
  for (const regionPath of [...byRegion.keys()].sort()) {
    const files = byRegion.get(regionPath) ?? [];

    if (files.length === 0) {
      continue;
    }

    if (files.length <= budget) {
      units.push({ id: regionPath === '' ? '<root>' : regionPath, regionPath, ownedFiles: files, partitionedFrom: null });
      continue;
    }

    for (const [index, part] of partition(files, regionPath, budget).entries()) {
      units.push({
        id: `${regionPath === '' ? '<root>' : regionPath}#${index}:${part.label}`,
        regionPath,
        ownedFiles: part.files,
        partitionedFrom: regionPath,
      });
    }
  }

  return units;
}

/**
 * Splits an over-budget region along directory boundaries.
 *
 * Grouped by the first path segment below the region's anchor, then by the next where a group is
 * still too large, and so on. Directory is the only boundary available without parsing, and it is
 * the one that best matches how an over-large region is actually over-large: Next.js's is thousands
 * of sibling fixture directories, and each is self-contained.
 *
 * A group that cannot be divided further — a single directory holding more than the budget — is
 * returned oversized rather than chopped at an arbitrary index. Splitting a real directory mid-way
 * would break resolution between files that plainly belong together, and a program that is too big
 * is a better failure than one that is wrong.
 */
function partition(
  files: readonly string[],
  regionPath: string,
  budget: number,
): readonly { readonly label: string; readonly files: readonly string[] }[] {
  const prefix = regionPath === '' ? '' : `${regionPath}/`;
  const depth = prefix === '' ? 0 : prefix.split('/').length - 1;

  const divide = (
    group: readonly string[],
    at: number,
    label: string,
  ): readonly { readonly label: string; readonly files: readonly string[] }[] => {
    if (group.length <= budget) {
      return [{ label, files: group }];
    }

    const bySegment = new Map<string, string[]>();

    for (const file of group) {
      const segments = file.split('/');
      // A file with nothing left to divide on — it sits directly in this directory — groups under
      // a name no directory can collide with.
      const segment = segments[at] ?? '.';
      const bucket = bySegment.get(segment);

      if (bucket === undefined) {
        bySegment.set(segment, [file]);
      } else {
        bucket.push(file);
      }
    }

    // Every file shares this segment, so this depth divides nothing. That is the common case rather
    // than the end of the road — `test/e2e/app-dir/*` shares three segments before it fans out — so
    // the walk descends, and only gives up when there is nothing left to descend into.
    if (bySegment.size <= 1) {
      const deeper = group.some((file) => file.split('/').length > at + 2);

      return deeper
        ? divide(group, at + 1, label === '' ? ([...bySegment.keys()][0] ?? '') : `${label}/${[...bySegment.keys()][0] ?? ''}`)
        : // A single directory holding more than the budget. Returned oversized rather than cut at
          // an arbitrary index: splitting files that plainly belong together would break resolution
          // between them, and a program that is too big is a better failure than one that is wrong.
          [{ label, files: group }];
    }

    return [...bySegment.keys()]
      .sort()
      .flatMap((segment) =>
        divide(bySegment.get(segment) ?? [], at + 1, label === '' ? segment : `${label}/${segment}`),
      );
  };

  return divide(files, depth, '');
}
