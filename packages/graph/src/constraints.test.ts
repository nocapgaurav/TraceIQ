import { RELATIONSHIP_TYPES } from '@traceiq/types';
import { describe, expect, it } from 'vitest';

import { ENDPOINT_RULES } from './constraints.js';
import { DECLARATION_NODE_KINDS, NODE_KINDS } from './types.js';

/**
 * Conformance tests for the legal endpoint matrix, spec §2.3. The matrix is part of
 * the frozen contract, so a change to it should fail here and force a conversation
 * rather than silently widen what the graph accepts.
 */
describe('the endpoint matrix', () => {
  it('covers exactly the nine edge types now produced', () => {
    // HANDLED_BY and READS joined with the complete framework annotation model; CALLS
    // joined with the call graph.
    expect(Object.keys(ENDPOINT_RULES).sort()).toEqual([
      'CALLS',
      'DECLARES',
      'EXPORTS',
      'EXTENDS',
      'HANDLED_BY',
      'IMPLEMENTS',
      'IMPORTS',
      'READS',
      'REFERENCES_TYPE',
    ]);
  });

  it('sources HANDLED_BY only at a Route, and targets a declaration', () => {
    expect(ENDPOINT_RULES.HANDLED_BY?.sources).toEqual(['Route']);
    expect([...(ENDPOINT_RULES.HANDLED_BY?.targets ?? [])].sort()).toEqual(
      [...DECLARATION_NODE_KINDS].sort(),
    );
  });

  it('lets CALLS run between declarations, and from a file for a module-level call', () => {
    expect(ENDPOINT_RULES.CALLS?.sources).toContain('File');
    expect(ENDPOINT_RULES.CALLS?.sources).toContain('Method');
    expect([...(ENDPOINT_RULES.CALLS?.targets ?? [])].sort()).toEqual(
      [...DECLARATION_NODE_KINDS].sort(),
    );
  });

  it('targets READS only at an EnvironmentVariable, sourced at a file or declaration', () => {
    expect(ENDPOINT_RULES.READS?.targets).toEqual(['EnvironmentVariable']);
    expect(ENDPOINT_RULES.READS?.sources).toContain('File');
    expect(ENDPOINT_RULES.READS?.sources).toContain('Method');
  });

  it('names only edge types from the frozen relationship vocabulary', () => {
    for (const type of Object.keys(ENDPOINT_RULES)) {
      expect(RELATIONSHIP_TYPES).toContain(type);
    }
  });

  it('names only node kinds from the published vocabulary', () => {
    for (const rule of Object.values(ENDPOINT_RULES)) {
      for (const kind of [...(rule?.sources ?? []), ...(rule?.targets ?? [])]) {
        expect(NODE_KINDS).toContain(kind);
      }
    }
  });

  it('lets DECLARES target any declaration kind, and be sourced at anything with a body', () => {
    expect([...(ENDPOINT_RULES.DECLARES?.targets ?? [])].sort()).toEqual(
      [...DECLARATION_NODE_KINDS].sort(),
    );
    expect(ENDPOINT_RULES.DECLARES?.sources).toEqual([
      'File',
      'Class',
      'Interface',
      'Enum',
      'Namespace',
      'Function',
      'Method',
      'Constructor',
      'Accessor',
      'Variable',
    ]);
  });

  it('excludes from DECLARES the kinds that cannot contain a declaration', () => {
    // A property, an enum member and a type alias have no body to nest anything in.
    for (const kind of ['Property', 'EnumMember', 'TypeAlias'] as const) {
      expect(ENDPOINT_RULES.DECLARES?.sources).not.toContain(kind);
    }
  });

  it.each(['IMPORTS', 'EXPORTS'] as const)('sources %s only at a File', (type) => {
    expect(ENDPOINT_RULES[type]?.sources).toEqual(['File']);
  });

  it.each(['IMPORTS', 'EXPORTS'] as const)(
    'lets %s target a file, an external or a declaration',
    (type) => {
      const targets = ENDPOINT_RULES[type]?.targets ?? [];

      expect(targets).toContain('File');
      expect(targets).toContain('External');
      expect(targets).toContain('Class');
    },
  );

  it('admits a mixin factory as a heritage target, which legal TypeScript produces', () => {
    // `class A extends Mixin(Base)` resolves to a Function or a Variable.
    for (const type of ['EXTENDS', 'IMPLEMENTS'] as const) {
      expect(ENDPOINT_RULES[type]?.targets).toContain('Function');
      expect(ENDPOINT_RULES[type]?.targets).toContain('Variable');
    }
  });

  it('admits an enum member as a type reference target', () => {
    // `let x: Status.Active` resolves to an EnumMember.
    expect(ENDPOINT_RULES.REFERENCES_TYPE?.targets).toContain('EnumMember');
    expect(ENDPOINT_RULES.REFERENCES_TYPE?.targets).toContain('Namespace');
  });

  it('excludes kinds no heritage clause or annotation can reach', () => {
    for (const type of ['EXTENDS', 'IMPLEMENTS', 'REFERENCES_TYPE'] as const) {
      for (const excluded of ['Property', 'Method', 'Constructor', 'Accessor', 'File'] as const) {
        expect(ENDPOINT_RULES[type]?.targets).not.toContain(excluded);
      }
    }
  });

  it('sources EXTENDS and IMPLEMENTS only at the kinds that can declare heritage', () => {
    expect(ENDPOINT_RULES.EXTENDS?.sources).toEqual(['Class', 'Interface']);
    expect(ENDPOINT_RULES.IMPLEMENTS?.sources).toEqual(['Class']);
  });

  it('sources REFERENCES_TYPE at any declaration, and never at a File', () => {
    expect([...(ENDPOINT_RULES.REFERENCES_TYPE?.sources ?? [])].sort()).toEqual(
      [...DECLARATION_NODE_KINDS].sort(),
    );
    expect(ENDPOINT_RULES.REFERENCES_TYPE?.sources).not.toContain('File');
  });

  it('does not admit an edge type reserved for a later milestone', () => {
    for (const reserved of [
      'WRITES',
      'DEPENDS_ON',
      'CONTINUES_TO',
      'TESTS',
    ] as const) {
      expect(ENDPOINT_RULES[reserved]).toBeUndefined();
    }
  });
});
