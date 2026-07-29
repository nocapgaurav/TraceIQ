import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IrFixture } from './ir-fixture.test-helper.js';

/**
 * Construction and nested declarations — what the IR Expansion added.
 *
 * The two belong in one fixture because they are the same feature seen twice: a
 * construction is an invocation, and the variable holding one is a nested declaration.
 * Binding `const svc = new Service(); svc.run()` needs both.
 */
const FILES = {
  'src/lib.ts': `export class Service {
  constructor(private readonly n: number) {}
  run(): number { return this.n; }
}
export class Plain {}
`,
  'src/nesting.ts': `import { Service, Plain } from './lib';

const topInstance = new Service(1);
const plainNumber = 5;

export function outer(): number {
  function inner(): number { return 1; }
  const arrow = (): number => 2;
  const expression = function (): number { return 3; };
  const svc = new Service(4);
  const local = 5;
  class LocalClass {}

  function deeper(): number {
    function deepest(): number { return 6; }
    return deepest();
  }

  return inner() + arrow() + expression() + svc.run() + local + deeper() + Number(LocalClass);
}

export class Holder {
  method(): number {
    function helper(): number { return 7; }
    const named = (): number => 8;
    const instance = new Plain();
    return helper() + named() + Number(instance);
  }

  get value(): number {
    function fromAccessor(): number { return 9; }
    return fromAccessor();
  }

  constructor() {
    function fromConstructor(): number { return 10; }
    fromConstructor();
  }
}

export const holderFactory = (): Holder => {
  function fromArrow(): number { return 11; }
  fromArrow();
  return new Holder();
};

topInstance.run();
`,
};

let fixture: IrFixture;

beforeAll(async () => {
  fixture = await IrFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

const declaration = (chain: string) => fixture.declaration('src/nesting.ts', chain);

const constructions = () => fixture.ir.callSites.filter((entry) => entry.isConstruction);

const construction = (calleeText: string) =>
  constructions().find((entry) => entry.calleeText === calleeText);

describe('construction as an invocation', () => {
  it('records a new expression as a call site, flagged as a construction', () => {
    expect(construction('Service')).toMatchObject({
      isConstruction: true,
      calleeRootName: 'Service',
      calleeMemberName: null,
    });
  });

  it('flags an ordinary call as not a construction', () => {
    const run = fixture.ir.callSites.find((entry) => entry.calleeText === 'topInstance.run');

    expect(run?.isConstruction).toBe(false);
  });

  it('records the arguments of a construction, like any other invocation', () => {
    const site = fixture.ir.callSites.find(
      (entry) => entry.isConstruction && entry.arguments.length > 0,
    );

    expect(site?.arguments[0]?.text).toMatch(/^\d+$/);
  });

  it('attributes a construction to the variable it initialises', () => {
    // This is what lets a later stage learn that `svc` holds a `Service` without a
    // type checker.
    const holders = constructions().map((entry) => entry.enclosingDeclarationId);

    expect(holders).toContain('sym:src/nesting.ts#outer.svc');
    expect(holders).toContain('sym:src/nesting.ts#Holder.method.instance');
  });

  it('attributes a module-level construction to the variable, not to the file', () => {
    const top = constructions().find(
      (entry) => entry.enclosingDeclarationId === 'sym:src/nesting.ts#topInstance',
    );

    expect(top).toBeDefined();
  });

  it('does not record a construction twice as a member access', () => {
    const accesses = fixture.ir.memberAccesses.filter(
      (entry) => entry.fileId === 'file:src/nesting.ts',
    );

    expect(accesses.some((entry) => entry.text.startsWith('new '))).toBe(false);
  });

  it('locates every construction', () => {
    for (const entry of constructions()) {
      expect(entry.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('nested declarations', () => {
  it('records a function declared inside a function', () => {
    expect(declaration('outer.inner')?.kind).toBe('function');
  });

  it('records an arrow assigned to a name inside a function', () => {
    expect(declaration('outer.arrow')?.kind).toBe('variable');
  });

  it('records a function expression assigned to a name', () => {
    expect(declaration('outer.expression')?.kind).toBe('variable');
  });

  it('records a variable holding a construction', () => {
    expect(declaration('outer.svc')?.kind).toBe('variable');
  });

  it('descends to any depth', () => {
    expect(declaration('outer.deeper')?.kind).toBe('function');
    expect(declaration('outer.deeper.deepest')?.kind).toBe('function');
  });

  it('records a function nested inside a method', () => {
    expect(declaration('Holder.method.helper')?.kind).toBe('function');
    expect(declaration('Holder.method.named')?.kind).toBe('variable');
    expect(declaration('Holder.method.instance')?.kind).toBe('variable');
  });

  it('records a function nested inside an accessor', () => {
    expect(declaration('Holder.value.fromAccessor')?.kind).toBe('function');
  });

  it('records a function nested inside a constructor', () => {
    expect(declaration('Holder.constructor.fromConstructor')?.kind).toBe('function');
  });

  it('records a function nested inside a module-level arrow', () => {
    expect(declaration('holderFactory.fromArrow')?.kind).toBe('function');
  });
});

describe('what nesting still excludes', () => {
  it('records no local that is not invocable and holds no instance', () => {
    expect(declaration('outer.local')).toBeUndefined();
    expect(declaration('plainNumber')).toBeDefined();
  });

  it('records no class declared inside a body', () => {
    // A local class cannot be named from outside, and no call site can address it.
    expect(declaration('outer.LocalClass')).toBeUndefined();
  });

  it('records no anonymous function, there being no name to address it by', () => {
    const anonymous = fixture.ir.declarations.filter((entry) =>
      entry.containerChain.some((segment) => segment.length === 0),
    );

    expect(anonymous).toEqual([]);
  });
});

describe('the expanded IR contract', () => {
  it('names every nested declaration under the declaration containing it', () => {
    expect(declaration('outer.deeper.deepest')?.containerChain).toEqual([
      'outer',
      'deeper',
      'deepest',
    ]);
  });

  it('gives every declaration a container chain ending in its own name', () => {
    for (const entry of fixture.ir.declarations) {
      expect(entry.containerChain.at(-1)).toBe(entry.name);
    }
  });

  it('records the container of every nested declaration as a declaration too', () => {
    // The graph derives DECLARES parentage by walking the chain outwards, so a nested
    // declaration whose container went unrecorded would be reparented to its file.
    const ids = new Set<string>(fixture.ir.declarations.map((entry) => entry.id));
    const nested = fixture.ir.declarations.filter((entry) => entry.containerChain.length > 1);

    expect(nested.length).toBeGreaterThan(0);

    for (const entry of nested) {
      const path = entry.fileId.slice('file:'.length);
      const parent = entry.containerChain.slice(0, -1).join('.');

      expect(ids.has(`sym:${path}#${parent}`)).toBe(true);
    }
  });

  it('records no duplicate declaration identifier', () => {
    const ids = fixture.ir.declarations.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the expanded IR plain data that survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(fixture.ir))).toEqual(fixture.ir);
  });

  it('exposes no ts-morph node anywhere in the IR', () => {
    const serialised = JSON.stringify(fixture.ir);

    expect(serialised).not.toContain('compilerNode');
    expect(serialised).not.toContain('_context');
  });
});
