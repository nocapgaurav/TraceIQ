import { describe, expect, it } from 'vitest';

import {
  IGNORED_DIRECTORY_NAMES,
  IGNORED_GLOB_PATTERNS,
  isIgnoredDirectoryName,
} from './ignore.js';

describe('ignored directory names', () => {
  it('are exactly the seven the milestone specifies', () => {
    expect([...IGNORED_DIRECTORY_NAMES]).toEqual([
      'node_modules',
      '.git',
      'dist',
      'build',
      'coverage',
      '.next',
      'out',
    ]);
  });

  it('contains no duplicates', () => {
    expect(new Set(IGNORED_DIRECTORY_NAMES).size).toBe(IGNORED_DIRECTORY_NAMES.length);
  });
});

describe('IGNORED_GLOB_PATTERNS', () => {
  it('derives one pattern per ignored name', () => {
    expect(IGNORED_GLOB_PATTERNS).toHaveLength(IGNORED_DIRECTORY_NAMES.length);
  });

  it('matches ignored directories at any depth', () => {
    expect(IGNORED_GLOB_PATTERNS).toContain('**/node_modules/**');
    expect(IGNORED_GLOB_PATTERNS).toContain('**/.next/**');
  });
});

describe('isIgnoredDirectoryName', () => {
  it.each(IGNORED_DIRECTORY_NAMES)('recognises %s', (name) => {
    expect(isIgnoredDirectoryName(name)).toBe(true);
  });

  it.each(['src', 'packages', 'distribution', 'outputs', 'node_modules_backup'])(
    'does not recognise %s',
    (name) => {
      expect(isIgnoredDirectoryName(name)).toBe(false);
    },
  );
});
