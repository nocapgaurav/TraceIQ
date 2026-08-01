import { describe, expect, it } from 'vitest';

import { languageOf, manifestEcosystemOf, roleOf } from './languages.js';

const role = (path: string) => roleOf(path, languageOf(path));

describe('language by extension', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.tsx', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/a.js', 'javascript'],
    ['src/a.mjs', 'javascript'],
    ['app/main.py', 'python'],
    ['Main.java', 'java'],
    ['Main.kt', 'kotlin'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['a.c', 'c'],
    ['a.cpp', 'cpp'],
    ['A.cs', 'csharp'],
    ['index.php', 'php'],
    ['app.rb', 'ruby'],
    ['README.md', 'markdown'],
    ['config.yaml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['main.tf', 'terraform'],
  ])('reads %s as %s', (path, expected) => {
    expect(languageOf(path)).toBe(expected);
  });

  it('recognises files identified by name rather than extension', () => {
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('Makefile')).toBe('make');
    expect(languageOf('Gemfile')).toBe('ruby');
  });

  it('recognises a suffixed or prefixed Dockerfile', () => {
    expect(languageOf('Dockerfile.prod')).toBe('dockerfile');
    expect(languageOf('api.dockerfile')).toBe('dockerfile');
  });

  it('is case-insensitive about the name', () => {
    expect(languageOf('DOCKERFILE')).toBe('dockerfile');
    expect(languageOf('src/A.TS')).toBe('typescript');
  });

  it('reports null rather than guessing for an unrecognised file', () => {
    // `null` is a real answer and is kept as one: a binary or a licence has no language,
    // and inventing one would put fiction into the language distribution.
    expect(languageOf('LICENSE')).toBeNull();
    expect(languageOf('logo.png')).toBeNull();
    expect(languageOf('data.bin')).toBeNull();
  });
});

describe('role by convention', () => {
  it('classifies a manifest ahead of its language', () => {
    // package.json is JSON, but calling it configuration would lose what makes it a
    // manifest.
    expect(role('package.json')).toBe('manifest');
    expect(role('pyproject.toml')).toBe('manifest');
    expect(role('go.mod')).toBe('manifest');
  });

  it('classifies a lockfile and a build script as build', () => {
    expect(role('pnpm-lock.yaml')).toBe('build');
    expect(role('Makefile')).toBe('build');
    expect(role('build.gradle')).toBe('manifest');
  });

  it('classifies containers and provisioning as infrastructure', () => {
    expect(role('Dockerfile')).toBe('infrastructure');
    expect(role('docker-compose.yml')).toBe('infrastructure');
    expect(role('infrastructure/main.tf')).toBe('infrastructure');
    expect(role('k8s/deployment.yaml')).toBe('infrastructure');
  });

  it('classifies a test by its directory or its name', () => {
    expect(role('tests/test_main.py')).toBe('test');
    expect(role('src/__tests__/a.ts')).toBe('test');
    expect(role('src/a.test.ts')).toBe('test');
    expect(role('src/a.spec.ts')).toBe('test');
    expect(role('pkg/thing_test.go')).toBe('test');
    expect(role('tests/conftest.py')).toBe('test');
  });

  it('prefers a filename signal over the directory it sits in', () => {
    // Naming a Dockerfile is stronger evidence than the folder holding it.
    expect(role('docs/Dockerfile')).toBe('infrastructure');
  });

  it('prefers a test directory over the language being a source language', () => {
    expect(role('tests/helper.py')).toBe('test');
  });

  it('classifies documentation by language and by directory', () => {
    expect(role('README.md')).toBe('documentation');
    expect(role('docs/guide.rst')).toBe('documentation');
    expect(role('docs/notes.txt')).toBe('documentation');
  });

  it('classifies describing languages as configuration', () => {
    expect(role('config.yaml')).toBe('configuration');
    expect(role('settings.json')).toBe('configuration');
    expect(role('app.xml')).toBe('configuration');
  });

  it('keeps SQL as source rather than grouping it with configuration', () => {
    // A schema or a migration is closer to source than to config, and grouping it with
    // YAML would hide it.
    expect(role('migrations/001_init.sql')).toBe('source');
  });

  it('classifies a programming language outside any convention as source', () => {
    expect(role('src/index.ts')).toBe('source');
    expect(role('app/main.py')).toBe('source');
    expect(role('cmd/server/main.go')).toBe('source');
  });

  it('classifies a file with no recognised language as other', () => {
    expect(role('LICENSE')).toBe('other');
    expect(role('logo.png')).toBe('other');
  });
});

describe('manifest ecosystems', () => {
  it.each([
    ['package.json', 'npm'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['pom.xml', 'maven'],
    ['build.gradle', 'gradle'],
    ['build.gradle.kts', 'gradle'],
    ['go.mod', 'go'],
    ['Cargo.toml', 'cargo'],
    ['composer.json', 'composer'],
    ['Gemfile', 'bundler'],
  ])('maps %s to %s', (name, expected) => {
    expect(manifestEcosystemOf(name)).toBe(expected);
  });

  it('recognises a nested manifest by its basename', () => {
    expect(manifestEcosystemOf('services/api/go.mod')).toBe('go');
  });

  it('recognises a .NET project file by its extension', () => {
    expect(manifestEcosystemOf('src/Api.csproj')).toBe('nuget');
  });

  it('reports null for a file that is not a manifest', () => {
    expect(manifestEcosystemOf('src/index.ts')).toBeNull();
    expect(manifestEcosystemOf('package-lock.json')).toBeNull();
  });
});
