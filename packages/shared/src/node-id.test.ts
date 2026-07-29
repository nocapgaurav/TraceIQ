import { describe, expect, it } from 'vitest';

import {
  InvalidNodeIdError,
  environmentVariableId,
  fileId,
  routeId,
  symbolId,
} from './node-id.js';
import { InvalidRepoPathError } from './repo-path.js';

describe('fileId', () => {
  it('builds the identifier form given in the contract', () => {
    expect(fileId('src/auth/auth.service.ts')).toBe('file:src/auth/auth.service.ts');
  });

  it('normalises the path before building', () => {
    expect(fileId('./src\\auth//auth.service.ts')).toBe('file:src/auth/auth.service.ts');
  });

  it('surfaces path validation failures rather than producing a broken identifier', () => {
    expect(() => fileId('/absolute/path.ts')).toThrow(InvalidRepoPathError);
  });
});

describe('symbolId', () => {
  it('builds the identifier form given in the contract', () => {
    expect(symbolId('src/auth/auth.service.ts', ['AuthService', 'login'])).toBe(
      'sym:src/auth/auth.service.ts#AuthService.login',
    );
  });

  it('addresses a top-level declaration with a single segment', () => {
    expect(symbolId('src/utils/hash.ts', ['hashPassword'])).toBe(
      'sym:src/utils/hash.ts#hashPassword',
    );
  });

  it('addresses a nested declaration through its full container chain', () => {
    expect(symbolId('src/a.ts', ['Outer', 'Inner', 'method'])).toBe(
      'sym:src/a.ts#Outer.Inner.method',
    );
  });

  it('is deterministic for identical input', () => {
    const chain = ['AuthService', 'login'];
    expect(symbolId('src/auth/auth.service.ts', chain)).toBe(
      symbolId('src/auth/auth.service.ts', chain),
    );
  });

  it('addresses an ECMAScript private member, whose name starts with "#"', () => {
    expect(symbolId('src/auth/auth.service.ts', ['AuthService', '#secret'])).toBe(
      'sym:src/auth/auth.service.ts#AuthService.#secret',
    );
  });

  it('keeps a private member distinct from a public one of the same bare name', () => {
    expect(symbolId('src/a.ts', ['C', '#value'])).not.toBe(symbolId('src/a.ts', ['C', 'value']));
  });

  it.each([
    ['an empty container chain', [] as string[]],
    ['an empty segment', ['AuthService', '']],
    ['a whitespace-only segment', ['AuthService', '   ']],
    ['a segment containing the chain delimiter', ['Auth.Service', 'login']],
    ['a segment with an interior private marker', ['Auth#Service', 'login']],
    ['a segment with a trailing private marker', ['AuthService', 'login#']],
  ])('rejects %s', (_description, chain) => {
    expect(() => symbolId('src/auth/auth.service.ts', chain)).toThrow(InvalidNodeIdError);
  });
});

describe('routeId', () => {
  it('builds the identifier form given in the contract', () => {
    expect(routeId('POST', '/api/auth/login')).toBe('route:POST:/api/auth/login');
  });

  it('upper-cases the method so casing cannot fork an identifier', () => {
    expect(routeId('post', '/api/auth/login')).toBe(routeId('POST', '/api/auth/login'));
  });

  it('collapses duplicate and trailing slashes from composed prefixes', () => {
    expect(routeId('GET', '/api//auth/profile/')).toBe('route:GET:/api/auth/profile');
  });

  it('preserves route parameters', () => {
    expect(routeId('GET', '/users/:id/posts/:postId')).toBe(
      'route:GET:/users/:id/posts/:postId',
    );
  });

  it('supports the root path', () => {
    expect(routeId('GET', '/')).toBe('route:GET:/');
  });

  it.each([
    ['an empty method', '', '/api'],
    ['a non-alphabetic method', 'GET!', '/api'],
    ['a method containing whitespace', 'GET POST', '/api'],
    ['a relative route path', 'GET', 'api/auth'],
    ['an empty route path', 'GET', ''],
  ])('rejects %s', (_description, method, routePath) => {
    expect(() => routeId(method, routePath)).toThrow(InvalidNodeIdError);
  });
});

describe('environmentVariableId', () => {
  it('builds the frozen identifier form', () => {
    expect(environmentVariableId('DATABASE_URL')).toBe('env:DATABASE_URL');
  });

  it('carries no path, a variable belonging to the process rather than a file', () => {
    expect(environmentVariableId('PORT')).toBe(environmentVariableId('PORT'));
  });

  it('trims surrounding whitespace', () => {
    expect(environmentVariableId('  PORT  ')).toBe('env:PORT');
  });

  it.each(['A', '_private', 'PORT_2', 'a1'])('accepts the name %s', (name) => {
    expect(() => environmentVariableId(name)).not.toThrow();
  });

  it.each([
    ['an empty name', ''],
    ['whitespace only', '   '],
    ['a leading digit', '1PORT'],
    ['a hyphen', 'MY-VAR'],
    ['a colon, which delimits identifiers', 'A:B'],
    ['a separator used by edge identity', 'A|B'],
    ['a dot', 'A.B'],
  ])('rejects %s', (_description, name) => {
    expect(() => environmentVariableId(name)).toThrow(InvalidNodeIdError);
  });
});
