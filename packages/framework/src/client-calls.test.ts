import { afterEach, describe, expect, it } from 'vitest';

import { FrameworkFixture } from './framework-fixture.test-helper.js';

/**
 * Requests the repository *makes* — the other end of the route arrow.
 *
 * Extracted with the same discipline routes are: a literal path or nothing. The negative cases are
 * the important ones, because a recorded request becomes an assertion that traffic flows somewhere.
 */
let fixture: FrameworkFixture | null = null;

afterEach(async () => {
  await fixture?.remove();
  fixture = null;
});

const pathsOf = (calls: FrameworkFixture['annotations']['clientCalls']): readonly string[] =>
  calls.map((entry) => `${entry.method ?? '—'} ${entry.path}`).sort();

describe('client calls', () => {
  it('records fetch, and states no method because the source states none', async () => {
    fixture = await FrameworkFixture.create({
      'src/api.ts': `export async function load(): Promise<void> {
        await fetch('/api/users');
      }`,
    });

    expect(pathsOf((fixture as FrameworkFixture).annotations.clientCalls)).toEqual(['— /api/users']);
    expect((fixture as FrameworkFixture).annotations.clientCalls[0]?.confidence).toBe('INFERRED');
  });

  it('reads the method a fetch options object states', async () => {
    // Correctness rather than completeness: a method-less call matches any route on the path, so
    // missing the DELETE here linked a deletion to a GET endpoint.
    fixture = await FrameworkFixture.create({
      'src/api.ts': `export async function remove(): Promise<void> {
        await fetch('/api/users/42', { method: 'DELETE' });
      }`,
    });

    expect(pathsOf((fixture as FrameworkFixture).annotations.clientCalls)).toEqual(['DELETE /api/users/42']);
  });

  it('records a verb member on any receiver', async () => {
    fixture = await FrameworkFixture.create({
      'src/api.ts': `declare const api: { get(p: string): Promise<void>; post(p: string, b: unknown): Promise<void> };
      export async function go(): Promise<void> {
        await api.get('/api/users');
        await api.post('/api/users', {});
      }`,
    });

    expect(pathsOf((fixture as FrameworkFixture).annotations.clientCalls)).toEqual(['GET /api/users', 'POST /api/users']);
  });

  it('records nothing for a template literal, which names no endpoint', async () => {
    // `fetch(`${base}/users/${id}`)` depends on values this reader cannot know, and inventing
    // `/users/` from it would fabricate the very connection the feature exists to establish.
    fixture = await FrameworkFixture.create({
      'src/api.ts': `export async function load(id: string): Promise<void> {
        const base = '/api';
        await fetch(\`\${base}/users/\${id}\`);
      }`,
    });

    expect((fixture as FrameworkFixture).annotations.clientCalls).toEqual([]);
  });

  it('records nothing for a non-path argument', async () => {
    // `cache.get('user')` is not a request, and a bare word is a key far more often than an
    // endpoint.
    fixture = await FrameworkFixture.create({
      'src/api.ts': `declare const cache: { get(k: string): unknown };
      export function read(): unknown {
        return cache.get('user');
      }`,
    });

    expect((fixture as FrameworkFixture).annotations.clientCalls).toEqual([]);
  });

  it('keeps an absolute URL, leaving the matcher to reject another host', async () => {
    fixture = await FrameworkFixture.create({
      'src/api.ts': `export async function charge(): Promise<void> {
        await fetch('https://api.stripe.com/v1/charges');
      }`,
    });

    expect(pathsOf((fixture as FrameworkFixture).annotations.clientCalls)).toEqual(['— https://api.stripe.com/v1/charges']);
  });
});
