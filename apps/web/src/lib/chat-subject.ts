import type { ChatSubject } from '@/types/api';

/**
 * A chat subject, written as one string.
 *
 * The API refuses to turn free text into a subject — resolving one is repository search, which belongs to
 * the Explorer — so a subject travels between pages already resolved. This is the spelling used for that:
 * the same prefixed vocabulary the CLI's `--subject` accepts, so a link, a command line and an API call
 * all name a subject the same way.
 *
 *   sym:<id>    one declaration
 *   file:<path> one file
 *   pkg:<name>  one package
 *   repository  the whole repository, and the default for anything unrecognised
 *
 * Unrecognised input falls back to the repository rather than throwing: this parses a URL a user may have
 * edited, and the cost of a wrong guess is answering a broader question, not failing to answer.
 */
export function parseChatSubject(text: string | null): ChatSubject {
  if (text === null) {
    return { kind: 'repository' };
  }

  const trimmed = text.trim();

  if (trimmed.startsWith('sym:')) {
    return { kind: 'symbol', id: trimmed };
  }

  if (trimmed.startsWith('file:')) {
    return { kind: 'file', path: trimmed.slice('file:'.length) };
  }

  if (trimmed.startsWith('pkg:')) {
    return { kind: 'package', name: trimmed.slice('pkg:'.length) };
  }

  return { kind: 'repository' };
}
