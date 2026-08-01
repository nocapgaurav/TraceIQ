import { describe, expect, it } from 'vitest';

import { deriveProfile, groupByDirectory, UNAVAILABLE } from '@/lib/repository-profile';
import { OVERVIEW } from '@/test/fixtures';
import type { Overview, PackageSummary, Role } from '@/types/api';

/**
 * The Repository Overview's derivation layer.
 *
 * These tests are mostly about restraint. The valuable assertions are not "it produced a sentence" but
 * "it refused to produce one" — a field that guesses is worse than a field that degrades, and the
 * degradation is the behaviour a future change is most likely to break by accident.
 */

function overviewWith(patch: {
  readonly packages?: readonly PackageSummary[];
  readonly roles?: Partial<Record<Role, number>>;
  readonly routes?: number;
  readonly environmentVariables?: number;
  readonly externalsByKind?: Readonly<Record<string, number>>;
}): Overview {
  return {
    ...OVERVIEW,
    repository: {
      ...OVERVIEW.repository,
      ...(patch.routes === undefined ? {} : { routes: patch.routes }),
      ...(patch.environmentVariables === undefined ? {} : { environmentVariables: patch.environmentVariables }),
      ...(patch.externalsByKind === undefined ? {} : { externalsByKind: patch.externalsByKind }),
    },
    architecture: {
      ...OVERVIEW.architecture,
      roleCounts: { ...OVERVIEW.architecture.roleCounts, ...patch.roles },
    },
    ...(patch.packages === undefined
      ? {}
      : { packages: { entries: patch.packages, total: patch.packages.length, truncated: false } }),
  };
}

function pkg(name: string, overrides: Partial<PackageSummary> = {}): PackageSummary {
  return { name, files: 1, declarations: 10, dependencies: 0, dependents: 0, ...overrides };
}

describe('deriveProfile', () => {
  it('never names the repository, because no endpoint reports one', () => {
    expect(deriveProfile(OVERVIEW).name).toBeNull();
  });

  it('never states a purpose, because structure does not carry one', () => {
    expect(deriveProfile(OVERVIEW).purpose).toBeNull();
  });

  it('describes the repository from counts alone', () => {
    const { description } = deriveProfile(OVERVIEW);

    expect(description.value).toContain('228 files');
    expect(description.value).toContain('3,148 declarations');
    expect(description.value).toContain('12,911 relationships');
    expect(description.evidence).toBe('counts reported by /overview');
  });

  it('is deterministic — the same payload derives the same profile', () => {
    expect(deriveProfile(OVERVIEW)).toEqual(deriveProfile(OVERVIEW));
  });

  it('reports the languages the scan counted, rather than assuming TypeScript', () => {
    // This replaced an assertion that the value was always exactly ['TypeScript'], with the evidence
    // "the analysis reads TypeScript projects only". Discovery became universal, and that made the
    // claim false — a Python repository was described to the reader as a TypeScript project.
    const { languages } = deriveProfile(OVERVIEW);

    expect(languages.value).toEqual(['TypeScript', 'Markdown']);
    expect(languages.evidence).toContain('by extension');
  });

  it('names a repository after whatever it is actually written in', () => {
    const python = overviewWith({});
    const profile = deriveProfile({
      ...python,
      capabilities: {
        depth: 'semantic',
        isPolyglot: false,
        languages: [{ language: 'python', files: 40 }],
        regions: [
          {
            path: '',
            primaryLanguage: 'python',
            languages: [{ language: 'python', files: 40 }],
            ecosystems: ['python'],
            fileCount: 40,
            sourceFileCount: 40,
            depth: 'semantic',
            reason: 'Python sources were parsed',
          },
        ],
      },
    });

    expect(profile.languages.value).toEqual(['Python']);
    expect(profile.shape.value).toContain('Python');
    expect(profile.shape.value).not.toContain('TypeScript');
  });

  it('calls a repository whose regions differ in language polyglot', () => {
    const base = overviewWith({});
    const profile = deriveProfile({
      ...base,
      capabilities: {
        depth: 'semantic',
        isPolyglot: true,
        languages: [
          { language: 'typescript', files: 30 },
          { language: 'python', files: 20 },
        ],
        regions: [
          {
            path: 'frontend',
            primaryLanguage: 'typescript',
            languages: [{ language: 'typescript', files: 30 }],
            ecosystems: ['npm'],
            fileCount: 30,
            sourceFileCount: 30,
            depth: 'semantic',
            reason: 'the TypeScript compiler read these sources',
          },
          {
            path: 'ml',
            primaryLanguage: 'python',
            languages: [{ language: 'python', files: 20 }],
            ecosystems: ['python'],
            fileCount: 20,
            sourceFileCount: 20,
            depth: 'semantic',
            reason: 'Python sources were parsed',
          },
        ],
      },
    });

    expect(profile.shape.value).toContain('polyglot');
    expect(profile.shape.value).toContain('TypeScript');
    expect(profile.shape.value).toContain('Python');
    expect(profile.languages.value).toEqual(['TypeScript', 'Python']);
  });

  describe('shape', () => {
    it('calls several packages across directories a monorepo', () => {
      const profile = deriveProfile(
        overviewWith({ packages: [pkg('apps/api'), pkg('apps/web'), pkg('packages/core')] }),
      );

      expect(profile.shape.value).toBe('TypeScript monorepo');
      expect(profile.shape.evidence).toContain('apps');
    });

    it('calls a single package a project', () => {
      expect(deriveProfile(overviewWith({ packages: [pkg('src')] })).shape.value).toBe('TypeScript project');
    });
  });

  describe('frameworks', () => {
    it('degrades when nothing was found, rather than guessing from package names', () => {
      const profile = deriveProfile({
        ...overviewWith({ routes: 0, environmentVariables: 0 }),
        technologies: [],
      });

      expect(profile.frameworks).toBeNull();
    });

    it('names the frameworks the API detected, and only those', () => {
      // This used to assert that *no* framework was named, because the API named none. It does
      // now — with the manifest entry or marker file that proves each — so the interface reports
      // the detection instead of paraphrasing its side effects.
      const profile = deriveProfile({
        ...overviewWith({ routes: 12, environmentVariables: 3 }),
        technologies: [
          {
            id: 'nextjs',
            name: 'Next.js',
            category: 'frontend',
            regionPath: 'apps/web',
            confidence: 'CERTAIN',
            evidence: "apps/web/package.json declares 'next'",
          },
          {
            id: 'vitest',
            name: 'Vitest',
            category: 'testing',
            regionPath: '',
            confidence: 'CERTAIN',
            evidence: "package.json declares 'vitest'",
          },
        ],
      });

      // The region is named beside the framework: in a monorepo, *which* project is Next.js is the
      // part a reader needs. A test runner is not what a reader means by "what is this built on",
      // so only frontend and backend reach this field.
      expect(profile.frameworks?.value).toEqual([
        'Next.js (apps/web)',
        'HTTP routing (12 routes registered)',
        'environment configuration (3 variables read)',
      ]);
      expect(profile.frameworks?.evidence).toMatch(/manifest entry or a marker file/);
    });

    it('still names nothing when the API detected no framework', () => {
      // The rule the old test guarded is intact: nothing is inferred in the browser. With no
      // detection the field reports outcomes only, exactly as before.
      const profile = deriveProfile({
        ...overviewWith({ routes: 12, environmentVariables: 0 }),
        technologies: [],
      });

      expect(profile.frameworks?.value).toEqual(['HTTP routing (12 routes registered)']);
      expect(JSON.stringify(profile.frameworks)).not.toMatch(/express|nest|fastify|next/i);
    });
  });

  describe('entry points', () => {
    it('degrades when no routes and no controllers were recorded', () => {
      expect(deriveProfile(overviewWith({ routes: 0, roles: { Controller: 0 } })).entryPoints).toBeNull();
    });

    it('reports routes and controllers where the analysis found them', () => {
      const profile = deriveProfile(overviewWith({ routes: 19, roles: { Controller: 4 } }));

      expect(profile.entryPoints?.value).toEqual(['19 HTTP routes', '4 controllers']);
    });
  });

  describe('architecture style', () => {
    it('names the layering roles that were annotated', () => {
      const profile = deriveProfile(
        overviewWith({
          packages: [pkg('apps/api'), pkg('apps/web'), pkg('packages/core')],
          roles: { Controller: 5, Service: 7, Repository: 3 },
        }),
      );

      expect(profile.architectureStyle?.value).toContain('controller, service and repository layering');
      expect(profile.architectureStyle?.evidence).toContain('5 Controller');
    });

    it('degrades for a single package with no layering roles', () => {
      const profile = deriveProfile(
        overviewWith({
          packages: [pkg('src')],
          roles: { Controller: 0, Service: 0, Repository: 0 },
        }),
      );

      expect(profile.architectureStyle).toBeNull();
    });
  });

  describe('main packages', () => {
    it('ranks by declarations and breaks ties by name, so the order never shuffles', () => {
      const profile = deriveProfile(
        overviewWith({
          packages: [
            pkg('b', { declarations: 5 }),
            pkg('a', { declarations: 5 }),
            pkg('c', { declarations: 90 }),
          ],
        }),
      );

      expect(profile.mainPackages.map((entry) => entry.name)).toEqual(['c', 'a', 'b']);
    });

    it('shows at most six', () => {
      const many = Array.from({ length: 20 }, (_, index) => pkg(`p${index}`, { declarations: index }));

      expect(deriveProfile(overviewWith({ packages: many })).mainPackages).toHaveLength(6);
    });
  });

  describe('stack', () => {
    it('counts packages across every ecosystem, naming the ecosystems only in the detail', () => {
      // `39 npm packages` and `Node.js` were the labels while npm was the only ecosystem the graph could
      // express. A Maven or Go dependency counted for nothing, and a Python standard-library module was
      // invisible — the kinds are `maven`, `go`, `python` and `stdlib` now.
      const profile = deriveProfile(
        overviewWith({ externalsByKind: { maven: 69, stdlib: 11 } }),
      );
      const labels = profile.stack.map((item) => item.label);

      expect(labels).toContain('69 packages');
      expect(labels).toContain('Standard library');
      expect(profile.stack.find((item) => item.label === '69 packages')?.detail).toContain('maven');
    });

    it('sums packages from several ecosystems in a polyglot repository', () => {
      const profile = deriveProfile(
        overviewWith({ externalsByKind: { npm: 36, go: 19, python: 12, node: 5 } }),
      );

      expect(profile.stack.map((item) => item.label)).toContain('67 packages');
    });

    it('omits the standard-library chip when no runtime module was imported', () => {
      const profile = deriveProfile(overviewWith({ externalsByKind: { npm: 2 } }));

      expect(profile.stack.map((item) => item.label)).not.toContain('Node.js');
    });
  });
});

describe('groupByDirectory', () => {
  it('groups packages by their first path segment', () => {
    const groups = groupByDirectory([
      pkg('apps/api', { files: 2, declarations: 20 }),
      pkg('apps/web', { files: 3, declarations: 30 }),
      pkg('packages/core', { files: 1, declarations: 5 }),
    ]);

    expect(groups).toEqual([
      { name: 'apps', packages: 2, files: 5, declarations: 50 },
      { name: 'packages', packages: 1, files: 1, declarations: 5 },
    ]);
  });

  it('puts a package with no separator at the repository root', () => {
    // Real payloads contain these: a root-level file such as `vitest.config.ts` becomes its own package.
    expect(groupByDirectory([pkg('vitest.config.ts')])[0]?.name).toBe('repository root');
  });

  it('orders by declarations then name, so the same input always renders the same way', () => {
    const groups = groupByDirectory([
      pkg('z/one', { declarations: 5 }),
      pkg('a/one', { declarations: 5 }),
      pkg('m/one', { declarations: 50 }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['m', 'a', 'z']);
  });

  it('returns nothing for no packages', () => {
    expect(groupByDirectory([])).toEqual([]);
  });
});

describe('UNAVAILABLE', () => {
  it('is the single wording every gap uses', () => {
    expect(UNAVAILABLE).toBe('Available after Repository Intelligence generation.');
  });
});
