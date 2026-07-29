import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NodeId } from '@traceiq/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GraphBuilder } from './graph-builder.js';
import {
  annotations,
  declaration,
  environmentAnnotation,
  externalTarget,
  file,
  fileTarget,
  ir,
  relationship,
  resolved,
  roleAnnotation,
  routeAnnotation,
  unresolvedReference,
} from './graph-fixture.test-helper.js';
import { GraphStore } from './graph-store.js';
import { GraphApiError, SqliteGraphApi } from './sqlite-graph-api.js';

/**
 * A graph with one of everything the API has to return: files, a class with a member,
 * an external, two routes sharing a path across files, and two reads of one variable.
 */
function sampleGraph() {
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
          lines: [3, 8],
        }),
        declaration({ path: 'src/a.ts', chain: ['handler'], kind: 'function' }),
        declaration({ path: 'src/b.ts', chain: ['otherHandler'], kind: 'function' }),
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
          fileId: 'file:src/a.ts',
          line: 2,
        }),
      ],
      unresolved: [unresolvedReference({ sourceId: 'file:src/a.ts', fileId: 'file:src/a.ts' })],
    }),
    annotations: annotations({
      framework: 'express',
      roles: [roleAnnotation({ declarationId: 'sym:src/a.ts#Service', role: 'Service' })],
      routes: [
        routeAnnotation({
          method: 'GET',
          path: '/health',
          handlers: [{ text: 'handler', declarationId: 'sym:src/a.ts#handler' }],
          fileId: 'file:src/a.ts',
          line: 5,
        }),
        // The same path in two files, which without prefix composition is common.
        routeAnnotation({
          method: 'GET',
          path: '/',
          handlers: [{ text: 'handler', declarationId: 'sym:src/a.ts#handler' }],
          fileId: 'file:src/a.ts',
          line: 6,
        }),
        routeAnnotation({
          method: 'GET',
          path: '/',
          handlers: [{ text: 'otherHandler', declarationId: 'sym:src/b.ts#otherHandler' }],
          fileId: 'file:src/b.ts',
          line: 4,
        }),
      ],
      environmentVariables: [
        environmentAnnotation({ name: 'PORT', usedIn: 'sym:src/a.ts#Service.run', fileId: 'file:src/a.ts' }),
        environmentAnnotation({ name: 'PORT', fileId: 'file:src/b.ts', line: 9 }),
      ],
    }),
  });
}

let directory: string;
let api: SqliteGraphApi;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'traceiq-graph-api-'));

  const databaseFile = path.join(directory, 'graph.db');
  const store = GraphStore.open(databaseFile);

  store.write(sampleGraph(), '2026-07-29T00:00:00.000Z');
  store.close();

  api = SqliteGraphApi.open(databaseFile);
});

afterAll(async () => {
  api.close();
  await rm(directory, { recursive: true, force: true });
});

const id = (value: string): NodeId => value as NodeId;

describe('getNode', () => {
  it('returns a node with its fields rehydrated', () => {
    expect(api.getNode(id('sym:src/a.ts#Service'))).toMatchObject({
      kind: 'Class',
      name: 'Service',
      fileId: 'file:src/a.ts',
      containerChain: 'Service',
      isExported: true,
      confidence: 'CERTAIN',
    });
  });

  it('returns every location of a node with several sites', () => {
    expect(api.getNode(id('sym:src/a.ts#Service.run'))?.locations.map((l) => l.startLine)).toEqual([
      3, 8,
    ]);
  });

  it('returns an empty location list for a file, which has no position in itself', () => {
    expect(api.getNode(id('file:src/a.ts'))?.locations).toEqual([]);
  });

  it('rehydrates booleans, and absent enrichment as null rather than false', () => {
    const node = api.getNode(id('sym:src/a.ts#Service'));

    expect(node?.isStatic).toBe(false);
    expect(node?.hasSymbol).toBeNull();
    expect(node?.isExportedFromModule).toBeNull();
  });

  it('rehydrates an external node with its kind and name', () => {
    expect(api.getNode(id('ext:npm:express'))).toMatchObject({
      kind: 'External',
      externalKind: 'npm',
      externalName: 'express',
    });
  });

  it('carries provenance so a node can explain itself', () => {
    const node = api.getNode(id('file:src/a.ts'));

    expect(node?.provenance.producer).toBe('graph-builder');
    expect(node?.provenance.evidence.length).toBeGreaterThan(10);
  });

  it('returns null for an identifier that is not in the graph', () => {
    expect(api.getNode(id('sym:src/a.ts#Absent'))).toBeNull();
  });
});

describe('exists', () => {
  it.each([
    'file:src/a.ts',
    'sym:src/a.ts#Service',
    'ext:npm:express',
    'route:GET:/health',
    'env:PORT',
  ])('reports %s as present', (value) => {
    expect(api.exists(id(value))).toBe(true);
  });

  it.each(['sym:src/a.ts#Absent', 'route:GET:/absent', 'env:ABSENT', 'nonsense'])(
    'reports %s as absent',
    (value) => {
      expect(api.exists(id(value))).toBe(false);
    },
  );
});

describe('getNodes', () => {
  it('returns every node of a kind, ordered by identifier', () => {
    const routes = api.getNodes('Route').map((node) => node.id);

    expect(routes).toEqual(['route:GET:/', 'route:GET:/health']);
    expect(routes).toEqual([...routes].sort());
  });

  it('returns locations for each node in one query', () => {
    const merged = api.getNodes('Route').find((node) => node.id === 'route:GET:/');

    // Two registrations in two files, so two locations and no single owning file.
    expect(merged?.locations).toHaveLength(2);
    expect(merged?.fileId).toBeNull();
  });

  it('returns environment variables, which belong to no file', () => {
    expect(api.getNodes('EnvironmentVariable')).toEqual([
      expect.objectContaining({ id: 'env:PORT', name: 'PORT', fileId: null }),
    ]);
  });

  it('returns an empty list for a kind with no nodes', () => {
    expect(api.getNodes('Enum')).toEqual([]);
  });
});

describe('getEdges', () => {
  it('returns every edge of a type, ordered by identifier', () => {
    const ids = api.getEdges('HANDLED_BY').map((edge) => edge.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual([...ids].sort());
  });

  it('preserves the ordinal that carries middleware order', () => {
    const handled = api.getEdges('HANDLED_BY');

    expect(handled.every((edge) => edge.ordinal !== null)).toBe(true);
  });

  it('leaves ordinal null on an edge that does not use it', () => {
    expect(api.getEdges('DECLARES').every((edge) => edge.ordinal === null)).toBe(true);
  });

  it('returns READS edges pointing at an environment variable', () => {
    expect(api.getEdges('READS').map((edge) => edge.targetId)).toEqual(['env:PORT', 'env:PORT']);
  });

  it('returns an empty list for a type with no edges', () => {
    expect(api.getEdges('CALLS')).toEqual([]);
  });

  it('carries provenance and a location on every edge', () => {
    for (const edge of api.getEdges('IMPORTS')) {
      expect(edge.provenance.evidence.length).toBeGreaterThan(5);
      expect(edge.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('getOutgoing and getIncoming', () => {
  it('returns one step forward from a node', () => {
    const outgoing = api.getOutgoing(id('route:POST:/login'));

    // No such route in this fixture, so the step is empty rather than an error.
    expect(outgoing).toEqual([]);
  });

  it('returns the edges leaving a route', () => {
    expect(api.getOutgoing(id('route:GET:/health')).map((edge) => edge.type)).toEqual([
      'HANDLED_BY',
    ]);
  });

  it('returns the edges arriving at a declaration', () => {
    const incoming = api.getIncoming(id('sym:src/a.ts#handler')).map((edge) => edge.type);

    // Declared by its file, and handled by two routes.
    expect(incoming).toContain('DECLARES');
    expect(incoming.filter((type) => type === 'HANDLED_BY')).toHaveLength(2);
  });

  it('returns the reads arriving at an environment variable', () => {
    expect(api.getIncoming(id('env:PORT')).map((edge) => edge.type)).toEqual(['READS', 'READS']);
  });

  it('orders both directions by edge identifier', () => {
    for (const edges of [
      api.getOutgoing(id('file:src/a.ts')),
      api.getIncoming(id('sym:src/a.ts#handler')),
    ]) {
      const ids = edges.map((edge) => edge.id);

      expect(ids).toEqual([...ids].sort());
    }
  });

  it('returns an empty list for a node that is not in the graph', () => {
    expect(api.getOutgoing(id('sym:src/a.ts#Absent'))).toEqual([]);
    expect(api.getIncoming(id('sym:src/a.ts#Absent'))).toEqual([]);
  });

  it('does not traverse: an outgoing edge is one step, not a reachable set', () => {
    // file → Service is one step. Service → Service.run is another, and the API never
    // returns it from the file. Following edges is the Query Engine's work.
    const fromFile = api.getOutgoing(id('file:src/a.ts')).map((edge) => edge.targetId);

    expect(fromFile).toContain('sym:src/a.ts#Service');
    expect(fromFile).not.toContain('sym:src/a.ts#Service.run');
  });
});

describe('getRoles', () => {
  it('returns the roles annotating a node, with confidence and evidence', () => {
    expect(api.getRoles(id('sym:src/a.ts#Service'))).toEqual([
      {
        nodeId: 'sym:src/a.ts#Service',
        role: 'Service',
        confidence: 'INFERRED',
        evidence: 'synthetic role annotation for testing',
      },
    ]);
  });

  it('returns nothing for a node carrying no role', () => {
    expect(api.getRoles(id('sym:src/a.ts#handler'))).toEqual([]);
  });

  it('returns nothing for a node that is not in the graph', () => {
    expect(api.getRoles(id('sym:src/a.ts#Absent'))).toEqual([]);
  });
});

describe('getUnresolved', () => {
  it('returns every unresolved reference, ordered by identifier', () => {
    const ids = api.getUnresolved().map((entry) => entry.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual([...ids].sort());
  });

  it('preserves the reason, the text, the provenance and the location', () => {
    const first = api.getUnresolved()[0];

    expect(first?.reason.length).toBeGreaterThan(0);
    expect(first?.text.length).toBeGreaterThan(0);
    expect(first?.provenance.evidence.length).toBeGreaterThan(10);
    expect(first?.location.startLine).toBeGreaterThan(0);
  });
});

describe('relationship filtering on the edge accessors', () => {
  it('restricts outgoing edges to one type', () => {
    const all = api.getOutgoing(id('file:src/a.ts'));
    const declares = api.getOutgoing(id('file:src/a.ts'), 'DECLARES');

    expect(declares.length).toBeGreaterThan(0);
    expect(declares.length).toBeLessThan(all.length);
    expect(declares.every((edge) => edge.type === 'DECLARES')).toBe(true);
  });

  it('restricts incoming edges to one type', () => {
    const handled = api.getIncoming(id('sym:src/a.ts#handler'), 'HANDLED_BY');

    expect(handled).toHaveLength(2);
    expect(handled.every((edge) => edge.type === 'HANDLED_BY')).toBe(true);
  });

  it('returns the same rows as filtering in memory would', () => {
    const filtered = api.getIncoming(id('sym:src/a.ts#handler'), 'HANDLED_BY');
    const inMemory = api
      .getIncoming(id('sym:src/a.ts#handler'))
      .filter((edge) => edge.type === 'HANDLED_BY');

    expect(filtered).toEqual(inMemory);
  });

  it('returns nothing for a type with no matching edge', () => {
    expect(api.getOutgoing(id('file:src/a.ts'), 'CALLS')).toEqual([]);
    expect(api.getIncoming(id('file:src/a.ts'), 'READS')).toEqual([]);
  });

  it('keeps the filtered result ordered by identifier', () => {
    const ids = api.getIncoming(id('sym:src/a.ts#handler'), 'HANDLED_BY').map((edge) => edge.id);

    expect(ids).toEqual([...ids].sort());
  });
});

describe('determinism', () => {
  it('answers identically on repeated reads', () => {
    expect(api.getNodes('Route')).toEqual(api.getNodes('Route'));
    expect(api.getEdges('HANDLED_BY')).toEqual(api.getEdges('HANDLED_BY'));
    expect(api.getOutgoing(id('file:src/a.ts'))).toEqual(api.getOutgoing(id('file:src/a.ts')));
  });

  it('returns plain data that survives a JSON round trip', () => {
    const node = api.getNode(id('sym:src/a.ts#Service'));

    expect(JSON.parse(JSON.stringify(node))).toEqual(node);
  });
});

describe('failure modes', () => {
  it('refuses a database that does not exist rather than creating one', () => {
    expect(() => SqliteGraphApi.open(path.join(directory, 'absent.db'))).toThrow(GraphApiError);
  });
});
