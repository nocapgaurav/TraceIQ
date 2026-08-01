import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { meetsDepth } from '@traceiq/graph-api';
import { afterEach, describe, expect, it } from 'vitest';

import type { LanguageAnalyzer } from '@traceiq/analyzer';
import { fileId, symbolId } from '@traceiq/shared';

import { EmptyRepositoryError, RepositoryPipeline } from './repository-pipeline.js';
import { TypeScriptAnalyzer } from './typescript-analyzer.js';
import type { ScanSummary } from './types.js';

/**
 * The repository shapes this milestone exists to accept.
 *
 * Every case runs the **real** pipeline over a real directory: the real scanner, the real
 * graph builder, the real SQLite store. A repository is described by what a scan actually
 * produced, and a fake would only prove the wiring calls something.
 *
 * The assertions are deliberately about *capability* as much as about counts. A Python
 * repository that scans but silently claims semantic analysis would pass a count-only test
 * and be exactly the failure this milestone is meant to prevent.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-'));

  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }

  return root;
}

/** Scans into a database outside the repository, so nothing describes its own output. */
async function scan(files: Readonly<Record<string, string>>): Promise<ScanSummary> {
  const root = await repository(files);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

  roots.push(databaseDirectory);

  return new RepositoryPipeline().scan({
    repositoryPath: root,
    databasePath: path.join(databaseDirectory, 'graph.db'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });
}

describe('CASE 2 — a JavaScript repository', () => {
  const FILES = {
    'package.json': '{"name":"js-app","dependencies":{"express":"^4.18.0"}}',
    'src/index.js': "const express = require('express');\nmodule.exports = express();\n",
    'README.md': '# JS App\n',
  };

  it('is accepted, and described', async () => {
    const summary = await scan(FILES);

    expect(summary.files).toBe(3);
    expect(summary.regions).toBe(1);
  });

  it('reports its languages, including the ones nothing can analyse', async () => {
    const summary = await scan(FILES);

    expect(summary.languages).toEqual(
      expect.arrayContaining([
        { language: 'javascript', files: 1 },
        { language: 'json', files: 1 },
        { language: 'markdown', files: 1 },
      ]),
    );
  });

  it('reads the dependency its manifest declares', async () => {
    const summary = await scan(FILES);

    expect(summary.manifests).toBe(1);
    expect(summary.declaredDependencies).toBe(1);
  });

  it('reaches semantic depth, the compiler reading JavaScript natively', async () => {
    // JavaScript is analysed by the same compiler as TypeScript under `allowJs`, so it gets
    // declarations, imports, exports and checker-resolved calls rather than discovery alone.
    const summary = await scan(FILES);

    expect(summary.depth).toBe('semantic');
    expect(summary.declarations).toBeGreaterThan(0);
  });

  it('records the CommonJS module it could not resolve, rather than dropping it', async () => {
    // `express` is declared in the manifest but not installed in the fixture, so the require
    // cannot bind to a package. The reference is still reported — an unresolvable import is a
    // fact about the repository, not an absence.
    const summary = await scan(FILES);

    expect(summary.unresolvedReferences).toBeGreaterThan(0);
  });
});

describe('CASE 3 — a Python repository', () => {
  const FILES = {
    'pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi", "pydantic>=2"]\n',
    'src/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'tests/test_main.py': 'def test_app():\n    assert True\n',
    'README.md': '# API\n',
  };

  it('is accepted, and described', async () => {
    const summary = await scan(FILES);

    expect(summary.files).toBe(4);
    expect(summary.languages).toEqual(
      expect.arrayContaining([{ language: 'python', files: 2 }]),
    );
  });

  it('reads the dependencies pyproject.toml declares', async () => {
    const summary = await scan(FILES);

    expect(summary.declaredDependencies).toBe(2);
  });

  it('parses its modules into declarations', async () => {
    const summary = await scan(FILES);

    expect(summary.declarations).toBeGreaterThan(0);
    expect(summary.depth).toBe('semantic');
  });

  it('does not claim its calls are proven, Python binding names at runtime', async () => {
    // Every Python call edge is INFERRED. Nothing here may read RESOLVED: that level is reserved
    // for a binding a type checker established, and Python offers no such guarantee.
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    const session = pipeline.open(databasePath);

    try {
      for (const edge of session.api.getEdges('CALLS')) {
        expect(edge.confidence).toBe('INFERRED');
      }
    } finally {
      session.close();
    }
  });
});

describe('CASE 4 — a Java repository', () => {
  const FILES = {
    'pom.xml':
      '<project><artifactId>svc</artifactId><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency></dependencies></project>\n',
    'src/main/java/com/example/Main.java':
      'package com.example;\npublic class Main { public static void main(String[] a) {} }\n',
    'README.md': '# Service\n',
  };

  it('is accepted, and reports Maven as its ecosystem', async () => {
    const summary = await scan(FILES);

    expect(summary.files).toBe(3);
    expect(summary.manifests).toBe(1);
    expect(summary.declaredDependencies).toBe(1);
  });

  it('reaches semantic depth, Java now having an analyser', async () => {
    const summary = await scan(FILES);

    expect(summary.depth).toBe('semantic');
    expect(summary.declarations).toBeGreaterThan(0);
  });

  it('does not claim its calls are proven, Java dispatching at runtime', async () => {
    // Every Java call edge is INFERRED. Nothing here may read RESOLVED: a field declared as an
    // interface may hold any implementation, and which one runs is decided at runtime.
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    const session = pipeline.open(databasePath);

    try {
      for (const edge of session.api.getEdges('CALLS')) {
        expect(edge.confidence).toBe('INFERRED');
      }
    } finally {
      session.close();
    }
  });
});

describe('CASE 5 — a polyglot repository', () => {
  const FILES = {
    'frontend/package.json': '{"name":"frontend","dependencies":{"react":"^19.0.0"}}',
    'frontend/src/app.tsx': 'export const App = (): null => null;\n',
    'frontend/tsconfig.json': '{"compilerOptions":{"jsx":"preserve","strict":true}}',
    'backend/pom.xml': '<project><artifactId>backend</artifactId></project>\n',
    'backend/src/main/java/com/example/Api.java': 'package com.example;\npublic class Api {}\n',
    'ml/pyproject.toml': '[project]\nname = "ml"\ndependencies = ["fastapi"]\n',
    'ml/app/predict.py': 'def predict():\n    return 1\n',
    'worker/go.mod': 'module example.com/worker\n\ngo 1.22\n',
    'worker/main.go': 'package main\n\nfunc main() {}\n',
    'infrastructure/main.tf': 'resource "aws_s3_bucket" "b" {}\n',
    'docker-compose.yml': 'services:\n  web:\n    build: ./frontend\n',
  };

  it('preserves every region rather than analysing only the TypeScript part', async () => {
    // The defect that motivated the milestone: this repository used to scan "successfully"
    // as one file — `frontend/src/app.tsx` — and report itself as a one-file repository.
    const summary = await scan(FILES);

    expect(summary.files).toBe(11);
    // Four manifest-anchored regions, plus the root holding Compose and Terraform.
    expect(summary.regions).toBe(5);
  });

  it('is recognised as a multi-technology system', async () => {
    expect((await scan(FILES)).isPolyglot).toBe(true);
  });

  it('detects every meaningful language, not one primary', async () => {
    const languages = (await scan(FILES)).languages.map((entry) => entry.language);

    expect(languages).toContain('typescript');
    expect(languages).toContain('java');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('terraform');
  });

  it('finds each ecosystem manifest', async () => {
    expect((await scan(FILES)).manifests).toBe(4);
  });

  it('reports the depth each region actually reached, region by region', async () => {
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    const session = pipeline.open(databasePath);

    try {
      const byPath = new Map(
        session.api.getCapabilities().regions.map((region) => [region.path, region]),
      );

      // Every region here now has an analyser: TypeScript, Python, Java and Go.
      expect(byPath.get('frontend')?.depth).toBe('semantic');
      expect(byPath.get('ml')?.depth).toBe('semantic');
      expect(byPath.get('backend')?.depth).toBe('semantic');
      expect(byPath.get('worker')?.depth).toBe('semantic');

      // Each region's reason names the evidence that region actually produced, not the language's.
      expect(byPath.get('worker')?.reason).toMatch(/Go sources were parsed/);
      expect(byPath.get('backend')?.reason).toMatch(/Java sources were parsed/);
    } finally {
      session.close();
    }
  });

  it('names each region by its own primary language', async () => {
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    const session = pipeline.open(databasePath);

    try {
      const languages = new Map(
        session.api
          .getCapabilities()
          .regions.map((region) => [region.path, region.primaryLanguage]),
      );

      expect(languages.get('frontend')).toBe('typescript');
      expect(languages.get('backend')).toBe('java');
      expect(languages.get('ml')).toBe('python');
      expect(languages.get('worker')).toBe('go');
    } finally {
      session.close();
    }
  });
});

describe('CASE 6 — a documentation and configuration repository', () => {
  const FILES = {
    'README.md': '# Handbook\n',
    'docs/architecture.md': '# Architecture\n',
    'docs/onboarding.md': '# Onboarding\n',
    'config.yaml': 'key: value\n',
  };

  it('produces useful structure rather than nothing to analyse', async () => {
    const summary = await scan(FILES);

    expect(summary.files).toBe(4);
    expect(summary.nodes).toBeGreaterThan(0);
    expect(summary.regions).toBe(1);
  });

  it('reports its documentation and configuration languages', async () => {
    const summary = await scan(FILES);

    expect(summary.languages).toEqual(
      expect.arrayContaining([
        { language: 'markdown', files: 3 },
        { language: 'yaml', files: 1 },
      ]),
    );
  });

  it('has no primary language, and says so rather than naming Markdown', async () => {
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

    const session = pipeline.open(databasePath);

    try {
      const region = session.api.getCapabilities().regions[0];

      expect(region?.primaryLanguage).toBeNull();
      expect(region?.sourceFileCount).toBe(0);
      expect(region?.reason).toMatch(/holds no source files/);
    } finally {
      session.close();
    }
  });
});

describe('failure isolation', () => {
  const FILES = {
    'frontend/package.json': '{"name":"frontend"}',
    'frontend/src/app.ts': 'export const value = 1;\n',
    'ml/pyproject.toml': '[project]\nname = "ml"\n',
    'ml/app/predict.py': 'def predict():\n    return 1\n',
  };

  /** An analyser that always throws, standing in for a parser meeting source it cannot read. */
  const exploding = {
    name: 'exploding',
    languages: ['python'],
    analyze(): never {
      throw new Error('the parser gave up');
    },
  };

  /**
   * An analyser that succeeds and returns facts the graph must refuse.
   *
   * The second failure mode, and the one that used to be fatal. Two declarations claiming one
   * identifier is exactly what Python's `@t.overload` produced against real source, and the graph
   * rejects it — correctly. What was wrong was the blast radius: the rejection escaped the whole
   * build, so the repository lost its file list and language distribution over one bad declaration.
   */
  const poisoning: LanguageAnalyzer = {
    name: 'poisoning',
    languages: ['python'],
    analyze({ inventory }) {
      const filePath = 'ml/app/predict.py';
      const file = fileId(filePath);
      const duplicate = symbolId(filePath, ['predict']);

      const declaration = {
        id: duplicate,
        fileId: file,
        kind: 'function' as const,
        name: 'predict',
        containerChain: ['predict'],
        visibility: null,
        modifiers: {
          isExported: false,
          isStatic: false,
          isAbstract: false,
          isReadonly: false,
          isOptional: false,
          isAsync: false,
        },
        locations: [{ startLine: 1, startColumn: 1, endLine: 2, endColumn: 13 }],
      };

      return {
        analyzer: 'poisoning',
        languages: ['python'],
        coveredFiles: [filePath],
        depth: 'semantic',
        reason: 'pretends to have analysed',
        contribution: {
          ir: {
            repository: { name: inventory.name, rootPath: inventory.rootPath },
            files: [{ id: file, path: filePath, isDeclarationFile: false }],
            // The same identifier twice.
            declarations: [declaration, declaration],
            imports: [],
            exports: [],
            callSites: [],
            memberAccesses: [],
          },
          resolved: {
            repository: { name: inventory.name, rootPath: inventory.rootPath },
            declarations: [],
            relationships: [],
            unresolved: [],
          },
          callGraph: { calls: [], externalCalls: [], unresolved: [] },
          annotations: {
            framework: null,
            roles: [],
            routes: [],
            environmentVariables: [],
            clientCalls: [],
          },
        },
        failure: null,
      };
    },
  };

  async function scanWith(analyzers: readonly LanguageAnalyzer[]): Promise<ScanSummary> {
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    return new RepositoryPipeline().scan({
      repositoryPath: root,
      databasePath: path.join(databaseDirectory, 'graph.db'),
      createdAt: '1970-01-01T00:00:00.000Z',
      analyzers,
    });
  }

  it('keeps analysing when one analyser throws', async () => {
    // The whole point: a Python parser failing must not cost the TypeScript frontend its analysis,
    // nor the repository its universal facts.
    const summary = await scanWith([new TypeScriptAnalyzer(), exploding]);

    expect(summary.files).toBe(4);
    expect(summary.declarations).toBeGreaterThan(0);
    expect(summary.depth).toBe('semantic');
  });

  it('reports the failure rather than hiding it', async () => {
    const summary = await scanWith([new TypeScriptAnalyzer(), exploding]);

    expect(summary.analyzerFailures).toEqual([
      { analyzer: 'exploding', failure: 'the parser gave up' },
    ]);
  });

  it('leaves the failed analyser\'s region at discovery depth, saying why', async () => {
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({
      repositoryPath: root,
      databasePath,
      createdAt: '1970-01-01T00:00:00.000Z',
      analyzers: [new TypeScriptAnalyzer(), exploding],
    });

    const session = pipeline.open(databasePath);

    try {
      const byPath = new Map(
        session.api.getCapabilities().regions.map((region) => [region.path, region]),
      );

      expect(byPath.get('frontend')?.depth).toBe('semantic');
      expect(byPath.get('ml')?.depth).toBe('universal');
      expect(byPath.get('ml')?.reason).toMatch(/exploding analyser failed/);
      expect(byPath.get('ml')?.reason).toMatch(/the parser gave up/);
    } finally {
      session.close();
    }
  });

  it('keeps the rest of the repository when the graph refuses one analyser\'s facts', async () => {
    const summary = await scanWith([new TypeScriptAnalyzer(), poisoning]);

    // Discovery survives in full: this is the layer no analyser produced and none may cost.
    expect(summary.files).toBe(4);
    expect(summary.manifests).toBe(2);
    expect(summary.languages.map((entry) => entry.language)).toContain('python');

    // And the analyser that behaved keeps its depth.
    expect(summary.declarations).toBeGreaterThan(0);
    expect(summary.depth).toBe('semantic');
  });

  it('reports the refused analyser rather than passing off a thinner graph as whole', async () => {
    const summary = await scanWith([new TypeScriptAnalyzer(), poisoning]);

    expect(summary.analyzerFailures).toHaveLength(1);
    expect(summary.analyzerFailures[0]?.analyzer).toBe('poisoning');
    expect(summary.analyzerFailures[0]?.failure).toMatch(/share the identifier/);
  });

  it('drops the refused analyser\'s region to discovery depth, saying why', async () => {
    const root = await repository(FILES);
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-polyglot-db-'));

    roots.push(databaseDirectory);

    const pipeline = new RepositoryPipeline();
    const databasePath = path.join(databaseDirectory, 'graph.db');

    await pipeline.scan({
      repositoryPath: root,
      databasePath,
      createdAt: '1970-01-01T00:00:00.000Z',
      analyzers: [new TypeScriptAnalyzer(), poisoning],
    });

    const session = pipeline.open(databasePath);

    try {
      const byPath = new Map(
        session.api.getCapabilities().regions.map((region) => [region.path, region]),
      );

      // `poisoning` claimed `semantic` and covered the file. Since its facts were dropped, keeping
      // that claim would be the exact dishonesty the capability model exists to prevent.
      expect(byPath.get('frontend')?.depth).toBe('semantic');
      expect(byPath.get('ml')?.depth).toBe('universal');
      expect(byPath.get('ml')?.reason).toMatch(/could not accept/);
      expect(byPath.get('ml')?.reason).toMatch(/share the identifier/);
    } finally {
      session.close();
    }
  });
});

describe('CASE 7 — an empty repository', () => {
  it('fails honestly, being the one repository with nothing to describe', async () => {
    await expect(scan({})).rejects.toThrow(EmptyRepositoryError);
  });

  it('says it contains no files, rather than blaming the language', async () => {
    await expect(scan({})).rejects.toThrow(/contains no files/);
  });
});

describe('CASE 1 — TypeScript keeps its semantic analysis', () => {
  const FILES = {
    'package.json': '{"name":"ts-app"}',
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022"}}',
    'src/service.ts': 'export class Service {\n  run(): number {\n    return 1;\n  }\n}\n',
    'src/index.ts':
      "import { Service } from './service.js';\n\nexport function main(): number {\n  return new Service().run();\n}\n",
  };

  it('still resolves declarations, imports and calls', async () => {
    const summary = await scan(FILES);

    expect(summary.declarations).toBeGreaterThan(0);
    expect(summary.callEdges).toBeGreaterThan(0);
  });

  it('reaches semantic depth', async () => {
    const summary = await scan(FILES);

    expect(summary.depth).toBe('semantic');
    expect(meetsDepth(summary.depth, 'semantic')).toBe(true);
  });

  it('is not reported as polyglot for a single-language repository', async () => {
    expect((await scan(FILES)).isPolyglot).toBe(false);
  });

  it('records the manifest and the configuration alongside the sources', async () => {
    // Universal facts and semantic facts coexist: the same graph holds both.
    const summary = await scan(FILES);

    expect(summary.files).toBe(4);
    expect(summary.manifests).toBe(1);
  });
});
