import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IrFixture } from './ir-fixture.test-helper.js';

/**
 * Call and member-access extraction. One fixture built once, covering the forms a
 * consumer has to be able to read.
 */
const FILES = {
  'src/routes.ts': `import { Router } from 'express';
const router = Router();
router.post('/login', handleLogin);
router.get('/users/:id', requireAuth, handleUser);
router.use('/api', router);
app.listen(3000);
export function register(): void {
  router.delete(\`/items\`, handleDelete);
}
function handleLogin(): void {}
function requireAuth(): void {}
function handleUser(): void {}
function handleDelete(): void {}
declare const app: { listen(port: number): void };
export default router;
`,
  'src/config.ts': `export const PORT = process.env.PORT;
export const URL = process.env['DATABASE_URL'];
const key = 'DYNAMIC';
export const DYNAMIC = process.env[key];
export class Holder {
  secret = process.env.JWT_SECRET;
  read(): string | undefined {
    return process.env.NESTED;
  }
}
`,
  'src/noise.ts': `export class Thing {
  private value = 1;
  run(): number {
    const local = this.value;
    return Object.keys({ a: 1 }).length + local;
  }
}
`,
};

let fixture: IrFixture;

beforeAll(async () => {
  fixture = await IrFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

const callsIn = (path: string) =>
  fixture.ir.callSites.filter((entry) => entry.fileId === `file:${path}`);

const accessesIn = (path: string) =>
  fixture.ir.memberAccesses.filter((entry) => entry.fileId === `file:${path}`);

const call = (path: string, calleeText: string) =>
  callsIn(path).find((entry) => entry.calleeText === calleeText);

describe('call sites', () => {
  it('records a member call with its root and member names split out', () => {
    expect(call('src/routes.ts', 'router.post')).toMatchObject({
      calleeRootName: 'router',
      calleeMemberName: 'post',
    });
  });

  it('records a bare identifier call with no member name', () => {
    expect(call('src/routes.ts', 'Router')).toMatchObject({
      calleeRootName: 'Router',
      calleeMemberName: null,
    });
  });

  it('reads a string-literal argument as a value, not as expression text', () => {
    // This is what lets a consumer take a route path without parsing.
    expect(call('src/routes.ts', 'router.post')?.arguments[0]).toEqual({
      text: "'/login'",
      stringValue: '/login',
    });
  });

  it('reads a template literal with no substitution as a string', () => {
    expect(call('src/routes.ts', 'router.delete')?.arguments[0]?.stringValue).toBe('/items');
  });

  it('leaves a non-literal argument without a value, keeping its text', () => {
    const handler = call('src/routes.ts', 'router.post')?.arguments[1];

    expect(handler).toEqual({ text: 'handleLogin', stringValue: null });
  });

  it('keeps arguments in source order, so a middleware chain stays ordered', () => {
    expect(call('src/routes.ts', 'router.get')?.arguments.map((entry) => entry.text)).toEqual([
      "'/users/:id'",
      'requireAuth',
      'handleUser',
    ]);
  });

  it('records a numeric argument as text with no string value', () => {
    expect(call('src/routes.ts', 'app.listen')?.arguments[0]).toEqual({
      text: '3000',
      stringValue: null,
    });
  });

  it('attributes a module-level call to no declaration', () => {
    expect(call('src/routes.ts', 'router.post')?.enclosingDeclarationId).toBeNull();
  });

  it('attributes a call inside a function body to that function', () => {
    expect(call('src/routes.ts', 'router.delete')?.enclosingDeclarationId).toBe(
      'sym:src/routes.ts#register',
    );
  });

  it('enters function bodies, unlike declaration extraction', () => {
    // The declaration walk never descends into a body; the expression walk must.
    expect(call('src/routes.ts', 'router.delete')).toBeDefined();
    expect(call('src/noise.ts', 'Object.keys')).toBeDefined();
  });

  it('attributes a call inside a method to that method', () => {
    expect(call('src/noise.ts', 'Object.keys')?.enclosingDeclarationId).toBe(
      'sym:src/noise.ts#Thing.run',
    );
  });

  it('records a location for every call', () => {
    for (const entry of fixture.ir.callSites) {
      expect(entry.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('member accesses', () => {
  it('records a chain rooted at an identifier, split into root and path', () => {
    const port = accessesIn('src/config.ts').find((entry) => entry.text === 'process.env.PORT');

    expect(port).toMatchObject({ rootName: 'process', path: ['env', 'PORT'] });
  });

  it('reads a string-literal element access as a path segment', () => {
    const url = accessesIn('src/config.ts').find((entry) =>
      entry.text.includes('DATABASE_URL'),
    );

    expect(url).toMatchObject({ rootName: 'process', path: ['env', 'DATABASE_URL'] });
  });

  it('rejects a computed element access rather than truncating the chain', () => {
    // `process.env[key]` is not addressable, and reporting it as `process.env` would
    // claim a different access from the one written.
    expect(accessesIn('src/config.ts').some((entry) => entry.text.includes('[key]'))).toBe(false);
  });

  it('attributes an access to the declaration whose initializer holds it', () => {
    const port = accessesIn('src/config.ts').find((entry) => entry.text === 'process.env.PORT');

    expect(port?.enclosingDeclarationId).toBe('sym:src/config.ts#PORT');
  });

  it('attributes an access inside a class property initializer to that property', () => {
    const secret = accessesIn('src/config.ts').find((entry) =>
      entry.text.includes('JWT_SECRET'),
    );

    expect(secret?.enclosingDeclarationId).toBe('sym:src/config.ts#Holder.secret');
  });

  it('attributes an access inside a method body to that method', () => {
    const nested = accessesIn('src/config.ts').find((entry) => entry.text.includes('NESTED'));

    expect(nested?.enclosingDeclarationId).toBe('sym:src/config.ts#Holder.read');
  });

  it('does not record a chain rooted at this', () => {
    // `this.value` describes local structure, not a cross-cutting reference.
    expect(accessesIn('src/noise.ts').some((entry) => entry.text.startsWith('this.'))).toBe(false);
  });

  it('does not record a callee, which the call site already describes', () => {
    expect(accessesIn('src/noise.ts').some((entry) => entry.text === 'Object.keys')).toBe(false);
    expect(accessesIn('src/routes.ts').some((entry) => entry.text === 'router.post')).toBe(false);
  });

  it('records only the outermost chain, not each prefix', () => {
    const chains = accessesIn('src/config.ts').map((entry) => entry.text);

    expect(chains).not.toContain('process.env');
  });

  it('records a location for every access', () => {
    for (const entry of fixture.ir.memberAccesses) {
      expect(entry.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('the IR contract', () => {
  it('keeps expressions plain data that survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(fixture.ir))).toEqual(fixture.ir);
  });

  it('attributes every expression to a file the IR recorded', () => {
    const fileIds = new Set(fixture.ir.files.map((entry) => entry.id));

    for (const entry of [...fixture.ir.callSites, ...fixture.ir.memberAccesses]) {
      expect(fileIds.has(entry.fileId)).toBe(true);
    }
  });

  it('attributes every enclosing declaration to one the IR recorded', () => {
    const declarationIds = new Set(fixture.ir.declarations.map((entry) => entry.id));

    for (const entry of [...fixture.ir.callSites, ...fixture.ir.memberAccesses]) {
      if (entry.enclosingDeclarationId !== null) {
        expect(declarationIds.has(entry.enclosingDeclarationId)).toBe(true);
      }
    }
  });

  it('still records no local declaration, expressions notwithstanding', () => {
    expect(fixture.declaration('src/noise.ts', 'Thing.run.local')).toBeUndefined();
  });
});
