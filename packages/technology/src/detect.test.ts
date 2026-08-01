import type { ManifestFile, RepositoryFile, TechnologyRegion } from '@traceiq/scanner';
import { describe, expect, it } from 'vitest';

import { detectTechnologies } from './detect.js';
import type { DetectedTechnology } from './types.js';

/**
 * Technology detection, against the rule that governs the whole layer: **no claim without
 * evidence**. Every case here asserts what was found *and* what proves it, because a framework
 * badge a reader cannot check is indistinguishable from a guess.
 *
 * The negative cases matter at least as much. A `.yaml` file is not Kubernetes, a note mentioning
 * Terraform is not Terraform, and a package called `expressive` is not Express.
 */
const file = (path: string, language: string | null = null): RepositoryFile => ({
  path,
  language: language as RepositoryFile['language'],
  role: 'source',
  bytes: 10,
});

const manifest = (
  path: string,
  dependencies: readonly string[],
  declaredName: string | null = null,
): ManifestFile => ({
  path,
  ecosystem: 'npm',
  declaredName,
  declaredDependencies: [...dependencies],
});

const region = (path: string, over: Partial<TechnologyRegion> = {}): TechnologyRegion => ({
  path,
  manifests: [],
  ecosystems: [],
  languages: [],
  primaryLanguage: null,
  fileCount: 1,
  sourceFileCount: 1,
  ...over,
});

const detect = async (input: {
  files?: readonly RepositoryFile[];
  manifests?: readonly ManifestFile[];
  regions?: readonly TechnologyRegion[];
  contents?: Readonly<Record<string, string>>;
}) =>
  detectTechnologies({
    files: input.files ?? [],
    manifests: input.manifests ?? [],
    regions: input.regions ?? [region('')],
    readFile: async (path) => input.contents?.[path] ?? null,
  });

const idsIn = (technologies: readonly DetectedTechnology[], regionPath = ''): readonly string[] =>
  technologies.filter((entry) => entry.regionPath === regionPath).map((entry) => entry.id);

describe('declared dependencies', () => {
  it('detects a framework a manifest declares, and names the entry that proves it', async () => {
    const { technologies } = await detect({
      manifests: [manifest('package.json', ['next', 'react', 'react-dom'])],
    });

    const next = technologies.find((entry) => entry.id === 'nextjs');

    expect(next).toMatchObject({ name: 'Next.js', category: 'frontend', confidence: 'CERTAIN' });
    expect(next?.evidence).toEqual([{ path: 'package.json', detail: "declares 'next'" }]);

    // One technology, not two, for a framework shipped as several packages.
    expect(technologies.find((entry) => entry.id === 'react')?.evidence).toEqual([
      { path: 'package.json', detail: "declares 'react', 'react-dom'" },
    ]);
  });

  it('matches a distribution name exactly, never as a substring', async () => {
    // `expressive` is not Express, and `react-native-web` is not React. A prefix match would claim
    // both, and a reader checking the evidence would find the claim was never in the file.
    const { technologies } = await detect({
      manifests: [manifest('package.json', ['expressive', 'preact', 'not-nextjs'])],
    });

    expect(technologies.map((entry) => entry.id)).toEqual([]);
  });

  it("detects a framework from the manifest's own name, which its repository never declares", async () => {
    // nestjs/nest does not depend on `@nestjs/core` — it *is* `@nestjs/core`. Before this rule,
    // scanning a framework's own repository found every framework it uses and not the one it is.
    const { technologies } = await detect({
      regions: [region(''), region('packages/core')],
      manifests: [
        manifest('package.json', ['jest']),
        manifest('packages/core/package.json', [], '@nestjs/core'),
      ],
    });

    const nest = technologies.find((entry) => entry.id === 'nestjs');

    expect(nest).toMatchObject({ regionPath: 'packages/core', confidence: 'CERTAIN' });
    expect(nest?.evidence).toEqual([
      { path: 'packages/core/package.json', detail: "is the package '@nestjs/core'" },
    ]);
  });

  it('recognises a backend framework in an ecosystem other than npm', async () => {
    const { technologies } = await detect({
      manifests: [
        {
          path: 'go.mod',
          ecosystem: 'go',
          declaredName: 'example.com/app',
          declaredDependencies: ['github.com/gin-gonic/gin'],
        },
      ],
    });

    expect(technologies).toMatchObject([{ id: 'gin', name: 'Gin', category: 'backend' }]);
  });

  it('matches a Maven coordinate against a rule that names the artifact', async () => {
    // Found in the product: spring-petclinic reported *no framework* while its `pom.xml` declared
    // `spring-boot-starter-web` on one line. A `pom.xml` is read as `group:artifact`, the rule was
    // written as the bare artifact npm-style, and the two spellings never met — so evidence that
    // was present and parsed named nothing.
    const { technologies } = await detect({
      manifests: [
        {
          path: 'pom.xml',
          ecosystem: 'maven',
          declaredName: 'org.springframework.samples:spring-petclinic',
          declaredDependencies: [
            'org.springframework.boot:spring-boot-starter-web',
            'org.springframework.boot:spring-boot-starter-data-jpa',
          ],
        },
      ],
    });

    expect(technologies).toMatchObject([
      { id: 'spring-boot', name: 'Spring Boot', category: 'backend', confidence: 'CERTAIN' },
    ]);
    expect(technologies[0]?.evidence).toEqual([
      {
        path: 'pom.xml',
        detail: "declares 'spring-boot-starter-web', 'spring-boot-starter-data-jpa'",
      },
    ]);
  });

  it('recognises a starter the exact-name rule never listed', async () => {
    // The rest of the same bug. spring-petclinic declares `spring-boot-starter-webmvc`,
    // `-actuator`, `-cache`, `-thymeleaf`, `-validation` and `-data-jpa` — and not one of the two
    // names the rule listed. Spring publishes dozens of starters and a repository takes the ones it
    // needs, so a family is the only reading that holds.
    const { technologies } = await detect({
      manifests: [
        {
          path: 'pom.xml',
          ecosystem: 'maven',
          declaredName: null,
          declaredDependencies: [
            'org.springframework.boot:spring-boot-starter-webmvc',
            'org.springframework.boot:spring-boot-starter-actuator',
          ],
        },
      ],
    });

    expect(technologies).toMatchObject([{ id: 'spring-boot', name: 'Spring Boot' }]);
    expect(technologies[0]?.evidence[0]?.detail).toBe(
      "declares 'spring-boot-starter-webmvc', 'spring-boot-starter-actuator'",
    );
  });

  it('does not let a prefix match something that merely contains it', async () => {
    const { technologies } = await detect({
      manifests: [manifest('package.json', ['my-spring-boot-starter-notes'])],
    });

    expect(technologies).toEqual([]);
  });

  it('matches a Gradle coordinate the same way', async () => {
    const { technologies } = await detect({
      manifests: [
        {
          path: 'build.gradle',
          ecosystem: 'gradle',
          declaredName: null,
          declaredDependencies: ['org.springframework.boot:spring-boot-starter'],
        },
      ],
    });

    expect(technologies).toMatchObject([{ id: 'spring-boot', name: 'Spring Boot' }]);
  });

  it('does not read a coordinate’s group as a package name', async () => {
    // Only the artifact half is compared. Matching the group too would let one vendor's namespace
    // stand in for any of its products.
    const { technologies } = await detect({
      manifests: [
        {
          path: 'pom.xml',
          ecosystem: 'maven',
          declaredName: null,
          declaredDependencies: ['spring-boot-starter-web:something-else'],
        },
      ],
    });

    expect(technologies).toEqual([]);
  });
});

describe('marker files', () => {
  it('detects Docker, Compose and Terraform from the files that define them', async () => {
    const { technologies } = await detect({
      files: [file('Dockerfile'), file('docker-compose.yml'), file('infra/main.tf')],
    });

    expect([...idsIn(technologies)].sort()).toEqual(['docker', 'docker-compose', 'terraform']);
    expect(technologies.every((entry) => entry.confidence === 'CERTAIN')).toBe(true);
  });

  it('detects a Dockerfile however it is named', async () => {
    const { technologies } = await detect({
      files: [file('api.Dockerfile'), file('Dockerfile.production')],
    });

    expect(technologies.find((entry) => entry.id === 'docker')?.evidence).toEqual([
      { path: 'api.Dockerfile', detail: 'a Dockerfile' },
      { path: 'Dockerfile.production', detail: 'a Dockerfile' },
    ]);
  });

  it('does not read a mention of a technology as the technology', async () => {
    // A note *about* Terraform is not a Terraform configuration.
    const { technologies } = await detect({
      files: [file('docs/terraform-notes.md'), file('scripts/dockerfile-tips.txt')],
    });

    expect(technologies).toEqual([]);
  });

  it('claims a GitHub workflow only inside the directory that makes it one', async () => {
    const { technologies } = await detect({
      files: [file('.github/workflows/ci.yml'), file('config/settings.yml')],
    });

    expect(idsIn(technologies)).toEqual(['github-actions']);
    expect(technologies[0]?.evidence).toEqual([
      { path: '.github/workflows/ci.yml', detail: 'a workflow definition' },
    ]);
  });
});

describe('Kubernetes, which needs the file itself', () => {
  it('detects a manifest that declares apiVersion and kind', async () => {
    const { technologies } = await detect({
      files: [file('k8s/deployment.yaml')],
      contents: {
        'k8s/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n',
      },
    });

    expect(technologies).toMatchObject([
      { id: 'kubernetes', name: 'Kubernetes', category: 'infrastructure', confidence: 'CERTAIN' },
    ]);
  });

  it('does not claim Kubernetes from an ordinary YAML file', async () => {
    // The whole reason this one detection reads contents: `.yaml` is the extension of every
    // configuration file ever written, and the extension proves nothing.
    const { technologies } = await detect({
      files: [file('config/app.yaml'), file('.github/workflows/ci.yml')],
      contents: {
        'config/app.yaml': 'server:\n  port: 8080\n',
        '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu\n',
      },
    });

    expect(technologies.some((entry) => entry.id === 'kubernetes')).toBe(false);
  });

  it('reads no file at all when the caller supplies no reader', async () => {
    const { technologies } = await detectTechnologies({
      files: [file('k8s/deployment.yaml')],
      manifests: [],
      regions: [region('')],
    });

    expect(technologies).toEqual([]);
  });
});

describe('confidence', () => {
  it('is certain from a file whose type the technology owns exclusively', async () => {
    // `.vue` *is* a Vue component. Rating this below a manifest entry would be inventing a
    // distinction the evidence does not support — see `DetectedTechnology.confidence`.
    const { technologies } = await detect({ files: [file('src/App.vue')] });

    expect(technologies).toMatchObject([{ id: 'vue', confidence: 'CERTAIN' }]);
  });

  it('accumulates every proof when a technology is found more than one way', async () => {
    const { technologies } = await detect({
      files: [file('src/App.vue')],
      manifests: [manifest('package.json', ['vue'])],
    });

    const vue = technologies.find((entry) => entry.id === 'vue');

    expect(vue?.confidence).toBe('CERTAIN');
    expect(vue?.evidence).toEqual([
      { path: 'package.json', detail: "declares 'vue'" },
      { path: 'src/App.vue', detail: 'a Vue single-file component' },
    ]);
  });
});

describe('regions', () => {
  it('attributes a technology to the region that holds it, not to the repository', async () => {
    // The case that makes this useful: a monorepo where one app is Next.js and another is NestJS.
    // Reporting both against the repository loses the only part an architecture view needs.
    const { technologies } = await detect({
      regions: [region(''), region('apps/web'), region('apps/api')],
      manifests: [
        manifest('package.json', ['turbo']),
        manifest('apps/web/package.json', ['next']),
        manifest('apps/api/package.json', ['@nestjs/core']),
      ],
    });

    expect(idsIn(technologies, '')).toEqual(['turborepo']);
    expect(idsIn(technologies, 'apps/web')).toEqual(['nextjs']);
    expect(idsIn(technologies, 'apps/api')).toEqual(['nestjs']);
  });

  it('does not let a nested package inherit the root, or the root a nested package', async () => {
    const { technologies } = await detect({
      regions: [region(''), region('packages/ui')],
      files: [file('Dockerfile'), file('packages/ui/src/Button.vue')],
    });

    expect(idsIn(technologies, '')).toEqual(['docker']);
    expect(idsIn(technologies, 'packages/ui')).toEqual(['vue']);
  });
});

describe('determinism', () => {
  it('produces byte-identical output from identical input', async () => {
    const input = {
      files: [file('src/b.vue'), file('src/a.vue'), file('Dockerfile')],
      manifests: [manifest('package.json', ['vue', 'vite'])],
    };

    expect(JSON.stringify(await detect(input))).toBe(JSON.stringify(await detect(input)));
  });
});

/**
 * Region classification — the architecture layer.
 *
 * Derived rather than declared: no repository states that `apps/web` is an application. What it
 * states is a Next.js dependency, and the shape follows. Every classification carries the reason,
 * so a reader who disagrees can see exactly what was followed.
 */
describe('architecture', () => {
  const architectureOf = async (input: Parameters<typeof detect>[0], path = '') =>
    (await detect(input)).architecture.find((entry) => entry.path === path);

  it('reads a region with a frontend framework as an application', async () => {
    const entry = await architectureOf({ manifests: [manifest('package.json', ['next'])] });

    expect(entry).toMatchObject({ kind: 'application', confidence: 'CERTAIN' });
    expect(entry?.reason).toContain('Next.js');
  });

  it('reads a region with a backend framework as a service', async () => {
    const entry = await architectureOf({ manifests: [manifest('package.json', ['fastify'])] });

    expect(entry).toMatchObject({ kind: 'service', confidence: 'CERTAIN' });
    expect(entry?.reason).toContain('serves requests');
  });

  it('prefers the frontend reading when a region is both', async () => {
    // A Next.js app with API routes is still the thing a user opens. Both technologies are
    // reported; the *kind* takes the most specific answer to "what is this for".
    const entry = await architectureOf({
      manifests: [manifest('package.json', ['next', 'express'])],
    });

    expect(entry?.kind).toBe('application');
    expect(entry?.technologies.map((technology) => technology.id).sort()).toEqual([
      'express',
      'nextjs',
    ]);
  });

  it('reads a manifest with source and no framework as a library', async () => {
    const entry = await architectureOf({
      manifests: [manifest('packages/ui/package.json', ['typescript'])],
      regions: [region('packages/ui', { sourceFileCount: 12 })],
      files: [file('packages/ui/src/index.ts', 'typescript')],
    }, 'packages/ui');

    // INFERRED, not CERTAIN: nothing in the repository *says* this is a library. The reading rests
    // on a convention about layout, which is what INFERRED means everywhere else in this project.
    expect(entry).toMatchObject({ kind: 'library', confidence: 'INFERRED' });
  });

  it('reads a region of deployment files with no code as infrastructure', async () => {
    const entry = await architectureOf({
      files: [file('deploy/main.tf'), file('deploy/Dockerfile')],
      regions: [region('deploy', { sourceFileCount: 0 })],
    }, 'deploy');

    expect(entry).toMatchObject({ kind: 'infrastructure', confidence: 'CERTAIN' });
  });

  it('does not call an application region infrastructure because it has a Dockerfile', async () => {
    // Almost every deployable application carries one. Checking infrastructure before code would
    // reclassify the entire repository.
    const entry = await architectureOf({
      manifests: [manifest('package.json', ['react'])],
      files: [file('Dockerfile')],
    });

    expect(entry?.kind).toBe('application');
  });

  it('says it does not know rather than guessing', async () => {
    const entry = await architectureOf({
      files: [file('docs/readme.md')],
      regions: [region('docs', { sourceFileCount: 0, fileCount: 1 })],
    }, 'docs');

    expect(entry).toMatchObject({ kind: 'unknown' });
    expect(entry?.reason).toContain('nothing in this region says what it is');
  });

  it('classifies each region of a monorepo on its own evidence', async () => {
    const { architecture } = await detect({
      regions: [
        region('', { sourceFileCount: 0 }),
        region('apps/web'),
        region('apps/api'),
        region('packages/shared'),
      ],
      manifests: [
        manifest('package.json', ['turbo']),
        manifest('apps/web/package.json', ['react']),
        manifest('apps/api/package.json', ['@nestjs/core']),
        manifest('packages/shared/package.json', []),
      ],
    });

    expect(architecture.map((entry) => [entry.path, entry.kind])).toEqual([
      ['', 'tooling'],
      ['apps/web', 'application'],
      ['apps/api', 'service'],
      ['packages/shared', 'library'],
    ]);
  });
});
