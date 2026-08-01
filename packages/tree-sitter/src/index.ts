import { createRequire } from 'node:module';

import { Language, Parser, type Node as SyntaxNode, type Tree } from 'web-tree-sitter';

/**
 * The tree-sitter host every non-compiler analyser shares.
 *
 * **Why this package exists.** The Python analyser arrived with its own grammar loading, its own
 * named-children helper and its own zero-to-one-based position conversion. Java needed all three
 * unchanged, and Go needed them again. Three copies of a position conversion is three chances to be
 * off by one in a way that misplaces every location in the product, and the milestone's whole point is
 * that a new analyser should add a language rather than re-add infrastructure.
 *
 * **Why tree-sitter.** There is no mature pure-JavaScript compiler for Python, Java or Go, and the
 * alternative — matching declarations with regular expressions — cannot survive nested classes,
 * generics, multi-line signatures, annotations or a string containing the word `class`. A wrong
 * declaration is worse than a missing one, because everything downstream trusts the graph.
 *
 * It is also *only* a parser: it produces a concrete syntax tree and resolves nothing. Every binding
 * decision therefore belongs to an analyser and can be given an honest confidence, rather than
 * inherited from a tool whose reasoning could not be described.
 *
 * **It never executes the repository.** Parsing reads text. No interpreter runs, no build file is
 * evaluated, no dependency is installed or downloaded — each grammar ships a prebuilt `.wasm`.
 */

/** The grammars available. A new language adds one entry here and one analyser package. */
export const GRAMMARS = {
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  java: 'tree-sitter-java/tree-sitter-java.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
} as const;

export type GrammarName = keyof typeof GRAMMARS;

const cache = new Map<GrammarName, Promise<Parser>>();

/**
 * A parser for one grammar, loaded once per process.
 *
 * Cached per grammar rather than globally: a polyglot repository loads Python and Java in the same
 * scan, and one cached parser would hand the second analyser the first one's language.
 */
export function parserFor(grammar: GrammarName): Promise<Parser> {
  const existing = cache.get(grammar);

  if (existing !== undefined) {
    return existing;
  }

  const loading = load(grammar);

  cache.set(grammar, loading);

  return loading;
}

async function load(grammar: GrammarName): Promise<Parser> {
  await Parser.init();

  const require = createRequire(import.meta.url);
  const language = await Language.load(require.resolve(GRAMMARS[grammar]));
  const parser = new Parser();

  parser.setLanguage(language);

  return parser;
}

export type { Parser, SyntaxNode, Tree };

/** Named children only: punctuation and keywords are noise for every walk built on this. */
export function children(node: SyntaxNode): readonly SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

/** Every named child of one type, in source order. */
export function childrenOfType(node: SyntaxNode, type: string): readonly SyntaxNode[] {
  return children(node).filter((child) => child.type === type);
}

/** The first named child of one type, or `null`. */
export function firstOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  return children(node).find((child) => child.type === type) ?? null;
}

export function fieldText(node: SyntaxNode, field: string): string | null {
  return node.childForFieldName(field)?.text ?? null;
}

export function fieldNode(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field) ?? null;
}

/**
 * Converts a tree-sitter node's position into TraceIQ's range convention.
 *
 * tree-sitter counts rows and columns from zero; the IR counts both from one, as every other producer
 * does. Getting this wrong would misplace every location in the product, which is why it lives in one
 * place rather than once per analyser.
 */
export function rangeOf(node: SyntaxNode): {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
} {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

/**
 * The leftmost identifier of an expression, or `null` when it is not rooted at one.
 *
 * `a.b.c()` is rooted at `a`; `foo().bar()` and `(x + y).z` are rooted at nothing addressable. Shared
 * because every analyser's call binding starts with the same question, and because answering it
 * differently per language is how a call quietly binds to the wrong thing.
 */
export function leftmostIdentifier(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node;

  while (current !== null) {
    if (current.type === 'identifier' || current.type === 'type_identifier') {
      return current.text;
    }

    const next: SyntaxNode | undefined = children(current)[0];

    if (next === undefined) {
      return null;
    }

    current = next;
  }

  return null;
}
