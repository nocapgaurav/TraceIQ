import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './markdown';

/**
 * The renderer's parser.
 *
 * It reads text a language model produced, so the tests that matter most are the ones proving it parses no
 * HTML and treats anything unsupported as literal text rather than guessing.
 */
describe('paragraphs', () => {
  it('joins wrapped lines into one paragraph', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'one two' }] },
    ]);
  });

  it('separates paragraphs on a blank line', () => {
    expect(parseMarkdown('one\n\ntwo')).toHaveLength(2);
  });

  it('produces nothing for empty or whitespace input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('headings', () => {
  it('reads each level', () => {
    for (let level = 1; level <= 6; level += 1) {
      const blocks = parseMarkdown(`${'#'.repeat(level)} Title`);

      expect(blocks[0]).toMatchObject({ type: 'heading', level });
    }
  });

  it('needs a space after the hashes, so a fact id is not a heading', () => {
    expect(parseMarkdown('#notaheading')[0]?.type).toBe('paragraph');
  });

  it('ignores a seventh hash, since there is no level 7', () => {
    expect(parseMarkdown('####### deep')[0]?.type).toBe('paragraph');
  });
});

describe('fenced code', () => {
  it('reads a block with its language', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n```')).toEqual([
      { type: 'code', language: 'ts', text: 'const a = 1;' },
    ]);
  });

  it('reads a block with no language', () => {
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ type: 'code', language: null, text: 'plain' }]);
  });

  it('never parses markdown inside a block', () => {
    const blocks = parseMarkdown('```\n**not bold** and # not a heading\n```');

    expect(blocks).toEqual([{ type: 'code', language: null, text: '**not bold** and # not a heading' }]);
  });

  it('closes an unterminated block at the end of the input, so a streaming fence still renders as code', () => {
    // Half a fenced block is exactly what arrives mid-stream. It must read as code, not as prose.
    expect(parseMarkdown('```ts\nconst a = 1;')).toEqual([
      { type: 'code', language: 'ts', text: 'const a = 1;' },
    ]);
  });

  it('accepts tildes as well as backticks', () => {
    expect(parseMarkdown('~~~\nx\n~~~')).toEqual([{ type: 'code', language: null, text: 'x' }]);
  });

  it('keeps blank lines inside a block', () => {
    expect(parseMarkdown('```\na\n\nb\n```')).toEqual([{ type: 'code', language: null, text: 'a\n\nb' }]);
  });
});

describe('lists', () => {
  it('reads a bullet list', () => {
    expect(parseMarkdown('- one\n- two')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
      },
    ]);
  });

  it('reads a numbered list', () => {
    const blocks = parseMarkdown('1. one\n2. two');

    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true });
    expect((blocks[0] as { items: readonly unknown[] }).items).toHaveLength(2);
  });

  it('accepts every bullet marker', () => {
    for (const marker of ['-', '*', '+']) {
      expect(parseMarkdown(`${marker} item`)[0]?.type).toBe('list');
    }
  });

  it('does not start a list without a space after the marker', () => {
    expect(parseMarkdown('-notalist')[0]?.type).toBe('paragraph');
  });

  it('separates a bullet list from a numbered list that follows it', () => {
    const blocks = parseMarkdown('- a\n1. b');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ ordered: false });
    expect(blocks[1]).toMatchObject({ ordered: true });
  });

  it('ends a list at a paragraph', () => {
    const blocks = parseMarkdown('- a\n\nprose');

    expect(blocks.map((block) => block.type)).toEqual(['list', 'paragraph']);
  });
});

describe('inline spans', () => {
  it('reads inline code', () => {
    expect(parseInline('a `b` c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'b' },
      { type: 'text', text: ' c' },
    ]);
  });

  it('never parses markdown inside inline code', () => {
    // A fact identifier can contain almost anything, so code must be inert.
    expect(parseInline('`**not bold**`')).toEqual([{ type: 'code', text: '**not bold**' }]);
  });

  it('reads strong emphasis in both spellings', () => {
    expect(parseInline('**a**')).toEqual([{ type: 'strong', children: [{ type: 'text', text: 'a' }] }]);
    expect(parseInline('__a__')).toEqual([{ type: 'strong', children: [{ type: 'text', text: 'a' }] }]);
  });

  it('reads emphasis in both spellings', () => {
    expect(parseInline('*a*')).toEqual([{ type: 'emphasis', children: [{ type: 'text', text: 'a' }] }]);
    expect(parseInline('_a_')).toEqual([{ type: 'emphasis', children: [{ type: 'text', text: 'a' }] }]);
  });

  it('reads strong before emphasis, so ** is never two nested emphases', () => {
    expect(parseInline('**a**')).toHaveLength(1);
    expect(parseInline('**a**')[0]?.type).toBe('strong');
  });

  it('leaves an underscore inside a word alone, because identifiers use them', () => {
    expect(parseInline('some_variable_name')).toEqual([{ type: 'text', text: 'some_variable_name' }]);
  });

  it('leaves an unmatched marker as text', () => {
    expect(parseInline('a * b')).toEqual([{ type: 'text', text: 'a * b' }]);
    expect(parseInline('**unclosed')).toEqual([{ type: 'text', text: '**unclosed' }]);
  });

  it('nests emphasis inside strong', () => {
    expect(parseInline('**a *b***')).toMatchObject({ 0: { type: 'strong' } });
  });
});

describe('what it refuses to parse', () => {
  it('treats raw HTML as literal text', () => {
    // The whole reason this parser is hand-written: there is no HTML path to disable, because none exists.
    const blocks = parseMarkdown('<script>alert(1)</script>');

    expect(blocks).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script>' }] },
    ]);
  });

  it('treats an img tag as literal text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')[0]).toMatchObject({ type: 'paragraph' });
  });

  it('treats a link as literal text, since links are not supported', () => {
    expect(parseInline('[a](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[a](javascript:alert(1))' },
    ]);
  });

  it('treats a blockquote as ordinary prose', () => {
    expect(parseMarkdown('> quoted')[0]).toMatchObject({ type: 'paragraph' });
  });

  it('treats a table as ordinary prose', () => {
    expect(parseMarkdown('| a | b |')[0]).toMatchObject({ type: 'paragraph' });
  });
});

describe('determinism', () => {
  it('parses the same source to the same tree', () => {
    const source = '# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```ts\nx\n```';

    expect(parseMarkdown(source)).toEqual(parseMarkdown(source));
  });

  it('handles the shape a real model produced', () => {
    // Observed live from qwen2.5:7b-instruct despite the prompt asking for plain prose.
    const blocks = parseMarkdown(
      'The analysis has several limitations:\n\n- **Call Coverage**: the graph binds names [f8].\n- Calls are inferred [f9].',
    );

    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'list']);
    expect((blocks[1] as { items: readonly unknown[] }).items).toHaveLength(2);
  });
});
