import { describe, expect, it } from 'vitest';

import { deriveIdentity } from './repository-identity';
import { OVERVIEW } from '@/test/fixtures';
import type { Overview } from '@/types/api';

/**
 * The repository identity header.
 *
 * **These exist because there was no test here and a real bug shipped through the gap.** The header
 * derived its Language field as the constant `'TypeScript'` and its Framework field as the constant
 * `'Express'`, both with sound-sounding evidence strings. Every unit test passed, the whole suite was
 * green, and opening the page against a Spring Boot repository showed "LANGUAGE: TypeScript /
 * FRAMEWORK: Express" above a paragraph that correctly called it a Java monorepo.
 *
 * The lesson worth encoding: a field derived from a constant needs a test that changes the input.
 */
const field = (overview: Overview, label: string) =>
  deriveIdentity(null, overview).fields.find((entry) => entry.label === label);

const withCapabilities = (overview: Overview, capabilities: Overview['capabilities']): Overview => ({
  ...overview,
  capabilities,
});

const singleLanguage = (language: string, files: number): Overview['capabilities'] => ({
  depth: 'semantic',
  isPolyglot: false,
  languages: [{ language, files }],
  regions: [
    {
      path: '',
      primaryLanguage: language,
      languages: [{ language, files }],
      ecosystems: [],
      fileCount: files,
      sourceFileCount: files,
      depth: 'semantic',
      reason: 'parsed',
    },
  ],
});

describe('language', () => {
  it('names the dominant language the scan counted', () => {
    expect(field(withCapabilities(OVERVIEW, singleLanguage('java', 49)), 'Language')?.value).toBe('Java');
    expect(field(withCapabilities(OVERVIEW, singleLanguage('go', 99)), 'Language')?.value).toBe('Go');
    expect(field(withCapabilities(OVERVIEW, singleLanguage('python', 83)), 'Language')?.value).toBe(
      'Python',
    );
    expect(field(withCapabilities(OVERVIEW, singleLanguage('javascript', 141)), 'Language')?.value).toBe(
      'JavaScript',
    );
  });

  it('never reports TypeScript for a repository that holds none', () => {
    const identity = deriveIdentity(null, withCapabilities(OVERVIEW, singleLanguage('java', 49)));

    expect(JSON.stringify(identity)).not.toContain('TypeScript');
  });

  it('names the runners-up in the evidence rather than hiding them', () => {
    const overview = withCapabilities(OVERVIEW, {
      depth: 'semantic',
      isPolyglot: true,
      languages: [
        { language: 'python', files: 487 },
        { language: 'typescript', files: 303 },
        { language: 'javascript', files: 184 },
      ],
      regions: [],
    });

    const language = field(overview, 'Language');

    expect(language?.value).toBe('Python');
    expect(language?.evidence).toContain('TypeScript');
    expect(language?.evidence).toContain('JavaScript');
  });

  it('names the language an analyser read, not the commonest extension', () => {
    // Flask: 85 markdown files against 83 Python ones. The header said `Markdown`, directly above a
    // paragraph correctly calling it a Python project and beside a card explaining what the *Python*
    // analyser had found. A file count is not a statement about what a repository is written in.
    const overview = withCapabilities(OVERVIEW, {
      depth: 'framework',
      isPolyglot: true,
      languages: [
        { language: 'markdown', files: 85 },
        { language: 'python', files: 83 },
        { language: 'html', files: 20 },
      ],
      regions: [
        {
          path: '',
          primaryLanguage: 'python',
          languages: [{ language: 'python', files: 83 }],
          ecosystems: ['python'],
          fileCount: 188,
          sourceFileCount: 83,
          depth: 'framework',
          reason: 'Python sources were parsed',
        },
      ],
    });

    expect(field(overview, 'Language')?.value).toBe('Python');
    expect(field(overview, 'Language')?.evidence).toContain('the language an analyser read');
  });

  it('falls back to the commonest extension when no analyser covered anything', () => {
    // A documentation repository. Nothing was analysed, so nothing can be claimed beyond what the
    // extensions say — and saying that is better than saying nothing.
    const overview = withCapabilities(OVERVIEW, {
      depth: 'universal',
      isPolyglot: false,
      languages: [
        { language: 'markdown', files: 40 },
        { language: 'yaml', files: 3 },
      ],
      regions: [
        {
          path: '',
          primaryLanguage: 'markdown',
          languages: [{ language: 'markdown', files: 40 }],
          ecosystems: [],
          fileCount: 43,
          sourceFileCount: 0,
          depth: 'universal',
          reason: 'no analyser covered these files',
        },
      ],
    });

    expect(field(overview, 'Language')?.value).toBe('Markdown');
    expect(field(overview, 'Language')?.evidence).toContain('by extension');
  });

  it('reports the language as unrecorded when the scan counted none', () => {
    const overview = withCapabilities(OVERVIEW, {
      depth: 'universal',
      isPolyglot: false,
      languages: [],
      regions: [],
    });

    expect(field(overview, 'Language')).toBeUndefined();
    expect(deriveIdentity(null, overview).unknown).toContain('Language');
  });
});

describe('HTTP routing', () => {
  it('states the outcome of framework extraction without naming a framework', () => {
    // Extraction now reads Express, Flask, FastAPI, Spring, Jakarta and four Go routers. Naming one from
    // the route count alone would be a coin toss, and it labelled Spring as Express.
    // The shared fixture records no routes, so the field is correctly absent there; this states one.
    const withRoutes: Overview = { ...OVERVIEW, repository: { ...OVERVIEW.repository, routes: 16 } };
    const routing = field(withRoutes, 'HTTP routing');

    expect(routing?.value).toMatch(/routes?$/);
    expect(JSON.stringify(routing)).not.toContain('Express');
  });

  it('degrades rather than claiming none when no route was recorded', () => {
    const overview: Overview = {
      ...OVERVIEW,
      repository: { ...OVERVIEW.repository, routes: 0 },
    };

    expect(field(overview, 'HTTP routing')).toBeUndefined();
    expect(deriveIdentity(null, overview).unknown).toContain('HTTP routing');
  });
});
