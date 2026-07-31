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

  it('claims TypeScript as a property of the analysis, not as a detection', () => {
    const { languages } = deriveProfile(OVERVIEW);

    expect(languages.value).toEqual(['TypeScript']);
    expect(languages.evidence).toContain('reads TypeScript projects only');
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
    it('degrades when nothing was extracted, rather than guessing from package names', () => {
      const profile = deriveProfile(overviewWith({ routes: 0, environmentVariables: 0 }));

      expect(profile.frameworks).toBeNull();
    });

    it('reports what extraction found, without naming the framework', () => {
      const profile = deriveProfile(overviewWith({ routes: 12, environmentVariables: 3 }));

      expect(profile.frameworks?.value).toEqual([
        'HTTP routing (12 routes registered)',
        'environment configuration (3 variables read)',
      ]);
      // The point of the whole field: no framework is named, because the API never names one.
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
    it('counts npm packages without naming them', () => {
      const profile = deriveProfile(overviewWith({ externalsByKind: { npm: 39, node: 5 } }));
      const labels = profile.stack.map((item) => item.label);

      expect(labels).toContain('39 npm packages');
      expect(labels).toContain('Node.js');
    });

    it('omits Node.js when no runtime module was imported', () => {
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
