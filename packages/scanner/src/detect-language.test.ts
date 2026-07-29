import { describe, expect, it } from 'vitest';

import { detectLanguage } from './detect-language.js';

describe('detectLanguage', () => {
  it('reports TypeScript when sources were discovered', () => {
    expect(detectLanguage({ hasTsconfig: false, sourceFileCount: 3 })).toBe('typescript');
  });

  it('reports TypeScript for a configured repository with no sources yet', () => {
    expect(detectLanguage({ hasTsconfig: true, sourceFileCount: 0 })).toBe('typescript');
  });

  it('reports TypeScript when both signals are present', () => {
    expect(detectLanguage({ hasTsconfig: true, sourceFileCount: 12 })).toBe('typescript');
  });

  it('reports unknown when neither signal is present', () => {
    expect(detectLanguage({ hasTsconfig: false, sourceFileCount: 0 })).toBe('unknown');
  });
});
