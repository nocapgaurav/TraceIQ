import type { NodeId } from '@traceiq/types';
import { describe, expect, it } from 'vitest';

import { declaringNodeIdOf } from './declares.js';
import { declaration } from './graph-fixture.test-helper.js';

/**
 * The one derivation the Graph Builder performs, spec §2.1. Tested directly because
 * its upward walk exists for a case that is easy to get wrong.
 */
const ids = (...values: string[]): ReadonlySet<NodeId> => new Set(values as NodeId[]);

describe('declaringNodeIdOf', () => {
  it('returns the file for a top-level declaration', () => {
    expect(declaringNodeIdOf(declaration({ path: 'a.ts', chain: ['C'] }), ids())).toBe(
      'file:a.ts',
    );
  });

  it('returns the immediate container when it exists', () => {
    expect(
      declaringNodeIdOf(
        declaration({ path: 'a.ts', chain: ['C', 'm'], kind: 'method' }),
        ids('sym:a.ts#C'),
      ),
    ).toBe('sym:a.ts#C');
  });

  it('returns the deepest existing ancestor', () => {
    expect(
      declaringNodeIdOf(
        declaration({ path: 'a.ts', chain: ['A', 'B', 'x'], kind: 'variable' }),
        ids('sym:a.ts#A', 'sym:a.ts#A.B'),
      ),
    ).toBe('sym:a.ts#A.B');
  });

  it('skips an ancestor the source never declares', () => {
    // `namespace A.B {}` declares A.B without declaring A, so a member of A.B whose
    // immediate parent chain is A.B resolves there, while A.B itself falls to the file.
    expect(
      declaringNodeIdOf(
        declaration({ path: 'a.ts', chain: ['A', 'B'], kind: 'namespace' }),
        ids('sym:a.ts#A.B'),
      ),
    ).toBe('file:a.ts');
  });

  it('walks past a missing intermediate to a shallower ancestor', () => {
    expect(
      declaringNodeIdOf(
        declaration({ path: 'a.ts', chain: ['A', 'B', 'c'], kind: 'variable' }),
        ids('sym:a.ts#A'),
      ),
    ).toBe('sym:a.ts#A');
  });

  it('falls back to the file when no ancestor exists at all', () => {
    expect(
      declaringNodeIdOf(declaration({ path: 'a.ts', chain: ['A', 'B', 'c'] }), ids()),
    ).toBe('file:a.ts');
  });

  it('never returns the declaration itself', () => {
    const target = declaration({ path: 'a.ts', chain: ['A', 'B'], kind: 'namespace' });

    expect(declaringNodeIdOf(target, ids('sym:a.ts#A.B'))).not.toBe(target.id);
  });

  it('keeps identically named chains in different files apart', () => {
    expect(
      declaringNodeIdOf(
        declaration({ path: 'b.ts', chain: ['C', 'm'], kind: 'method' }),
        ids('sym:a.ts#C'),
      ),
    ).toBe('file:b.ts');
  });
});
