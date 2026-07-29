import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IrFixture } from './ir-fixture.test-helper.js';

const FILES = {
  'src/source.ts': `export const value = 1;
export type Shape = { a: string };
export default value;
`,
  'src/imports.ts': `import def, { value, value as renamed, type Shape } from './source';
import * as everything from './source';
import './source';
import type { Shape as OnlyType } from './source';
import type Fallback from './source';
export {};
`,
  'src/exports.ts': `const local = 1;
class Local {}
export { local, local as aliased, Local };
export { value } from './source';
export { value as forwarded } from './source';
export * from './source';
export * as bundled from './source';
export type { Shape } from './source';
export { type Shape as InlineType } from './source';
`,
  'src/inline.ts': `export class Klass {}
export interface Shape { a: string }
export type Alias = string;
export enum Level { One }
export function fn(): void {}
export const konst = 1;
export namespace Space { export const inner = 1; }
class Private {}
const hidden = 1;
`,
  'src/default-decl.ts': `export default class Named {}
`,
  'src/default-expr.ts': `const thing = { a: 1 };
export default thing;
`,
  'src/default-literal.ts': `export default { a: 1 };
`,
  'src/equals.ts': `const legacy = 5;
export = legacy;
`,
};

let fixture: IrFixture;

beforeAll(async () => {
  fixture = await IrFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

describe('imports', () => {
  it('records one entry per import statement', () => {
    expect(fixture.importsIn('src/imports.ts')).toHaveLength(5);
  });

  it('keeps the module specifier exactly as written, unresolved', () => {
    for (const entry of fixture.importsIn('src/imports.ts')) {
      expect(entry.moduleSpecifier).toBe('./source');
    }
  });

  it('records a default binding', () => {
    const bindings = fixture.importsIn('src/imports.ts')[0]?.bindings ?? [];

    expect(bindings[0]).toEqual({
      kind: 'default',
      importedName: 'default',
      localName: 'def',
      isTypeOnly: false,
    });
  });

  it('records named bindings, including an alias', () => {
    const bindings = fixture.importsIn('src/imports.ts')[0]?.bindings ?? [];

    expect(bindings.filter((binding) => binding.kind === 'named')).toEqual([
      { kind: 'named', importedName: 'value', localName: 'value', isTypeOnly: false },
      { kind: 'named', importedName: 'value', localName: 'renamed', isTypeOnly: false },
      { kind: 'named', importedName: 'Shape', localName: 'Shape', isTypeOnly: true },
    ]);
  });

  it('records a namespace binding with no imported name', () => {
    const entry = fixture.importsIn('src/imports.ts')[1];

    expect(entry?.bindings).toEqual([
      { kind: 'namespace', importedName: null, localName: 'everything', isTypeOnly: false },
    ]);
  });

  it('records a side-effect import with no bindings', () => {
    const entry = fixture.importsIn('src/imports.ts')[2];

    expect(entry?.bindings).toEqual([]);
    expect(entry?.isTypeOnly).toBe(false);
  });

  it('marks a type-only statement and every binding it governs', () => {
    const entry = fixture.importsIn('src/imports.ts')[3];

    expect(entry?.isTypeOnly).toBe(true);
    expect(entry?.bindings.every((binding) => binding.isTypeOnly)).toBe(true);
  });

  it('marks a type-only default import', () => {
    const entry = fixture.importsIn('src/imports.ts')[4];

    expect(entry?.isTypeOnly).toBe(true);
    expect(entry?.bindings[0]?.kind).toBe('default');
  });

  it('records a location for every import', () => {
    for (const entry of fixture.importsIn('src/imports.ts')) {
      expect(entry.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('exports written as a declaration modifier', () => {
  it('records one entry per exported declaration', () => {
    const entries = fixture.exportsIn('src/inline.ts');

    expect(entries.map((entry) => entry.exportedName)).toEqual([
      'Klass',
      'Shape',
      'Alias',
      'Level',
      'fn',
      'konst',
      'Space',
    ]);
  });

  it('links each to the declaration it exports', () => {
    for (const entry of fixture.exportsIn('src/inline.ts')) {
      expect(entry.kind).toBe('declaration');
      expect(entry.declarationId).not.toBeNull();
      expect(fixture.ir.declarations.some((d) => d.id === entry.declarationId)).toBe(true);
    }
  });

  it('omits declarations that are not exported', () => {
    const names = fixture.exportsIn('src/inline.ts').map((entry) => entry.exportedName);

    expect(names).not.toContain('Private');
    expect(names).not.toContain('hidden');
  });

  it('does not treat an export inside a namespace as a module export', () => {
    const names = fixture.exportsIn('src/inline.ts').map((entry) => entry.exportedName);

    expect(names).toContain('Space');
    expect(names).not.toContain('inner');
    expect(fixture.declaration('src/inline.ts', 'Space.inner')?.kind).toBe('variable');
  });
});

describe('export statements', () => {
  it('records a local named export and its alias', () => {
    const named = fixture
      .exportsIn('src/exports.ts')
      .filter((entry) => entry.kind === 'named' && entry.moduleSpecifier === null);

    expect(named.map((entry) => [entry.localName, entry.exportedName])).toEqual([
      ['local', 'local'],
      ['local', 'aliased'],
      ['Local', 'Local'],
    ]);
  });

  it('leaves declarationId unset for a named export, which needs scope analysis', () => {
    const named = fixture
      .exportsIn('src/exports.ts')
      .filter((entry) => entry.kind === 'named' && entry.moduleSpecifier === null);

    expect(named.every((entry) => entry.declarationId === null)).toBe(true);
  });

  it('records a re-export with its unresolved specifier', () => {
    const forwarded = fixture
      .exportsIn('src/exports.ts')
      .find((entry) => entry.exportedName === 'forwarded');

    expect(forwarded).toMatchObject({
      kind: 'named',
      localName: 'value',
      moduleSpecifier: './source',
    });
  });

  it('records a star re-export with no exported name', () => {
    const star = fixture.exportsIn('src/exports.ts').find((entry) => entry.kind === 'star');

    expect(star).toMatchObject({ exportedName: null, moduleSpecifier: './source' });
  });

  it('records a named star re-export', () => {
    const starAs = fixture.exportsIn('src/exports.ts').find((entry) => entry.kind === 'star-as');

    expect(starAs).toMatchObject({ exportedName: 'bundled', moduleSpecifier: './source' });
  });

  it('marks a type-only re-export statement', () => {
    const typeOnly = fixture
      .exportsIn('src/exports.ts')
      .find((entry) => entry.exportedName === 'Shape');

    expect(typeOnly?.isTypeOnly).toBe(true);
  });

  it('marks a specifier-level type-only export', () => {
    const inline = fixture
      .exportsIn('src/exports.ts')
      .find((entry) => entry.exportedName === 'InlineType');

    expect(inline?.isTypeOnly).toBe(true);
  });
});

describe('default and equals exports', () => {
  it('records a named default-exported declaration', () => {
    const entries = fixture.exportsIn('src/default-decl.ts');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'default',
      exportedName: 'default',
      localName: 'Named',
    });
    expect(entries[0]?.declarationId).toBe('sym:src/default-decl.ts#Named');
  });

  it('records a default-exported identifier', () => {
    const entry = fixture.exportsIn('src/default-expr.ts')[0];

    expect(entry).toMatchObject({
      kind: 'default',
      exportedName: 'default',
      localName: 'thing',
      declarationId: null,
    });
  });

  it('records a default-exported literal with no local name', () => {
    const entry = fixture.exportsIn('src/default-literal.ts')[0];

    expect(entry).toMatchObject({ kind: 'default', exportedName: 'default', localName: null });
  });

  it('records export equals', () => {
    const entry = fixture.exportsIn('src/equals.ts')[0];

    expect(entry).toMatchObject({ kind: 'equals', exportedName: null, localName: 'legacy' });
  });
});
