import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CallGraphFixture } from './call-graph-fixture.test-helper.js';
import { CALL_KINDS, UNRESOLVED_CALL_REASONS } from './types.js';

/**
 * One fixture covering every binding rule and every way a call can fail to bind.
 */
const FILES = {
  'src/lib.ts': `export class Service {
  private helper(): number { return 1; }
  run(): number { return this.helper(); }
  static make(): Service { return new Service(); }
  chained(): number { return this.run() + this.helper(); }
}
export class WithCtor {
  constructor(readonly n: number) {}
  ping(): number { return this.n; }
}
export namespace Space {
  export function inner(): number { return 2; }
}
export function exported(): number { return 3; }
`,
  'src/main.ts': `import { Service, WithCtor, exported } from './lib';
import * as everything from './lib';
import nodePath from 'node:path';

const instance = new Service();
const built = new WithCtor(1);
const notAFunction = 5;
const opaque = getService();

export function recursive(depth: number): number {
  return depth <= 0 ? 0 : recursive(depth - 1);
}

export function callsEverything(): void {
  local();
  exported();
  Service.make();
  everything.exported();
  recursive(1);
  instance.run();
  built.ping();
  new Service();
  new WithCtor(2);
  nested();
  Service.missing();
  everything.missing();
  unbound();
  getService().run();
  notAFunction.toFixed();
  opaque.run();
  nodePath.join('a', 'b');

  function nested(): number {
    function deeper(): number { return 1; }
    const arrow = (): number => 2;
    const local = new Service();

    return deeper() + arrow() + local.run();
  }
}

function local(): void {}
function getService(): Service { return instance; }
`,
  'src/module-level.ts': `import { exported } from './lib';
exported();
export const marker = 1;
`,
  'src/no-class.ts': `export function loose(): void {
  this.something();
}
`,
};

let fixture: CallGraphFixture;

beforeAll(async () => {
  fixture = await CallGraphFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

describe('binding rules', () => {
  it('binds a local call to a top-level declaration in the same file', () => {
    expect(fixture.call('local')).toMatchObject({
      kind: 'local',
      sourceId: 'sym:src/main.ts#callsEverything',
      targetId: 'sym:src/main.ts#local',
    });
  });

  it('binds an imported call to the declaration the Resolver bound the import to', () => {
    expect(fixture.call('exported')).toMatchObject({
      kind: 'imported',
      targetId: 'sym:src/lib.ts#exported',
    });
  });

  it('binds a this-member call to a member of the enclosing class', () => {
    expect(fixture.call('this.helper')).toMatchObject({
      kind: 'this-member',
      sourceId: 'sym:src/lib.ts#Service.run',
      targetId: 'sym:src/lib.ts#Service.helper',
    });
  });

  it('binds a static-member call through the class the root names', () => {
    expect(fixture.call('Service.make')).toMatchObject({
      kind: 'static-member',
      targetId: 'sym:src/lib.ts#Service.make',
    });
  });

  it('binds a namespace-member call through the module a namespace import names', () => {
    expect(fixture.call('everything.exported')).toMatchObject({
      kind: 'namespace-member',
      targetId: 'sym:src/lib.ts#exported',
    });
  });

  it('binds a construction to the constructor of the class the root names', () => {
    expect(fixture.call('WithCtor')).toMatchObject({
      kind: 'construction',
      targetId: 'sym:src/lib.ts#WithCtor.constructor',
    });
  });

  it('binds a construction of a class with no constructor to the class itself', () => {
    // The construction still happens, and pointing at the class says more than nothing.
    const construction = fixture.callGraph.calls.find(
      (entry) => entry.kind === 'construction' && entry.targetId === 'sym:src/lib.ts#Service',
    );

    expect(construction).toBeDefined();
  });

  it('binds a call on a constructed variable to the member of its class', () => {
    // `const instance = new Service(); instance.run()`. This is the shape the IR
    // Expansion exists for.
    expect(fixture.call('instance.run')).toMatchObject({
      kind: 'instance-member',
      targetId: 'sym:src/lib.ts#Service.run',
    });
  });

  it('binds through a constructed variable whose class declares a constructor', () => {
    expect(fixture.call('built.ping')).toMatchObject({
      kind: 'instance-member',
      targetId: 'sym:src/lib.ts#WithCtor.ping',
    });
  });

  it('binds a call to a function nested inside another function', () => {
    expect(fixture.call('nested')).toMatchObject({
      kind: 'local',
      sourceId: 'sym:src/main.ts#callsEverything',
      targetId: 'sym:src/main.ts#callsEverything.nested',
    });
  });

  it('binds a call from inside a nested function to a name in its own scope', () => {
    expect(fixture.call('deeper')).toMatchObject({
      kind: 'local',
      sourceId: 'sym:src/main.ts#callsEverything.nested',
      targetId: 'sym:src/main.ts#callsEverything.nested.deeper',
    });
  });

  it('binds a call to a nested arrow assigned to a name', () => {
    expect(fixture.call('arrow')).toMatchObject({
      kind: 'local',
      targetId: 'sym:src/main.ts#callsEverything.nested.arrow',
    });
  });

  it('binds a member call on a variable constructed inside a nested function', () => {
    expect(fixture.call('local.run')).toMatchObject({
      kind: 'instance-member',
      sourceId: 'sym:src/main.ts#callsEverything.nested',
      targetId: 'sym:src/lib.ts#Service.run',
    });
  });

  it('uses only kinds from the published vocabulary', () => {
    for (const call of fixture.callGraph.calls) {
      expect(CALL_KINDS).toContain(call.kind);
    }
  });
});

describe('recursion', () => {
  it('binds a self-call, recursion being a real fact about the code', () => {
    const call = fixture.call('recursive');

    expect(call?.sourceId).toBe('sym:src/main.ts#recursive');
    expect(call?.targetId).toBe('sym:src/main.ts#recursive');
  });

  it('binds a repeated this-member call once per site, not once per target', () => {
    // `chained()` calls this.run() and this.helper(); each is its own call.
    const fromChained = fixture.callsFrom('sym:src/lib.ts#Service.chained');

    expect(fromChained.map((entry) => entry.calleeText).sort()).toEqual([
      'this.helper',
      'this.run',
    ]);
  });
});

describe('module-level calls', () => {
  it('attributes a call outside any declaration to its file', () => {
    const call = fixture.callGraph.calls.find(
      (entry) => entry.provenance.fileId === 'file:src/module-level.ts',
    );

    expect(call?.sourceId).toBe('file:src/module-level.ts');
    expect(call?.targetId).toBe('sym:src/lib.ts#exported');
  });
});

describe('what deliberately does not bind', () => {
  it('reports a member on a value as needing a type, not as a missing member', () => {
    // A variable whose initializer is not a construction still has no recoverable type,
    // so the member cannot be bound without a checker.
    expect(fixture.unresolved('opaque.run')).toMatchObject({ reason: 'root-type-unknown' });
    expect(fixture.unresolved('notAFunction.toFixed')).toMatchObject({
      reason: 'root-type-unknown',
    });
  });

  it('reports a missing member on a container that did bind', () => {
    expect(fixture.unresolved('Service.missing')).toMatchObject({ reason: 'member-not-found' });
    expect(fixture.unresolved('everything.missing')).toMatchObject({ reason: 'member-not-found' });
  });

  it('reports an unbound root', () => {
    expect(fixture.unresolved('unbound')).toMatchObject({ reason: 'root-not-bound' });
  });

  it('records a call that leaves the repository as an edge onto the dependency', () => {
    // `nodePath.join` resolves to a Node builtin. There is correctly no repository
    // declaration to point at, but there *is* a boundary to name — and naming it is the
    // difference between "which of my declarations use node:path" being answerable and not.
    // It stays out of `unresolved`, because nothing here failed.
    expect(fixture.unresolved('nodePath.join')).toBeUndefined();

    const external = fixture.externalCall('nodePath.join');

    expect(external?.name).toBe('node:path');
    expect(external?.origin).toBe('standard-library');
    // INFERRED, not RESOLVED: the import statement proves where the name came from, and no
    // checker confirmed that the callee exists.
    expect(external?.confidence).toBe('INFERRED');
    expect(external?.provenance.evidence).toMatch(/leaves the repository/);
  });

  it('reports a callee that is not rooted at an identifier', () => {
    expect(fixture.unresolved('getService().run')).toMatchObject({
      reason: 'callee-not-addressable',
    });
  });

  it('reports this used where the enclosing declaration has no container', () => {
    expect(fixture.unresolved('this.something')).toMatchObject({
      reason: 'no-enclosing-container',
    });
  });

  it('uses only reasons from the published vocabulary', () => {
    for (const entry of fixture.callGraph.unresolved) {
      expect(UNRESOLVED_CALL_REASONS).toContain(entry.reason);
    }
  });

  it('keeps every unbound call visible rather than dropping it', () => {
    // Each of the six failing forms above appears exactly once.
    expect(fixture.callGraph.unresolved.length).toBeGreaterThanOrEqual(6);
  });
});

describe('explainability', () => {
  it('records every call as INFERRED, this stage having no type checker', () => {
    expect(fixture.callGraph.calls.every((entry) => entry.confidence === 'INFERRED')).toBe(true);
  });

  it('names the rule that fired in the evidence', () => {
    expect(fixture.call('this.helper')?.provenance.evidence).toMatch(/member of the container/);
    expect(fixture.call('everything.exported')?.provenance.evidence).toMatch(/namespace import/);
  });

  it('explains every failure in words', () => {
    for (const entry of fixture.callGraph.unresolved) {
      expect(entry.provenance.evidence.length).toBeGreaterThan(20);
    }
  });

  it('locates every call and every failure', () => {
    for (const entry of [...fixture.callGraph.calls, ...fixture.callGraph.unresolved]) {
      expect(entry.location.startLine).toBeGreaterThan(0);
      expect(entry.provenance.producer).toBe('call-graph');
    }
  });

  it('attributes every call to a file the IR recorded', () => {
    const fileIds = new Set(fixture.ir.files.map((entry) => entry.id));

    for (const entry of [...fixture.callGraph.calls, ...fixture.callGraph.unresolved]) {
      expect(fileIds.has(entry.provenance.fileId)).toBe(true);
    }
  });
});

describe('graph consistency', () => {
  it('targets only declarations the IR recorded', () => {
    const declarationIds = new Set(fixture.ir.declarations.map((entry) => entry.id));

    for (const call of fixture.callGraph.calls) {
      expect(declarationIds.has(call.targetId)).toBe(true);
    }
  });

  it('sources every call at a declaration or a file the IR recorded', () => {
    const known = new Set<string>([
      ...fixture.ir.declarations.map((entry) => entry.id),
      ...fixture.ir.files.map((entry) => entry.id),
    ]);

    for (const entry of [...fixture.callGraph.calls, ...fixture.callGraph.unresolved]) {
      expect(known.has(entry.sourceId)).toBe(true);
    }
  });

  it('produces no duplicate call at one site', () => {
    const keys = fixture.callGraph.calls.map(
      (entry) =>
        `${entry.sourceId}|${entry.targetId}|${entry.calleeText}|${entry.location.startLine}:${entry.location.startColumn}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('binds every call site to exactly one outcome', () => {
    // Three outcomes, not two: a call reaches a declaration, reaches a dependency, or reaches
    // neither. The third was folded into `unresolved` until external calls became nameable
    // without a type checker.
    expect(
      fixture.callGraph.calls.length +
        fixture.callGraph.externalCalls.length +
        fixture.callGraph.unresolved.length,
    ).toBe(fixture.ir.callSites.length);
  });
});

describe('determinism', () => {
  it('binds identically from identical inputs', () => {
    expect(fixture.rebind()).toEqual(fixture.callGraph);
  });

  it('produces plain data that survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(fixture.callGraph))).toEqual(fixture.callGraph);
  });

  it('emits calls in the order the IR recorded their sites', () => {
    const sites = fixture.ir.callSites.map(
      (site) => `${site.fileId}|${site.location.startLine}:${site.location.startColumn}`,
    );
    const bound = fixture.callGraph.calls.map(
      (call) => `${call.provenance.fileId}|${call.location.startLine}:${call.location.startColumn}`,
    );

    // The bound calls are a subsequence of the recorded sites.
    let cursor = 0;

    for (const entry of bound) {
      cursor = sites.indexOf(entry, cursor);
      expect(cursor).toBeGreaterThanOrEqual(0);
    }
  });
});
