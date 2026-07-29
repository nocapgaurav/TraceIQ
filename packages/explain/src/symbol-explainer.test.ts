import type { RouteExplanation, RouteResult } from '@traceiq/query';
import type { NodeId } from '@traceiq/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeQueries, edge, node, reference, role, unresolved } from './fake-queries.test-helper.js';
import { SymbolExplainer } from './symbol-explainer.js';
import { LIMITATION_CODES, type LimitationCode } from './types.js';

const SUBJECT = 'sym:src/auth/user.service.ts#UserService.login' as NodeId;
const FILE = 'file:src/auth/user.service.ts';
const OTHER_FILE = 'file:src/other.ts';

const subject = node({ id: SUBJECT, kind: 'Method', fileId: FILE, lines: [12, 40] });
const owner = node({ id: 'sym:src/auth/user.service.ts#UserService', kind: 'Class', fileId: FILE });
const caller = node({ id: 'sym:src/auth/routes.ts#handleLogin', kind: 'Function', fileId: 'file:src/auth/routes.ts' });
const typeUser = node({ id: 'sym:src/auth/dto.ts#LoginDto', kind: 'Interface', fileId: 'file:src/auth/dto.ts' });
const repository = node({ id: 'sym:src/db/user.repo.ts#UserRepository.find', kind: 'Method', fileId: 'file:src/db/user.repo.ts' });
const middleware = node({ id: 'sym:src/auth/routes.ts#requireAuth', kind: 'Function', fileId: 'file:src/auth/routes.ts' });
const secret = node({ id: 'env:JWT_SECRET', kind: 'EnvironmentVariable' });
const port = node({ id: 'env:PORT', kind: 'EnvironmentVariable' });
const express = node({ id: 'ext:npm:express', kind: 'External' });
const zod = node({ id: 'ext:npm:zod', kind: 'External' });
const routeNode = node({ id: 'route:POST:/login', kind: 'Route' });
const healthNode = node({ id: 'route:GET:/health', kind: 'Route' });

const callIn = edge({ type: 'CALLS', sourceId: caller.id, targetId: SUBJECT, confidence: 'INFERRED' });
const typeIn = edge({ type: 'REFERENCES_TYPE', sourceId: typeUser.id, targetId: SUBJECT });
const importIn = edge({ type: 'IMPORTS', sourceId: FILE, targetId: SUBJECT });
const callOut = edge({ type: 'CALLS', sourceId: SUBJECT, targetId: repository.id, confidence: 'INFERRED' });
const declaresIn = edge({ type: 'DECLARES', sourceId: owner.id, targetId: SUBJECT, confidence: 'CERTAIN' });

const middlewareEdge = edge({ type: 'HANDLED_BY', sourceId: routeNode.id, targetId: middleware.id, ordinal: 0 });
const handlerEdge = edge({ type: 'HANDLED_BY', sourceId: routeNode.id, targetId: SUBJECT, ordinal: 1 });

const composition = {
  composed: false,
  prefixes: [],
  effectivePath: '/login',
  note: 'no mount information is recorded in the graph',
} as const;

const loginRoute: RouteResult = {
  node: routeNode,
  method: 'POST',
  path: '/login',
  composition,
  handlers: [
    { edge: middlewareEdge, declaration: middleware },
    { edge: handlerEdge, declaration: subject },
  ],
};

const loginExplanation: RouteExplanation = {
  route: loginRoute,
  middleware: [{ edge: middlewareEdge, declaration: middleware }],
  handler: { edge: handlerEdge, declaration: subject },
  unresolvedHandlers: [],
};

const healthHandlerEdge = edge({
  type: 'HANDLED_BY',
  sourceId: healthNode.id,
  targetId: middleware.id,
  ordinal: 0,
});

const healthRoute: RouteResult = {
  node: healthNode,
  method: 'GET',
  path: '/health',
  composition: { ...composition, effectivePath: '/health' },
  handlers: [{ edge: healthHandlerEdge, declaration: middleware }],
};

const healthExplanation: RouteExplanation = {
  route: healthRoute,
  middleware: [],
  handler: { edge: healthHandlerEdge, declaration: middleware },
  unresolvedHandlers: [],
};

let queries: FakeQueries;
let explainer: SymbolExplainer;

beforeEach(() => {
  queries = new FakeQueries();
  queries.declaration = { node: subject, roles: [] };
  queries.enclosing = { edge: declaresIn, declaration: owner };
  // Deliberately includes an edge that is neither a call nor a type reference, so the
  // projections can be shown to select rather than to pass everything through.
  queries.references = [
    reference(caller, callIn),
    reference(typeUser, typeIn),
    reference(node({ id: FILE, kind: 'File' }), importIn),
  ];
  queries.callees = [{ edge: callOut, target: repository }];
  queries.routes = [loginRoute, healthRoute];
  queries.explanations = new Map([
    [routeNode.id, loginExplanation],
    [healthNode.id, healthExplanation],
  ]);
  queries.environmentVariables = [
    {
      node: secret,
      reads: [reference(subject, edge({ type: 'READS', sourceId: SUBJECT, targetId: secret.id }))],
    },
    {
      node: port,
      reads: [reference(caller, edge({ type: 'READS', sourceId: caller.id, targetId: port.id }))],
    },
  ];
  queries.dependencies = [
    {
      node: express,
      importedBy: [
        reference(node({ id: FILE, kind: 'File' }), edge({ type: 'IMPORTS', sourceId: FILE, targetId: express.id })),
      ],
    },
    {
      node: zod,
      importedBy: [
        reference(node({ id: OTHER_FILE, kind: 'File' }), edge({ type: 'IMPORTS', sourceId: OTHER_FILE, targetId: zod.id })),
      ],
    },
  ];
  queries.unresolvedReferences = [
    { reference: unresolved({ type: 'CALLS', sourceId: SUBJECT, text: 'hash(password)' }), source: subject },
    { reference: unresolved({ type: 'IMPORTS', sourceId: FILE, text: 'bcrypt' }), source: null },
    { reference: unresolved({ type: 'CALLS', sourceId: caller.id, text: 'elsewhere()' }), source: caller },
  ];
  queries.resetCalls();
  explainer = new SymbolExplainer(queries);
});

const explain = () => explainer.explain(SUBJECT);

const codesOf = (): readonly LimitationCode[] =>
  (explain()?.limitations ?? []).map((entry) => entry.code);

describe('the declaration itself', () => {
  it('returns the declaration with its roles, not a copy of selected fields', () => {
    expect(explain()?.declaration).toEqual({ node: subject, roles: [] });
  });

  it('reports the declaration kind', () => {
    expect(explain()?.kind).toBe('Method');
  });

  it('reports the source file as an identifier and the path inside it', () => {
    expect(explain()?.sourceFile).toEqual({ id: FILE, path: 'src/auth/user.service.ts' });
  });

  it('reports every source location, so an overload set keeps all of them', () => {
    expect(explain()?.locations.map((entry) => entry.startLine)).toEqual([12, 40]);
  });

  it('reports the enclosing declaration with the DECLARES edge establishing it', () => {
    expect(explain()?.enclosingDeclaration).toEqual({ edge: declaresIn, declaration: owner });
  });

  it('carries the declaration confidence and provenance', () => {
    expect(explain()?.confidence).toBe('CERTAIN');
    expect(explain()?.provenance.producer).toBe('graph-builder');
  });
});

describe('calls and references', () => {
  it('reports incoming calls', () => {
    expect(explain()?.incomingCalls.map((entry) => entry.edge.sourceId)).toEqual([caller.id]);
  });

  it('reports outgoing calls with the declaration each reaches', () => {
    expect(explain()?.outgoingCalls).toEqual([{ edge: callOut, target: repository }]);
  });

  it('reports every reference, including those that are neither calls nor type positions', () => {
    expect(explain()?.references.map((entry) => entry.edge.type)).toEqual([
      'CALLS',
      'REFERENCES_TYPE',
      'IMPORTS',
    ]);
  });

  it('reports type references', () => {
    expect(explain()?.typeReferences.map((entry) => entry.edge.sourceId)).toEqual([typeUser.id]);
  });

  it('makes incoming calls and type references subsets of references', () => {
    // They are projections of one query rather than separate ones, so this holds by
    // construction instead of by coincidence.
    const result = explain();
    const references = result?.references ?? [];

    for (const entry of [...(result?.incomingCalls ?? []), ...(result?.typeReferences ?? [])]) {
      expect(references).toContain(entry);
    }
  });

  it('excludes DECLARES from references, containment not being a reference', () => {
    expect(explain()?.references.some((entry) => entry.edge.type === 'DECLARES')).toBe(false);
  });
});

describe('routes reaching the declaration', () => {
  it('reports the route whose chain reaches it, and no other', () => {
    expect(explain()?.routes.map((entry) => entry.explanation.route.path)).toEqual(['/login']);
  });

  it('reports where in the chain it sits, with the ordinal from the edge', () => {
    expect(explain()?.routes[0]).toMatchObject({ position: 'handler', ordinal: 1 });
  });

  it('reports the whole explanation, so middleware order survives', () => {
    expect(explain()?.routes[0]?.explanation.middleware.map((entry) => entry.declaration?.id)).toEqual([
      middleware.id,
    ]);
  });

  it('reports a middleware position when the declaration is not the final handler', () => {
    // `requireAuth` is middleware on /login and the only handler on /health, so the two
    // occurrences must be positioned differently.
    queries.declaration = { node: middleware, roles: [] };
    queries.resetCalls();

    const result = explainer.explain(middleware.id);

    expect(
      result?.routes.map((entry) => `${entry.explanation.route.path} ${entry.position}`),
    ).toEqual(['/login middleware', '/health handler']);
  });

  it('reports one entry per occurrence when a declaration appears twice in one chain', () => {
    const twice = edge({ type: 'HANDLED_BY', sourceId: routeNode.id, targetId: SUBJECT, ordinal: 2, line: 9 });

    queries.routes = [{ ...loginRoute, handlers: [...loginRoute.handlers, { edge: twice, declaration: subject }] }];
    queries.resetCalls();

    expect(explain()?.routes.map((entry) => entry.ordinal)).toEqual([1, 2]);
  });

  it('reports no route when none reaches it', () => {
    queries.routes = [healthRoute];
    queries.resetCalls();

    expect(explain()?.routes).toEqual([]);
  });
});

describe('environment variables, externals and unresolved references', () => {
  it('reports only the variables this declaration reads', () => {
    expect(explain()?.environmentVariables.map((entry) => entry.node.id)).toEqual([secret.id]);
  });

  it('reports only this declaration reads of a variable, not every read of it', () => {
    queries.environmentVariables = [
      {
        node: secret,
        reads: [
          reference(caller, edge({ type: 'READS', sourceId: caller.id, targetId: secret.id })),
          reference(subject, edge({ type: 'READS', sourceId: SUBJECT, targetId: secret.id, line: 3 })),
        ],
      },
    ];
    queries.resetCalls();

    expect(explain()?.environmentVariables[0]?.reads.map((entry) => entry.edge.sourceId)).toEqual([
      SUBJECT,
    ]);
  });

  it('reports externals imported by the containing file, and no other file', () => {
    expect(explain()?.externalDependencies.map((entry) => entry.node.id)).toEqual([express.id]);
  });

  it('labels an unresolved reference recorded at this declaration', () => {
    const own = explain()?.unresolved.filter((entry) => entry.scope === 'declaration');

    expect(own?.map((entry) => entry.result.reference.text)).toEqual(['hash(password)']);
  });

  it('labels an unresolved reference recorded at the containing file', () => {
    const file = explain()?.unresolved.filter((entry) => entry.scope === 'file');

    expect(file?.map((entry) => entry.result.reference.text)).toEqual(['bcrypt']);
  });

  it('excludes an unresolved reference recorded elsewhere', () => {
    expect(explain()?.unresolved.map((entry) => entry.result.reference.text)).not.toContain(
      'elsewhere()',
    );
  });
});

describe('limitations', () => {
  it('uses only codes from the closed vocabulary', () => {
    for (const code of codesOf()) {
      expect(LIMITATION_CODES).toContain(code);
    }
  });

  it('emits them in the vocabulary order, whatever fired', () => {
    const emitted = codesOf();
    const expected = LIMITATION_CODES.filter((code) => emitted.includes(code));

    expect(emitted).toEqual(expected);
  });

  it('always reports the ones that are unconditionally true', () => {
    expect(codesOf()).toEqual(
      expect.arrayContaining([
        'call-coverage-partial',
        'no-transitive-reach',
        'source-file-node-not-reachable',
      ]),
    );
  });

  it('leaves a general limitation with no count', () => {
    const general = explain()?.limitations.find((entry) => entry.code === 'no-transitive-reach');

    expect(general?.affected).toBeNull();
  });

  it('counts the parts a conditional limitation bears on', () => {
    const inferred = explain()?.limitations.find((entry) => entry.code === 'calls-are-inferred');

    // One incoming and one outgoing call, both INFERRED.
    expect(inferred?.affected).toBe(2);
  });

  it('reports an unbound call this declaration makes', () => {
    const unbound = explain()?.limitations.find(
      (entry) => entry.code === 'unbound-calls-at-this-declaration',
    );

    expect(unbound?.affected).toBe(1);
  });

  it('does not report a conditional limitation that does not apply', () => {
    expect(codesOf()).not.toContain('roles-are-judgements');
    expect(codesOf()).not.toContain('ambiguous-relationships');
  });

  it('reports roles as judgements when the declaration carries one', () => {
    queries.declaration = { node: subject, roles: [role(SUBJECT, 'Service')] };
    queries.resetCalls();

    expect(codesOf()).toContain('roles-are-judgements');
  });

  it('reports ambiguity when a relationship carries a candidate group', () => {
    queries.references = [
      reference(caller, edge({ type: 'CALLS', sourceId: caller.id, targetId: SUBJECT, candidateGroup: 'g1' })),
    ];
    queries.resetCalls();

    expect(codesOf()).toContain('ambiguous-relationships');
  });

  it('reports uncomposed route paths only when a route reaches it', () => {
    expect(codesOf()).toContain('route-prefixes-not-composed');

    queries.routes = [];
    queries.resetCalls();

    expect(codesOf()).not.toContain('route-prefixes-not-composed');
  });

  it('states each limitation in text fixed by its code, never composed', () => {
    // The same code always carries the same words, so a consumer can match on the code and
    // no number is ever interpolated into the prose.
    const first = explain()?.limitations ?? [];

    queries.resetCalls();

    const second = explainer.explain(SUBJECT)?.limitations ?? [];

    for (const [index, entry] of first.entries()) {
      expect(second[index]?.detail).toBe(entry.detail);
      expect(entry.detail).not.toMatch(/\d/);
    }
  });
});

describe('the query budget', () => {
  it('asks each question exactly once', () => {
    explain();

    expect(queries.calls).toEqual({
      findDeclaration: 1,
      findEnclosingDeclaration: 1,
      findReferences: 1,
      findCallees: 1,
      findRoutes: 1,
      // One per route that actually reaches the declaration, which is one of two here.
      explainRoute: 1,
      findEnvironmentVariables: 1,
      findDependencies: 1,
      findUnresolved: 1,
    });
  });

  it('asks nothing further when the identifier is not a declaration', () => {
    queries.declaration = null;
    queries.resetCalls();

    expect(explainer.explain(SUBJECT)).toBeNull();
    expect(queries.calls.findDeclaration).toBe(1);
    expect(Object.values(queries.calls).reduce((total, count) => total + count, 0)).toBe(1);
  });

  it('asks about no route when none reaches the declaration', () => {
    queries.routes = [healthRoute];
    queries.resetCalls();
    explain();

    expect(queries.calls.explainRoute).toBe(0);
  });
});

describe('explainability and determinism', () => {
  it('returns null for an identifier that names no declaration', () => {
    queries.declaration = null;

    expect(explainer.explain('file:src/auth/user.service.ts' as NodeId)).toBeNull();
  });

  it('produces an identical result from identical answers', () => {
    const first = explain();

    queries.resetCalls();

    expect(explainer.explain(SUBJECT)).toEqual(first);
  });

  it('produces plain data that survives a JSON round trip', () => {
    const result = explain();

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('carries the graph edge behind every relationship it reports', () => {
    const result = explain();
    const withEdges = [
      ...(result?.references ?? []),
      ...(result?.incomingCalls ?? []),
      ...(result?.typeReferences ?? []),
      ...(result?.outgoingCalls ?? []),
    ];

    expect(withEdges.length).toBeGreaterThan(0);

    for (const entry of withEdges) {
      expect(entry.edge.provenance.evidence.length).toBeGreaterThan(0);
      expect(entry.edge.location.startLine).toBeGreaterThan(0);
    }
  });

  it('sorts nothing, so every list stays in the order the Query Engine gave it', () => {
    const reversed = [...queries.references].reverse();

    queries.references = reversed;
    queries.resetCalls();

    expect(explain()?.references).toEqual(reversed);
  });
});
