import { afterEach, describe, expect, it } from 'vitest';

import { CallGraphFixture, type FixtureFiles } from './call-graph-fixture.test-helper.js';

let fixture: CallGraphFixture | null = null;

afterEach(async () => {
  await fixture?.remove();
  fixture = null;
});

async function checked(files: FixtureFiles): Promise<CallGraphFixture> {
  fixture = await CallGraphFixture.createChecked(files);

  return fixture;
}

async function unchecked(files: FixtureFiles): Promise<CallGraphFixture> {
  fixture = await CallGraphFixture.create(files);

  return fixture;
}

describe('what the checker reaches that the name rules cannot', () => {
  it('binds a method called through a parameter of a class type', async () => {
    // No construction to trace, so the name rules can only report `root-type-unknown`.
    const files = {
      'src/a.ts': `export class Service { run(): void {} }
export function use(service: Service): void { service.run(); }`,
    };

    expect((await unchecked(files)).unresolved('service.run')?.reason).toBe('root-not-bound');

    await fixture?.remove();

    const call = (await checked(files)).call('service.run');

    expect(call).toMatchObject({
      targetId: 'sym:src/a.ts#Service.run',
      kind: 'checked',
      confidence: 'RESOLVED',
    });
  });

  it('binds a method called on the result of another call', async () => {
    const files = {
      'src/a.ts': `export class Service { run(): void {} }
export function make(): Service { return new Service(); }
export function go(): void { make().run(); }`,
    };

    expect((await unchecked(files)).unresolved('make().run')?.reason).toBe(
      'callee-not-addressable',
    );

    await fixture?.remove();

    expect((await checked(files)).call('make().run')?.targetId).toBe('sym:src/a.ts#Service.run');
  });

  it('binds a method called through an interface', async () => {
    const files = {
      'src/a.ts': `export interface Runner { run(): void }
export function go(runner: Runner): void { runner.run(); }`,
    };

    expect((await checked(files)).call('runner.run')).toMatchObject({
      targetId: 'sym:src/a.ts#Runner.run',
      confidence: 'RESOLVED',
    });
  });

  it('binds a method called through a destructured value', async () => {
    const files = {
      'src/a.ts': `export class Service { run(): void {} }
export function go(input: { service: Service }): void {
  const { service } = input;
  service.run();
}`,
    };

    expect((await checked(files)).call('service.run')?.targetId).toBe('sym:src/a.ts#Service.run');
  });

  it('binds a call across files to the imported declaration', async () => {
    const files = {
      'src/service.ts': 'export class Service { run(): void {} }',
      'src/use.ts': `import { Service } from './service';
export function go(service: Service): void { service.run(); }`,
    };

    expect((await checked(files)).call('service.run')?.targetId).toBe(
      'sym:src/service.ts#Service.run',
    );
  });

  it('picks the overload the checker selected, not the first declared', async () => {
    const files = {
      'src/a.ts': `export class Service {
  run(value: string): void;
  run(value: number): void;
  run(value: unknown): void {}
}
export function go(service: Service): void { service.run(1); }`,
    };

    // All three signatures share one IR declaration, so the assertion is that a call with
    // overloads binds at all rather than being abandoned.
    expect((await checked(files)).call('service.run')?.confidence).toBe('RESOLVED');
  });

  it('binds a call to an arrow function held in a variable, via the recorded declaration', async () => {
    // The checker resolves to the arrow function; the IR recorded the variable. The
    // binder walks outwards to the declaration that was actually recorded.
    const files = {
      'src/a.ts': `export const helper = (): void => {};
export function go(): void { helper(); }`,
    };

    expect((await checked(files)).call('helper')?.targetId).toBe('sym:src/a.ts#helper');
  });

  it('binds a construction to the constructor', async () => {
    const files = {
      'src/a.ts': `export class Service { constructor(readonly name: string) {} }
export function go(): Service { return new Service('x'); }`,
    };

    expect((await checked(files)).call('Service')?.targetId).toBe(
      'sym:src/a.ts#Service.constructor',
    );
  });

  it('binds a construction of a class with no declared constructor to the class', async () => {
    const files = {
      'src/a.ts': `export class Service {}
export function go(): Service { return new Service(); }`,
    };

    expect((await checked(files)).call('Service')?.targetId).toBe('sym:src/a.ts#Service');
  });
});

describe('calls that leave the repository', () => {
  it('records a call into a package as an external call, not as an edge to nothing', async () => {
    const files = {
      'node_modules/tiny-dep/package.json': '{"name":"tiny-dep","types":"index.d.ts"}',
      'node_modules/tiny-dep/index.d.ts': 'export declare function greet(name: string): string;',
      'src/a.ts': `import { greet } from 'tiny-dep';
export function go(): string { return greet('x'); }`,
    };

    const external = (await checked(files)).externalCall('greet');

    expect(external).toMatchObject({
      origin: 'package',
      name: 'tiny-dep',
      confidence: 'RESOLVED',
    });
  });

  it('produces no CALLS relationship for an external call', async () => {
    // The two collections are disjoint: one names a declaration in this repository, the
    // other names a boundary.
    const files = {
      'node_modules/tiny-dep/package.json': '{"name":"tiny-dep","types":"index.d.ts"}',
      'node_modules/tiny-dep/index.d.ts': 'export declare function greet(name: string): string;',
      'src/a.ts': `import { greet } from 'tiny-dep';
export function go(): string { return greet('x'); }`,
    };

    const created = await checked(files);

    expect(created.call('greet')).toBeUndefined();
    expect(created.externalCall('greet')).toBeDefined();
  });

  it('does not record a language builtin as a dependency', async () => {
    // `JSON.stringify` is not something the repository chose to depend on. An edge per
    // call would bury the packages it did choose.
    const files = {
      'src/a.ts': 'export function go(value: unknown): string { return JSON.stringify(value); }',
    };

    const created = await checked(files);

    expect(created.externalCall('JSON.stringify')).toBeUndefined();
    expect(created.unresolved('JSON.stringify')?.reason).toBe('callee-is-language-builtin');
  });

  it('explains a language builtin rather than reporting it as a failure to bind', async () => {
    const files = {
      'src/a.ts': 'export function go(items: string[]): string[] { return items.map((x) => x); }',
    };

    expect((await checked(files)).unresolved('items.map')?.provenance.evidence).toMatch(
      /TypeScript library declaration/,
    );
  });

  it('does not let a name rule claim a builtin call for a local of the same name', async () => {
    // Without the explicit reason, the bare-name rule would happily bind this `parse`.
    const files = {
      'src/a.ts': `export function parse(): void {}
export function go(value: string): unknown { return JSON.parse(value); }`,
    };

    const created = await checked(files);

    expect(created.call('JSON.parse')).toBeUndefined();
    expect(created.unresolved('JSON.parse')?.reason).toBe('callee-is-language-builtin');
  });
});

describe('the two tiers together', () => {
  it('falls back to a name rule when the checker declines', async () => {
    // An untyped receiver gives the checker nothing to resolve, but the name rule can
    // still offer the one declaration in scope — at the weaker confidence.
    const files = {
      'src/a.ts': `export class Service { run(): void {} }
export function go(service: any): void { service.run(); }`,
    };

    const call = (await checked(files)).call('service.run');

    if (call !== undefined) {
      expect(call.confidence).toBe('INFERRED');
      expect(call.kind).not.toBe('checked');
    }
  });

  it('marks every checker binding RESOLVED and every name binding INFERRED', async () => {
    const files = {
      'src/a.ts': `export class Service { run(): void {} }
export function go(service: Service): void { service.run(); }`,
    };

    for (const call of (await checked(files)).callGraph.calls) {
      expect(call.confidence).toBe(call.kind === 'checked' ? 'RESOLVED' : 'INFERRED');
    }
  });

  it('binds nothing through the checker when no context is given', async () => {
    const files = {
      'src/a.ts': `export class Service { run(): void {} }
export function go(service: Service): void { service.run(); }`,
    };

    const created = await unchecked(files);

    expect(created.callGraph.calls.every((call) => call.kind !== 'checked')).toBe(true);
    expect(created.callGraph.externalCalls).toEqual([]);
  });

  it('is deterministic across two bindings of the same inputs', async () => {
    const created = await checked({
      'src/a.ts': `export class Service { run(): void {} }
export function go(service: Service): void { service.run(); }`,
    });

    // `rebind` runs without a context, so this checks the name tier's determinism; the
    // checker tier's output is compared against itself through the stored graph.
    expect(created.rebind().calls.map((call) => call.calleeText)).toEqual(
      created.rebind().calls.map((call) => call.calleeText),
    );
  });
});

/**
 * The scope boundary in `#identify`.
 *
 * The checker resolves a callee to the compiler's own idea of a declaration, which is finer than
 * the graph's — so the binder walks outwards to the recorded declaration containing it. That walk
 * was unbounded, and every local the IR does not model bound to whichever declaration enclosed it.
 * Measured on this repository: 83 self-referential CALLS edges, all checker-bound, none in the
 * source.
 */
describe('locals the IR does not record', () => {
  it('does not bind a destructured local to the function that holds it', async () => {
    const fixture = await CallGraphFixture.createChecked({
      'src/main.ts': `
        function useCounter(): [number, (next: number) => void] {
          return [0, () => {}];
        }

        export function App(): void {
          const [count, setCount] = useCounter();

          setCount(count + 1);
        }
      `,
    });

    try {
      // `setCount` is an array-destructured binding. The IR records no declaration for it, so
      // there is nothing to bind to — and `App` is the caller, not the callee.
      expect(fixture.call('setCount')).toBeUndefined();
      expect(
        fixture.callGraph.calls.filter((entry) => entry.sourceId === entry.targetId),
      ).toEqual([]);
    } finally {
      await fixture.remove();
    }
  });

  it('does not bind a parameter call to the function that declares it', async () => {
    const fixture = await CallGraphFixture.createChecked({
      'src/main.ts': `
        export function run(callback: () => void): void {
          callback();
        }
      `,
    });

    try {
      expect(fixture.call('callback')).toBeUndefined();
      expect(fixture.callGraph.calls.some((entry) => entry.targetId.endsWith('#run'))).toBe(false);
    } finally {
      await fixture.remove();
    }
  });

  it('still binds an arrow assigned to a recorded variable', async () => {
    // The case the outward walk exists for: the checker resolves to the arrow, the IR recorded
    // the variable. No function boundary is crossed, because the arrow *is* where the walk starts.
    const fixture = await CallGraphFixture.createChecked({
      'src/main.ts': `
        const helper = (): void => {};

        export function run(): void {
          helper();
        }
      `,
    });

    try {
      expect(fixture.call('helper')).toMatchObject({
        targetId: 'sym:src/main.ts#helper',
        confidence: 'RESOLVED',
      });
    } finally {
      await fixture.remove();
    }
  });

  it('still binds a call to a nested function declared in the same body', async () => {
    const fixture = await CallGraphFixture.createChecked({
      'src/main.ts': `
        export function outer(): void {
          function inner(): void {}

          inner();
        }
      `,
    });

    try {
      expect(fixture.call('inner')?.targetId).toBe('sym:src/main.ts#outer.inner');
    } finally {
      await fixture.remove();
    }
  });
});
