import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IrBuilder } from '@traceiq/ir';
import { ProjectHost } from '@traceiq/project-host';
import { Resolver } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GraphBuilder } from './graph-builder.js';
import { GraphStore } from './graph-store.js';
import type { RepositoryGraph } from './types.js';

/**
 * The whole pipeline over real TypeScript: Project Host, IR Builder, Resolver, Graph
 * Builder, Graph Store. The unit tests use synthetic inputs for precision; this one
 * proves the stages actually fit together and that a real graph satisfies the
 * database's own constraints.
 */
const FILES = {
  'src/base.ts': `export interface Shape { a: string }
export class Root { protected seed = 1; }
export type Alias = Shape;
`,
  'src/impl.ts': `import { Shape, Root, Alias } from './base';
import * as everything from './base';
import path from 'node:path';
import missing from './nowhere';

export class Impl extends Root implements Shape {
  a = 'x';
  #hidden = 1;
  values?: Map<string, Alias>;
  async run(): Promise<Shape> { void path; void everything; void missing; return this; }
}

const local = 1;
export { local };
`,
};

let root: string;
let graph: RepositoryGraph;
let read: Database.Database;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-pipeline-'));

  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: true,
        skipLibCheck: true,
      },
    }),
    ...FILES,
  };

  for (const [relativePath, contents] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents, 'utf8');
  }

  const inventory: RepositoryInventory = {
    name: 'pipeline',
    rootPath: root,
    language: 'typescript',
    framework: 'unknown',
    packageManager: 'unknown',
    sourceFiles: Object.keys(FILES).sort(),
    directories: [],
    tsconfigPath: 'tsconfig.json',
    packageJsonPath: null,
    lockfile: null,
    entryPoints: [],
    ignoredPaths: [],
    workspacePackages: [],
      files: [],
      languages: [],
      manifests: [],
      regions: [],
  };

  const context = new ProjectHost().load(inventory);
  const ir = new IrBuilder().build(context);
  const resolved = new Resolver().resolve({ ir, context });

  graph = new GraphBuilder().build({ ir, resolved });
  context.dispose();

  const databaseFile = path.join(root, 'graph.db');
  const store = GraphStore.open(databaseFile);

  store.write(graph, '2026-07-29T00:00:00.000Z');
  store.close();

  read = new Database(databaseFile, { readonly: true });
});

afterAll(async () => {
  read.close();
  await rm(root, { recursive: true, force: true });
});

const one = <T>(sql: string, ...parameters: unknown[]): T | undefined =>
  read.prepare(sql).get(...(parameters as [])) as T | undefined;

const all = <T>(sql: string, ...parameters: unknown[]): T[] =>
  read.prepare(sql).all(...(parameters as [])) as T[];

describe('the persisted graph', () => {
  it('is internally consistent with no dangling references', () => {
    expect(read.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(read.pragma('foreign_key_check')).toEqual([]);
  });

  it('holds a node for each file and each declaration', () => {
    expect(one<{ c: number }>(`SELECT COUNT(*) c FROM nodes WHERE kind = 'File'`)?.c).toBe(2);
    expect(one<{ c: number }>(`SELECT COUNT(*) c FROM nodes WHERE id = 'sym:src/impl.ts#Impl'`)?.c).toBe(1);
  });

  it('records the class heritage the Resolver bound', () => {
    expect(
      one<{ target_id: string }>(
        `SELECT target_id FROM edges WHERE type = 'EXTENDS' AND source_id = 'sym:src/impl.ts#Impl'`,
      )?.target_id,
    ).toBe('sym:src/base.ts#Root');

    expect(
      one<{ target_id: string }>(
        `SELECT target_id FROM edges WHERE type = 'IMPLEMENTS' AND source_id = 'sym:src/impl.ts#Impl'`,
      )?.target_id,
    ).toBe('sym:src/base.ts#Shape');
  });

  it('declares members through their class, and the class through its file', () => {
    expect(
      one<{ source_id: string }>(
        `SELECT source_id FROM edges WHERE type = 'DECLARES' AND target_id = 'sym:src/impl.ts#Impl.run'`,
      )?.source_id,
    ).toBe('sym:src/impl.ts#Impl');

    expect(
      one<{ source_id: string }>(
        `SELECT source_id FROM edges WHERE type = 'DECLARES' AND target_id = 'sym:src/impl.ts#Impl'`,
      )?.source_id,
    ).toBe('file:src/impl.ts');
  });

  it('addresses an ECMAScript private member', () => {
    expect(
      one<{ visibility: string }>(
        `SELECT visibility FROM nodes WHERE id = 'sym:src/impl.ts#Impl.#hidden'`,
      )?.visibility,
    ).toBe('private');
  });

  it('creates external nodes in each of the approved forms it encounters', () => {
    const externals = all<{ id: string; external_kind: string }>(
      `SELECT id, external_kind FROM nodes WHERE kind = 'External' ORDER BY id`,
    );

    expect(externals.map((row) => row.id)).toContain('ext:node:path');
    expect(externals.some((row) => row.external_kind === 'builtin')).toBe(true);
    expect(externals.every((row) => row.id.startsWith('ext:'))).toBe(true);
    // No identity may carry a version.
    expect(externals.every((row) => !/\d+\.\d+\.\d+/.test(row.id))).toBe(true);
  });

  it('keeps an unresolvable import visible rather than dropping it', () => {
    const unresolved = all<{ text: string; reason: string }>(
      `SELECT text, reason FROM unresolved_references`,
    );

    expect(unresolved.some((row) => row.text === './nowhere')).toBe(true);
  });

  it('resolves an export specifier the IR could not link', () => {
    expect(
      one<{ target_id: string; confidence: string }>(
        `SELECT target_id, confidence FROM edges WHERE type = 'EXPORTS' AND name = 'local'`,
      ),
    ).toEqual({ target_id: 'sym:src/impl.ts#local', confidence: 'RESOLVED' });
  });

  it('marks an inline exported declaration CERTAIN, needing no resolution', () => {
    expect(
      one<{ confidence: string }>(
        `SELECT confidence FROM edges WHERE type = 'EXPORTS' AND target_id = 'sym:src/base.ts#Shape'`,
      )?.confidence,
    ).toBe('CERTAIN');
  });

  it('uses only confidence levels from the frozen vocabulary', () => {
    const levels = all<{ confidence: string }>(
      `SELECT DISTINCT confidence FROM edges ORDER BY confidence`,
    ).map((row) => row.confidence);

    for (const level of levels) {
      expect(['CERTAIN', 'RESOLVED', 'INFERRED', 'AMBIGUOUS']).toContain(level);
    }
  });

  it('gives every edge a location and readable evidence', () => {
    expect(
      one<{ c: number }>(
        `SELECT COUNT(*) c FROM edges WHERE start_line < 1 OR LENGTH(provenance_evidence) < 10`,
      )?.c,
    ).toBe(0);
  });

  it('leaves ordinal unused and content hashes null, as version 1 specifies', () => {
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM edges WHERE ordinal IS NOT NULL')?.c).toBe(0);
    expect(
      one<{ c: number }>('SELECT COUNT(*) c FROM file_revisions WHERE content_hash IS NOT NULL')?.c,
    ).toBe(0);
  });

  it('has no roles, there being no Framework Extractor', () => {
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM node_roles')?.c).toBe(0);
  });

  it('persists exactly what the builder produced', () => {
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM nodes')?.c).toBe(graph.nodes.length);
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM edges')?.c).toBe(graph.edges.length);
  });
});
