import { describe, expect, it } from 'vitest';

import { InvalidRepoPathError, normalizeRepoPath } from './repo-path.js';

describe('normalizeRepoPath', () => {
  it('leaves an already canonical path untouched', () => {
    expect(normalizeRepoPath('src/auth/auth.service.ts')).toBe('src/auth/auth.service.ts');
  });

  it('converts Windows separators to POSIX', () => {
    expect(normalizeRepoPath('src\\auth\\auth.service.ts')).toBe('src/auth/auth.service.ts');
  });

  it('strips a leading current-directory segment', () => {
    expect(normalizeRepoPath('./src/index.ts')).toBe('src/index.ts');
  });

  it('collapses duplicate slashes', () => {
    expect(normalizeRepoPath('src//auth///index.ts')).toBe('src/auth/index.ts');
  });

  it('drops a trailing slash', () => {
    expect(normalizeRepoPath('src/auth/')).toBe('src/auth');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRepoPath('  src/index.ts  ')).toBe('src/index.ts');
  });

  it('is idempotent', () => {
    const once = normalizeRepoPath('./src//auth/');
    expect(normalizeRepoPath(once)).toBe(once);
  });

  it.each([
    ['an empty path', ''],
    ['a whitespace-only path', '   '],
    ['a POSIX absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\repo\\src\\index.ts'],
    ['a path escaping the repository root', '../outside/index.ts'],
    ['a path with an interior parent segment', 'src/../../index.ts'],
    ['a path resolving to the repository root', './'],
    ['a path containing the identifier delimiter', 'src/we#ird.ts'],
  ])('rejects %s', (_description, rawPath) => {
    expect(() => normalizeRepoPath(rawPath)).toThrow(InvalidRepoPathError);
  });

  it('names the offending path in the error message', () => {
    expect(() => normalizeRepoPath('/etc/passwd')).toThrow(/"\/etc\/passwd"/);
  });
});
