import { describe, expect, it } from 'vitest';

import { LOCKFILES, selectLockfile } from './detect-package-manager.js';

describe('selectLockfile', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ])('maps %s to %s', (fileName, packageManager) => {
    expect(selectLockfile([fileName])).toEqual({ path: fileName, packageManager });
  });

  it('returns null when no recognised lockfile is present', () => {
    expect(selectLockfile(['package.json', 'tsconfig.json'])).toBeNull();
  });

  it('returns null for an empty root', () => {
    expect(selectLockfile([])).toBeNull();
  });

  it('resolves a repository holding several lockfiles by documented precedence', () => {
    expect(selectLockfile(['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'])).toEqual({
      path: 'pnpm-lock.yaml',
      packageManager: 'pnpm',
    });
  });

  it('records which file the answer came from, so the choice stays explainable', () => {
    const lockfile = selectLockfile(['yarn.lock', 'package-lock.json']);

    expect(lockfile?.path).toBe('package-lock.json');
  });

  it('ignores lockfiles that are not at the repository root', () => {
    expect(selectLockfile(['packages/api/pnpm-lock.yaml'])).toBeNull();
  });
});

describe('LOCKFILES', () => {
  it('lists every recognised lockfile exactly once', () => {
    const fileNames = LOCKFILES.map((definition) => definition.fileName);

    expect(new Set(fileNames).size).toBe(fileNames.length);
  });
});
