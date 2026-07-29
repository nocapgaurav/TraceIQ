import { describe, expect, it } from 'vitest';

import { CONVENTIONAL_ENTRY_POINTS, resolveEntryPoints } from './entry-points.js';

describe('resolveEntryPoints', () => {
  it('resolves a declared entry that names a discovered source file', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [{ field: 'main', target: 'src/server.ts' }],
      sourceFiles: ['src/server.ts', 'src/other.ts'],
    });

    expect(entryPoints).toEqual([{ path: 'src/server.ts', origin: 'manifest', field: 'main' }]);
  });

  it('normalises a declared target before matching', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [{ field: 'main', target: './src/server.ts' }],
      sourceFiles: ['src/server.ts'],
    });

    expect(entryPoints[0]?.path).toBe('src/server.ts');
  });

  it('drops a declared target pointing at build output, which is never discovered', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [{ field: 'main', target: 'dist/index.js' }],
      sourceFiles: ['src/other.ts'],
    });

    expect(entryPoints).toEqual([]);
  });

  it('falls back to a conventional entry when the declared target is build output', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [{ field: 'main', target: 'dist/index.js' }],
      sourceFiles: ['src/index.ts'],
    });

    expect(entryPoints).toEqual([
      { path: 'src/index.ts', origin: 'convention', field: null },
    ]);
  });

  it('reports declared entries before conventional ones', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [{ field: 'bin.cli', target: 'src/cli.ts' }],
      sourceFiles: ['src/cli.ts', 'src/index.ts'],
    });

    expect(entryPoints.map((entry) => entry.path)).toEqual(['src/cli.ts', 'src/index.ts']);
    expect(entryPoints.map((entry) => entry.origin)).toEqual(['manifest', 'convention']);
  });

  it('never reports the same path twice', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [
        { field: 'main', target: 'src/index.ts' },
        { field: 'module', target: './src/index.ts' },
      ],
      sourceFiles: ['src/index.ts'],
    });

    expect(entryPoints).toEqual([{ path: 'src/index.ts', origin: 'manifest', field: 'main' }]);
  });

  it('attributes a declared entry to the field it came from', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [{ field: 'exports["."].import', target: 'src/index.ts' }],
      sourceFiles: ['src/index.ts'],
    });

    expect(entryPoints[0]?.field).toBe('exports["."].import');
  });

  it('reports conventional entries in their documented order', () => {
    const entryPoints = resolveEntryPoints({
      manifestEntries: [],
      sourceFiles: ['app.ts', 'src/main.ts', 'src/index.ts'],
    });

    expect(entryPoints.map((entry) => entry.path)).toEqual([
      'src/index.ts',
      'src/main.ts',
      'app.ts',
    ]);
  });

  it('returns nothing when no source file looks like an entry point', () => {
    expect(
      resolveEntryPoints({ manifestEntries: [], sourceFiles: ['src/auth/auth.service.ts'] }),
    ).toEqual([]);
  });

  it.each([
    ['an absolute target', '/etc/passwd'],
    ['a target escaping the repository', '../elsewhere/index.ts'],
    ['a target resolving to the root', '.'],
    ['an empty target', ''],
  ])('treats %s as not an entry point rather than an error', (_description, target) => {
    expect(() =>
      resolveEntryPoints({
        manifestEntries: [{ field: 'main', target }],
        sourceFiles: ['src/other.ts'],
      }),
    ).not.toThrow();
  });
});

describe('CONVENTIONAL_ENTRY_POINTS', () => {
  it('contains no duplicates', () => {
    expect(new Set(CONVENTIONAL_ENTRY_POINTS).size).toBe(CONVENTIONAL_ENTRY_POINTS.length);
  });
});
