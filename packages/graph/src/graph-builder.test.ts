import { describe, expect, it } from 'vitest';

import { GraphConstraintError } from './constraints.js';
import { GraphBuilder, PLACEHOLDER_REVISION_ID } from './graph-builder.js';
import {
  annotations,
  declaration,
  declarationTarget,
  enrichment,
  externalTarget,
  file,
  fileTarget,
  ir,
  relationship,
  resolved,
  roleAnnotation,
  unresolvedReference,
} from './graph-fixture.test-helper.js';
import { NODE_KINDS, type GraphNode, type RepositoryGraph } from './types.js';

const builder = new GraphBuilder();

const node = (graph: RepositoryGraph, id: string): GraphNode | undefined =>
  graph.nodes.find((entry) => entry.id === id);

describe('nodes', () => {
  it('creates a File node per IR file, with no location', () => {
    const graph = builder.build({
      ir: ir({ files: [file('src/a.ts'), file('src/b.d.ts', true)] }),
      resolved: resolved({}),
    });

    expect(graph.nodes.map((entry) => entry.kind)).toEqual(['File', 'File']);
    expect(node(graph, 'file:src/a.ts')).toMatchObject({
      name: 'src/a.ts',
      fileId: null,
      isDeclarationFile: null,
      confidence: 'CERTAIN',
      locations: [],
    });
    expect(node(graph, 'file:src/b.d.ts')?.isDeclarationFile).toBe(true);
  });

  it.each([
    ['class', 'Class'],
    ['interface', 'Interface'],
    ['type-alias', 'TypeAlias'],
    ['enum', 'Enum'],
    ['enum-member', 'EnumMember'],
    ['function', 'Function'],
    ['method', 'Method'],
    ['property', 'Property'],
    ['accessor', 'Accessor'],
    ['constructor', 'Constructor'],
    ['variable', 'Variable'],
    ['namespace', 'Namespace'],
  ] as const)('maps the IR kind %s to the node kind %s', (irKind, nodeKind) => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['Thing'], kind: irKind })],
      }),
      resolved: resolved({}),
    });

    expect(node(graph, 'sym:a.ts#Thing')?.kind).toBe(nodeKind);
  });

  it('uses only kinds from the published vocabulary', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
      }),
      resolved: resolved({
        relationships: [
          relationship({
            type: 'IMPORTS',
            sourceId: 'file:a.ts',
            target: externalTarget('package', 'express'),
          }),
        ],
      }),
    });

    for (const entry of graph.nodes) {
      expect(NODE_KINDS).toContain(entry.kind);
    }
  });

  it('copies declaration modifiers, visibility and locations', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [
          declaration({
            path: 'a.ts',
            chain: ['C', 'field'],
            kind: 'property',
            visibility: 'protected',
            modifiers: { isStatic: true, isReadonly: true },
            lines: [4, 9],
          }),
        ],
      }),
      resolved: resolved({}),
    });

    expect(node(graph, 'sym:a.ts#C.field')).toMatchObject({
      visibility: 'protected',
      isStatic: true,
      isReadonly: true,
      isAsync: false,
      containerChain: 'C.field',
      fileId: 'file:a.ts',
    });
    expect(node(graph, 'sym:a.ts#C.field')?.locations).toHaveLength(2);
  });

  it('records every declaration site, as a merged interface or an overload set has', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [
          declaration({ path: 'a.ts', chain: ['Merged'], kind: 'interface', lines: [1, 7, 12] }),
        ],
      }),
      resolved: resolved({}),
    });

    expect(node(graph, 'sym:a.ts#Merged')?.locations.map((entry) => entry.startLine)).toEqual([
      1, 7, 12,
    ]);
  });
});

describe('declaration enrichment', () => {
  it('copies the checker-confirmed facts', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
      }),
      resolved: resolved({
        declarations: [
          enrichment({ declarationId: 'sym:a.ts#C', hasSymbol: true, isExportedFromModule: true }),
        ],
      }),
    });

    expect(node(graph, 'sym:a.ts#C')).toMatchObject({
      hasSymbol: true,
      isExportedFromModule: true,
    });
  });

  it('leaves enrichment null when the Resolver recorded none, never false', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
      }),
      resolved: resolved({}),
    });

    expect(node(graph, 'sym:a.ts#C')).toMatchObject({
      hasSymbol: null,
      isExportedFromModule: null,
    });
  });

  it('carries the Resolver evidence alongside its own', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
      }),
      resolved: resolved({ declarations: [enrichment({ declarationId: 'sym:a.ts#C' })] }),
    });

    const evidence = node(graph, 'sym:a.ts#C')?.provenance.evidence ?? '';

    expect(evidence).toContain('recorded by the IR Builder as a class declaration');
    expect(evidence).toContain('synthetic enrichment for testing');
  });
});

describe('DECLARES edges', () => {
  const declaresFor = (targetId: string, graph: RepositoryGraph) =>
    graph.edges.find((entry) => entry.type === 'DECLARES' && entry.targetId === targetId);

  it('sources a top-level declaration at its file', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
      }),
      resolved: resolved({}),
    });

    expect(declaresFor('sym:a.ts#C', graph)?.sourceId).toBe('file:a.ts');
  });

  it('sources a member at its container', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [
          declaration({ path: 'a.ts', chain: ['C'] }),
          declaration({ path: 'a.ts', chain: ['C', 'm'], kind: 'method' }),
        ],
      }),
      resolved: resolved({}),
    });

    expect(declaresFor('sym:a.ts#C.m', graph)?.sourceId).toBe('sym:a.ts#C');
  });

  it('emits exactly one DECLARES edge per declaration', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [
          declaration({ path: 'a.ts', chain: ['C'] }),
          declaration({ path: 'a.ts', chain: ['C', 'm'], kind: 'method' }),
          declaration({ path: 'a.ts', chain: ['C', 'p'], kind: 'property' }),
        ],
      }),
      resolved: resolved({}),
    });

    expect(graph.edges.filter((entry) => entry.type === 'DECLARES')).toHaveLength(3);
  });

  it('is always CERTAIN, being derived from syntax alone', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
      }),
      resolved: resolved({}),
    });

    expect(declaresFor('sym:a.ts#C', graph)).toMatchObject({ confidence: 'CERTAIN' });
  });

  it('falls back to the file for a dotted namespace whose outer segment is undeclared', () => {
    // `namespace A.B {}` declares A.B without declaring A, so A.B is declared by the
    // file and members of A.B are declared by A.B.
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [
          declaration({ path: 'a.ts', chain: ['A', 'B'], kind: 'namespace' }),
          declaration({ path: 'a.ts', chain: ['A', 'B', 'x'], kind: 'variable' }),
        ],
      }),
      resolved: resolved({}),
    });

    expect(declaresFor('sym:a.ts#A.B', graph)?.sourceId).toBe('file:a.ts');
    expect(declaresFor('sym:a.ts#A.B.x', graph)?.sourceId).toBe('sym:a.ts#A.B');
  });
});

describe('relationship edges', () => {
  it('copies confidence verbatim rather than recomputing it', () => {
    const graph = builder.build({
      ir: ir({ files: [file('a.ts'), file('b.ts')] }),
      resolved: resolved({
        relationships: [
          relationship({
            type: 'IMPORTS',
            sourceId: 'file:a.ts',
            target: fileTarget('b.ts'),
            confidence: 'INFERRED',
          }),
        ],
      }),
    });

    expect(graph.edges.find((entry) => entry.type === 'IMPORTS')?.confidence).toBe('INFERRED');
  });

  it('preserves the candidate group so alternatives stay recognisable', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [
          declaration({ path: 'a.ts', chain: ['A'] }),
          declaration({ path: 'a.ts', chain: ['B'], kind: 'interface' }),
          declaration({ path: 'a.ts', chain: ['C'], kind: 'interface' }),
        ],
      }),
      resolved: resolved({
        relationships: [
          relationship({
            type: 'IMPLEMENTS',
            sourceId: 'sym:a.ts#A',
            target: declarationTarget('sym:a.ts#B'),
            confidence: 'AMBIGUOUS',
            candidateGroup: 'group-1',
          }),
          relationship({
            type: 'IMPLEMENTS',
            sourceId: 'sym:a.ts#A',
            target: declarationTarget('sym:a.ts#C'),
            confidence: 'AMBIGUOUS',
            candidateGroup: 'group-1',
          }),
        ],
      }),
    });

    const ambiguous = graph.edges.filter((entry) => entry.confidence === 'AMBIGUOUS');

    expect(ambiguous).toHaveLength(2);
    expect(new Set(ambiguous.map((entry) => entry.candidateGroup))).toEqual(new Set(['group-1']));
    // The candidates differ only in target, so identity must too.
    expect(new Set(ambiguous.map((entry) => entry.id)).size).toBe(2);
  });

  it('leaves ordinal null, it being reserved in version 1', () => {
    const graph = builder.build({
      ir: ir({ files: [file('a.ts'), file('b.ts')] }),
      resolved: resolved({
        relationships: [
          relationship({ type: 'IMPORTS', sourceId: 'file:a.ts', target: fileTarget('b.ts') }),
        ],
      }),
    });

    expect(graph.edges.every((entry) => entry.ordinal === null)).toBe(true);
  });

  it('carries the Resolver as the producer, not itself', () => {
    const graph = builder.build({
      ir: ir({ files: [file('a.ts'), file('b.ts')] }),
      resolved: resolved({
        relationships: [
          relationship({ type: 'IMPORTS', sourceId: 'file:a.ts', target: fileTarget('b.ts') }),
        ],
      }),
    });

    expect(graph.edges.find((entry) => entry.type === 'IMPORTS')?.provenance.producer).toBe(
      'imports',
    );
  });
});

describe('revision and unresolved references', () => {
  it('uses the placeholder revision', () => {
    const graph = builder.build({ ir: ir({ files: [file('a.ts')] }), resolved: resolved({}) });

    expect(graph.revisionId).toBe(PLACEHOLDER_REVISION_ID);
    expect(graph.revisionId).toBe(1);
  });

  it('lists every file for file_revisions', () => {
    const graph = builder.build({
      ir: ir({ files: [file('a.ts'), file('b.ts')] }),
      resolved: resolved({}),
    });

    expect(graph.fileIds).toEqual(['file:a.ts', 'file:b.ts']);
  });

  it('carries unresolved references through with their reason and text', () => {
    const graph = builder.build({
      ir: ir({ files: [file('a.ts')] }),
      resolved: resolved({
        unresolved: [unresolvedReference({ sourceId: 'file:a.ts', text: './missing' })],
      }),
    });

    expect(graph.unresolved).toHaveLength(1);
    expect(graph.unresolved[0]).toMatchObject({
      reason: 'module-not-resolved',
      text: './missing',
      sourceId: 'file:a.ts',
    });
  });

  it('gives unresolved references distinct identifiers', () => {
    const graph = builder.build({
      ir: ir({ files: [file('a.ts')] }),
      resolved: resolved({
        unresolved: [
          unresolvedReference({ sourceId: 'file:a.ts', text: './one' }),
          unresolvedReference({ sourceId: 'file:a.ts', text: './two', reason: 'no-symbol' }),
        ],
      }),
    });

    expect(new Set(graph.unresolved.map((entry) => entry.id)).size).toBe(2);
  });
});

describe('determinism', () => {
  const inputs = () => ({
    ir: ir({
      files: [file('a.ts'), file('b.ts')],
      declarations: [
        declaration({ path: 'a.ts', chain: ['C'] }),
        declaration({ path: 'a.ts', chain: ['C', 'm'], kind: 'method' }),
      ],
    }),
    resolved: resolved({
      relationships: [
        relationship({
          type: 'IMPORTS',
          sourceId: 'file:a.ts',
          target: externalTarget('package', 'zod'),
        }),
        relationship({
          type: 'IMPORTS',
          sourceId: 'file:a.ts',
          target: externalTarget('standard-library', 'node:fs'),
          line: 2,
        }),
      ],
    }),
  });

  it('produces an identical graph from identical inputs', () => {
    expect(builder.build(inputs())).toEqual(builder.build(inputs()));
  });

  it('orders external nodes by identity, independent of discovery order', () => {
    const graph = builder.build(inputs());
    const externals = graph.nodes
      .filter((entry) => entry.kind === 'External')
      .map((entry) => entry.id);

    expect(externals).toEqual([...externals].sort());
  });

  it('produces a graph that survives a JSON round trip', () => {
    const graph = builder.build(inputs());

    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
  });
});

describe('constraint enforcement', () => {
  it('rejects an edge whose target is not a node', () => {
    expect(() =>
      builder.build({
        ir: ir({ files: [file('a.ts')] }),
        resolved: resolved({
          relationships: [
            relationship({
              type: 'IMPORTS',
              sourceId: 'file:a.ts',
              target: fileTarget('absent.ts'),
            }),
          ],
        }),
      }),
    ).toThrow(GraphConstraintError);
  });

  it('rejects an edge whose source is not a node', () => {
    expect(() =>
      builder.build({
        ir: ir({ files: [file('a.ts')] }),
        resolved: resolved({
          relationships: [
            relationship({
              type: 'IMPORTS',
              sourceId: 'file:ghost.ts',
              target: fileTarget('a.ts'),
            }),
          ],
        }),
      }),
    ).toThrow(/not a node/);
  });

  it('rejects an endpoint pairing the specification forbids', () => {
    // IMPORTS may only be sourced at a File.
    expect(() =>
      builder.build({
        ir: ir({
          files: [file('a.ts')],
          declarations: [declaration({ path: 'a.ts', chain: ['C'] })],
        }),
        resolved: resolved({
          relationships: [
            relationship({
              type: 'IMPORTS',
              sourceId: 'sym:a.ts#C',
              target: fileTarget('a.ts'),
            }),
          ],
        }),
      }),
    ).toThrow(/may not be sourced at a Class/);
  });

  it('rejects an unresolved reference sourced at something that is not a node', () => {
    expect(() =>
      builder.build({
        ir: ir({ files: [file('a.ts')] }),
        resolved: resolved({ unresolved: [unresolvedReference({ sourceId: 'file:ghost.ts' })] }),
      }),
    ).toThrow(GraphConstraintError);
  });

  it('rejects two declarations sharing an identifier', () => {
    const duplicate = declaration({ path: 'a.ts', chain: ['C'] });

    expect(() =>
      builder.build({
        ir: ir({ files: [file('a.ts')], declarations: [duplicate, duplicate] }),
        resolved: resolved({}),
      }),
    ).toThrow(/two nodes share the identifier/);
  });

  it('rejects two identical relationships, which would collide on edge identity', () => {
    const duplicated = relationship({
      type: 'IMPORTS',
      sourceId: 'file:a.ts',
      target: fileTarget('b.ts'),
    });

    expect(() =>
      builder.build({
        ir: ir({ files: [file('a.ts'), file('b.ts')] }),
        resolved: resolved({ relationships: [duplicated, duplicated] }),
      }),
    ).toThrow(/two edges share the identifier/);
  });

  it('rejects a declaration whose file is not among the IR files', () => {
    expect(() =>
      builder.build({
        ir: ir({
          files: [file('a.ts')],
          declarations: [declaration({ path: 'orphan.ts', chain: ['C'] })],
        }),
        resolved: resolved({}),
      }),
    ).toThrow(/names file file:orphan.ts, which is not a node/);
  });

  it('rejects a declaration with no source location rather than inventing one', () => {
    expect(() =>
      builder.build({
        ir: ir({
          files: [file('a.ts')],
          declarations: [{ ...declaration({ path: 'a.ts', chain: ['C'] }), locations: [] }],
        }),
        resolved: resolved({}),
      }),
    ).toThrow(/has no source location/);
  });

  it('rejects a role annotating something that is not a node', () => {
    expect(() =>
      builder.build({
        ir: ir({ files: [file('a.ts')] }),
        resolved: resolved({}),
        annotations: annotations({
          roles: [roleAnnotation({ declarationId: 'sym:a.ts#Ghost', role: 'Service' })],
        }),
      }),
    ).toThrow(/is not a node/);
  });
});

describe('framework annotations', () => {
  it('translates a role annotation onto an existing node', () => {
    const graph = builder.build({
      ir: ir({
        files: [file('a.ts')],
        declarations: [declaration({ path: 'a.ts', chain: ['AuthService'] })],
      }),
      resolved: resolved({}),
      annotations: annotations({
        roles: [roleAnnotation({ declarationId: 'sym:a.ts#AuthService', role: 'Service' })],
      }),
    });

    expect(graph.roles).toEqual([
      {
        nodeId: 'sym:a.ts#AuthService',
        role: 'Service',
        confidence: 'INFERRED',
        evidence: 'synthetic role annotation for testing',
      },
    ]);
  });

  it('produces no roles when none are supplied, there being no Framework Extractor', () => {
    const graph = builder.build({ ir: ir({ files: [file('a.ts')] }), resolved: resolved({}) });

    expect(graph.roles).toEqual([]);
  });
});
