/**
 * Terminal formatting.
 *
 * Plain ASCII throughout: **no colours, no progress bars, no box drawing.** Output is written to be
 * read in a terminal and piped into a file with equal fidelity, and to be byte-identical for
 * identical input — nothing here consults the clock, the terminal width or the environment.
 */

/** Two spaces per level, so nesting reads without any drawing characters. */
export function indent(text: string, level = 1): string {
  const prefix = '  '.repeat(level);

  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join('\n');
}

export function heading(text: string): string {
  return `${text}\n${'-'.repeat(text.length)}`;
}

/** A `key: value` block, keys padded so the values line up. */
export function fields(entries: readonly (readonly [string, string | number])[]): string {
  const width = entries.reduce((widest, [key]) => Math.max(widest, key.length), 0);

  return entries.map(([key, value]) => `${key.padEnd(width)}  ${String(value)}`).join('\n');
}

export interface Column {
  readonly header: string;
  /** Right-aligned suits a count; left suits a name. */
  readonly align?: 'left' | 'right';
}

/**
 * A plain table: a header row, a dashed rule, then the rows.
 *
 * Columns are padded to their widest cell. A table with no rows renders as a single `(none)` line
 * rather than a bare header, because an empty table reads as a formatting failure.
 */
export function table(columns: readonly Column[], rows: readonly (readonly (string | number)[])[]): string {
  if (rows.length === 0) {
    return '(none)';
  }

  const cells = rows.map((row) => row.map((value) => String(value)));
  const widths = columns.map((column, index) =>
    cells.reduce((widest, row) => Math.max(widest, (row[index] ?? '').length), column.header.length),
  );

  const line = (values: readonly string[]): string =>
    values
      .map((value, index) => {
        const width = widths[index] ?? value.length;

        return columns[index]?.align === 'right' ? value.padStart(width) : value.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '-'.repeat(width))),
    ...cells.map(line),
  ].join('\n');
}

/** A bulleted list, or `(none)`. */
export function list(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : items.map((item) => `- ${item}`).join('\n');
}

/** Joins sections with a blank line between them, dropping any that are empty. */
export function sections(...parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join('\n\n');
}

/**
 * `shown of total` when a list was capped, or just the total when it was not.
 *
 * A cap is never silent in the API, and it is never silent in the output either.
 */
export function counted(shown: number, total: number, truncated: boolean): string {
  return truncated ? `${shown} of ${total}` : String(total);
}

/** Trims an identifier's `sym:`/`file:` prefix for display, leaving it unambiguous. */
export function short(id: string): string {
  return id.replace(/^(sym|file|route|env|ext):/, '');
}
