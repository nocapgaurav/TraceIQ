import type { Node, Symbol as TsSymbol } from 'ts-morph';

/**
 * A symbol lookup that survives the checker throwing.
 *
 * **Every checker call in this package goes through here.** TypeScript's `getSymbolAtLocation` is
 * not total: asked about an alias it cannot follow, it dereferences an undefined symbol inside
 * `getImmediateAliasedSymbol` and throws `Cannot read properties of undefined (reading 'flags')`.
 * That is a compiler fault, not a fact about the source, and it is reachable from ordinary published
 * JavaScript — axios's re-exports trigger it, and dash's do too with a different field.
 *
 * The cost of not guarding it was total. One such site aborted the Resolver, which aborted the
 * TypeScript analyser, which left a 460-file repository at discovery depth with no declarations at
 * all. One reference the checker cannot answer about should cost that reference and nothing else.
 *
 * `undefined` is deliberately *not* the answer here — the caller must be able to tell "the checker
 * says nothing is here" from "the checker broke", because only the first is a statement about the
 * repository. See `UNRESOLVED_REASONS`.
 */
export type CheckerSymbol =
  | { readonly outcome: 'symbol'; readonly symbol: TsSymbol | undefined }
  | { readonly outcome: 'failed'; readonly detail: string };

/** The symbol the checker reports at this node, or the fault it raised trying. */
export function symbolAt(node: Node): CheckerSymbol {
  try {
    return { outcome: 'symbol', symbol: node.getSymbol() };
  } catch (cause) {
    return { outcome: 'failed', detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * The symbol an alias points at, or `undefined` when it is not an alias or cannot be followed.
 *
 * Guarded for the same reason and by the same evidence: `getAliasedSymbol` is documented to throw
 * for a symbol that is not an alias, and it can also throw while following one.
 */
export function aliasedSymbolOf(symbol: TsSymbol): TsSymbol | undefined {
  try {
    return symbol.getAliasedSymbol();
  } catch {
    return undefined;
  }
}
