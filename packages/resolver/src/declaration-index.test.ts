import path from 'node:path';

import type { DeclarationIR, RepositoryIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';
import { describe, expect, it } from 'vitest';

import { DeclarationIndex } from './declaration-index.js';

/**
 * The index is the keystone of correlation: it is what lets a compiler node be
 * traced back to the declaration the IR recorded. It takes plain data, so it is
 * tested with plain data.
 */

const ROOT = path.join(path.sep, 'repo');

const declaration = (
  id: string,
  fileId: string,
  sites: readonly [number, number][],
): DeclarationIR => ({
  id: id as NodeId,
  fileId: fileId as NodeId,
  kind: 'interface',
  name: id.split('.').at(-1) ?? id,
  containerChain: [id.split('#').at(-1) ?? id],
  visibility: null,
  modifiers: {
    isExported: true,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
  },
  locations: sites.map(([startLine, startColumn]) => ({
    startLine,
    startColumn,
    endLine: startLine,
    endColumn: startColumn + 5,
  })),
});

const IR: RepositoryIR = {
  repository: { name: 'repo', rootPath: ROOT },
  files: [
    { id: 'file:src/a.ts' as NodeId, path: 'src/a.ts', isDeclarationFile: false },
    { id: 'file:src/b.ts' as NodeId, path: 'src/b.ts', isDeclarationFile: false },
  ],
  declarations: [
    declaration('sym:src/a.ts#Single', 'file:src/a.ts', [[3, 1]]),
    // Two sites, as a merged interface or an overload set would have.
    declaration('sym:src/a.ts#Merged', 'file:src/a.ts', [
      [7, 1],
      [11, 1],
    ]),
    declaration('sym:src/b.ts#Single', 'file:src/b.ts', [[3, 1]]),
  ],
  imports: [],
  exports: [],
  callSites: [],
  memberAccesses: [],
};

const index = DeclarationIndex.fromIr(IR);

describe('file lookup', () => {
  it('maps an absolute path back to its file identifier', () => {
    expect(index.fileIdOf(path.join(ROOT, 'src', 'a.ts'))).toBe('file:src/a.ts');
  });

  it('reports a file outside the analysed set as unknown', () => {
    expect(index.fileIdOf(path.join(ROOT, 'src', 'absent.ts'))).toBeUndefined();
    expect(index.fileIdOf('/elsewhere/node_modules/express/index.d.ts')).toBeUndefined();
  });
});

describe('declaration lookup by position', () => {
  it('finds the declaration recorded at a position', () => {
    expect(index.declarationAt('file:src/a.ts' as NodeId, 3, 1)?.id).toBe('sym:src/a.ts#Single');
  });

  it('finds a declaration from every one of its sites', () => {
    expect(index.declarationAt('file:src/a.ts' as NodeId, 7, 1)?.id).toBe('sym:src/a.ts#Merged');
    expect(index.declarationAt('file:src/a.ts' as NodeId, 11, 1)?.id).toBe('sym:src/a.ts#Merged');
  });

  it('keeps identical positions in different files apart', () => {
    expect(index.declarationAt('file:src/a.ts' as NodeId, 3, 1)?.id).toBe('sym:src/a.ts#Single');
    expect(index.declarationAt('file:src/b.ts' as NodeId, 3, 1)?.id).toBe('sym:src/b.ts#Single');
  });

  it('reports no declaration at an unrecorded position', () => {
    expect(index.declarationAt('file:src/a.ts' as NodeId, 4, 1)).toBeUndefined();
  });

  it('distinguishes a column, so two declarations on one line do not collide', () => {
    expect(index.declarationAt('file:src/a.ts' as NodeId, 3, 9)).toBeUndefined();
  });
});

describe('declaration lookup by identifier', () => {
  it('finds a declaration by its identifier', () => {
    expect(index.declarationById('sym:src/a.ts#Merged' as NodeId)?.locations).toHaveLength(2);
  });

  it('reports an unknown identifier as absent', () => {
    expect(index.declarationById('sym:src/a.ts#Absent' as NodeId)).toBeUndefined();
  });
});
