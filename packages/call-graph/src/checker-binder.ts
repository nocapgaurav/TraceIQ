import type { CallSiteIR, RepositoryIR, SourceRange } from '@traceiq/ir';
import type { ProjectContext } from '@traceiq/project-host';
import { DeclarationIndex, classifyExternalFile, type ExternalOrigin } from '@traceiq/resolver';
import type { Ecosystem, NodeId } from '@traceiq/types';
import { Node, type CallExpression, type NewExpression, type TypeChecker } from 'ts-morph';

import type { UnresolvedCallReason } from './types.js';

/**
 * What the type checker made of one call site.
 *
 * `'unbound'` means the checker had no answer, not that the call is unbindable: the name
 * rules run afterwards and frequently succeed where this does not, which is why the two
 * tiers exist rather than one replacing the other.
 */
export type CheckerOutcome =
  | { readonly kind: 'declaration'; readonly targetId: NodeId; readonly evidence: string }
  | {
      readonly kind: 'external';
      readonly origin: ExternalOrigin;
      readonly name: string | null;
      readonly ecosystem: Ecosystem | null;
      readonly evidence: string;
    }
  | { readonly kind: 'unbound'; readonly reason: UnresolvedCallReason | null };

/**
 * Binds call sites through the TypeScript type checker.
 *
 * The name-based rules this sits above bind *text*: they ask which declaration is called
 * `run` somewhere the caller can see. The checker binds *symbols* — it knows the type of
 * the receiver, so `svc.run()` reaches `Service.run` whether `svc` came from a
 * constructor, a parameter, a factory, a destructuring or an interface, and
 * `getSvc().run()` reaches it through a call it had to type first.
 *
 * That difference is why a binding from here is `RESOLVED` and a binding from a name rule
 * is `INFERRED`. The name rules match a plausible declaration; the checker reports the one
 * the compiler itself would call.
 *
 * **It is still not complete, and cannot be.** A call through a runtime-chosen receiver
 * has no single answer, and the checker declines rather than guessing — as it should. Such
 * a site falls through to the name rules and, failing those, is reported unresolved.
 *
 * The context is borrowed, never owned. Nothing here disposes it, and every lookup happens
 * during `resolve`, so no compiler state outlives the call graph stage.
 */
export class CheckerBinder {
  readonly #checker: TypeChecker;
  readonly #index: DeclarationIndex;
  readonly #callsByPosition: ReadonlyMap<string, CallExpression | NewExpression>;

  private constructor(
    checker: TypeChecker,
    index: DeclarationIndex,
    callsByPosition: ReadonlyMap<string, CallExpression | NewExpression>,
  ) {
    this.#checker = checker;
    this.#index = index;
    this.#callsByPosition = callsByPosition;
  }

  /**
   * Indexes every call expression in the repository by its position.
   *
   * A `CallSiteIR` records text and a position, deliberately holding no compiler node —
   * the IR is plain data and outlives the program. Position is therefore how a call site
   * is correlated back to the syntax it came from, using the same range convention the IR
   * Builder recorded it with.
   */
  static create(input: {
    readonly context: ProjectContext;
    readonly ir: RepositoryIR;
    /**
     * The declaration index to bind against. Defaults to one built from `ir` alone.
     *
     * Supplied when this IR is one bounded compilation of several: a call reaching a declaration
     * another unit owns must find it, not be classified as leaving the repository.
     */
    readonly index?: DeclarationIndex;
  }): CheckerBinder {
    const callsByPosition = new Map<string, CallExpression | NewExpression>();

    for (const file of input.ir.files) {
      const sourceFile = input.context.findSourceFile(file.path);

      if (sourceFile === undefined) {
        continue;
      }

      sourceFile.forEachDescendant((node) => {
        if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
          callsByPosition.set(positionKey(file.id, rangeOf(node)), node);
        }
      });
    }

    return new CheckerBinder(
      input.context.typeChecker,
      input.index ?? DeclarationIndex.fromIr(input.ir),
      callsByPosition,
    );
  }

  bind(site: CallSiteIR): CheckerOutcome {
    const node = this.#callsByPosition.get(positionKey(site.fileId, site.location));

    if (node === undefined) {
      return UNBOUND;
    }

    /*
     * The checker is asked, and is allowed to fail.
     *
     * It is a large third-party component being interrogated at every call site in a repository,
     * and some inputs make it throw from inside its own contextual-typing code — untyped JavaScript
     * object literals in a conditional are one observed case, raising
     * `Cannot read properties of undefined (reading 'escapedName')`. Letting that escape would cost
     * the whole scan for one pathological expression.
     *
     * Falling through is not swallowing the problem: the name rules still try, and whatever they
     * bind is recorded as `INFERRED` rather than `RESOLVED`. The result is weaker evidence for that
     * one call, which is exactly what happened.
     */
    let declaration: Node | undefined;

    try {
      declaration = this.#declarationFor(node);
    } catch {
      return UNBOUND;
    }

    if (declaration === undefined) {
      return UNBOUND;
    }

    const absolutePath = declaration.getSourceFile().getFilePath();
    const fileId = this.#index.fileIdOf(absolutePath);

    // Declared outside the analysed set: the call leaves the repository. Which package it
    // leaves for is worth recording — it is the only way to answer what a declaration
    // actually depends on, since IMPORTS is recorded at the file.
    if (fileId === undefined) {
      const external = classifyExternalFile(absolutePath);

      // A TypeScript library declaration is not a dependency. `JSON.stringify`,
      // `Map`, `Object.keys` — the repository did not choose these, it is written in
      // them, and recording each as a dependency edge buries the packages it *did*
      // choose. Reported unresolved with a reason that says so, rather than falling
      // through to the name rules, which could otherwise match some unrelated local
      // declaration that happens to share the name.
      if (external.origin === 'language-builtin') {
        return LANGUAGE_BUILTIN;
      }

      // No package name is recoverable, so there is nothing to point at that a reader
      // could act on. `ext:outside-analysis` exists, but an edge onto a nameless
      // sentinel asserts a dependency without naming it.
      if (external.origin === 'outside-analysis') {
        return OUTSIDE_ANALYSIS;
      }

      return {
        kind: 'external',
        origin: external.origin,
        name: external.name,
        ecosystem: external.ecosystem,
        evidence: `the type checker resolved '${site.calleeText}' to a declaration in this package`,
      };
    }

    const targetId = this.#identify(fileId, declaration);

    if (targetId === undefined) {
      return UNBOUND;
    }

    return {
      kind: 'declaration',
      targetId,
      evidence: `the type checker resolved '${site.calleeText}' to this declaration`,
    };
  }

  /**
   * The declaration the compiler would actually invoke.
   *
   * `getResolvedSignature` is asked first because it is the strongest answer available:
   * it is the overload the checker selected for these arguments, so an overloaded callee
   * binds to the signature in force rather than to whichever is declared first.
   *
   * Falling back to the callee's symbol covers what has no signature to resolve — a
   * construction of a class with no declared constructor, and calls the checker typed as
   * `any`, where a symbol may still exist.
   */
  #declarationFor(node: CallExpression | NewExpression): Node | undefined {
    const signature = this.#checker.getResolvedSignature(node);
    const fromSignature = signature?.getDeclaration();

    // A synthesized signature — the implicit constructor of a class that declares none —
    // reports the class as its declaration, which is the right target anyway.
    if (fromSignature !== undefined) {
      return fromSignature as unknown as Node;
    }

    const symbol = this.#checker.getSymbolAtLocation(node.getExpression());

    if (symbol === undefined) {
      return undefined;
    }

    const aliased = trySymbolAlias(symbol, this.#checker);

    return (aliased ?? symbol).getDeclarations()[0];
  }

  /**
   * Maps a compiler declaration onto the IR node identifier standing for it.
   *
   * Ancestors are tried when the declaration itself is not one the IR recorded. The
   * compiler's idea of a declaration is finer than the graph's: `const f = () => {}`
   * resolves to the arrow function, while the IR recorded the variable. Walking outwards
   * finds the recorded declaration that contains it.
   *
   * **The walk stops at a function boundary, and that is the whole correctness of it.**
   * Once the walk leaves a function's parameter list or body, the declaration it started
   * from is a *local* of that function, and the function is the thing doing the calling
   * rather than the thing being called. Without the stop, `const [n, setN] = useState(0)`
   * inside `App` binds `setN(…)` to `App` — an array-destructured binding is not an IR
   * declaration, so the walk climbed out of the body and took the first recorded thing it
   * met. Every React component in this repository called itself: **83 self-referential
   * CALLS edges, all checker-bound, none of them in the source.** A parameter does the
   * same thing without even a body to cross: `function f(cb) { cb(); }` bound `f → f`.
   *
   * Yields nothing when no ancestor was recorded before that boundary. That is the honest
   * answer — the name rules try next, and failing those the site is reported unresolved,
   * which is strictly better than an edge that is not in the program.
   */
  #identify(fileId: NodeId, declaration: Node): NodeId | undefined {
    let current: Node | undefined = declaration;

    while (current !== undefined && !Node.isSourceFile(current)) {
      // Reached a function that *contains* where we started rather than being it. Anything
      // recorded above this point is the caller's container, not the callee.
      if (current !== declaration && introducesScope(current)) {
        return undefined;
      }

      const range = rangeOf(current);
      const found = this.#index.declarationAt(fileId, range.startLine, range.startColumn);

      if (found !== undefined) {
        return found.id;
      }

      current = current.getParent();
    }

    return undefined;
  }
}

/**
 * Whether a node introduces a scope whose locals are not the node itself.
 *
 * Class and interface bodies are deliberately absent: a method *is* a recorded declaration
 * and is reached directly, and a property initialised with an arrow is the arrow's own
 * recorded container. Only a callable's parameters and body hold locals that could be
 * mistaken for it.
 */
function introducesScope(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/** The checker had no answer; the name rules should try. */
const UNBOUND: CheckerOutcome = { kind: 'unbound', reason: null };

/** The checker answered, and the answer is that no edge belongs here. */
const LANGUAGE_BUILTIN: CheckerOutcome = { kind: 'unbound', reason: 'callee-is-language-builtin' };
const OUTSIDE_ANALYSIS: CheckerOutcome = { kind: 'unbound', reason: 'callee-outside-analysis' };

/**
 * Follows an import or export indirection to the declaring symbol.
 *
 * `getAliasedSymbol` throws rather than returning undefined for a symbol that is not an
 * alias, so the check is a try rather than a test.
 */
function trySymbolAlias(
  symbol: ReturnType<TypeChecker['getSymbolAtLocation']>,
  checker: TypeChecker,
): ReturnType<TypeChecker['getSymbolAtLocation']> {
  if (symbol === undefined) {
    return undefined;
  }

  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

/**
 * Must stay identical to the IR Builder's conversion, because position is what correlates
 * a compiler node to an IR record. Duplicated for the same reason the Resolver duplicates
 * it: exporting it from `@traceiq/ir` would put a ts-morph type in that package's API.
 */
function rangeOf(node: Node): SourceRange {
  const file = node.getSourceFile();
  const start = file.getLineAndColumnAtPos(node.getStart());
  const end = file.getLineAndColumnAtPos(node.getEnd());

  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

/**
 * Identifies a call expression by its **full** range, start and end.
 *
 * The end is not redundant. In `make().run()` the outer call and the inner `make()` begin
 * at the same character, so a key of start alone collides and one silently stands in for
 * the other — binding the chained call to `make` rather than to `run`. Ranges nest, so
 * only the pair is unique.
 */
function positionKey(fileId: NodeId, range: SourceRange): string {
  return `${fileId}@${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
}
