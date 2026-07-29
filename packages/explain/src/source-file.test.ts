import type { NodeId } from '@traceiq/types';
import { describe, expect, it } from 'vitest';

import { sourceFileOf } from './source-file.js';

const id = (value: string): NodeId => value as NodeId;

describe('sourceFileOf', () => {
  it('reads the repository-relative path out of a file identifier', () => {
    expect(sourceFileOf(id('file:src/auth/user.service.ts'))).toEqual({
      id: 'file:src/auth/user.service.ts',
      path: 'src/auth/user.service.ts',
    });
  });

  it('keeps a path containing a colon, the prefix being the only delimiter', () => {
    expect(sourceFileOf(id('file:src/a:b.ts'))?.path).toBe('src/a:b.ts');
  });

  it('rejects an identifier of another kind rather than mangling it', () => {
    expect(sourceFileOf(id('sym:src/a.ts#C'))).toBeNull();
    expect(sourceFileOf(id('ext:npm:express'))).toBeNull();
    expect(sourceFileOf(id('route:GET:/health'))).toBeNull();
  });

  it('rejects a prefix with no path after it', () => {
    expect(sourceFileOf(id('file:'))).toBeNull();
  });

  it('accepts a missing identifier, a declaration with no file being possible in the model', () => {
    expect(sourceFileOf(null)).toBeNull();
  });
});
