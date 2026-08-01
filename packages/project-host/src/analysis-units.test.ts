import type { RepositoryInventory, TechnologyRegion } from '@traceiq/scanner';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILE_BUDGET,
  DEFAULT_WHOLE_PROGRAM_LIMIT,
  planAnalysisUnits,
} from './analysis-units.js';

/**
 * Bounding is off below `DEFAULT_WHOLE_PROGRAM_LIMIT`, so a test about *how* a repository is
 * divided has to ask for it. Passing `wholeProgramLimit: 0` is how a case says "this repository is
 * large" without listing eight thousand files.
 */
const BOUNDED = { wholeProgramLimit: 0 } as const;

/**
 * Planning bounded compilations.
 *
 * Two properties matter more than any individual case and are asserted everywhere: **every source
 * is owned**, and **no source is owned twice**. The first means the plan analyses the whole
 * repository; the second is a correctness requirement rather than tidiness, because a file
 * extracted by two units produces the same declaration identifier twice and the graph refuses it.
 */
const region = (path: string): TechnologyRegion => ({
  path,
  manifests: [],
  ecosystems: [],
  languages: [],
  primaryLanguage: null,
  fileCount: 0,
  sourceFileCount: 0,
});

const inventoryOf = (
  sourceFiles: readonly string[],
  regionPaths: readonly string[],
): RepositoryInventory =>
  ({
    name: 'fixture',
    rootPath: '/repo',
    sourceFiles,
    regions: regionPaths.map(region),
  }) as unknown as RepositoryInventory;

/** The two invariants, checked on every plan in this file. */
const expectPartitionOf = (
  units: ReturnType<typeof planAnalysisUnits>,
  sourceFiles: readonly string[],
): void => {
  const owned = units.flatMap((unit) => unit.ownedFiles);

  expect([...owned].sort()).toEqual([...sourceFiles].sort());
  expect(new Set(owned).size).toBe(owned.length);
};

describe('one unit per region', () => {
  it('gives each region its own unit', () => {
    const files = ['apps/web/a.ts', 'apps/web/b.ts', 'apps/api/c.ts', 'readme.ts'];
    const units = planAnalysisUnits(inventoryOf(files, ['', 'apps/web', 'apps/api']), BOUNDED);

    expect(units.map((unit) => [unit.id, unit.ownedFiles.length])).toEqual([
      ['<root>', 1],
      ['apps/api', 1],
      ['apps/web', 2],
    ]);
    expectPartitionOf(units, files);
  });

  it('uses the scanner’s own region rule, so a file lands where the scan counted it', () => {
    // A nested region claims its files from the root; the deepest anchor wins, exactly as the
    // region derivation decided. Two views of one repository must not disagree.
    const files = ['packages/ui/src/a.ts', 'src/b.ts'];
    const units = planAnalysisUnits(inventoryOf(files, ['', 'packages/ui']), BOUNDED);

    expect(units.find((unit) => unit.id === 'packages/ui')?.ownedFiles).toEqual([
      'packages/ui/src/a.ts',
    ]);
    expect(units.find((unit) => unit.id === '<root>')?.ownedFiles).toEqual(['src/b.ts']);
  });

  it('plans one unit for a repository with no regions at all', () => {
    const units = planAnalysisUnits(inventoryOf(['a.ts', 'b.ts'], []), BOUNDED);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ regionPath: '', partitionedFrom: null });
  });

  it('marks a whole-region unit as unpartitioned', () => {
    const units = planAnalysisUnits(inventoryOf(['a.ts'], ['']), BOUNDED);

    expect(units[0]?.partitionedFrom).toBeNull();
  });

  it('plans identically from identical input, so the plan can be matched across scans', () => {
    const files = ['b/2.ts', 'a/1.ts', 'b/1.ts'];
    const input = inventoryOf(files, ['', 'a', 'b']);

    expect(JSON.stringify(planAnalysisUnits(input, BOUNDED))).toBe(
      JSON.stringify(planAnalysisUnits(input, BOUNDED)),
    );
  });
});

describe('a region too large to compile at once', () => {
  const fixtures = (count: number, directory: (index: number) => string): readonly string[] =>
    Array.from({ length: count }, (_, index) => `${directory(index)}/file${index}.ts`);

  it('leaves a region under the budget whole', () => {
    // Every repository that analyses correctly today is under this, which is what makes the budget
    // safe: React's largest region is 1,967 roots and TraceIQ's is 129.
    const files = fixtures(50, (index) => `test/case${index}`);
    const units = planAnalysisUnits(inventoryOf(files, ['']), { ...BOUNDED, fileBudget: 100 });

    expect(units).toHaveLength(1);
    expect(units[0]?.partitionedFrom).toBeNull();
  });

  it('splits along directory boundaries, and says it did', () => {
    // Next.js's root region is 13,151 roots, 6,715 of them independent fixture apps under
    // `test/e2e/app-dir`. Directory is the only boundary available without parsing, and it is the
    // one those files actually have.
    const files = fixtures(30, (index) => `test/case${index % 6}`);
    const units = planAnalysisUnits(inventoryOf(files, ['']), { ...BOUNDED, fileBudget: 10 });

    expect(units.length).toBeGreaterThan(1);
    expect(units.every((unit) => unit.partitionedFrom === '')).toBe(true);
    expect(units.every((unit) => unit.ownedFiles.length <= 10)).toBe(true);
    expectPartitionOf(units, files);
  });

  it('keeps a directory together rather than cutting it at an index', () => {
    // A single directory over the budget is returned oversized. Splitting files that plainly
    // belong together would break resolution between them, and a program that is too big is a
    // better failure than one that is wrong.
    const files = fixtures(20, () => 'test/one');
    const units = planAnalysisUnits(inventoryOf(files, ['']), { ...BOUNDED, fileBudget: 5 });

    expect(units).toHaveLength(1);
    expect(units[0]?.ownedFiles).toHaveLength(20);
  });

  it('goes deeper only where a group is still too large', () => {
    const files = [...fixtures(20, () => 'test/deep/a'), ...fixtures(2, () => 'test/shallow')];
    const units = planAnalysisUnits(inventoryOf(files, ['']), { ...BOUNDED, fileBudget: 10 });

    expectPartitionOf(units, files);
    // The small directory is one unit; the large one was divided further.
    expect(units.some((unit) => unit.ownedFiles.length === 2)).toBe(true);
  });

  it('splits relative to the region anchor, not the repository root', () => {
    const files = [
      ...fixtures(12, () => 'packages/big/a'),
      ...fixtures(12, () => 'packages/big/b'),
    ];
    const units = planAnalysisUnits(inventoryOf(files, ['', 'packages/big']), { ...BOUNDED, fileBudget: 15 });

    expect(units.map((unit) => unit.ownedFiles.length).sort()).toEqual([12, 12]);
    expect(units.every((unit) => unit.regionPath === 'packages/big')).toBe(true);
    expectPartitionOf(units, files);
  });
});

describe('a repository small enough for one program', () => {
  it('is one unit, which is the behaviour that shipped before bounding existed', () => {
    // The common case, and it must stay the fast one: bounding costs parse time, because a unit's
    // program re-parses every shared dependency it reaches. Measured on TraceIQ, the IR took 1.8 s
    // as one program and 8.4 s across 32 units.
    const files = ['apps/web/a.ts', 'apps/api/b.ts'];
    const units = planAnalysisUnits(inventoryOf(files, ['', 'apps/web', 'apps/api']));

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ id: '<repository>', partitionedFrom: null });
    expect(units[0]?.ownedFiles).toEqual(files);
  });

  it('plans nothing for a repository with no sources', () => {
    expect(planAnalysisUnits(inventoryOf([], ['']))).toEqual([]);
  });
});

describe('the thresholds', () => {
  it('keeps every region in the validation corpus whole', () => {
    // React's largest is 1,967, zod's 287, dash's 204, TraceIQ's 129. The budget must sit above all
    // of them or this milestone changes the behaviour of repositories that already work.
    expect(DEFAULT_FILE_BUDGET).toBeGreaterThan(1_967);
  });

  it('leaves every repository in the validation corpus on the single-program path', () => {
    // React is the largest at 4,505 sources and peaks at 1.5 GB as one program — comfortable.
    // Next.js is 22,400 and exhausts a 12 GB heap, which is the case bounding exists for.
    expect(DEFAULT_WHOLE_PROGRAM_LIMIT).toBeGreaterThan(4_505);
    expect(DEFAULT_WHOLE_PROGRAM_LIMIT).toBeLessThan(22_400);
  });
});
