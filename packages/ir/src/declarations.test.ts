import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IrFixture } from './ir-fixture.test-helper.js';
import { DECLARATION_KINDS, type DeclarationKind } from './types.js';

/**
 * One fixture repository covering every declaration form, built once. Building a
 * TypeScript program per assertion would dominate the runtime for no gain.
 */
const FILES = {
  'src/members.ts': `export class Service {
  #secret = 1;
  private token = 'x';
  protected level = 2;
  public named = 'n';
  plain = 3;
  static registry = 4;
  readonly id?: string;
  constructor(a: string) {}
  get value(): number { return 1; }
  set value(v: number) {}
  async run(): Promise<void> {}
  static async boot(): Promise<void> {}
}
export abstract class Base {
  abstract handle(): void;
  protected abstract readonly slot?: string;
}
`,
  'src/shapes.ts': `export interface Repo {
  find(id: string): string;
  find(id: number): string;
  readonly url: string;
  optional?: number;
}
export interface Repo {
  extra: boolean;
}
export type Alias = string;
export enum Status { Active, Inactive = 2 }
`,
  'src/functions.ts': `export function helper(a: string): void;
export function helper(a: number): void;
export function helper(a: unknown): void {}
export async function loader(): Promise<void> {}
function hidden(): void {}
function withLocals() {
  class Local {}
  const inner = 1;
  function nested() {}
  return inner + Number(nested);
}
export const exported = 1;
const unexported = 2;
export let mutable = 3;
`,
  'src/namespaces.ts': `export namespace Outer {
  export class Inner {}
  export const value = 1;
  namespace Buried { export const deep = 1; }
}
export namespace Dotted.Path { export const x = 1; }
`,
  'src/anonymous.ts': `export default class {}
`,
  'src/anonymous-fn.ts': `export default function () {}
`,
  'src/unaddressable.ts': `export const { PORT, HOST } = process.env;
export class Computed {
  [Symbol.iterator]() {}
  ['literal']() {}
}
export interface Headers { 'content-type': string; }
export const plain = 1;
`,
  'src/ambient.d.ts': `declare module 'lodash.debounce' { export const x: number; }
declare global { interface Window { custom: string } }
export declare const ambient: string;
`,
};

let fixture: IrFixture;

beforeAll(async () => {
  fixture = await IrFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

describe('stable identifiers', () => {
  it('gives every declaration an identifier in the contract format', () => {
    for (const declaration of fixture.ir.declarations) {
      expect(declaration.id).toMatch(/^sym:[^#]+#.+$/);
    }
  });

  it('never issues the same identifier twice', () => {
    const ids = fixture.ir.declarations.map((declaration) => declaration.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds the identifier from the file path and container chain', () => {
    expect(fixture.declaration('src/members.ts', 'Service.run')?.name).toBe('run');
  });

  it('keeps the container chain consistent with the identifier', () => {
    for (const declaration of fixture.ir.declarations) {
      expect(declaration.id).toBe(
        `sym:${declaration.fileId.replace('file:', '')}#${declaration.containerChain.join('.')}`,
      );
      expect(declaration.containerChain.at(-1)).toBe(declaration.name);
    }
  });

  it('attributes every declaration to a file present in the IR', () => {
    const fileIds = new Set(fixture.ir.files.map((file) => file.id));

    for (const declaration of fixture.ir.declarations) {
      expect(fileIds.has(declaration.fileId)).toBe(true);
    }
  });
});

describe('source locations', () => {
  it('records at least one location for every declaration', () => {
    for (const declaration of fixture.ir.declarations) {
      expect(declaration.locations.length).toBeGreaterThan(0);
    }
  });

  it('records 1-based, ordered, non-negative positions', () => {
    for (const declaration of fixture.ir.declarations) {
      for (const location of declaration.locations) {
        expect(location.startLine).toBeGreaterThan(0);
        expect(location.startColumn).toBeGreaterThan(0);
        expect(location.endLine).toBeGreaterThanOrEqual(location.startLine);
      }
    }
  });

  it('points at the declaration rather than the file start', () => {
    // `Base` is the second declaration in members.ts.
    const base = fixture.declaration('src/members.ts', 'Base');

    expect(base?.locations[0]?.startLine).toBeGreaterThan(1);
  });

  it('orders merged locations by position', () => {
    const find = fixture.declaration('src/shapes.ts', 'Repo.find');
    const lines = find?.locations.map((location) => location.startLine) ?? [];

    expect(lines).toEqual([...lines].sort((left, right) => left - right));
  });
});

describe('declaration kinds', () => {
  it.each([
    ['src/members.ts', 'Service', 'class'],
    ['src/members.ts', 'Service.constructor', 'constructor'],
    ['src/members.ts', 'Service.run', 'method'],
    ['src/members.ts', 'Service.plain', 'property'],
    ['src/members.ts', 'Service.value', 'accessor'],
    ['src/shapes.ts', 'Repo', 'interface'],
    ['src/shapes.ts', 'Repo.find', 'method'],
    ['src/shapes.ts', 'Repo.url', 'property'],
    ['src/shapes.ts', 'Alias', 'type-alias'],
    ['src/shapes.ts', 'Status', 'enum'],
    ['src/shapes.ts', 'Status.Active', 'enum-member'],
    ['src/functions.ts', 'helper', 'function'],
    ['src/functions.ts', 'exported', 'variable'],
    ['src/namespaces.ts', 'Outer', 'namespace'],
  ])('records %s#%s as %s', (path, chain, kind) => {
    expect(fixture.declaration(path, chain)?.kind).toBe(kind);
  });

  it('uses only kinds from the published vocabulary', () => {
    const allowed = new Set<DeclarationKind>(DECLARATION_KINDS);

    for (const declaration of fixture.ir.declarations) {
      expect(allowed.has(declaration.kind)).toBe(true);
    }
  });

  it('treats a getter and setter pair as one accessor with two locations', () => {
    const accessor = fixture.declaration('src/members.ts', 'Service.value');

    expect(accessor?.kind).toBe('accessor');
    expect(accessor?.locations).toHaveLength(2);
  });
});

describe('visibility', () => {
  it.each([
    ['Service.token', 'private'],
    ['Service.#secret', 'private'],
    ['Service.level', 'protected'],
    ['Service.named', 'public'],
    ['Service.plain', 'public'],
    ['Service.constructor', 'public'],
    ['Service.value', 'public'],
    ['Service.run', 'public'],
  ])('records %s as %s', (chain, visibility) => {
    expect(fixture.declaration('src/members.ts', chain)?.visibility).toBe(visibility);
  });

  it('addresses an ECMAScript private field, which a plain identifier cannot shadow', () => {
    expect(fixture.declaration('src/members.ts', 'Service.#secret')).toBeDefined();
  });

  it.each([
    ['src/members.ts', 'Service'],
    ['src/shapes.ts', 'Alias'],
    ['src/shapes.ts', 'Status'],
    ['src/shapes.ts', 'Status.Active'],
    ['src/functions.ts', 'helper'],
    ['src/functions.ts', 'exported'],
    ['src/namespaces.ts', 'Outer'],
  ])('leaves visibility unset where the language has no such concept: %s#%s', (path, chain) => {
    expect(fixture.declaration(path, chain)?.visibility).toBeNull();
  });

  it('leaves interface members unset, since an interface admits no modifiers', () => {
    expect(fixture.declaration('src/shapes.ts', 'Repo.url')?.visibility).toBeNull();
    expect(fixture.declaration('src/shapes.ts', 'Repo.find')?.visibility).toBeNull();
  });
});

describe('modifiers', () => {
  it('records static members', () => {
    expect(fixture.declaration('src/members.ts', 'Service.registry')?.modifiers.isStatic).toBe(true);
    expect(fixture.declaration('src/members.ts', 'Service.plain')?.modifiers.isStatic).toBe(false);
  });

  it('records async functions and methods', () => {
    expect(fixture.declaration('src/members.ts', 'Service.run')?.modifiers.isAsync).toBe(true);
    expect(fixture.declaration('src/functions.ts', 'loader')?.modifiers.isAsync).toBe(true);
  });

  it('records abstract classes and members', () => {
    expect(fixture.declaration('src/members.ts', 'Base')?.modifiers.isAbstract).toBe(true);
    expect(fixture.declaration('src/members.ts', 'Base.handle')?.modifiers.isAbstract).toBe(true);
  });

  it('records readonly and optional', () => {
    const id = fixture.declaration('src/members.ts', 'Service.id');

    expect(id?.modifiers.isReadonly).toBe(true);
    expect(id?.modifiers.isOptional).toBe(true);
  });

  it('records optional interface members', () => {
    expect(fixture.declaration('src/shapes.ts', 'Repo.optional')?.modifiers.isOptional).toBe(true);
    expect(fixture.declaration('src/shapes.ts', 'Repo.url')?.modifiers.isReadonly).toBe(true);
  });

  it('records whether a top-level declaration is exported', () => {
    expect(fixture.declaration('src/functions.ts', 'exported')?.modifiers.isExported).toBe(true);
    expect(fixture.declaration('src/functions.ts', 'unexported')?.modifiers.isExported).toBe(false);
    expect(fixture.declaration('src/functions.ts', 'hidden')?.modifiers.isExported).toBe(false);
  });
});

describe('declarations sharing one symbol path', () => {
  it('folds overload signatures into one declaration', () => {
    const helper = fixture.declaration('src/functions.ts', 'helper');

    expect(helper?.locations).toHaveLength(3);
    expect(
      fixture.declarationsIn('src/functions.ts').filter((entry) => entry.name === 'helper'),
    ).toHaveLength(1);
  });

  it('keeps an overload set exported when only the first signature says so', () => {
    expect(fixture.declaration('src/functions.ts', 'helper')?.modifiers.isExported).toBe(true);
  });

  it('folds merged interfaces into one declaration', () => {
    const repo = fixture.declaration('src/shapes.ts', 'Repo');

    expect(repo?.locations).toHaveLength(2);
  });

  it('collects members contributed by every merged interface declaration', () => {
    expect(fixture.declaration('src/shapes.ts', 'Repo.extra')).toBeDefined();
    expect(fixture.declaration('src/shapes.ts', 'Repo.url')).toBeDefined();
  });

  it('folds interface method overloads into one declaration with two locations', () => {
    expect(fixture.declaration('src/shapes.ts', 'Repo.find')?.locations).toHaveLength(2);
  });
});

describe('traversal boundaries', () => {
  it('descends into a function body for what is invocable there', () => {
    expect(fixture.declaration('src/functions.ts', 'withLocals.nested')?.kind).toBe('function');
  });

  it('records nothing local that is not invocable', () => {
    // A local class is unreachable from outside and never named by a call, and a local
    // holding a number is not invocable at all. Recording either would grow the IR
    // without giving a later stage anything to bind.
    expect(fixture.declaration('src/functions.ts', 'withLocals.Local')).toBeUndefined();
    expect(fixture.declaration('src/functions.ts', 'withLocals.inner')).toBeUndefined();
  });

  it('records the enclosing function itself', () => {
    expect(fixture.declaration('src/functions.ts', 'withLocals')?.kind).toBe('function');
  });

  it('names a nested declaration under the function containing it', () => {
    const nested = fixture.declaration('src/functions.ts', 'withLocals.nested');

    expect(nested?.containerChain).toEqual(['withLocals', 'nested']);
  });

  it('descends into namespaces', () => {
    expect(fixture.declaration('src/namespaces.ts', 'Outer.Inner')?.kind).toBe('class');
    expect(fixture.declaration('src/namespaces.ts', 'Outer.value')?.kind).toBe('variable');
  });

  it('descends into a nested namespace', () => {
    expect(fixture.declaration('src/namespaces.ts', 'Outer.Buried.deep')?.kind).toBe('variable');
  });

  it('turns a dotted namespace into nested chain segments', () => {
    expect(fixture.declaration('src/namespaces.ts', 'Dotted.Path')?.kind).toBe('namespace');
    expect(fixture.declaration('src/namespaces.ts', 'Dotted.Path.x')?.kind).toBe('variable');
  });

  it('declares no node for the implicit outer segment of a dotted namespace', () => {
    expect(fixture.declaration('src/namespaces.ts', 'Dotted')).toBeUndefined();
  });
});

describe('anonymous default exports', () => {
  it('addresses an anonymous default class as "default"', () => {
    const anonymous = fixture.declaration('src/anonymous.ts', 'default');

    expect(anonymous?.kind).toBe('class');
    expect(anonymous?.name).toBe('default');
  });

  it('addresses an anonymous default function as "default"', () => {
    expect(fixture.declaration('src/anonymous-fn.ts', 'default')?.kind).toBe('function');
  });
});

describe('names the identifier format cannot address', () => {
  it('skips a destructuring pattern', () => {
    const names = fixture.declarationsIn('src/unaddressable.ts').map((entry) => entry.name);

    expect(names).not.toContain('PORT');
    expect(names).not.toContain('HOST');
    expect(names.some((name) => name.includes('{'))).toBe(false);
  });

  it('skips computed and string-literal member names', () => {
    const names = fixture.declarationsIn('src/unaddressable.ts').map((entry) => entry.name);

    expect(names.some((name) => name.includes('['))).toBe(false);
    expect(names).not.toContain('content-type');
  });

  it('still records the containers themselves', () => {
    expect(fixture.declaration('src/unaddressable.ts', 'Computed')?.kind).toBe('class');
    expect(fixture.declaration('src/unaddressable.ts', 'Headers')?.kind).toBe('interface');
    expect(fixture.declaration('src/unaddressable.ts', 'plain')?.kind).toBe('variable');
  });

  it('produces only addressable identifiers', () => {
    for (const declaration of fixture.ir.declarations) {
      expect(declaration.name).toMatch(/^#?[A-Za-z_$][\w$]*$/);
    }
  });
});

describe('ambient declarations', () => {
  it('does not descend into an ambient module block', () => {
    const names = fixture.declarationsIn('src/ambient.d.ts').map((entry) => entry.name);

    expect(names).not.toContain('x');
  });

  it('does not descend into a global augmentation', () => {
    expect(fixture.declaration('src/ambient.d.ts', 'Window')).toBeUndefined();
  });

  it('still records ordinary declarations in a declaration file', () => {
    expect(fixture.declaration('src/ambient.d.ts', 'ambient')?.kind).toBe('variable');
  });
});
