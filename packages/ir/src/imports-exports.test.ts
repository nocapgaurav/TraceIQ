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

/**
 * CommonJS exports.
 *
 * Carried forward as a known limitation through two milestones, and measurable: express reported
 * **9** EXPORTS across 141 CommonJS files — its nine ES ones — so the public surface of every
 * module in the framework most likely to be a JavaScript user's first scan was invisible.
 *
 * No new `ExportKind` was added. CommonJS states the same three things ES modules do, and mapping
 * onto the existing vocabulary is what lets every downstream consumer read these without a branch.
 */
describe('CommonJS exports', () => {
  let commonjs: IrFixture;

  beforeAll(async () => {
    commonjs = await IrFixture.create({
      'src/util.js': `
        function normalize(value) { return value; }
        exports.normalize = normalize;
        exports.compile = function compile(value) { return value; };
        exports.parse = (value) => value;
      `,
      'src/router.js': `
        function Router() {}
        module.exports = Router;
      `,
      'src/pair.js': `
        const first = 1;
        function second() {}
        module.exports = { first, second, aliased: second, 'quoted-name': second };
      `,
      'src/mixed.js': `
        export const fromEs = 1;
        module.exports.fromCjs = function () {};
      `,
      'src/forward.js': `
        module.exports = require('./router');
      `,
      'src/forward-package.js': `
        module.exports = require('express');
      `,
      'src/computed.js': `
        exports.methods = ['a', 'b'].map((entry) => entry.toUpperCase());
      `,
      'src/conditional.js': `
        if (process.env.X) { module.exports = 1; }
        exports[String(1)] = 2;
      `,
    });
  });

  afterAll(async () => {
    await commonjs.remove();
  });

  const named = (file: string): readonly string[] =>
    commonjs
      .exportsIn(file)
      .filter((entry) => entry.kind === 'named')
      .map((entry) => entry.exportedName ?? '')
      .sort();

  it('records exports.<name> for an identifier, a named function and an arrow', () => {
    expect(named('src/util.js')).toEqual(['compile', 'normalize', 'parse']);
  });

  it('records module.exports = X as an equals export, matching export =', () => {
    const entries = commonjs.exportsIn('src/router.js');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'equals', exportedName: null, localName: 'Router' });
  });

  it('records one named export per property of an exported object literal', () => {
    // Shorthand, a property, an alias and a quoted key. A computed key is not here, deliberately.
    expect(named('src/pair.js')).toEqual(['aliased', 'first', 'quoted-name', 'second']);
  });

  it('records both module systems in a file that mixes them', () => {
    expect(commonjs.exportsIn('src/mixed.js').map((entry) => entry.exportedName).sort()).toEqual([
      'fromCjs',
      'fromEs',
    ]);
  });

  it('records a forwarded module as a star export carrying the specifier', () => {
    expect(commonjs.exportsIn('src/forward.js')[0]).toMatchObject({
      kind: 'star',
      exportedName: null,
      moduleSpecifier: './router',
    });

    expect(commonjs.exportsIn('src/forward-package.js')[0]?.moduleSpecifier).toBe('express');
  });

  it('records nothing for a conditional assignment or a computed name', () => {
    // Both publish something a static reader cannot state: one depends on the environment, the
    // other names an expression no importer could write.
    expect(commonjs.exportsIn('src/conditional.js')).toHaveLength(0);
  });

  it('declares an exported function expression, as the ES form has always been', () => {
    // `exports.compile = function compile(v) {}` declares a function in every sense a reader cares
    // about. Its ES twin, `export const compile = function (v) {}`, has been a declaration since
    // the IR existed.
    expect(commonjs.declaration('src/util.js', 'compile')).toMatchObject({
      kind: 'function',
      modifiers: expect.objectContaining({ isExported: true }),
    });

    expect(commonjs.declaration('src/util.js', 'parse')?.kind).toBe('function');
  });

  it('declares nothing for an exported value that is a computation', () => {
    // `exports.methods = METHODS.map(…)` publishes a value whose shape is a computation. It is a
    // real export and is recorded as one; it declares nothing, and inventing a declaration for it
    // would put a node in the graph with no source construct behind it.
    expect(commonjs.exportsIn('src/computed.js').map((entry) => entry.exportedName)).toEqual([
      'methods',
    ]);
    expect(commonjs.declaration('src/computed.js', 'methods')).toBeUndefined();
  });
});
