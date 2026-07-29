import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FrameworkFixture } from './framework-fixture.test-helper.js';
import { HTTP_METHODS } from './types.js';

const FILES = {
  'src/router.ts': `import { Router } from 'express';
const router = Router();
router.get('/get', handle);
router.post('/post', handle);
router.put('/put', handle);
router.patch('/patch', handle);
router.delete('/delete', handle);
router.head('/head', handle);
router.options('/options', handle);
router.all('/all', handle);
router.get('/chain', first, second, handle);
router.get(\`/template\`, handle);
router.use('/mounted', mounted);
router.get(BASE + '/computed', handle);
router.get('/no-handler');
export function register(): void {
  router.post('/inside', handle);
}
const BASE = '/api';
function handle(): void {}
function first(): void {}
function second(): void {}
function mounted(): void {}
export default router;
`,
  'src/app.ts': `import express from 'express';
const app = express();
app.get('/from-app', handler);
function handler(): void {}
export default app;
`,
  'src/member-handler.ts': `import { Router } from 'express';
import { Controller } from './controller';
const router = Router();
const controller = new Controller();
router.get('/member', controller.show);
export default router;
`,
  'src/controller.ts': `export class Controller {
  show(): void {}
}
`,
  'src/not-express.ts': `const thing = makeThing();
thing.get('/looks-like-a-route', () => undefined);
function makeThing() { return { get(_p: string, _h: unknown) {} }; }
export default thing;
`,
};

let fixture: FrameworkFixture;

beforeAll(async () => {
  fixture = await FrameworkFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

describe('framework detection', () => {
  it('reports Express when a file imports it', () => {
    expect(fixture.annotations.framework).toBe('express');
  });
});

describe('route extraction', () => {
  it.each([
    ['GET', '/get'],
    ['POST', '/post'],
    ['PUT', '/put'],
    ['PATCH', '/patch'],
    ['DELETE', '/delete'],
    ['HEAD', '/head'],
    ['OPTIONS', '/options'],
    ['ALL', '/all'],
  ])('extracts a %s route at %s', (method, routePath) => {
    expect(fixture.route(method, routePath)).toBeDefined();
  });

  it('uses only methods from the published vocabulary', () => {
    for (const route of fixture.annotations.routes) {
      expect(HTTP_METHODS).toContain(route.method);
    }
  });

  it('reads a path written as a template literal', () => {
    expect(fixture.route('GET', '/template')).toBeDefined();
  });

  it('records a single handler', () => {
    expect(fixture.route('POST', '/post')?.handlers).toEqual([
      { text: 'handle', ordinal: 0, declarationId: 'sym:src/router.ts#handle' },
    ]);
  });

  it('keeps a middleware chain in source order', () => {
    expect(fixture.route('GET', '/chain')?.handlers.map((entry) => entry.text)).toEqual([
      'first',
      'second',
      'handle',
    ]);
    expect(fixture.route('GET', '/chain')?.handlers.map((entry) => entry.ordinal)).toEqual([
      0, 1, 2,
    ]);
  });

  it('links a bare-identifier handler to its declaration', () => {
    expect(fixture.route('GET', '/get')?.handlers[0]?.declarationId).toBe(
      'sym:src/router.ts#handle',
    );
  });

  it('leaves a member-expression handler unlinked, that needing resolution', () => {
    const route = fixture.route('GET', '/member');

    expect(route?.handlers[0]).toEqual({
      text: 'controller.show',
      ordinal: 0,
      declarationId: null,
    });
  });

  it('attributes a module-level registration to no declaration', () => {
    expect(fixture.route('GET', '/get')?.registeredInDeclarationId).toBeNull();
  });

  it('attributes a registration inside a function to that function', () => {
    expect(fixture.route('POST', '/inside')?.registeredInDeclarationId).toBe(
      'sym:src/router.ts#register',
    );
  });

  it('extracts a route from an application, not only a router', () => {
    expect(fixture.route('GET', '/from-app')).toBeDefined();
  });

  it('records every route as INFERRED, no annotation being proven', () => {
    expect(fixture.annotations.routes.every((entry) => entry.confidence === 'INFERRED')).toBe(true);
  });

  it('says whether the Resolver confirmed the express package, not just the specifier text', () => {
    // express is not installed in the fixture, yet the Resolver still classifies a bare
    // specifier as the express package, so the stronger wording is what appears.
    expect(fixture.route('GET', '/get')?.provenance.evidence).toContain('from the express package');
  });

  it('explains each route in terms of the syntax it was read from', () => {
    for (const route of fixture.annotations.routes) {
      expect(route.provenance.annotator).toBe('routes');
      expect(route.provenance.evidence).toMatch(/traced/);
      expect(route.location.startLine).toBeGreaterThan(0);
    }
  });
});

describe('what is deliberately not a route', () => {
  it('does not treat use() as a route, it carrying no HTTP method', () => {
    expect(fixture.annotations.routes.some((entry) => entry.path === '/mounted')).toBe(false);
  });

  it('does not guess at a computed path', () => {
    expect(fixture.annotations.routes.some((entry) => entry.path.includes('computed'))).toBe(false);
  });

  it('ignores a registration with no handler', () => {
    expect(fixture.annotations.routes.some((entry) => entry.path === '/no-handler')).toBe(false);
  });

  it('ignores a method call on something not traced to Express', () => {
    // `thing.get('/looks-like-a-route', …)` is shaped exactly like a route, and the
    // only thing distinguishing it is that `thing` was never traced to express.
    expect(
      fixture.annotations.routes.some((entry) => entry.path === '/looks-like-a-route'),
    ).toBe(false);
  });

  it('records no route in a file that does not import Express', () => {
    expect(
      fixture.annotations.routes.some((entry) => entry.provenance.fileId === 'file:src/not-express.ts'),
    ).toBe(false);
  });
});

describe('determinism', () => {
  it('produces identical annotations from identical inputs', () => {
    expect(fixture.reextract()).toEqual(fixture.annotations);
  });

  it('produces annotations that survive a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(fixture.annotations))).toEqual(fixture.annotations);
  });

  it('orders routes by the file and position they were read from', () => {
    const positions = fixture.annotations.routes.map(
      (entry) => `${entry.provenance.fileId}:${String(entry.location.startLine).padStart(4, '0')}`,
    );

    expect(positions).toEqual([...positions].sort());
  });
});
