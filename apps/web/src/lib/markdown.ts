/**
 * A deliberately small markdown parser, for chat answers only.
 *
 * **Why hand-written.** This renders text a language model produced, which is untrusted input. A general
 * markdown library passes raw HTML through by default, and turning that off correctly is a standing
 * obligation on every upgrade. Supporting eight constructs in a hundred lines removes the whole class of
 * problem: there is no HTML path to disable, because none is parsed.
 *
 * **Why at all.** The system prompt asks the model for plain prose with no markdown — and a real 7B model
 * emits `**bold**` and `-` bullets anyway. Rendering is therefore about displaying what a model actually
 * produced, not about inviting it. Repository pages stay plain rendered data, as they were.
 *
 * The output is a token tree, not a string. Nothing here builds HTML, so the component that consumes it
 * cannot be handed markup to inject — React escapes every text node it renders.
 */

export type Inline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'emphasis'; readonly children: readonly Inline[] }
  | { readonly type: 'strong'; readonly children: readonly Inline[] };

export type Block =
  | { readonly type: 'paragraph'; readonly children: readonly Inline[] }
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly Inline[] }
  | { readonly type: 'code'; readonly language: string | null; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] };

/**
 * Parses the supported subset: paragraphs, headings, inline code, fenced code, bullet and numbered lists,
 * emphasis and strong emphasis. Anything else is left as literal text rather than guessed at.
 */
export function parseMarkdown(source: string): readonly Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];

  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // A fenced block runs to its closing fence, or to the end of the input — which matters while a stream
    // is still arriving, since a half-written fence must still render as code rather than as prose.
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)/.exec(line);

    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const language = fence[2] ?? '';
      const body: string[] = [];

      index += 1;

      while (index < lines.length) {
        const candidate = lines[index] ?? '';

        if (new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(candidate)) {
          index += 1;
          break;
        }

        body.push(candidate);
        index += 1;
      }

      blocks.push({ type: 'code', language: language === '' ? null : language, text: body.join('\n') });

      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);

    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ''),
      });
      index += 1;

      continue;
    }

    const bullet = /^ {0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^ {0,3}\d+[.)]\s+(.*)$/.exec(line);

    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null;
      const items: Inline[][] = [];

      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        const next = ordered ? /^ {0,3}\d+[.)]\s+(.*)$/.exec(candidate) : /^ {0,3}[-*+]\s+(.*)$/.exec(candidate);

        if (next === null) {
          break;
        }

        items.push([...parseInline(next[1] ?? '')]);
        index += 1;
      }

      blocks.push({ type: 'list', ordered, items });

      continue;
    }

    if (line.trim() === '') {
      index += 1;

      continue;
    }

    // A paragraph runs until a blank line or anything that starts a different block.
    const paragraph: string[] = [];

    while (index < lines.length) {
      const candidate = lines[index] ?? '';

      if (
        candidate.trim() === '' ||
        /^ {0,3}(`{3,}|~{3,})/.test(candidate) ||
        /^ {0,3}#{1,6}\s/.test(candidate) ||
        /^ {0,3}[-*+]\s/.test(candidate) ||
        /^ {0,3}\d+[.)]\s/.test(candidate)
      ) {
        break;
      }

      paragraph.push(candidate.trim());
      index += 1;
    }

    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
    }
  }

  return blocks;
}

/**
 * Parses inline spans.
 *
 * Code is matched first and its contents are never parsed further, so `` `**not bold**` `` stays literal —
 * which matters here, because a fact identifier can contain almost anything.
 */
export function parseInline(source: string): readonly Inline[] {
  const out: Inline[] = [];
  let text = '';

  const flush = (): void => {
    if (text !== '') {
      out.push({ type: 'text', text });
      text = '';
    }
  };

  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);

    const code = /^(`+)([\s\S]*?)\1/.exec(rest);

    if (code !== null) {
      flush();
      out.push({ type: 'code', text: code[2] ?? '' });
      index += code[0].length;

      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);

    if (strong !== null) {
      flush();
      out.push({ type: 'strong', children: parseInline(strong[2] ?? '') });
      index += strong[0].length;

      continue;
    }

    // A single marker, and not part of a `**` pair — checked after strong so `**x**` is never read as two
    // nested emphases. `_` inside a word is left alone, because identifiers use it.
    const emphasis = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest);

    if (emphasis !== null && !(emphasis[1] === '_' && /\w$/.test(source.slice(0, index)))) {
      flush();
      out.push({ type: 'emphasis', children: parseInline(emphasis[2] ?? '') });
      index += emphasis[0].length;

      continue;
    }

    text += source[index] ?? '';
    index += 1;
  }

  flush();

  return out;
}
