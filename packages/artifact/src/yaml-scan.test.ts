import { describe, expect, it } from 'vitest';

import { documentCount, scanYaml, topLevelKeys } from './yaml-scan.js';

/**
 * The structural YAML reader, and the shapes it must get right or get honestly wrong.
 *
 * **It is not a YAML parser and this file is where that claim is kept honest.** Each test either asserts a
 * shape the reader must handle, or asserts the *stated* degradation for one it does not — an anchor read as
 * a literal, a flow sequence kept whole. A reader whose limitations are asserted is a reader whose
 * limitations somebody has thought about; one whose limitations are only in a comment drifts.
 */

const paths = (text: string): readonly string[] => scanYaml(text).map((entry) => entry.path.join('.'));

const at = (text: string, path: string): string | undefined =>
  scanYaml(text).find((entry) => entry.path.join('.') === path)?.value;

describe('mappings', () => {
  it('records a key path from the document root', () => {
    expect(paths('a:\n  b:\n    c: 1\n')).toEqual(['a', 'a.b', 'a.b.c']);
    expect(at('a:\n  b:\n    c: 1\n', 'a.b.c')).toBe('1');
  });

  it('closes a block when the indentation returns', () => {
    expect(paths('a:\n  b: 1\nc: 2\n')).toEqual(['a', 'a.b', 'c']);
  });

  it('keeps a colon inside a value, because a value is worth more than a tidy split', () => {
    expect(at('image: node:20-alpine\n', 'image')).toBe('node:20-alpine');
  });

  it('strips a trailing comment only where doing so cannot corrupt the value', () => {
    expect(at('image: node:20 # pinned\n', 'image')).toBe('node:20');
    // The hash sits inside an unbalanced quote, so the whole line is kept rather than truncated.
    expect(at('run: echo "# heading"\n', 'run')).toBe('echo "# heading"');
  });

  it('unquotes a quoted scalar and a quoted key', () => {
    expect(at('"a b": "c d"\n', 'a b')).toBe('c d');
  });
});

describe('sequences', () => {
  it('numbers items in file order rather than nesting them inside one another', () => {
    /*
     * **The defect this test exists for.** An item frame sits at the same indentation as the next item, so
     * a first version that unwound only deeper frames left the previous item open — and every step of a CI
     * job was recorded as a child of the step above it, which meant a job with six steps reported one.
     */
    const text = ['steps:', '  - name: a', '  - name: b', '  - name: c'].join('\n');

    expect(paths(text)).toEqual(['steps', 'steps.[0].name', 'steps.[1].name', 'steps.[2].name']);
  });

  it('handles items indented under their key and items at their key’s own indentation', () => {
    const under = ['a:', '  - x', '  - y'].join('\n');
    const beside = ['a:', '- x', '- y'].join('\n');

    expect(paths(under)).toEqual(['a', 'a.[0]', 'a.[1]']);
    // The second spelling is equally legal YAML, and popping the key frame would have detached the whole
    // sequence from its parent.
    expect(paths(beside)).toEqual(['a', 'a.[0]', 'a.[1]']);
  });

  it('opens a block for an item whose marker is alone on its line', () => {
    const text = ['a:', '  -', '    b: 1', '  -', '    b: 2'].join('\n');

    expect(paths(text)).toEqual(['a', 'a.[0].b', 'a.[1].b']);
  });

  it('records a bare scalar item with no key', () => {
    const entries = scanYaml('a:\n  - x\n');

    expect(entries[1]?.key).toBeNull();
    expect(entries[1]?.value).toBe('x');
  });
});

describe('block scalars', () => {
  it('folds a literal block onto one line with a visible separator', () => {
    const text = ['run: |', '  npm ci', '  npm test'].join('\n');

    expect(at(text, 'run')).toBe('npm ci; npm test');
  });

  it('continues the scan after the block, so a following key is not swallowed', () => {
    const text = ['run: |', '  a', '  b', 'next: 1'].join('\n');

    expect(paths(text)).toEqual(['run', 'next']);
    expect(at(text, 'next')).toBe('1');
  });

  it('accepts every block indicator YAML spells', () => {
    for (const indicator of ['|', '>', '|-', '>-', '|+', '|2']) {
      expect(at(`run: ${indicator}\n  x\n`, 'run')).toBe('x');
    }
  });
});

describe('documents', () => {
  it('restarts the key space at a separator and counts the documents', () => {
    const text = ['kind: A', '---', 'kind: B', '---', 'kind: C'].join('\n');
    const entries = scanYaml(text);

    expect(documentCount(entries)).toBe(3);
    expect(entries.map((entry) => entry.value)).toEqual(['A', 'B', 'C']);
    // Every document's `kind` is at the root of its own document rather than nested in the previous one.
    expect(entries.every((entry) => entry.path.length === 1)).toBe(true);
  });

  it('reports top-level keys of the first document only, because that is what decides the family', () => {
    const text = ['jobs:', '  a: 1', '---', 'services:', '  b: 1'].join('\n');

    expect([...topLevelKeys(text === '' ? [] : scanYaml(text))]).toEqual(['jobs']);
  });
});

describe('stated degradations', () => {
  it('keeps a flow sequence whole rather than splitting it into entries', () => {
    // Nothing is lost — the text is intact — only unsplit, which is the coarse-but-true reading this
    // reader prefers to a wrong one.
    expect(at('ports: [80, 443]\n', 'ports')).toBe('[80, 443]');
  });

  it('reads an anchor and an alias as literal text rather than expanding them', () => {
    const text = ['base: &base', '  a: 1', 'other:', '  <<: *base'].join('\n');

    expect(at(text, 'base')).toBe('&base');
    expect(at(text, 'other.<<')).toBe('*base');
  });

  it('reads a tab-indented file on a best effort rather than refusing it', () => {
    // YAML forbids tabs, so this file is not YAML. One tab as one level is as good an answer as an error.
    expect(paths('a:\n\tb: 1\n')).toEqual(['a', 'a.b']);
  });

  it('ignores a comment-only line and a blank line', () => {
    expect(paths('# note\n\na: 1\n')).toEqual(['a']);
  });

  it('is deterministic', () => {
    const text = ['jobs:', '  a:', '    steps:', '      - run: x'].join('\n');

    expect(JSON.stringify(scanYaml(text))).toBe(JSON.stringify(scanYaml(text)));
  });
});
