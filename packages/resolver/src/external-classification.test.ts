import { describe, expect, it } from 'vitest';

import {
  classifyExternalFile,
  classifyUnresolvedSpecifier,
  packageNameFromPath,
  packageNameFromSpecifier,
} from './external-classification.js';

describe('packageNameFromSpecifier', () => {
  it.each([
    ['express', 'express'],
    ['express/lib/router', 'express'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/sub/path', '@scope/pkg'],
    ['ts-morph', 'ts-morph'],
  ])('reads %s as %s', (specifier, expected) => {
    expect(packageNameFromSpecifier(specifier)).toBe(expected);
  });

  it.each([
    ['a relative specifier', './local'],
    ['a parent specifier', '../up'],
    ['an absolute specifier', '/etc/thing'],
    ['an empty specifier', ''],
    ['a scope with no package', '@scope'],
  ])('reads %s as no package', (_description, specifier) => {
    expect(packageNameFromSpecifier(specifier)).toBeNull();
  });
});

describe('packageNameFromPath', () => {
  it('reads the package from an installed path', () => {
    expect(packageNameFromPath('/repo/node_modules/express/lib/router.d.ts')).toBe('express');
  });

  it('reads a scoped package', () => {
    expect(packageNameFromPath('/repo/node_modules/@types/node/fs.d.ts')).toBe('@types/node');
  });

  it('attributes a nested dependency to itself, not to its host', () => {
    expect(
      packageNameFromPath('/repo/node_modules/host/node_modules/nested/index.d.ts'),
    ).toBe('nested');
  });

  it('reads a pnpm store path', () => {
    expect(
      packageNameFromPath('/repo/node_modules/.pnpm/ts-morph@28.0.0/node_modules/ts-morph/x.d.ts'),
    ).toBe('ts-morph');
  });

  it('reads a repository path as no package', () => {
    expect(packageNameFromPath('/repo/src/index.ts')).toBeNull();
  });
});

describe('classifyExternalFile', () => {
  it('classifies an installed package', () => {
    expect(classifyExternalFile('/repo/node_modules/express/index.d.ts')).toEqual({
      origin: 'package',
      name: 'express',
    });
  });

  it.each([
    '/repo/node_modules/typescript/lib/lib.es5.d.ts',
    '/repo/node_modules/typescript/lib/lib.dom.d.ts',
    '/elsewhere/lib.es2015.promise.d.ts',
  ])('classifies %s as a TypeScript built-in with no name', (filePath) => {
    // The specific lib file is deliberately not recorded: a built-in is declared
    // across several, and naming the file would make one type look like several
    // ambiguous candidates.
    expect(classifyExternalFile(filePath)).toEqual({ origin: 'typescript-lib', name: null });
  });

  it('classifies an unrecognised outside file', () => {
    expect(classifyExternalFile('/somewhere/else/thing.d.ts')).toEqual({
      origin: 'outside-analysis',
      name: null,
    });
  });

  it('accepts Windows separators', () => {
    expect(classifyExternalFile('C:\\repo\\node_modules\\express\\index.d.ts')).toEqual({
      origin: 'package',
      name: 'express',
    });
  });
});

describe('classifyUnresolvedSpecifier', () => {
  it.each(['node:path', 'node:fs/promises', 'node:os'])(
    'treats %s as a Node builtin, which its reserved prefix proves',
    (specifier) => {
      // TypeScript never resolves a `node:` specifier to a file — its types come
      // from ambient declarations — so this path is the only one that sees them.
      expect(classifyUnresolvedSpecifier(specifier)).toEqual({
        target: { kind: 'external', origin: 'node-builtin', name: specifier },
        confidence: 'CERTAIN',
        evidence: expect.stringContaining('reserved'),
      });
    },
  );

  it('infers an uninstalled package from a bare specifier, without claiming certainty', () => {
    const classified = classifyUnresolvedSpecifier('express/lib/router');

    expect(classified?.target).toEqual({ kind: 'external', origin: 'package', name: 'express' });
    expect(classified?.confidence).toBe('INFERRED');
  });

  it('infers a scoped package', () => {
    expect(classifyUnresolvedSpecifier('@scope/pkg/deep')?.target).toEqual({
      kind: 'external',
      origin: 'package',
      name: '@scope/pkg',
    });
  });

  it.each(['./relative', '../up', '/absolute'])(
    'reports %s as a genuine failure rather than a package',
    (specifier) => {
      expect(classifyUnresolvedSpecifier(specifier)).toBeNull();
    },
  );
});
