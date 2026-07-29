import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { GraphBuilder } from './graph-builder.js';
import {
  annotations,
  declaration,
  externalTarget,
  file,
  fileTarget,
  ir,
  relationship,
  resolved,
  roleAnnotation,
  unresolvedReference,
} from './graph-fixture.test-helper.js';
import { GraphStore, GraphStoreError } from './graph-store.js';
import { SCHEMA_VERSION } from './schema.js';
import type { RepositoryGraph } from './types.js';

const CREATED_AT = '2026-07-29T00:00:00.000Z';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'traceiq-graph-'));

  directories.push(directory);

  return path.join(directory, 'graph.db');
}

/** A small but complete graph: files, a class with a member, and two externals. */
function sampleGraph(): RepositoryGraph {
  return new GraphBuilder().build({
    ir: ir({
      files: [file('src/a.ts'), file('src/b.ts')],
      declarations: [
        declaration({ path: 'src/a.ts', chain: ['Service'], modifiers: { isExported: true } }),
        declaration({
          path: 'src/a.ts',
          chain: ['Service', 'run'],
          kind: 'method',
          visibility: 'public',
          modifiers: { isAsync: true },
          lines: [3, 8],
        }),
      ],
    }),
    resolved: resolved({
      relationships: [
        relationship({
          type: 'IMPORTS',
          sourceId: 'file:src/a.ts',
          target: fileTarget('src/b.ts'),
          fileId: 'file:src/a.ts',
        }),
        relationship({
          type: 'IMPORTS',
          sourceId: 'file:src/a.ts',
          target: externalTarget('package', 'express'),
          confidence: 'INFERRED',
          fileId: 'file:src/a.ts',
          line: 2,
        }),
        relationship({
          type: 'REFERENCES_TYPE',
          sourceId: 'sym:src/a.ts#Service.run',
          target: externalTarget('typescript-lib'),
          name: 'Promise',
          fileId: 'file:src/a.ts',
          line: 3,
        }),
      ],
      unresolved: [unresolvedReference({ sourceId: 'file:src/a.ts', fileId: 'file:src/a.ts' })],
    }),
    annotations: annotations({
      roles: [roleAnnotation({ declarationId: 'sym:src/a.ts#Service', role: 'Service' })],
    }),
  });
}

async function written(): Promise<{ path: string; read: Database.Database }> {
  const filePath = await databasePath();
  const store = GraphStore.open(filePath);

  store.write(sampleGraph(), CREATED_AT);
  store.close();

  return { path: filePath, read: new Database(filePath, { readonly: true }) };
}

describe('schema creation', () => {
  it('creates every specified table', async () => {
    const { read } = await written();
    const names = read
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    read.close();

    expect(names).toEqual([
      'edges',
      'file_revisions',
      'node_locations',
      'node_roles',
      'nodes',
      'repository',
      'revisions',
      'unresolved_references',
    ]);
  });

  it('creates the traversal indexes the specification names', async () => {
    const { read } = await written();
    const names = read
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    read.close();

    expect(names).toContain('edges_by_source');
    expect(names).toContain('edges_by_target');
    expect(names).toContain('edges_by_group');
    expect(names).toContain('edges_by_file');
  });

  it('records the repository as a singleton with its schema version', async () => {
    const { read } = await written();
    const rows = read.prepare<[], { name: string; schema_version: number }>(
      'SELECT name, schema_version FROM repository',
    ).all();

    read.close();

    expect(rows).toEqual([{ name: 'repo', schema_version: SCHEMA_VERSION }]);
  });

  it('reopens an existing database without recreating it', async () => {
    const filePath = await databasePath();
    const first = GraphStore.open(filePath);

    first.write(sampleGraph(), CREATED_AT);
    first.close();

    const second = GraphStore.open(filePath);

    expect(() => second.write(sampleGraph(), CREATED_AT)).not.toThrow();
    second.close();
  });

  it('refuses a database written by a different schema version', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);

    store.write(sampleGraph(), CREATED_AT);
    store.close();

    const tamper = new Database(filePath);

    tamper.prepare('UPDATE repository SET schema_version = ?').run(SCHEMA_VERSION + 1);
    tamper.close();

    expect(() => GraphStore.open(filePath)).toThrow(GraphStoreError);
  });
});

describe('persisted rows', () => {
  it('writes every node, edge, location and unresolved reference', async () => {
    const graph = sampleGraph();
    const { read } = await written();
    const count = (table: string) =>
      read.prepare<[], { c: number }>(`SELECT COUNT(*) c FROM ${table}`).get()?.c;

    expect(count('nodes')).toBe(graph.nodes.length);
    expect(count('edges')).toBe(graph.edges.length);
    expect(count('unresolved_references')).toBe(graph.unresolved.length);
    expect(count('node_roles')).toBe(1);
    // Two declarations, one with two sites.
    expect(count('node_locations')).toBe(3);

    read.close();
  });

  it('stores booleans as 0 and 1, and absent enrichment as NULL', async () => {
    const { read } = await written();
    const row = read
      .prepare<[string], { is_exported: number; is_async: number; has_symbol: number | null }>(
        'SELECT is_exported, is_async, has_symbol FROM nodes WHERE id = ?',
      )
      .get('sym:src/a.ts#Service');

    read.close();

    expect(row).toEqual({ is_exported: 1, is_async: 0, has_symbol: null });
  });

  it('writes the placeholder revision and a null source hash', async () => {
    const { read } = await written();
    const revision = read
      .prepare<[], { id: number; created_at: string; source_hash: string | null }>(
        'SELECT id, created_at, source_hash FROM revisions',
      )
      .get();

    read.close();

    expect(revision).toEqual({ id: 1, created_at: CREATED_AT, source_hash: null });
  });

  it('writes one file_revisions row per file, with a null content hash', async () => {
    const { read } = await written();
    const rows = read
      .prepare<[], { file_id: string; content_hash: string | null; revision_id: number }>(
        'SELECT file_id, content_hash, revision_id FROM file_revisions ORDER BY file_id',
      )
      .all();

    read.close();

    expect(rows).toEqual([
      { file_id: 'file:src/a.ts', content_hash: null, revision_id: 1 },
      { file_id: 'file:src/b.ts', content_hash: null, revision_id: 1 },
    ]);
  });

  it('stamps every node and edge with the placeholder revision', async () => {
    const { read } = await written();
    const distinct = (table: string) =>
      read
        .prepare<[], { revision_id: number }>(`SELECT DISTINCT revision_id FROM ${table}`)
        .all()
        .map((row) => row.revision_id);

    expect(distinct('nodes')).toEqual([1]);
    expect(distinct('edges')).toEqual([1]);
    expect(distinct('unresolved_references')).toEqual([1]);

    read.close();
  });

  it('writes external nodes under the approved identity scheme', async () => {
    const { read } = await written();
    const rows = read
      .prepare<[], { id: string; external_kind: string; external_name: string | null }>(
        `SELECT id, external_kind, external_name FROM nodes WHERE kind = 'External' ORDER BY id`,
      )
      .all();

    read.close();

    expect(rows).toEqual([
      { id: 'ext:builtin:Promise', external_kind: 'builtin', external_name: 'Promise' },
      { id: 'ext:npm:express', external_kind: 'npm', external_name: 'express' },
    ]);
  });
});

describe('integrity', () => {
  it('leaves the database internally consistent', async () => {
    const { read } = await written();

    expect(read.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(read.pragma('foreign_key_check')).toEqual([]);

    read.close();
  });

  it('enforces foreign keys, so a dangling edge cannot be inserted', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);

    store.write(sampleGraph(), CREATED_AT);
    store.close();

    const direct = new Database(filePath);

    direct.pragma('foreign_keys = ON');

    expect(() =>
      direct
        .prepare(
          `INSERT INTO edges (id, type, source_id, target_id, name, confidence, candidate_group,
             ordinal, provenance_resolver, provenance_file_id, provenance_evidence,
             start_line, start_column, end_line, end_column, revision_id)
           VALUES ('x','IMPORTS','file:src/a.ts','file:ghost.ts',NULL,'RESOLVED',NULL,
             NULL,'imports','file:src/a.ts','e',1,1,1,1,1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    direct.close();
  });

  it('rejects a relationship type outside the frozen vocabulary', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);

    store.write(sampleGraph(), CREATED_AT);
    store.close();

    const direct = new Database(filePath);

    expect(() =>
      direct
        .prepare(
          `INSERT INTO edges (id, type, source_id, target_id, name, confidence, candidate_group,
             ordinal, provenance_resolver, provenance_file_id, provenance_evidence,
             start_line, start_column, end_line, end_column, revision_id)
           VALUES ('y','USES','file:src/a.ts','file:src/b.ts',NULL,'RESOLVED',NULL,
             NULL,'imports','file:src/a.ts','e',1,1,1,1,1)`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    direct.close();
  });

  it('rejects a confidence level outside the frozen vocabulary', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);

    store.write(sampleGraph(), CREATED_AT);
    store.close();

    const direct = new Database(filePath);

    expect(() =>
      direct.prepare(`UPDATE edges SET confidence = 'LIKELY'`).run(),
    ).toThrow(/CHECK/i);

    direct.close();
  });

  it('accepts a node kind outside the current set, that vocabulary being open', async () => {
    // `Route`, `EnvironmentVariable` and `DatabaseTable` are still to come, so a
    // CHECK on nodes.kind would force exactly the migration the schema avoids.
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);

    store.write(sampleGraph(), CREATED_AT);
    store.close();

    const direct = new Database(filePath);

    direct.pragma('foreign_keys = ON');

    expect(() =>
      direct
        .prepare(
          `INSERT INTO nodes (id, kind, name, confidence, provenance_producer,
             provenance_evidence, revision_id)
           VALUES ('route:GET:/health','Route','GET /health','CERTAIN','framework','e',1)`,
        )
        .run(),
    ).not.toThrow();

    direct.close();
  });
});

describe('transactions', () => {
  it('replaces a previous write rather than accumulating rows', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);
    const graph = sampleGraph();

    store.write(graph, CREATED_AT);
    store.write(graph, CREATED_AT);
    store.close();

    const read = new Database(filePath, { readonly: true });
    const nodes = read.prepare<[], { c: number }>('SELECT COUNT(*) c FROM nodes').get()?.c;

    read.close();

    expect(nodes).toBe(graph.nodes.length);
  });

  it('rolls back completely when a write fails, leaving the previous graph intact', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);
    const good = sampleGraph();

    store.write(good, CREATED_AT);

    // A graph whose edge names a node that does not exist. The builder would have
    // refused it, so it is constructed directly to exercise the store's own safety.
    const broken: RepositoryGraph = {
      ...good,
      edges: [
        {
          ...good.edges[0]!,
          id: 'edge:broken',
          targetId: 'file:ghost.ts' as never,
        },
      ],
    };

    expect(() => store.write(broken, CREATED_AT)).toThrow(GraphStoreError);
    store.close();

    const read = new Database(filePath, { readonly: true });
    const counts = {
      nodes: read.prepare<[], { c: number }>('SELECT COUNT(*) c FROM nodes').get()?.c,
      edges: read.prepare<[], { c: number }>('SELECT COUNT(*) c FROM edges').get()?.c,
    };

    read.close();

    // The failed write must leave no trace, including its deletions.
    expect(counts).toEqual({ nodes: good.nodes.length, edges: good.edges.length });
  });

  it('writes an empty graph without failing', async () => {
    const filePath = await databasePath();
    const store = GraphStore.open(filePath);
    const empty = new GraphBuilder().build({ ir: ir({ files: [] }), resolved: resolved({}) });

    expect(() => store.write(empty, CREATED_AT)).not.toThrow();
    store.close();
  });
});

describe('failure modes', () => {
  it('refuses a path that cannot be opened', () => {
    expect(() => GraphStore.open('/nonexistent-directory/graph.db')).toThrow(GraphStoreError);
  });
});

describe('determinism of persistence', () => {
  it('produces identical rows on repeated writes of the same graph', async () => {
    const read = async (): Promise<unknown> => {
      const filePath = await databasePath();
      const store = GraphStore.open(filePath);

      store.write(sampleGraph(), CREATED_AT);
      store.close();

      const connection = new Database(filePath, { readonly: true });
      const snapshot = {
        nodes: connection.prepare('SELECT * FROM nodes ORDER BY id').all(),
        edges: connection.prepare('SELECT * FROM edges ORDER BY id').all(),
        locations: connection
          .prepare('SELECT * FROM node_locations ORDER BY node_id, ordinal')
          .all(),
        unresolved: connection.prepare('SELECT * FROM unresolved_references ORDER BY id').all(),
      };

      connection.close();

      return snapshot;
    };

    expect(await read()).toEqual(await read());
  });
});
