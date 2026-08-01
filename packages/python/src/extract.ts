import { DeclarationCollector } from '@traceiq/ir';
import type { CallSiteIR, DeclarationIR, ImportIR, SourceRange } from '@traceiq/ir';
import { fileId, symbolId } from '@traceiq/shared';
import type { NodeId } from '@traceiq/types';

import { children, fieldText, rangeOf, type SyntaxNode } from './parser.js';

/** What one Python module contributed, before anything is resolved across files. */
export interface ModuleFacts {
  readonly declarations: readonly DeclarationIR[];
  readonly imports: readonly ImportIR[];
  readonly callSites: readonly CallSiteIR[];
  /** Base-class expressions per class declaration, for the resolver to bind. */
  readonly heritage: readonly HeritageFact[];
  /** Decorators on a declaration, as written. Framework detection reads these. */
  readonly decorators: readonly DecoratorFact[];
  /** `store = Store()` inside a function body, whose callee decides the local's type. */
  readonly localAssignments: readonly LocalAssignmentFact[];
}

/**
 * A local bound to the result of a call, inside a function body.
 *
 * **Python's answer to "what type is this" is almost always a construction**, and the construction
 * is written down: `store = Store()`. Nothing else in the language states a local's type without a
 * type annotation nobody is obliged to write. Recording the callee — rather than a type — is the
 * honest shape, because `Store()` is a class call and `make_store()` is a function call and the
 * syntax cannot tell them apart. The resolver knows which names are classes, and binds only those.
 */
export interface LocalAssignmentFact {
  /** The function or method whose body holds the assignment. */
  readonly ownerId: NodeId;
  readonly name: string;
  /** The leftmost identifier of the initialising call's callee. */
  readonly calleeRootName: string | null;
  /** The final attribute when the callee is `mod.Klass`, else `null`. */
  readonly calleeMemberName: string | null;
  readonly location: SourceRange;
}

export interface HeritageFact {
  readonly declarationId: NodeId;
  /** The base as written: `Base`, `models.Base`, `Generic[T]`. */
  readonly text: string;
  /** The leftmost identifier, which is what a name lookup can bind. */
  readonly rootName: string;
  readonly location: SourceRange;
}

export interface DecoratorFact {
  readonly declarationId: NodeId;
  /** The decorator as written, without the `@`: `app.get("/users")`. */
  readonly text: string;
  /** The dotted callee when the decorator is a call, else the bare name. */
  readonly calleeText: string;
  readonly location: SourceRange;
}

const NO_MODIFIERS = {
  isExported: false,
  isStatic: false,
  isAbstract: false,
  isReadonly: false,
  isOptional: false,
  isAsync: false,
} as const;

/**
 * Walks one module's syntax tree into IR facts.
 *
 * **Only what the syntax states.** A name is a declaration because `def`, `class` or a module-level
 * assignment says so — every declaration here is `CERTAIN`, because it is a reading of the source
 * rather than an inference about it. Anything requiring knowledge beyond this file (what an imported
 * name refers to, which function a call reaches) is left to the resolver, which marks it honestly.
 *
 * Python has no export statement, so **no `ExportIR` is produced**. Module-level names are importable
 * by convention and `__all__` only advises `import *`; emitting exports would invent a construct the
 * language does not have, purely so the shape matched TypeScript's.
 */
export function extractModule(input: {
  readonly repoRelativePath: string;
  readonly root: SyntaxNode;
}): ModuleFacts {
  const file = fileId(input.repoRelativePath);
  // Keyed by identifier rather than by syntactic site. Python redefines freely — `@t.overload`
  // signatures, a name reassigned at module level, a `def` shadowed under `if TYPE_CHECKING` — and
  // every one of those is one addressable declaration written more than once. Emitting a
  // declaration per site produced duplicate identifiers, which the graph rejects outright.
  const collector = new DeclarationCollector();
  /** Kind by identifier, first site winning, so "is this chain a class?" is a lookup not a scan. */
  const kindById = new Map<NodeId, DeclarationIR['kind']>();
  const imports: ImportIR[] = [];
  const callSites: CallSiteIR[] = [];
  const heritage: HeritageFact[] = [];
  const decorators: DecoratorFact[] = [];
  const localAssignments: LocalAssignmentFact[] = [];

  /**
   * One pass over the tree, visiting every node exactly once.
   *
   * The single pass matters: an earlier version recorded calls with a separate recursive walk *and*
   * descended with this one, so a nested call such as `UserService().create(x)` was recorded twice
   * and produced two edges with the same identity.
   */
  const visit = (node: SyntaxNode, chain: readonly string[], enclosing: NodeId | null): void => {
    for (const child of children(node)) {
      switch (child.type) {
        case 'decorated_definition': {
          visitDecorated(child, chain, enclosing);
          continue;
        }

        case 'function_definition':
        case 'class_definition': {
          visitDefinition(child, chain, enclosing, []);
          continue;
        }

        case 'import_statement':
        case 'import_from_statement': {
          imports.push(...readImport(child, input.repoRelativePath));
          continue;
        }

        default:
          break;
      }

      // A module-level or class-level binding is a declaration; one inside a function body is a
      // local, which the graph does not model for any language.
      if (child.type === 'assignment') {
        readAssignment(child, chain, enclosing);
      }

      if (child.type === 'call') {
        const callee = child.childForFieldName('function');

        if (callee !== null) {
          callSites.push(callSite(callee, child, file, enclosing));
        }
      }

      visit(child, chain, enclosing);
    }
  };

  const visitDecorated = (
    node: SyntaxNode,
    chain: readonly string[],
    enclosing: NodeId | null,
  ): void => {
    const applied = children(node).filter((child) => child.type === 'decorator');
    const definition = children(node).find(
      (child) => child.type === 'function_definition' || child.type === 'class_definition',
    );

    if (definition === undefined) {
      return;
    }

    visitDefinition(definition, chain, enclosing, applied);
  };

  const visitDefinition = (
    node: SyntaxNode,
    chain: readonly string[],
    enclosing: NodeId | null,
    applied: readonly SyntaxNode[],
  ): void => {
    const name = fieldText(node, 'name');

    if (name === null) {
      return;
    }

    const isClass = node.type === 'class_definition';
    const nextChain = [...chain, name];
    const kind = isClass
      ? 'class'
      : // A `def` inside a `class` is a method; anywhere else it is a function. Nested functions are
        // reported as functions too, which is what they are.
        enclosingIsClass(chain, kindById, input.repoRelativePath)
        ? 'method'
        : 'function';

    const { id } = collector.add({
      repoRelativePath: input.repoRelativePath,
      fileId: file,
      kind,
      name,
      containerChain: nextChain,
      visibility: null,
      // A leading underscore is Python's convention for "not part of the interface". It is a
      // convention rather than enforcement, so it is not recorded as visibility.
      modifiers: { ...NO_MODIFIERS, isAsync: isAsyncDefinition(node) },
      locations: [rangeOf(node)],
    });

    if (!kindById.has(id)) {
      kindById.set(id, kind);
    }

    for (const decorator of applied) {
      const text = decorator.text.replace(/^@/, '');

      decorators.push({
        declarationId: id,
        text,
        calleeText: text.split('(')[0] ?? text,
        location: rangeOf(decorator),
      });

      // A decorator is also a call: `@app.get("/x")` invokes `app.get`. Visited rather than
      // separately collected, so it goes through the same single pass as everything else.
      visit(decorator, chain, enclosing);
    }

    if (isClass) {
      for (const base of readBases(node)) {
        heritage.push({ declarationId: id, ...base });
      }
    }

    const body = node.childForFieldName('body');

    if (body !== null) {
      visit(body, nextChain, id);
    }
  };

  const readAssignment = (
    node: SyntaxNode,
    chain: readonly string[],
    enclosing: NodeId | null,
  ): void => {
    const assignment = node.type === 'assignment' ? node : children(node).find((c) => c.type === 'assignment');

    if (assignment === undefined) {
      return;
    }

    // Only module and class level becomes a declaration. A function body's assignments are locals,
    // which the graph models for no language — but their *type* is recorded below, because
    // `store = Store()` is the one thing that makes `store.save()` bindable in Python.
    if (enclosing !== null && !isClassChain(chain, kindById, input.repoRelativePath)) {
      readLocalAssignment(assignment, enclosing);
      return;
    }

    const left = assignment.childForFieldName('left');

    if (left === null || left.type !== 'identifier') {
      return;
    }

    const nextChain = [...chain, left.text];
    const kind = chain.length === 0 ? 'variable' : 'property';

    const { id } = collector.add({
      repoRelativePath: input.repoRelativePath,
      fileId: file,
      kind,
      name: left.text,
      containerChain: nextChain,
      visibility: null,
      modifiers: NO_MODIFIERS,
      locations: [rangeOf(assignment)],
    });

    if (!kindById.has(id)) {
      kindById.set(id, kind);
    }
  };

  /**
   * `store = Store()` inside a function body.
   *
   * Only the shape where the right-hand side is a call rooted at a plain name, because that is the
   * only shape whose type the source states. Python constructs by calling the class, so `Store()`
   * and `make_store()` are syntactically identical — which name is a class is decided in
   * resolution, where the declarations are known, and a call to a function correctly yields
   * nothing rather than a wrong type.
   */
  function readLocalAssignment(assignment: SyntaxNode, ownerId: NodeId): void {
    const left = assignment.childForFieldName('left');
    const right = assignment.childForFieldName('right');

    if (left === null || left.type !== 'identifier' || right === null || right.type !== 'call') {
      return;
    }

    const callee = right.childForFieldName('function');

    if (callee === null) {
      return;
    }

    localAssignments.push({
      ownerId,
      name: left.text,
      calleeRootName: leftmostIdentifier(callee),
      calleeMemberName: callee.type === 'attribute' ? (fieldText(callee, 'attribute') ?? null) : null,
      location: rangeOf(assignment),
    });
  }

  visit(input.root, [], null);

  return {
    declarations: collector.toArray(),
    imports,
    callSites,
    heritage,
    decorators,
    localAssignments,
  };
}

/**
 * Whether the chain names a class, so a `def` inside it is a method.
 *
 * Answered from declarations already collected, which works because a container is always visited
 * before its body. A map lookup rather than a scan of every declaration so far: the scan made
 * extraction quadratic in a module's declaration count, which a 5,000-line module notices.
 */
function enclosingIsClass(
  chain: readonly string[],
  kindById: ReadonlyMap<NodeId, DeclarationIR['kind']>,
  filePath: string,
): boolean {
  return isClassChain(chain, kindById, filePath);
}

function isClassChain(
  chain: readonly string[],
  kindById: ReadonlyMap<NodeId, DeclarationIR['kind']>,
  filePath: string,
): boolean {
  if (chain.length === 0) {
    return false;
  }

  return kindById.get(symbolId(filePath, chain)) === 'class';
}

function isAsyncDefinition(node: SyntaxNode): boolean {
  // tree-sitter models `async def` as a function_definition whose first token is `async`.
  return node.children.some((child) => child?.type === 'async');
}

function readBases(node: SyntaxNode): readonly Omit<HeritageFact, 'declarationId'>[] {
  const list = node.childForFieldName('superclasses');

  if (list === null) {
    return [];
  }

  const bases: Omit<HeritageFact, 'declarationId'>[] = [];

  for (const base of children(list)) {
    // `metaclass=ABCMeta` is a keyword argument, not a base class.
    if (base.type === 'keyword_argument') {
      continue;
    }

    const rootName = leftmostIdentifier(base);

    if (rootName !== null) {
      bases.push({ text: base.text, rootName, location: rangeOf(base) });
    }
  }

  return bases;
}

function callSite(
  callee: SyntaxNode,
  call: SyntaxNode,
  file: NodeId,
  enclosing: NodeId | null,
): CallSiteIR {
  const text = callee.text;
  const member = callee.type === 'attribute' ? (fieldText(callee, 'attribute') ?? null) : null;

  return {
    fileId: file,
    // Python constructs by calling the class, which is indistinguishable from a function call
    // without knowing what the name refers to. The resolver decides; the syntax cannot.
    isConstruction: false,
    enclosingDeclarationId: enclosing,
    calleeText: text,
    calleeRootName: leftmostIdentifier(callee),
    calleeMemberName: member,
    arguments: [],
    location: rangeOf(call),
  };
}

/** `a.b.c()` → `a`; `self.run()` → `self`; `f()[0]()` → `null`, being unaddressable by name. */
function leftmostIdentifier(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node;

  while (current !== null) {
    if (current.type === 'identifier') {
      return current.text;
    }

    if (current.type === 'attribute') {
      current = current.childForFieldName('object');
      continue;
    }

    return null;
  }

  return null;
}

/**
 * Reads `import a.b`, `import a as b`, `from m import x, y as z`, and their relative forms.
 *
 * The dots of a relative import are preserved in the specifier — `.`, `..models` — because resolving
 * them needs the importing module's own name, which the resolver has and this does not.
 */
function readImport(node: SyntaxNode, filePath: string): readonly ImportIR[] {
  const file = fileId(filePath);
  const location = rangeOf(node);

  if (node.type === 'import_statement') {
    return children(node).flatMap((child) => {
      if (child.type === 'dotted_name') {
        const name = child.text;

        return [
          {
            fileId: file,
            moduleSpecifier: name,
            // `import a.b` binds the top-level package `a`, not `a.b`.
            bindings: [{ kind: 'namespace' as const, localName: name.split('.')[0] ?? name, importedName: null, isTypeOnly: false }],
            isTypeOnly: false,
            location,
          },
        ];
      }

      if (child.type === 'aliased_import') {
        const name = fieldText(child, 'name');
        const alias = fieldText(child, 'alias');

        return name === null || alias === null
          ? []
          : [
              {
                fileId: file,
                moduleSpecifier: name,
                bindings: [{ kind: 'namespace' as const, localName: alias, importedName: null, isTypeOnly: false }],
                isTypeOnly: false,
                location,
              },
            ];
      }

      return [];
    });
  }

  const moduleNode = node.childForFieldName('module_name');
  const specifier = moduleNode?.text ?? relativePrefix(node);

  if (specifier === null) {
    return [];
  }

  // Python has no type-only import, so the flag is always false rather than sometimes unknown.
  const bindings: { kind: 'named'; localName: string; importedName: string; isTypeOnly: false }[] = [];
  let wildcard = false;

  for (const child of children(node)) {
    if (child === moduleNode) {
      continue;
    }

    if (child.type === 'wildcard_import') {
      wildcard = true;
      continue;
    }

    if (child.type === 'dotted_name' && child.text !== moduleNode?.text) {
      bindings.push({ kind: 'named', localName: child.text, importedName: child.text, isTypeOnly: false });
    }

    if (child.type === 'aliased_import') {
      const name = fieldText(child, 'name');
      const alias = fieldText(child, 'alias');

      if (name !== null && alias !== null) {
        bindings.push({ kind: 'named', localName: alias, importedName: name, isTypeOnly: false });
      }
    }
  }

  // `from m import *` binds names this analyser cannot enumerate without executing the module, so
  // the statement is recorded with no bindings rather than with guessed ones.
  return [
    {
      fileId: file,
      moduleSpecifier: specifier,
      bindings: wildcard ? [] : bindings,
      isTypeOnly: false,
      location,
    },
  ];
}

/** `from . import x` has no module node; the dots are separate tokens. */
function relativePrefix(node: SyntaxNode): string | null {
  const dots = node.children.filter((child) => child?.type === '.' || child?.type === '...');

  return dots.length === 0 ? null : dots.map((child) => child?.text ?? '').join('');
}
