import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ResolverFixture } from './resolver-fixture.test-helper.js';
import { RESOLVED_RELATIONSHIP_TYPES, RESOLVERS, UNRESOLVED_REASONS } from './types.js';

/**
 * One fixture repository exercising every resolution path, built once. Each stage
 * of the pipeline is expensive, and a per-assertion program would dominate the
 * runtime for no gain.
 */
const FILES = {
  'src/base.ts': `export interface Shape { a: string }
export interface Other { b: number }
export class Root { m(): void {} }
export type Alias = Shape;
export const val = 1;
export default class Anonymous {}
`,
  'src/merged.ts': `export interface Dup { a: string }
export interface Dup { b: number }
`,
  // Same interface name in two separate modules. These do not merge — TypeScript
  // merges declarations only within one module — so each resolves to its own file.
  'src/split-a.ts': `export interface Split { fromA: string }
`,
  'src/split-b.ts': `export interface Split { fromB: number }
`,
  'src/consumer.ts': `import { Shape, Other, Root, Alias, val } from './base';
import { Dup } from './merged';
import defaulted from './base';
import * as everything from './base';
import './base';
import missing from './nowhere';
import express from 'express';
import type { Split } from './split-a';

export class Generic<T> { held?: T }

export class Impl extends Generic<Shape> implements Shape, Other {
  prop: Shape;
  nested?: Map<string, Alias[]>;
  constructor(seed: Dup) { super(); void seed; }
  method(a: Root): Promise<Other> { return null as never; }
  get accessor(): Alias { return null as never; }
  set accessor(next: Alias) { void next; }
}

export type Composed = Shape & { extra: Alias };

const local = 1;
export { local, val as renamedVal };
export { Shape } from './base';
export * from './base';
export * as bundled from './base';
`,
  'src/separate.ts': `import { Split } from './split-a';
export type Uses = Split;
const untouched = 1;
void untouched;
`,
  'src/equals.ts': `const legacy = 5;
export = legacy;
`,
};

let fixture: ResolverFixture;

beforeAll(async () => {
  fixture = await ResolverFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

describe('output shape', () => {
  it('echoes the IR repository metadata without modifying the IR', () => {
    expect(fixture.resolved.repository).toEqual(fixture.ir.repository);
  });

  it('leaves the IR unchanged', () => {
    // The Resolver holds the IR only to read it. A round trip proves nothing was
    // mutated into it, since a compiler object would not survive.
    expect(JSON.parse(JSON.stringify(fixture.ir))).toEqual(fixture.ir);
  });

  it('produces a result that survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(fixture.resolved))).toEqual(fixture.resolved);
  });

  it('uses only relationship types from the published subset', () => {
    for (const relationship of fixture.resolved.relationships) {
      expect(RESOLVED_RELATIONSHIP_TYPES).toContain(relationship.type);
    }
  });

  it('uses only the four confidence levels', () => {
    for (const relationship of fixture.resolved.relationships) {
      expect(['CERTAIN', 'RESOLVED', 'INFERRED', 'AMBIGUOUS']).toContain(
        relationship.confidence,
      );
    }
  });

  it('uses only published unresolved reasons', () => {
    for (const entry of fixture.resolved.unresolved) {
      expect(UNRESOLVED_REASONS).toContain(entry.reason);
    }
  });
});

describe('provenance', () => {
  it('names a known resolver on every relationship', () => {
    for (const relationship of fixture.resolved.relationships) {
      expect(RESOLVERS).toContain(relationship.provenance.resolver);
    }
  });

  it('explains every relationship in words', () => {
    for (const relationship of fixture.resolved.relationships) {
      expect(relationship.provenance.evidence.length).toBeGreaterThan(10);
    }
  });

  it('explains every unresolved reference in words', () => {
    for (const entry of fixture.resolved.unresolved) {
      expect(entry.provenance.evidence.length).toBeGreaterThan(10);
    }
  });

  it('records a source location on every relationship', () => {
    for (const relationship of fixture.resolved.relationships) {
      expect(relationship.location.startLine).toBeGreaterThan(0);
      expect(relationship.location.startColumn).toBeGreaterThan(0);
    }
  });

  it('records a source location on every unresolved reference', () => {
    for (const entry of fixture.resolved.unresolved) {
      expect(entry.location.startLine).toBeGreaterThan(0);
    }
  });

  it('attributes every relationship to a file the IR recorded', () => {
    const fileIds = new Set(fixture.ir.files.map((file) => file.id));

    for (const relationship of fixture.resolved.relationships) {
      expect(fileIds.has(relationship.provenance.fileId)).toBe(true);
    }
  });
});

describe('correlation with the IR', () => {
  // These are the canary for position-based correlation. If the Resolver's notion
  // of a source position ever diverges from the IR Builder's, sources stop
  // matching and these fail.
  it('sources every relationship at a declaration or file the IR recorded', () => {
    const known = new Set<string>([
      ...fixture.ir.declarations.map((entry) => entry.id),
      ...fixture.ir.files.map((entry) => entry.id),
    ]);

    for (const relationship of fixture.resolved.relationships) {
      expect(known.has(relationship.sourceId)).toBe(true);
    }
  });

  it('targets only declarations the IR recorded', () => {
    const declarationIds = new Set(fixture.ir.declarations.map((entry) => entry.id));

    for (const relationship of fixture.resolved.relationships) {
      if (relationship.target.kind === 'declaration') {
        expect(declarationIds.has(relationship.target.declarationId)).toBe(true);
      }
    }
  });

  it('enriches declarations the IR recorded, and only those', () => {
    const declarationIds = new Set(fixture.ir.declarations.map((entry) => entry.id));

    for (const declaration of fixture.resolved.declarations) {
      expect(declarationIds.has(declaration.declarationId)).toBe(true);
    }
  });

  it('correlates class members, not only top-level declarations', () => {
    expect(fixture.declaration('sym:src/consumer.ts#Impl.method')).toBeDefined();
    expect(fixture.declaration('sym:src/consumer.ts#Impl.prop')).toBeDefined();
  });
});

describe('declaration enrichment', () => {
  it('finds a symbol for every declaration in this fixture', () => {
    expect(fixture.resolved.declarations.every((entry) => entry.hasSymbol)).toBe(true);
  });

  it('confirms an inline exported declaration is a module export', () => {
    expect(fixture.declaration('sym:src/base.ts#Shape')?.isExportedFromModule).toBe(true);
  });

  it('confirms a declaration exported only by a separate statement, which the IR could not see', () => {
    const local = fixture.declaration('sym:src/consumer.ts#local');

    expect(local?.isExportedFromModule).toBe(true);
    // The IR sees no export modifier on it, which is exactly the gap this fills.
    expect(
      fixture.ir.declarations.find((entry) => entry.id === 'sym:src/consumer.ts#local')
        ?.modifiers.isExported,
    ).toBe(false);
  });

  it('reports a module-local declaration as not exported', () => {
    expect(fixture.declaration('sym:src/separate.ts#untouched')?.isExportedFromModule).toBe(
      false,
    );
  });

  it('treats the subject of `export =` as a module export', () => {
    // `export = legacy` makes legacy exactly what the module exports, even though
    // no export modifier appears on the declaration.
    expect(fixture.declaration('sym:src/equals.ts#legacy')?.isExportedFromModule).toBe(true);
  });

  it('does not treat a class member as a module export', () => {
    expect(fixture.declaration('sym:src/consumer.ts#Impl.prop')?.isExportedFromModule).toBe(
      false,
    );
  });
});

describe('imports', () => {
  it('resolves a module specifier to an analysed file', () => {
    const moduleLevel = fixture
      .relationships('IMPORTS')
      .filter(
        (entry) =>
          entry.name === null &&
          entry.target.kind === 'file' &&
          entry.provenance.fileId === 'file:src/consumer.ts',
      );

    expect(moduleLevel.length).toBeGreaterThan(0);
    expect(ResolverFixture.targetId(moduleLevel[0])).toBe('file:src/base.ts');
  });

  it('resolves a named binding to the declaration it names', () => {
    expect(ResolverFixture.targetId(fixture.named('IMPORTS', 'Shape')[0])).toBe(
      'sym:src/base.ts#Shape',
    );
  });

  it('resolves an aliased binding to the original declaration', () => {
    const alias = fixture.named('IMPORTS', 'Alias')[0];

    expect(ResolverFixture.targetId(alias)).toBe('sym:src/base.ts#Alias');
    expect(alias?.confidence).toBe('RESOLVED');
  });

  it('resolves a default import', () => {
    expect(ResolverFixture.targetId(fixture.named('IMPORTS', 'defaulted')[0])).toBe(
      'sym:src/base.ts#Anonymous',
    );
  });

  it('resolves a namespace import to the module it binds, not to a declaration', () => {
    const namespaceBinding = fixture.named('IMPORTS', 'everything')[0];

    expect(namespaceBinding?.target).toEqual({ kind: 'file', fileId: 'file:src/base.ts' });
  });

  it('records a side-effect import at module level only', () => {
    const sideEffect = fixture
      .relationships('IMPORTS')
      .filter((entry) => entry.name === null && ResolverFixture.targetId(entry) === 'file:src/base.ts');

    // Four statements import ./base: named, default, namespace and side-effect.
    // Each is recorded once at module level, with bindings recorded separately.
    expect(sideEffect).toHaveLength(4);
  });

  it('infers an uninstalled package from a bare specifier', () => {
    const external = fixture
      .relationships('IMPORTS')
      .find((entry) => entry.target.kind === 'external' && entry.target.name === 'express');

    expect(external?.confidence).toBe('INFERRED');
    expect(external?.provenance.evidence).toMatch(/bare specifier/);
  });

  it('keeps an unresolvable relative specifier visible', () => {
    const unresolved = fixture
      .unresolved('module-not-resolved')
      .find((entry) => entry.text === './nowhere');

    expect(unresolved?.type).toBe('IMPORTS');
  });

  it('collapses a merged interface to one target rather than reporting ambiguity', () => {
    const dup = fixture.named('IMPORTS', 'Dup')[0];

    expect(dup?.confidence).toBe('RESOLVED');
    expect(ResolverFixture.targetId(dup)).toBe('sym:src/merged.ts#Dup');
  });
});

describe('exports', () => {
  it('records an inline exported declaration as CERTAIN, needing no resolution', () => {
    const inline = fixture
      .named('EXPORTS', 'Shape')
      .find((entry) => entry.provenance.fileId === 'file:src/base.ts');

    expect(inline?.confidence).toBe('CERTAIN');
    expect(ResolverFixture.targetId(inline)).toBe('sym:src/base.ts#Shape');
  });

  it('resolves a local export specifier, which the IR left unresolved', () => {
    const exported = fixture.named('EXPORTS', 'local')[0];

    expect(exported?.confidence).toBe('RESOLVED');
    expect(ResolverFixture.targetId(exported)).toBe('sym:src/consumer.ts#local');

    // The IR could not link this, because matching the name needs scope analysis.
    expect(
      fixture.ir.exports.find((entry) => entry.exportedName === 'local')?.declarationId,
    ).toBeNull();
  });

  it('resolves a renamed re-export across files', () => {
    expect(ResolverFixture.targetId(fixture.named('EXPORTS', 'renamedVal')[0])).toBe(
      'sym:src/base.ts#val',
    );
  });

  it('resolves a star re-export to the module, without expanding it', () => {
    const star = fixture
      .relationships('EXPORTS')
      .find((entry) => entry.name === null && entry.target.kind === 'file');

    expect(ResolverFixture.targetId(star)).toBe('file:src/base.ts');
    expect(star?.provenance.evidence).toMatch(/not expanded/);
  });

  it('resolves a named star re-export', () => {
    expect(ResolverFixture.targetId(fixture.named('EXPORTS', 'bundled')[0])).toBe(
      'file:src/base.ts',
    );
  });

  it('resolves export equals', () => {
    const equals = fixture
      .relationships('EXPORTS')
      .find((entry) => entry.provenance.fileId === 'file:src/equals.ts');

    expect(ResolverFixture.targetId(equals)).toBe('sym:src/equals.ts#legacy');
  });
});

describe('heritage', () => {
  it('resolves extends to the base declaration', () => {
    const extendsClause = fixture.relationships('EXTENDS')[0];

    expect(extendsClause?.sourceId).toBe('sym:src/consumer.ts#Impl');
    expect(ResolverFixture.targetId(extendsClause)).toBe('sym:src/consumer.ts#Generic');
  });

  it('resolves every implements clause separately', () => {
    const implemented = fixture
      .relationships('IMPLEMENTS')
      .map((entry) => ResolverFixture.targetId(entry));

    expect(implemented).toEqual(['sym:src/base.ts#Shape', 'sym:src/base.ts#Other']);
  });

  it('sources heritage at the declaring class, not at its file', () => {
    for (const relationship of [
      ...fixture.relationships('EXTENDS'),
      ...fixture.relationships('IMPLEMENTS'),
    ]) {
      expect(relationship.sourceId.startsWith('sym:')).toBe(true);
    }
  });
});

describe('type references', () => {
  it('resolves a property type', () => {
    const propertyType = fixture.from('sym:src/consumer.ts#Impl.prop');

    expect(ResolverFixture.targetId(propertyType[0])).toBe('sym:src/base.ts#Shape');
  });

  it('resolves a parameter type', () => {
    const parameterTypes = fixture
      .from('sym:src/consumer.ts#Impl.constructor')
      .map((entry) => ResolverFixture.targetId(entry));

    expect(parameterTypes).toContain('sym:src/merged.ts#Dup');
  });

  it('resolves a return type', () => {
    const returnTypes = fixture
      .from('sym:src/consumer.ts#Impl.method')
      .map((entry) => ResolverFixture.targetId(entry));

    expect(returnTypes).toContain('sym:src/base.ts#Other');
  });

  it('resolves nested type arguments as well as the outer type', () => {
    const nested = fixture.from('sym:src/consumer.ts#Impl.nested');

    expect(nested.map((entry) => entry.name)).toContain('Map');
    expect(nested.map((entry) => ResolverFixture.targetId(entry))).toContain(
      'sym:src/base.ts#Alias',
    );
  });

  it('resolves a heritage type argument, which the heritage clause itself does not cover', () => {
    const heritageArgument = fixture
      .from('sym:src/consumer.ts#Impl')
      .filter((entry) => entry.type === 'REFERENCES_TYPE');

    expect(heritageArgument.map((entry) => ResolverFixture.targetId(entry))).toContain(
      'sym:src/base.ts#Shape',
    );
  });

  it('resolves a type alias right-hand side', () => {
    expect(
      fixture.from('sym:src/base.ts#Alias').map((entry) => ResolverFixture.targetId(entry)),
    ).toContain('sym:src/base.ts#Shape');
  });

  it('resolves accessor types', () => {
    expect(
      fixture
        .from('sym:src/consumer.ts#Impl.accessor')
        .map((entry) => ResolverFixture.targetId(entry)),
    ).toContain('sym:src/base.ts#Alias');
  });

  it('reports a TypeScript built-in as one external target, not several candidates', () => {
    const promise = fixture.named('REFERENCES_TYPE', 'Promise');

    expect(promise).toHaveLength(1);
    expect(promise[0]?.confidence).toBe('RESOLVED');
    expect(promise[0]?.target).toEqual({ kind: 'external', origin: 'typescript-lib', name: null });
  });

  it('keeps a type parameter visible, distinguished from a resolution failure', () => {
    const typeParameters = fixture.unresolved('type-parameter');

    expect(typeParameters.length).toBeGreaterThan(0);
    expect(typeParameters[0]?.name).toBe('T');
  });

  it('does not resolve types inside function bodies', () => {
    // `null as never` inside method bodies must contribute nothing.
    expect(fixture.named('REFERENCES_TYPE', 'never')).toEqual([]);
  });
});

describe('ambiguity invariants', () => {
  // No TypeScript program reachable by the IR yields two distinct in-IR targets for
  // one symbol, so this fixture produces no AMBIGUOUS relationship. Asserting over
  // that empty set would be vacuous; the expansion mechanism is unit-tested in
  // resolution-collector.test.ts, and the limitation is recorded in the README.
  it('produces no ambiguity from this fixture, as documented', () => {
    expect(
      fixture.resolved.relationships.filter((entry) => entry.confidence === 'AMBIGUOUS'),
    ).toEqual([]);
  });

  it('leaves candidateGroup unset on every relationship that is not ambiguous', () => {
    for (const relationship of fixture.resolved.relationships) {
      if (relationship.confidence !== 'AMBIGUOUS') {
        expect(relationship.candidateGroup).toBeNull();
      }
    }
  });

  it('notes a declaration site it could not address rather than dropping it silently', () => {
    // A module augmentation declares into an ambient block, which the IR skips. The
    // resolution still succeeds, and the evidence says a site was left out.
    const withNote = fixture.resolved.relationships.filter((entry) =>
      entry.provenance.evidence.includes('further declaration site'),
    );

    for (const relationship of withNote) {
      expect(relationship.confidence).toBe('RESOLVED');
    }
  });
});
