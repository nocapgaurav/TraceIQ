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
  ])('rejects %s', (_description, rawPath) => {
    expect(() => normalizeRepoPath(rawPath)).toThrow(InvalidRepoPathError);
  });

  it('names the offending path in the error message', () => {
    expect(() => normalizeRepoPath('/etc/passwd')).toThrow(/"\/etc\/passwd"/);
  });
});

describe('characters that collide with the identifier scheme', () => {
  it('encodes a "#" in a file name rather than rejecting the file', () => {
    // Next.js ships `client#component.tsx`. Rejecting it threw out of the *file* node, which the
    // tolerant build cannot retry past — one legal file name cost the whole repository its scan.
    expect(normalizeRepoPath('app/client#component.tsx')).toBe('app/client%23component.tsx');
  });

  it('leaves the encoded form unambiguous for anything splitting on the delimiter', () => {
    // Every existing parser takes the first literal `#` as the path/chain boundary. An encoded one
    // contains none, so the first literal `#` is still the real delimiter.
    expect(normalizeRepoPath('a/b#c.ts')).not.toContain('#');
  });
});
