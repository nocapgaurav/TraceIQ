import type { NodeId } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeGraph, edge, node, role, unresolved } from './fake-graph.test-helper.js';
import { QueryEngine } from './query-engine.js';

const id = (value: string): NodeId => value as NodeId;

/**
 * A graph covering every query: files, a controller with a method, a service, a
 * repository, two routes with an ordered chain, an environment variable read twice, two
 * externals, and two unresolved references.
 */
function graph(): FakeGraph {
  const fake = new FakeGraph();

  fake
    .addNode(node({ id: 'file:src/routes.ts', kind: 'File', name: 'src/routes.ts' }))
    .addNode(node({ id: 'file:src/svc.ts', kind: 'File', name: 'src/svc.ts' }))
    .addNode(
      node({ id: 'sym:src/routes.ts#AuthController', kind: 'Class', name: 'AuthController', fileId: 'file:src/routes.ts' }),
    )
    .addNode(
      node({ id: 'sym:src/routes.ts#AuthController.login', kind: 'Method', name: 'login', fileId: 'file:src/routes.ts' }),
    )
    .addNode(node({ id: 'sym:src/routes.ts#requireAuth', kind: 'Function', name: 'requireAuth', fileId: 'file:src/routes.ts' }))
    .addNode(node({ id: 'sym:src/routes.ts#handle', kind: 'Function', name: 'handle', fileId: 'file:src/routes.ts' }))
    .addNode(node({ id: 'sym:src/svc.ts#AuthService', kind: 'Class', name: 'AuthService', fileId: 'file:src/svc.ts' }))
    .addNode(node({ id: 'sym:src/svc.ts#UserRepository', kind: 'Class', name: 'UserRepository', fileId: 'file:src/svc.ts' }))
    .addNode(node({ id: 'sym:src/svc.ts#Shape', kind: 'Interface', name: 'Shape', fileId: 'file:src/svc.ts' }))
    .addNode(node({ id: 'route:POST:/login', kind: 'Route', name: 'POST /login', fileId: 'file:src/routes.ts' }))
    .addNode(node({ id: 'route:GET:/users/:id', kind: 'Route', name: 'GET /users/:id', fileId: 'file:src/routes.ts' }))
    .addNode(node({ id: 'env:PORT', kind: 'EnvironmentVariable', name: 'PORT' }))
    .addNode(node({ id: 'ext:npm:express', kind: 'External', name: 'express', externalKind: 'npm', externalName: 'express' }))
    .addNode(node({ id: 'ext:node:fs', kind: 'External', name: 'fs', externalKind: 'node', externalName: 'fs' }));

  fake
    // Containment, which findReferences must exclude.
    .addEdge(edge({ type: 'DECLARES', sourceId: 'file:src/routes.ts', targetId: 'sym:src/routes.ts#AuthController' }))
    .addEdge(edge({ type: 'DECLARES', sourceId: 'sym:src/routes.ts#AuthController', targetId: 'sym:src/routes.ts#AuthController.login' }))
    // A real reference and a type reference to the same target.
    .addEdge(edge({ type: 'IMPORTS', sourceId: 'file:src/routes.ts', targetId: 'sym:src/svc.ts#Shape', name: 'Shape', line: 2 }))
    .addEdge(edge({ type: 'REFERENCES_TYPE', sourceId: 'sym:src/routes.ts#handle', targetId: 'sym:src/svc.ts#Shape', name: 'Shape', line: 7 }))
    // A route chain: middleware first, handler last.
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: 'route:POST:/login', targetId: 'sym:src/routes.ts#requireAuth', name: 'requireAuth', ordinal: 0, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: 'route:POST:/login', targetId: 'sym:src/routes.ts#AuthController.login', name: 'login', ordinal: 1, confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'HANDLED_BY', sourceId: 'route:GET:/users/:id', targetId: 'sym:src/routes.ts#handle', name: 'handle', ordinal: 0, confidence: 'INFERRED' }))
    // A call chain, including recursion and a module-level caller.
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/routes.ts#handle', targetId: 'sym:src/svc.ts#AuthService', name: 'AuthService', confidence: 'INFERRED', line: 11 }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'sym:src/routes.ts#handle', targetId: 'sym:src/routes.ts#handle', name: 'handle', confidence: 'INFERRED', line: 12 }))
    .addEdge(edge({ type: 'CALLS', sourceId: 'file:src/svc.ts', targetId: 'sym:src/svc.ts#AuthService', name: 'AuthService', confidence: 'INFERRED', line: 13 }))
    .addEdge(edge({ type: 'READS', sourceId: 'sym:src/svc.ts#AuthService', targetId: 'env:PORT', name: 'PORT', confidence: 'INFERRED' }))
    .addEdge(edge({ type: 'READS', sourceId: 'sym:src/routes.ts#handle', targetId: 'env:PORT', name: 'PORT', confidence: 'INFERRED', line: 9 }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: 'file:src/routes.ts', targetId: 'ext:npm:express', line: 1 }))
    .addEdge(edge({ type: 'IMPORTS', sourceId: 'file:src/svc.ts', targetId: 'ext:node:fs', confidence: 'CERTAIN' }));

  fake
    .addRole(role({ nodeId: 'sym:src/routes.ts#AuthController', role: 'Controller' }))
    .addRole(role({ nodeId: 'sym:src/svc.ts#AuthService', role: 'Service' }))
    .addRole(role({ nodeId: 'sym:src/svc.ts#UserRepository', role: 'Repository' }))
    .addRole(role({ nodeId: 'sym:src/routes.ts#requireAuth', role: 'Middleware' }));

  fake
    .addUnresolved(unresolved({ type: 'IMPORTS', sourceId: 'file:src/routes.ts', reason: 'module-not-resolved', text: './nowhere' }))
    .addUnresolved(
      unresolved({ type: 'HANDLED_BY', sourceId: 'route:GET:/users/:id', reason: 'handler-not-linked', text: 'controller.show', name: 'controller.show' }),
    );

  return fake;
}

let fake: FakeGraph;
let engine: QueryEngine;

beforeEach(() => {
  fake = graph();
  engine = new QueryEngine(fake);
});

describe('findDeclaration', () => {
  it('returns the declaration with its roles', () => {
    const result = engine.findDeclaration(id('sym:src/routes.ts#AuthController'));

    expect(result?.node.name).toBe('AuthController');
    expect(result?.roles.map((entry) => entry.role)).toEqual(['Controller']);
  });

  it('preserves confidence, provenance and locations', () => {
    const result = engine.findDeclaration(id('sym:src/svc.ts#AuthService'));

    expect(result?.node.confidence).toBe('CERTAIN');
    expect(result?.node.provenance.evidence.length).toBeGreaterThan(10);
    expect(result?.node.locations.length).toBeGreaterThan(0);
  });

  it('returns no roles for a declaration carrying none', () => {
    expect(engine.findDeclaration(id('sym:src/svc.ts#Shape'))?.roles).toEqual([]);
  });

  it('returns null for an identifier that is not in the graph', () => {
    expect(engine.findDeclaration(id('sym:src/svc.ts#Absent'))).toBeNull();
  });

  it.each(['file:src/routes.ts', 'route:POST:/login', 'env:PORT', 'ext:npm:express'])(
    'returns null for %s, which is not a declaration',
    (value) => {
      expect(engine.findDeclaration(id(value))).toBeNull();
    },
  );
});

describe('findEnclosingDeclaration', () => {
  it('returns the declaration containing this one, with the DECLARES edge', () => {
    const result = engine.findEnclosingDeclaration(id('sym:src/routes.ts#AuthController.login'));

    expect(result?.declaration?.id).toBe('sym:src/routes.ts#AuthController');
    expect(result?.edge.type).toBe('DECLARES');
  });

  it('returns null when a file declares it, a file not being a declaration', () => {
    expect(engine.findEnclosingDeclaration(id('sym:src/routes.ts#AuthController'))).toBeNull();
  });

  it('returns null for a declaration nothing declares', () => {
    expect(engine.findEnclosingDeclaration(id('sym:src/svc.ts#Shape'))).toBeNull();
  });

  it('costs one incoming lookup and one node read', () => {
    fake.resetCalls();
    engine.findEnclosingDeclaration(id('sym:src/routes.ts#AuthController.login'));

    expect(fake.calls.getIncoming).toBe(1);
    expect(fake.calls.getNode).toBe(1);
  });

  it('is the one place containment is reported, findReferences excluding it', () => {
    const id_ = id('sym:src/routes.ts#AuthController.login');

    expect(engine.findReferences(id_).some((entry) => entry.edge.type === 'DECLARES')).toBe(false);
    expect(engine.findEnclosingDeclaration(id_)).not.toBeNull();
  });
});

describe('findReferences', () => {
  it('returns everything referring to a node, with the referring node attached', () => {
    const references = engine.findReferences(id('sym:src/svc.ts#Shape'));

    expect(references.map((entry) => entry.edge.type).sort()).toEqual([
      'IMPORTS',
      'REFERENCES_TYPE',
    ]);
    expect(references.every((entry) => entry.source !== null)).toBe(true);
  });

  it('excludes DECLARES, containment not being a reference', () => {
    const references = engine.findReferences(id('sym:src/routes.ts#AuthController.login'));

    expect(references.map((entry) => entry.edge.type)).toEqual(['HANDLED_BY']);
  });

  it('preserves each edge’s confidence, provenance and location', () => {
    for (const reference of engine.findReferences(id('env:PORT'))) {
      expect(reference.edge.confidence).toBe('INFERRED');
      expect(reference.edge.provenance.evidence.length).toBeGreaterThan(10);
      expect(reference.edge.location.startLine).toBeGreaterThan(0);
    }
  });

  it('returns nothing for a node nothing refers to', () => {
    expect(engine.findReferences(id('sym:src/svc.ts#UserRepository'))).toEqual([]);
  });
});

describe('findCallers and findCallees', () => {
  it('returns what calls a declaration, with the caller attached', () => {
    const callers = engine.findCallers(id('sym:src/svc.ts#AuthService'));

    expect(callers.map((entry) => entry.source?.id).sort()).toEqual([
      'file:src/svc.ts',
      'sym:src/routes.ts#handle',
    ]);
  });

  it('returns what a declaration calls, with the target attached', () => {
    const callees = engine.findCallees(id('sym:src/routes.ts#handle'));

    expect(callees.map((entry) => entry.target?.id).sort()).toEqual([
      'sym:src/routes.ts#handle',
      'sym:src/svc.ts#AuthService',
    ]);
  });

  it('reports recursion in both directions', () => {
    const self = id('sym:src/routes.ts#handle');

    expect(engine.findCallers(self).some((entry) => entry.source?.id === self)).toBe(true);
    expect(engine.findCallees(self).some((entry) => entry.target?.id === self)).toBe(true);
  });

  it('accepts a file as a caller, a module-level call having no declaration', () => {
    expect(engine.findCallees(id('file:src/svc.ts')).map((entry) => entry.target?.name)).toEqual([
      'AuthService',
    ]);
  });

  it('returns only CALLS, not every edge', () => {
    for (const entry of engine.findCallers(id('sym:src/svc.ts#AuthService'))) {
      expect(entry.edge.type).toBe('CALLS');
    }
  });

  it('preserves call confidence, provenance and location', () => {
    for (const entry of engine.findCallees(id('sym:src/routes.ts#handle'))) {
      expect(entry.edge.confidence).toBe('INFERRED');
      expect(entry.edge.provenance.evidence.length).toBeGreaterThan(10);
      expect(entry.edge.location.startLine).toBeGreaterThan(0);
    }
  });

  it('returns nothing for a declaration in no call relationship', () => {
    expect(engine.findCallers(id('sym:src/svc.ts#Shape'))).toEqual([]);
    expect(engine.findCallees(id('sym:src/svc.ts#Shape'))).toEqual([]);
  });

  it('includes calls in findReferences, CALLS being a reference', () => {
    expect(
      engine.findReferences(id('sym:src/svc.ts#AuthService')).some((entry) => entry.edge.type === 'CALLS'),
    ).toBe(true);
  });

  it('stays one step: a callee of a callee is not returned', () => {
    // handle → AuthService, and AuthService reads PORT. Neither is transitive.
    const callees = engine.findCallees(id('sym:src/routes.ts#handle'));

    expect(callees.every((entry) => entry.edge.type === 'CALLS')).toBe(true);
    expect(callees.map((entry) => entry.target?.id)).not.toContain('env:PORT');
  });
});

describe('findTypeReferences', () => {
  it('returns only references from a type position', () => {
    const typeReferences = engine.findTypeReferences(id('sym:src/svc.ts#Shape'));

    expect(typeReferences.map((entry) => entry.edge.type)).toEqual(['REFERENCES_TYPE']);
    expect(typeReferences[0]?.source?.name).toBe('handle');
  });

  it('returns nothing where a node is referenced only in other ways', () => {
    expect(engine.findTypeReferences(id('ext:npm:express'))).toEqual([]);
  });
});

describe('findRoutes', () => {
  it('returns every route with its method and path', () => {
    expect(engine.findRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /users/:id',
      'POST /login',
    ]);
  });

  it('keeps a path containing parameter colons intact', () => {
    // `route:GET:/users/:id` has three colons; only the first two are separators.
    expect(engine.findRoutes().find((route) => route.method === 'GET')?.path).toBe('/users/:id');
  });

  it('orders handlers by ordinal, so middleware order survives', () => {
    const login = engine.findRoutes().find((route) => route.path === '/login');

    expect(login?.handlers.map((entry) => entry.edge.ordinal)).toEqual([0, 1]);
    expect(login?.handlers.map((entry) => entry.declaration?.name)).toEqual([
      'requireAuth',
      'login',
    ]);
  });

  it('preserves route confidence and provenance', () => {
    for (const route of engine.findRoutes()) {
      expect(route.node.provenance.evidence.length).toBeGreaterThan(10);
      expect(route.handlers.every((entry) => entry.edge.confidence === 'INFERRED')).toBe(true);
    }
  });
});

describe('route path composition', () => {
  it('reports honestly that no prefix could be composed', () => {
    // A mount is written `app.use('/api', router)`. The IR records that call, but the
    // Framework Extractor keeps only the middleware and discards the path, so nothing in
    // the graph says where a router is mounted.
    const route = engine.findRoutes()[0];

    expect(route?.composition.composed).toBe(false);
    expect(route?.composition.prefixes).toEqual([]);
    expect(route?.composition.note).toMatch(/no mount information/);
  });

  it('reports the effective path as the local one, never a guess', () => {
    const login = engine.findRoutes().find((route) => route.path === '/login');

    expect(login?.composition.effectivePath).toBe('/login');
  });

  it('composes per query rather than storing a composed path', () => {
    // Nothing is written back, so two reads compute the same answer independently.
    expect(engine.findRoutes()).toEqual(engine.findRoutes());
  });
});

describe('explainRoute', () => {
  it('splits the chain into middleware and final handler', () => {
    const explanation = engine.explainRoute(id('route:POST:/login'));

    expect(explanation?.middleware.map((entry) => entry.declaration?.name)).toEqual([
      'requireAuth',
    ]);
    expect(explanation?.handler?.declaration?.name).toBe('login');
  });

  it('treats a single handler as the handler, with no middleware', () => {
    const explanation = engine.explainRoute(id('route:GET:/users/:id'));

    expect(explanation?.middleware).toEqual([]);
    expect(explanation?.handler?.declaration?.name).toBe('handle');
  });

  it('surfaces handlers the pipeline could not link', () => {
    const explanation = engine.explainRoute(id('route:GET:/users/:id'));

    expect(explanation?.unresolvedHandlers.map((entry) => entry.text)).toEqual([
      'controller.show',
    ]);
  });

  it('does not attribute another route’s unresolved handler', () => {
    expect(engine.explainRoute(id('route:POST:/login'))?.unresolvedHandlers).toEqual([]);
  });

  it('returns null for something that is not a route', () => {
    expect(engine.explainRoute(id('sym:src/svc.ts#AuthService'))).toBeNull();
    expect(engine.explainRoute(id('route:GET:/absent'))).toBeNull();
  });
});

describe('findEnvironmentVariables', () => {
  it('returns each variable with every read of it', () => {
    const variables = engine.findEnvironmentVariables();

    expect(variables.map((entry) => entry.node.name)).toEqual(['PORT']);
    expect(variables[0]?.reads).toHaveLength(2);
  });

  it('attaches the declaration performing each read', () => {
    expect(
      engine.findEnvironmentVariables()[0]?.reads.map((entry) => entry.source?.name).sort(),
    ).toEqual(['AuthService', 'handle']);
  });

  it('preserves read confidence and location', () => {
    for (const read of engine.findEnvironmentVariables()[0]?.reads ?? []) {
      expect(read.edge.confidence).toBe('INFERRED');
      expect(read.edge.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('findDependencies', () => {
  it('returns every external with the files importing it', () => {
    const dependencies = engine.findDependencies();

    expect(dependencies.map((entry) => entry.node.id)).toEqual(['ext:node:fs', 'ext:npm:express']);
    expect(dependencies.find((entry) => entry.node.externalName === 'express')?.importedBy).toHaveLength(1);
  });

  it('distinguishes a package from a Node builtin', () => {
    expect(
      engine.findDependencies().map((entry) => entry.node.externalKind),
    ).toEqual(['node', 'npm']);
  });

  it('preserves the confidence of each import', () => {
    const builtin = engine.findDependencies().find((entry) => entry.node.externalKind === 'node');

    expect(builtin?.importedBy[0]?.edge.confidence).toBe('CERTAIN');
  });
});

describe('roles', () => {
  it('finds controllers', () => {
    expect(engine.findControllers().map((entry) => entry.node.name)).toEqual(['AuthController']);
  });

  it('finds services', () => {
    expect(engine.findServices().map((entry) => entry.node.name)).toEqual(['AuthService']);
  });

  it('finds repositories', () => {
    expect(engine.findRepositories().map((entry) => entry.node.name)).toEqual(['UserRepository']);
  });

  it('finds any role through the general operation', () => {
    expect(engine.findByRole('Middleware').map((entry) => entry.node.name)).toEqual(['requireAuth']);
  });

  it('reports which role matched, and every role the node carries', () => {
    const controller = engine.findControllers()[0];

    expect(controller?.matched).toBe('Controller');
    expect(controller?.roles.map((entry) => entry.role)).toEqual(['Controller']);
  });

  it('preserves role confidence and evidence', () => {
    const service = engine.findServices()[0];

    expect(service?.roles[0]?.confidence).toBe('INFERRED');
    expect(service?.roles[0]?.evidence.length).toBeGreaterThan(10);
  });

  it('returns nothing for a role no declaration carries', () => {
    expect(engine.findByRole('Model')).toEqual([]);
  });
});

describe('findUnresolved', () => {
  it('returns every unresolved reference with its source node', () => {
    const results = engine.findUnresolved();

    expect(results).toHaveLength(2);
    expect(results.every((entry) => entry.source !== null)).toBe(true);
  });

  it('preserves the reason, the text and the explanation', () => {
    const module = engine.findUnresolved().find((entry) => entry.reference.text === './nowhere');

    expect(module?.reference.reason).toBe('module-not-resolved');
    expect(module?.reference.provenance.evidence.length).toBeGreaterThan(10);
  });
});

describe('determinism', () => {
  it.each([
    ['findRoutes', () => engine.findRoutes()],
    ['findEnvironmentVariables', () => engine.findEnvironmentVariables()],
    ['findDependencies', () => engine.findDependencies()],
    ['findUnresolved', () => engine.findUnresolved()],
    ['findControllers', () => engine.findControllers()],
  ] as const)('%s answers identically on repeated calls', (_name, run) => {
    expect(run()).toEqual(run());
  });

  it('returns plain data that survives a JSON round trip', () => {
    const routes = engine.findRoutes();

    expect(JSON.parse(JSON.stringify(routes))).toEqual(routes);
  });
});

describe('bounded traversal', () => {
  it('reaches no further than two steps for a route', () => {
    fake.resetCalls();
    engine.findRoutes();

    // One getNodes, one getOutgoing per route, one getNode per handler. Nothing recursive.
    expect(fake.calls.getNodes).toBe(1);
    expect(fake.calls.getOutgoing).toBe(2);
    expect(fake.calls.getNode).toBe(3);
    expect(fake.calls.getIncoming).toBe(0);
  });

  it('answers a declaration lookup in two calls', () => {
    fake.resetCalls();
    engine.findDeclaration(id('sym:src/svc.ts#AuthService'));

    expect(fake.calls.getNode).toBe(1);
    expect(fake.calls.getRoles).toBe(1);
  });

  it('uses the type filter rather than reading and discarding', () => {
    fake.resetCalls();
    engine.findTypeReferences(id('sym:src/svc.ts#Shape'));

    expect(fake.calls.getIncoming).toBe(1);
  });

  it('scans only role-bearing kinds when looking for a role', () => {
    fake.resetCalls();
    engine.findServices();

    // Class, Function and Variable — not every declaration kind.
    expect(fake.calls.getNodes).toBe(3);
  });
});
