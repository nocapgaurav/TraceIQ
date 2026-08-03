/**
 * A structural reader for indentation-based YAML. **Not a YAML parser, and it must not become one.**
 *
 * What the artefact layer needs from a workflow file is which jobs it declares, which steps each job
 * holds, and what those steps run. All of that is visible in the shape of the indentation, which is why
 * this is 150 lines rather than a dependency: anchors, merge keys, multi-document streams, flow mappings,
 * tags and the seven ways YAML spells a string are all things a conforming parser must handle and none of
 * them changes the answer to "what jobs does this declare".
 *
 * The consequences are stated rather than hidden, and every one of them is reported through the artefact's
 * `boundary` sentence:
 *
 * - **Anchors and aliases are not expanded.** A job defined once and aliased three times is read as one
 *   job and three aliases, which understates the file.
 * - **Flow mappings are read as scalars.** `ports: [80, 443]` yields one value `[80, 443]` rather than
 *   two entries; the text is kept whole so nothing is lost, only unsplit.
 * - **A multi-document stream is read as one document.** `---` separators are recorded as boundaries so a
 *   caller can count documents, and the entries of all of them share one key space.
 * - **A tab-indented file is read on a best effort.** YAML forbids tabs; a file using them is not YAML,
 *   and treating one tab as one level is as good an answer as refusing.
 *
 * Where the shape is genuinely ambiguous the reader prefers to report *less* structure and keep the text,
 * because a wrong element is a false fact and an unsplit one is only a coarse fact.
 */

export interface YamlEntry {
  /**
   * The key path from the document root, sequence positions included as `[0]`, `[1]`.
   *
   * `['jobs', 'build', 'steps', '[2]', 'run']` — which is what makes "the steps of the build job"
   * answerable without the caller reconstructing a tree.
   */
  readonly path: readonly string[];
  /** The mapping key, or `null` for a bare scalar inside a sequence. */
  readonly key: string | null;
  /** The scalar value, block scalars folded onto one line. `''` where the key opens a block. */
  readonly value: string;
  /** 1-based. */
  readonly line: number;
  /** How many documents preceded this entry in the stream. `0` for the first. */
  readonly document: number;
}

/** How much of a folded block scalar is kept. A `run:` block can be forty lines; its shape is in the first. */
const BLOCK_LIMIT = 400;

/** How many entries one file may contribute. Above this the file is described by its first entries. */
const ENTRY_LIMIT = 4000;

interface Frame {
  readonly indent: number;
  readonly key: string;
  /** Next sequence index at this level, so `[0]`, `[1]` are assigned in file order. */
  index: number;
}

export function scanYaml(text: string): readonly YamlEntry[] {
  const lines = text.split('\n');
  const entries: YamlEntry[] = [];
  const stack: Frame[] = [];

  let document = 0;

  for (let cursor = 0; cursor < lines.length && entries.length < ENTRY_LIMIT; cursor += 1) {
    const raw = lines[cursor] ?? '';
    const body = withoutComment(raw);

    if (body.trim() === '') {
      continue;
    }

    if (/^---\s*$/.test(body.trim())) {
      // A new document restarts the key space. The counter is what lets a caller say "three Kubernetes
      // resources in one file" rather than merging them into one.
      document += 1;
      stack.length = 0;

      continue;
    }

    if (/^\.\.\.\s*$/.test(body.trim())) {
      continue;
    }

    const indent = indentOf(body);
    let rest = body.slice(indent);

    // Unwind to the frame this line belongs under. A sequence item sits *at* its key's indentation in
    // the common spelling, so the item marker is handled after the unwind rather than before it.
    while (stack.length > 0 && (stack.at(-1) as Frame).indent >= indent && !rest.startsWith('- ')) {
      stack.pop();
    }

    let sequenceIndex: number | null = null;

    if (rest === '-' || rest.startsWith('- ')) {
      /*
       * Unwind to the sequence this item belongs to, closing any **sibling item** first.
       *
       * The asymmetry is the whole of it, and getting it wrong nested every step of a job inside the step
       * above it: an item frame sits at the *same* indentation as the next item, so popping only frames
       * indented deeper left the previous item open and the next one became its child. A mapping frame at
       * equal indentation must be kept for the opposite reason — YAML allows a sequence's items to sit at
       * its key's own indentation, and popping the key would detach the whole sequence from its parent.
       */
      while (stack.length > 0) {
        const top = stack.at(-1) as Frame;
        const isItem = top.key.startsWith('[');

        if (top.indent > indent || (isItem && top.indent >= indent)) {
          stack.pop();

          continue;
        }

        break;
      }

      const parent = stack.at(-1);

      if (parent === undefined) {
        // A top-level sequence: the document is a list. Synthesised so positions still have a path.
        stack.push({ indent: -1, key: '', index: 0 });
      }

      const frame = stack.at(-1) as Frame;

      sequenceIndex = frame.index;
      frame.index += 1;
      rest = rest === '-' ? '' : rest.slice(2).trimStart();
    }

    const base = pathOf(stack);
    const position = sequenceIndex === null ? base : [...base, `[${sequenceIndex}]`];

    if (rest === '') {
      // A sequence item that opens a block: `- ` on its own line, with the mapping beneath it. The frame
      // has to exist so the mapping's keys land inside the item rather than beside it.
      if (sequenceIndex !== null) {
        stack.push({ indent, key: `[${sequenceIndex}]`, index: 0 });
      }

      continue;
    }

    const mapping = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(rest);

    if (mapping === null) {
      entries.push({ path: position, key: null, value: rest.trim(), line: cursor + 1, document });

      continue;
    }

    const key = unquote((mapping[1] ?? '').trim());
    const inline = (mapping[2] ?? '').trim();

    if (sequenceIndex !== null) {
      // `- name: Build` is a mapping inside a new sequence item; the item frame must be open before the
      // key is recorded, or the next line's `run:` would attach to the wrong item.
      stack.push({ indent, key: `[${sequenceIndex}]`, index: 0 });
    }

    const here = [...pathOf(stack), key];

    if (isBlockScalar(inline)) {
      const folded = foldBlock(lines, cursor + 1, indent);

      entries.push({ path: here, key, value: folded.text, line: cursor + 1, document });
      cursor = folded.next - 1;

      continue;
    }

    entries.push({ path: here, key, value: unquote(inline), line: cursor + 1, document });

    if (inline === '') {
      stack.push({ indent, key, index: 0 });
    }
  }

  return entries;
}

/** Top-level keys of the first document, which is what decides what kind of YAML file this is. */
export function topLevelKeys(entries: readonly YamlEntry[]): ReadonlySet<string> {
  const keys = new Set<string>();

  for (const entry of entries) {
    if (entry.document === 0 && entry.path.length === 1 && entry.key !== null) {
      keys.add(entry.key);
    }
  }

  return keys;
}

/** How many documents the stream held. */
export function documentCount(entries: readonly YamlEntry[]): number {
  return entries.reduce((most, entry) => Math.max(most, entry.document + 1), 0);
}

function pathOf(stack: readonly Frame[]): readonly string[] {
  return stack.filter((frame) => frame.key !== '').map((frame) => frame.key);
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);

  return (match?.[0] ?? '').length;
}

/**
 * A trailing comment removed, but only where doing so cannot corrupt a value.
 *
 * `image: node:20 # pinned` loses its comment; `run: echo "# heading"` keeps everything, because the
 * quotes before the hash are unbalanced at that point and a value is more valuable than a tidy line.
 */
function withoutComment(line: string): string {
  if (line.trimStart().startsWith('#')) {
    return '';
  }

  const hash = /\s#/.exec(line);

  if (hash?.index === undefined) {
    return line.trimEnd();
  }

  const before = line.slice(0, hash.index);
  const balanced = (quote: string): boolean => (before.split(quote).length - 1) % 2 === 0;

  return (balanced('"') && balanced("'") ? before : line).trimEnd();
}

function isBlockScalar(value: string): boolean {
  return /^[|>][+-]?\d*$/.test(value);
}

/**
 * A block scalar folded onto one line.
 *
 * Joined with `; ` rather than with a newline, because the value becomes an element's `detail` and a
 * multi-line detail cannot be shown on a fact line or in a table row. The separator is visible, so a
 * reader can see that the original had several lines.
 */
function foldBlock(
  lines: readonly string[],
  from: number,
  parentIndent: number,
): { readonly text: string; readonly next: number } {
  const parts: string[] = [];
  let cursor = from;

  for (; cursor < lines.length; cursor += 1) {
    const raw = lines[cursor] ?? '';

    if (raw.trim() === '') {
      continue;
    }

    if (indentOf(raw) <= parentIndent) {
      break;
    }

    parts.push(raw.trim());

    if (parts.join('; ').length > BLOCK_LIMIT) {
      break;
    }
  }

  // The scan continues from the first line that is *not* part of the block, so a following key is read.
  while (cursor < lines.length && (lines[cursor] ?? '').trim() !== '' && indentOf(lines[cursor] ?? '') > parentIndent) {
    cursor += 1;
  }

  return { text: truncate(parts.join('; '), BLOCK_LIMIT), next: cursor };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }

  return value;
}

export function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();

  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}
