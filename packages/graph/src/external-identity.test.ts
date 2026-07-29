import { describe, expect, it } from 'vitest';

import { externalIdentityOf } from './external-identity.js';
import { externalTarget } from './graph-fixture.test-helper.js';

const target = (
  origin: 'package' | 'node-builtin' | 'typescript-lib' | 'outside-analysis',
  name: string | null = null,
) => externalTarget(origin, name) as Extract<ReturnType<typeof externalTarget>, { kind: 'external' }>;

describe('ext:npm — packages', () => {
  it.each([
    ['express', 'ext:npm:express'],
    ['fast-glob', 'ext:npm:fast-glob'],
    ['@types/node', 'ext:npm:@types/node'],
    ['@ts-morph/common', 'ext:npm:@ts-morph/common'],
  ])('names %s as %s', (name, expected) => {
    expect(externalIdentityOf(target('package', name), null).id).toBe(expected);
  });

  it('never puts a version in the identity, versions being metadata', () => {
    const identity = externalIdentityOf(target('package', 'ts-morph'), null);

    expect(identity.id).toBe('ext:npm:ts-morph');
    expect(identity.id).not.toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('ext:node — Node builtins', () => {
  it.each([
    ['node:fs', 'ext:node:fs'],
    ['node:path', 'ext:node:path'],
    ['node:fs/promises', 'ext:node:fs/promises'],
  ])('strips the reserved prefix, naming %s as %s', (name, expected) => {
    // The prefix is what identifies a builtin; repeating it inside the identity
    // would read as `ext:node:node:fs`.
    expect(externalIdentityOf(target('node-builtin', name), null).id).toBe(expected);
  });

  it('accepts a name that already lacks the prefix', () => {
    expect(externalIdentityOf(target('node-builtin', 'fs'), null).id).toBe('ext:node:fs');
  });
});

describe('ext:builtin — TypeScript built-ins', () => {
  it('names the symbol from the reference, the target carrying none', () => {
    // A built-in is declared across several lib files, so the Resolver deliberately
    // reports no name of its own; the reference name is the symbol.
    expect(externalIdentityOf(target('typescript-lib'), 'Promise').id).toBe(
      'ext:builtin:Promise',
    );
  });

  it('keeps distinct built-ins distinct', () => {
    expect(externalIdentityOf(target('typescript-lib'), 'Map').id).not.toBe(
      externalIdentityOf(target('typescript-lib'), 'Record').id,
    );
  });

  it('falls back to the bare kind rather than fabricating a name', () => {
    expect(externalIdentityOf(target('typescript-lib'), null).id).toBe('ext:builtin');
    expect(externalIdentityOf(target('typescript-lib'), '   ').id).toBe('ext:builtin');
  });
});

describe('ext:outside-analysis', () => {
  it('collapses to a single nameless sentinel', () => {
    // No package or symbol name is recoverable: the Resolver records no path for
    // these, so every one of them is the same node.
    const first = externalIdentityOf(target('outside-analysis'), 'symbolId');
    const second = externalIdentityOf(target('outside-analysis'), 'NodeId');

    expect(first.id).toBe('ext:outside-analysis');
    expect(second.id).toBe(first.id);
    expect(first.name).toBeNull();
  });
});

describe('identity shape', () => {
  it('always begins with the ext: prefix', () => {
    for (const identity of [
      externalIdentityOf(target('package', 'x'), null),
      externalIdentityOf(target('node-builtin', 'node:fs'), null),
      externalIdentityOf(target('typescript-lib'), 'Promise'),
      externalIdentityOf(target('outside-analysis'), null),
    ]) {
      expect(identity.id.startsWith('ext:')).toBe(true);
    }
  });

  it('never contains the edge-identity separator', () => {
    for (const identity of [
      externalIdentityOf(target('package', '@scope/pkg'), null),
      externalIdentityOf(target('node-builtin', 'node:fs/promises'), null),
      externalIdentityOf(target('typescript-lib'), 'ReadonlyMap'),
    ]) {
      expect(identity.id).not.toContain('|');
    }
  });
});
