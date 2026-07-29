import { describe, expect, it } from 'vitest';

import { DeclarationCollector, type DeclarationInput } from './declaration-collector.js';
import { modifiers } from './modifiers.js';
import type { SourceRange } from './types.js';

const range = (startLine: number): SourceRange => ({
  startLine,
  startColumn: 1,
  endLine: startLine,
  endColumn: 10,
});

function input(overrides: Partial<DeclarationInput> = {}): DeclarationInput {
  return {
    repoRelativePath: 'src/a.ts',
    fileId: 'file:src/a.ts' as DeclarationInput['fileId'],
    kind: 'function',
    name: 'thing',
    containerChain: ['thing'],
    visibility: null,
    modifiers: modifiers(),
    locations: [range(1)],
    ...overrides,
  };
}

describe('DeclarationCollector', () => {
  it('reports the first site of an identifier as new', () => {
    expect(new DeclarationCollector().add(input()).isNew).toBe(true);
  });

  it('reports a repeated identifier as not new, so consequences are recorded once', () => {
    const collector = new DeclarationCollector();

    collector.add(input());

    expect(collector.add(input({ locations: [range(5)] })).isNew).toBe(false);
  });

  it('issues the identifier the path and chain imply', () => {
    const collector = new DeclarationCollector();

    expect(collector.add(input({ containerChain: ['Outer', 'inner'] })).id).toBe(
      'sym:src/a.ts#Outer.inner',
    );
  });

  it('folds repeated sites into one declaration', () => {
    const collector = new DeclarationCollector();

    collector.add(input());
    collector.add(input({ locations: [range(5)] }));

    expect(collector.toArray()).toHaveLength(1);
  });

  it('accumulates every site as a location', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ locations: [range(7)] }));
    collector.add(input({ locations: [range(3)] }));

    expect(collector.toArray()[0]?.locations.map((entry) => entry.startLine)).toEqual([3, 7]);
  });

  it('keeps the kind of the first site when sites disagree', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ kind: 'function' }));
    collector.add(input({ kind: 'namespace' }));

    expect(collector.toArray()[0]?.kind).toBe('function');
  });

  it('unions modifiers, so an overload set exported once is exported', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ modifiers: modifiers({ isExported: true }) }));
    collector.add(input({ modifiers: modifiers({ isAsync: true }) }));

    expect(collector.toArray()[0]?.modifiers).toMatchObject({
      isExported: true,
      isAsync: true,
      isStatic: false,
    });
  });

  it('takes the first stated visibility', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ visibility: null }));
    collector.add(input({ visibility: 'protected' }));

    expect(collector.toArray()[0]?.visibility).toBe('protected');
  });

  it('does not let a later site overwrite a stated visibility', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ visibility: 'private' }));
    collector.add(input({ visibility: 'public' }));

    expect(collector.toArray()[0]?.visibility).toBe('private');
  });

  it('keeps declarations with distinct chains separate', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ containerChain: ['a'], name: 'a' }));
    collector.add(input({ containerChain: ['b'], name: 'b' }));

    expect(collector.toArray().map((entry) => entry.name)).toEqual(['a', 'b']);
  });

  it('keeps the same chain in different files separate', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ repoRelativePath: 'src/a.ts' }));
    collector.add(input({ repoRelativePath: 'src/b.ts' }));

    expect(collector.toArray()).toHaveLength(2);
  });

  it('returns declarations in first-encounter order', () => {
    const collector = new DeclarationCollector();

    collector.add(input({ containerChain: ['z'], name: 'z' }));
    collector.add(input({ containerChain: ['a'], name: 'a' }));

    expect(collector.toArray().map((entry) => entry.name)).toEqual(['z', 'a']);
  });

  it('reports nothing when nothing was collected', () => {
    expect(new DeclarationCollector().toArray()).toEqual([]);
  });

  it('does not expose its internal location array for mutation', () => {
    const collector = new DeclarationCollector();
    const locations = [range(1)];

    collector.add(input({ locations }));
    locations.push(range(2));

    expect(collector.toArray()[0]?.locations).toHaveLength(1);
  });
});
