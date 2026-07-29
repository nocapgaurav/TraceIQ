import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FrameworkFixture } from './framework-fixture.test-helper.js';

const FILES = {
  // Roles by name suffix, in a directory that suggests nothing.
  'src/flat.ts': `export class AuthController { handle(): void {} }
export class AuthService { run(): void {} }
export class UserRepository { find(): void {} }
export class UserRepo { find(): void {} }
export class AuthMiddleware { use(): void {} }
export class UserModel { id = 1; }
export class OrderEntity { id = 2; }
export class PlainThing { id = 3; }
`,
  // Roles by directory, with names that suggest nothing.
  'src/controllers/thing.ts': `export class Thing { handle(): void {} }
`,
  'src/services/worker.ts': `export class Worker { run(): void {} }
`,
  'src/repositories/store.ts': `export class Store { find(): void {} }
`,
  'src/middleware/guard.ts': `export function guard(): void {}
`,
  'src/models/record.ts': `export class RecordShape { id = 1; }
`,
  // Middleware evidenced by use, not by name.
  'src/routes.ts': `import { Router } from 'express';
const router = Router();
router.get('/x', plainlyNamed, finalHandler);
router.use(mountedPlainly);
export function plainlyNamed(): void {}
export function finalHandler(): void {}
export function mountedPlainly(): void {}
export default router;
`,
  'src/thing.test.ts': `export const fixtureValue = 1;
export class TestOnlyHelper { help(): void {} }
`,
  'src/__tests__/nested.ts': `export const helper = 2;
`,
};

let fixture: FrameworkFixture;

beforeAll(async () => {
  fixture = await FrameworkFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

describe('roles from a name suffix', () => {
  it.each([
    ['AuthController', 'Controller'],
    ['AuthService', 'Service'],
    ['UserRepository', 'Repository'],
    ['UserRepo', 'Repository'],
    ['AuthMiddleware', 'Middleware'],
    ['UserModel', 'Model'],
    ['OrderEntity', 'Model'],
  ])('reads %s as a %s', (name, role) => {
    expect(fixture.roleNames(`sym:src/flat.ts#${name}`)).toContain(role);
  });

  it('names the suffix that matched, so the claim is checkable', () => {
    expect(fixture.rolesOf('sym:src/flat.ts#AuthService')[0]?.provenance.evidence).toContain(
      "its name ends with 'Service'",
    );
  });

  it('attributes no role to a declaration matching nothing', () => {
    expect(fixture.roleNames('sym:src/flat.ts#PlainThing')).toEqual([]);
  });
});

describe('roles from a directory', () => {
  it.each([
    ['src/controllers/thing.ts#Thing', 'Controller'],
    ['src/services/worker.ts#Worker', 'Service'],
    ['src/repositories/store.ts#Store', 'Repository'],
    ['src/middleware/guard.ts#guard', 'Middleware'],
    ['src/models/record.ts#RecordShape', 'Model'],
  ])('reads %s as a %s', (suffix, role) => {
    expect(fixture.roleNames(`sym:${suffix}`)).toContain(role);
  });

  it('names the directory that matched', () => {
    expect(fixture.rolesOf('sym:src/services/worker.ts#Worker')[0]?.provenance.evidence).toContain(
      "under a 'services/' directory",
    );
  });
});

describe('middleware from use rather than from naming', () => {
  it('reads a non-final handler in a route chain as middleware', () => {
    // `plainlyNamed` carries no naming or directory hint at all; the only evidence is
    // that it runs ahead of the final handler.
    expect(fixture.roleNames('sym:src/routes.ts#plainlyNamed')).toContain('Middleware');
  });

  it('does not read the final handler as middleware', () => {
    expect(fixture.roleNames('sym:src/routes.ts#finalHandler')).not.toContain('Middleware');
  });

  it('reads a handler passed to use() as middleware', () => {
    expect(fixture.roleNames('sym:src/routes.ts#mountedPlainly')).toContain('Middleware');
  });

  it('prefers use as evidence over any convention', () => {
    expect(fixture.rolesOf('sym:src/routes.ts#plainlyNamed')[0]?.provenance.evidence).toContain(
      'used as middleware',
    );
  });
});

describe('the Test role', () => {
  it('reads a declaration in a test file as a Test', () => {
    expect(fixture.roleNames('sym:src/thing.test.ts#TestOnlyHelper')).toContain('Test');
    expect(fixture.roleNames('sym:src/thing.test.ts#fixtureValue')).toContain('Test');
  });

  it('reads a declaration under a tests directory as a Test', () => {
    expect(fixture.roleNames('sym:src/__tests__/nested.ts#helper')).toContain('Test');
  });

  it('does not read an ordinary file as a Test', () => {
    expect(fixture.roleNames('sym:src/flat.ts#AuthService')).not.toContain('Test');
  });
});

describe('what does not receive a role', () => {
  it('never annotates a class member', () => {
    // A method plays no architectural role; its class does.
    expect(fixture.roleNames('sym:src/flat.ts#AuthController.handle')).toEqual([]);
  });

  it('annotates only declarations the IR recorded', () => {
    const declarationIds = new Set(fixture.ir.declarations.map((entry) => entry.id));

    for (const role of fixture.annotations.roles) {
      expect(declarationIds.has(role.declarationId)).toBe(true);
    }
  });
});

describe('the role contract', () => {
  it('records every role as INFERRED, a convention being evidence and not proof', () => {
    expect(fixture.annotations.roles.every((entry) => entry.confidence === 'INFERRED')).toBe(true);
  });

  it('explains every role and locates it', () => {
    for (const role of fixture.annotations.roles) {
      expect(role.provenance.annotator).toBe('roles');
      expect(role.provenance.evidence.length).toBeGreaterThan(20);
      expect(role.location.startLine).toBeGreaterThan(0);
    }
  });

  it('never attributes the same role twice to one declaration', () => {
    for (const role of fixture.annotations.roles) {
      const matching = fixture
        .rolesOf(role.declarationId)
        .filter((entry) => entry.role === role.role);

      expect(matching).toHaveLength(1);
    }
  });

  it('produces identical roles from identical inputs', () => {
    expect(fixture.reextract().roles).toEqual(fixture.annotations.roles);
  });
});
