import { DeclarationCollector } from '@traceiq/ir';
import type { CallSiteIR, DeclarationIR, ImportIR, SourceRange } from '@traceiq/ir';
import { fileId } from '@traceiq/shared';
import {
  children,
  childrenOfType,
  fieldNode,
  fieldText,
  leftmostIdentifier,
  rangeOf,
  type SyntaxNode,
} from '@traceiq/tree-sitter';
import type { NodeId } from '@traceiq/types';

/**
 * An embedded type, which is how Go composes.
 *
 * `struct { Base }` and `interface { io.Reader }` both promote the embedded type's methods onto the
 * embedding one. That is the closest thing Go has to inheritance, and it is recorded as `EXTENDS`
 * because promotion is what it does — a method found on `Base` is reachable through the embedder.
 */
export interface EmbeddingFact {
  readonly declarationId: NodeId;
  /** Exactly as written: `io.Reader`, `*Base`, `Base[T]`. */
  readonly text: string;
  /** The rightmost identifier, which is the *type* name — `io.Reader` embeds `Reader`. */
  readonly typeName: string;
  /** The qualifier for a cross-package embed, or `null`: `io` in `io.Reader`. */
  readonly qualifier: string | null;
  readonly location: SourceRange;
}

/** A type named in a signature, a field or a receiver. */
export interface TypeReferenceFact {
  readonly declarationId: NodeId;
  readonly typeName: string;
  readonly qualifier: string | null;
  readonly text: string;
  readonly location: SourceRange;
}

/** A method's receiver, which is what makes it a method rather than a function. */
export interface ReceiverFact {
  readonly declarationId: NodeId;
  /** The receiver's type name, without any pointer star: `Server` for `(s *Server)`. */
  readonly typeName: string;
  /** The receiver variable, or `null` for an unnamed receiver `(*Server)`. */
  readonly variableName: string | null;
  readonly location: SourceRange;
}

/**
 * A local variable inside a function body, and what the source says its type is.
 *
 * **Go writes types down less often than Java does, and infers them more.** `db := sql.Open(…)`
 * states no type at all, and the one it has comes from a signature elsewhere. So three shapes are
 * recorded, and resolution takes the first that answers:
 *
 * - `declaredTypeName` — `var s Server`. Written down.
 * - `compositeTypeName` — `s := Server{}` or `s := &Server{}`. The literal states it.
 * - `factory` — `s := NewServer()` or `s := pkg.New()`. The type is the function's first declared
 *   result, which is known when that function is in reachable source.
 *
 * Anything else — a range variable, a channel receive, a type assertion — yields no fact, so a call
 * through it stays honestly unbound.
 */
export interface LocalVariableFact {
  /** The function or method the local lives in. */
  readonly ownerId: NodeId;
  readonly name: string;
  readonly declaredTypeName: string | null;
  readonly declaredQualifier: string | null;
  readonly compositeTypeName: string | null;
  readonly compositeQualifier: string | null;
  /** A `NewThing()` or `pkg.New()` initialiser. `memberName` is null for the bare form. */
  readonly factory: { readonly rootName: string; readonly memberName: string | null } | null;
  readonly location: SourceRange;
}

/**
 * A function's or method's first declared result type.
 *
 * The *first* only. `(*Server, error)` is Go's overwhelmingly common shape and the value a caller
 * assigns is the first one; a multi-value assignment binding both is not what a `x := f()` call
 * writes, and reading the second as the variable's type would be wrong for every one of them.
 */
export interface ResultTypeFact {
  readonly declarationId: NodeId;
  readonly typeName: string;
  readonly qualifier: string | null;
}

export interface SourceFileFacts {
  /** The `package` clause's name. Every Go file has one. */
  readonly packageName: string | null;
  readonly declarations: readonly DeclarationIR[];
  readonly imports: readonly ImportIR[];
  readonly callSites: readonly CallSiteIR[];
  readonly embeddings: readonly EmbeddingFact[];
  readonly typeReferences: readonly TypeReferenceFact[];
  readonly receivers: readonly ReceiverFact[];
  readonly localVariables: readonly LocalVariableFact[];
  readonly resultTypes: readonly ResultTypeFact[];
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
 * Reads one Go source file.
 *
 * **Go's own rules make several things simpler and one thing harder.** Simpler: a package is a
 * directory, an identifier is exported exactly when it starts with an upper-case letter, and there are
 * no classes to nest. Harder: a method belongs to its receiver's type but is written at file scope, so
 * `func (s *Server) Start()` must be attributed to `Server` even though the syntax puts it beside it.
 *
 * The container chain reflects that attribution — `Server.Start`, not `Start` — because that is what
 * makes the method addressable and what every other analyser's chain means. A plain function's chain is
 * just its name.
 *
 * Nothing here resolves across files. An import path is text, an embedded type is a name, and a call on
 * a variable is a name plus a member. Binding is `resolve.ts`, which says which of its answers are
 * proven.
 */
export function extractSourceFile(input: {
  readonly repoRelativePath: string;
  readonly root: SyntaxNode;
}): SourceFileFacts {
  const file = fileId(input.repoRelativePath);
  const collector = new DeclarationCollector();

  const imports: ImportIR[] = [];
  const callSites: CallSiteIR[] = [];
  const embeddings: EmbeddingFact[] = [];
  const typeReferences: TypeReferenceFact[] = [];
  const receivers: ReceiverFact[] = [];
  const localVariables: LocalVariableFact[] = [];
  const resultTypes: ResultTypeFact[] = [];

  let packageName: string | null = null;

  const add = (spec: {
    readonly chain: readonly string[];
    readonly kind: DeclarationIR['kind'];
    readonly name: string;
    readonly node: SyntaxNode;
    readonly modifiers?: Partial<DeclarationIR['modifiers']>;
  }): NodeId => {
    const { id } = collector.add({
      repoRelativePath: input.repoRelativePath,
      fileId: file,
      kind: spec.kind,
      name: spec.name,
      containerChain: spec.chain,
      // Go has no access keywords. Exportedness *is* its visibility, and it is spelled by the case of
      // the first letter — a fact about the identifier, not a modifier a reader could miss.
      visibility: isExportedName(spec.name) ? 'public' : 'private',
      modifiers: { ...NO_MODIFIERS, isExported: isExportedName(spec.name), ...spec.modifiers },
      locations: [rangeOf(spec.node)],
    });

    return id;
  };

  const recordTypeNames = (declarationId: NodeId, node: SyntaxNode | null): void => {
    if (node === null) {
      return;
    }

    for (const named of typeNamesOf(node)) {
      typeReferences.push({
        declarationId,
        typeName: named.typeName,
        qualifier: named.qualifier,
        text: named.text,
        location: rangeOf(node),
      });
    }
  };

  /** Walks statements, attributing calls to `owner`. */
  const walkBody = (node: SyntaxNode, owner: NodeId | null): void => {
    for (const child of children(node)) {
      if (child.type === 'call_expression') {
        const site = callSiteOf(child, file, owner);

        if (site !== null) {
          callSites.push(site);
        }
      }

      if (owner !== null && (child.type === 'short_var_declaration' || child.type === 'var_declaration')) {
        localVariables.push(...localVariablesOf(child, owner));
      }

      // A nested func literal's calls still belong to the enclosing declaration: Go has no name for
      // the literal, so there is nothing else to attribute them to.
      walkBody(child, owner);
    }
  };

  const visitType = (spec: SyntaxNode): void => {
    const name = fieldText(spec, 'name');
    const typeNode = fieldNode(spec, 'type');

    if (name === null || typeNode === null) {
      return;
    }

    const kind = typeNode.type === 'interface_type' ? 'interface' : 'class';
    const id = add({ chain: [name], kind, name, node: spec });

    if (typeNode.type === 'struct_type') {
      readStructFields(typeNode, [name], id);
      return;
    }

    if (typeNode.type === 'interface_type') {
      readInterfaceMembers(typeNode, [name], id);
      return;
    }

    // `type Celsius float64` and `type Handler func(...)`: a defined type over an existing one. The
    // underlying type is a reference, which is the fact worth having.
    recordTypeNames(id, typeNode);
  };

  const readStructFields = (
    structNode: SyntaxNode,
    chain: readonly string[],
    ownerId: NodeId,
  ): void => {
    const list = children(structNode).find((child) => child.type === 'field_declaration_list');

    if (list === undefined) {
      return;
    }

    for (const field of childrenOfType(list, 'field_declaration')) {
      const names = childrenOfType(field, 'field_identifier');
      const typeNode = fieldNode(field, 'type');

      if (names.length === 0) {
        // No field name: this is an embedded type, which promotes its methods onto the struct.
        const embedded = embeddingOf(field, typeNode);

        if (embedded !== null) {
          embeddings.push({ declarationId: ownerId, ...embedded });
        }

        continue;
      }

      for (const nameNode of names) {
        const id = add({
          chain: [...chain, nameNode.text],
          kind: 'property',
          name: nameNode.text,
          node: nameNode,
        });

        recordTypeNames(id, typeNode);
      }
    }
  };

  const readInterfaceMembers = (
    interfaceNode: SyntaxNode,
    chain: readonly string[],
    ownerId: NodeId,
  ): void => {
    for (const member of children(interfaceNode)) {
      if (member.type === 'method_elem') {
        const name = fieldText(member, 'name');

        if (name !== null) {
          const id = add({
            chain: [...chain, name],
            kind: 'method',
            name,
            node: member,
            // An interface method has no body: it is a requirement rather than an implementation.
            modifiers: { isAbstract: true },
          });

          recordTypeNames(id, fieldNode(member, 'parameters'));
          recordTypeNames(id, fieldNode(member, 'result'));
        }

        continue;
      }

      // An embedded interface — `interface { io.Reader }` — promotes its methods too.
      if (member.type === 'type_elem' || member.type === 'interface_type_name') {
        const embedded = embeddingOf(member, member);

        if (embedded !== null) {
          embeddings.push({ declarationId: ownerId, ...embedded });
        }
      }
    }
  };

  const visit = (node: SyntaxNode): void => {
    for (const child of children(node)) {
      if (child.type === 'package_clause') {
        packageName = children(child)[0]?.text ?? null;
        continue;
      }

      if (child.type === 'import_declaration') {
        imports.push(...readImports(child, file));
        continue;
      }

      if (child.type === 'type_declaration') {
        for (const spec of children(child)) {
          if (spec.type === 'type_spec' || spec.type === 'type_alias') {
            visitType(spec);
          }
        }

        continue;
      }

      if (child.type === 'function_declaration') {
        const name = fieldText(child, 'name');

        if (name !== null) {
          const id = add({ chain: [name], kind: 'function', name, node: child });

          recordTypeNames(id, fieldNode(child, 'parameters'));
          recordTypeNames(id, fieldNode(child, 'result'));
          recordResultType(id, fieldNode(child, 'result'));

          const body = fieldNode(child, 'body');

          if (body !== null) {
            walkBody(body, id);
          }
        }

        continue;
      }

      if (child.type === 'method_declaration') {
        visitMethod(child);
        continue;
      }

      if (child.type === 'const_declaration' || child.type === 'var_declaration') {
        for (const spec of children(child)) {
          if (spec.type !== 'const_spec' && spec.type !== 'var_spec') {
            continue;
          }

          for (const nameNode of childrenOfType(spec, 'identifier')) {
            const id = add({
              chain: [nameNode.text],
              kind: 'variable',
              name: nameNode.text,
              node: nameNode,
              // A `const` cannot be reassigned, which is what readonly means everywhere else.
              modifiers: { isReadonly: child.type === 'const_declaration' },
            });

            recordTypeNames(id, fieldNode(spec, 'type'));

            const value = fieldNode(spec, 'value');

            if (value !== null) {
              walkBody(value, id);
            }
          }
        }

        continue;
      }

      visit(child);
    }
  };

  const visitMethod = (node: SyntaxNode): void => {
    const name = fieldText(node, 'name');
    const receiverNode = fieldNode(node, 'receiver');

    if (name === null || receiverNode === null) {
      return;
    }

    const receiver = receiverOf(receiverNode);

    if (receiver === null) {
      return;
    }

    // Attributed to its receiver's type, because that is what makes it addressable. Go writes the
    // method beside the type rather than inside it, and a chain of just the method name would collide
    // the moment two types declared the same method — which in Go is constant.
    const id = add({
      chain: [receiver.typeName, name],
      kind: 'method',
      name,
      node,
    });

    receivers.push({
      declarationId: id,
      typeName: receiver.typeName,
      variableName: receiver.variableName,
      location: rangeOf(receiverNode),
    });

    recordTypeNames(id, fieldNode(node, 'parameters'));
    recordTypeNames(id, fieldNode(node, 'result'));
    recordResultType(id, fieldNode(node, 'result'));

    const body = fieldNode(node, 'body');

    if (body !== null) {
      walkBody(body, id);
    }
  };

  function recordResultType(declarationId: NodeId, resultNode: SyntaxNode | null): void {
    if (resultNode === null) {
      return;
    }

    const first = typeNamesOf(resultNode)[0];

    if (first !== undefined) {
      resultTypes.push({ declarationId, typeName: first.typeName, qualifier: first.qualifier });
    }
  }

  visit(input.root);

  return {
    packageName,
    declarations: collector.toArray(),
    imports,
    callSites,
    embeddings,
    typeReferences,
    receivers,
    localVariables,
    resultTypes,
  };
}

/**
 * Reads a `x := …` or a body-scoped `var x T = …` into a fact per name it declares.
 *
 * Multi-value forms are handled by position: `a, b := f()` pairs the first name with the first
 * expression only when the counts match. They do not match for `a, err := f()` against a single
 * call expression — Go is destructuring a tuple there — and in that case no initialiser is
 * attributed to any name, which is correct: the first result belongs to `a`, and saying so would
 * need the callee's arity, which this reader does not have.
 */
function localVariablesOf(node: SyntaxNode, ownerId: NodeId): readonly LocalVariableFact[] {
  const found: LocalVariableFact[] = [];

  const record = (nameNode: SyntaxNode, typeNode: SyntaxNode | null, value: SyntaxNode | null): void => {
    const declared = typeNode === null ? undefined : typeNamesOf(typeNode)[0];
    const composite = value === null ? null : compositeTypeOf(value);

    found.push({
      ownerId,
      name: nameNode.text,
      declaredTypeName: declared?.typeName ?? null,
      declaredQualifier: declared?.qualifier ?? null,
      compositeTypeName: composite?.typeName ?? null,
      compositeQualifier: composite?.qualifier ?? null,
      factory: value === null ? null : factoryCallOf(value),
      location: rangeOf(nameNode),
    });
  };

  if (node.type === 'short_var_declaration') {
    const left = fieldNode(node, 'left');
    const right = fieldNode(node, 'right');

    if (left === null) {
      return found;
    }

    const names = childrenOfType(left, 'identifier');
    const values = right === null ? [] : children(right).filter((child) => child.type !== ',');

    for (const [position, nameNode] of names.entries()) {
      record(nameNode, null, names.length === values.length ? (values[position] ?? null) : null);
    }

    return found;
  }

  for (const spec of childrenOfType(node, 'var_spec')) {
    const typeNode = fieldNode(spec, 'type');
    const value = fieldNode(spec, 'value');
    const names = childrenOfType(spec, 'identifier');
    const values = value === null ? [] : children(value).filter((child) => child.type !== ',');

    for (const [position, nameNode] of names.entries()) {
      record(nameNode, typeNode, names.length === values.length ? (values[position] ?? null) : null);
    }
  }

  return found;
}

/** The type named by a composite literal: `Server{}`, `&Server{}`, `pkg.Config{}`. */
function compositeTypeOf(
  value: SyntaxNode,
): { readonly typeName: string; readonly qualifier: string | null } | null {
  // `&Server{}` is a unary expression over the literal. Taking the address does not change which
  // type's methods the variable provides, so it is unwrapped rather than treated as a different case.
  const inner = value.type === 'unary_expression' ? (fieldNode(value, 'operand') ?? value) : value;

  if (inner.type !== 'composite_literal') {
    return null;
  }

  const typeNode = fieldNode(inner, 'type');

  return typeNode === null ? null : (typeNamesOf(typeNode)[0] ?? null);
}

/** A `NewThing()` or `pkg.New()` initialiser, whose first result is the variable's type. */
function factoryCallOf(
  value: SyntaxNode,
): { readonly rootName: string; readonly memberName: string | null } | null {
  // `&NewThing()` is not valid Go, but `&Thing{}` reaching here as a unary expression is, and the
  // composite rule above already claimed it. Only a call is a factory.
  if (value.type !== 'call_expression') {
    return null;
  }

  const functionNode = fieldNode(value, 'function');

  if (functionNode === null) {
    return null;
  }

  if (functionNode.type === 'selector_expression') {
    const operand = fieldNode(functionNode, 'operand');
    const member = fieldNode(functionNode, 'field')?.text ?? null;

    // Only a simple `pkg.New()`. A chained receiver needs the type of the chain, which is what this
    // inference is trying to establish.
    return operand === null || operand.type !== 'identifier' || member === null
      ? null
      : { rootName: operand.text, memberName: member };
  }

  return functionNode.type === 'identifier' ? { rootName: functionNode.text, memberName: null } : null;
}

/** Go's visibility rule: an identifier is exported when it begins with an upper-case letter. */
export function isExportedName(name: string): boolean {
  const first = name[0];

  return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
}

/** The receiver of a method declaration: its type name and the variable it binds. */
function receiverOf(
  receiverNode: SyntaxNode,
): { readonly typeName: string; readonly variableName: string | null } | null {
  const parameter = childrenOfType(receiverNode, 'parameter_declaration')[0];

  if (parameter === undefined) {
    return null;
  }

  const typeNode = fieldNode(parameter, 'type');
  const nameNode = fieldNode(parameter, 'name');

  if (typeNode === null) {
    return null;
  }

  // `(s *Server)` and `(s Server)` both have receiver type `Server`. A pointer receiver is not a
  // different type for addressing purposes, and treating it as one would split every type's methods
  // across two names.
  const typeName = rightmostTypeName(typeNode);

  return typeName === null
    ? null
    : { typeName, variableName: nameNode === null ? null : nameNode.text };
}

/**
 * An embedded type's name and qualifier.
 *
 * `io.Reader` embeds `Reader` from package `io`; `Base` embeds a type in this package; `*Base` embeds
 * through a pointer, which promotes the same methods.
 */
function embeddingOf(
  node: SyntaxNode,
  typeNode: SyntaxNode | null,
): Omit<EmbeddingFact, 'declarationId'> | null {
  const target = typeNode ?? node;
  const typeName = rightmostTypeName(target);

  if (typeName === null) {
    return null;
  }

  return {
    text: target.text,
    typeName,
    qualifier: qualifierOf(target),
    location: rangeOf(node),
  };
}

/**
 * The type name a node names, taking the *rightmost* identifier.
 *
 * Rightmost rather than leftmost, because a Go qualified type puts the package first: `io.Reader` names
 * the type `Reader`, and taking the leftmost would name the package. That is the opposite of a Java or
 * Python call chain, which is exactly why this is spelled out here rather than shared.
 */
function rightmostTypeName(node: SyntaxNode): string | null {
  if (node.type === 'qualified_type') {
    return fieldText(node, 'name');
  }

  if (node.type === 'type_identifier' || node.type === 'identifier' || node.type === 'field_identifier') {
    return node.text;
  }

  // `*Server`, `Base[T]`, `[]Foo` — unwrap and try again.
  for (const child of children(node)) {
    const found = rightmostTypeName(child);

    if (found !== null) {
      return found;
    }
  }

  return null;
}

/** The package qualifier of a type, or `null` when it is local. */
function qualifierOf(node: SyntaxNode): string | null {
  if (node.type === 'qualified_type') {
    return fieldNode(node, 'package')?.text ?? null;
  }

  for (const child of children(node)) {
    const found = qualifierOf(child);

    if (found !== null) {
      return found;
    }
  }

  return null;
}

/** Every type named inside a node, deduplicated. Generic arguments and element types included. */
function typeNamesOf(
  node: SyntaxNode,
): readonly { readonly typeName: string; readonly qualifier: string | null; readonly text: string }[] {
  const found: { typeName: string; qualifier: string | null; text: string }[] = [];

  const walk = (current: SyntaxNode): void => {
    if (current.type === 'qualified_type') {
      const name = fieldText(current, 'name');

      if (name !== null) {
        found.push({ typeName: name, qualifier: fieldNode(current, 'package')?.text ?? null, text: current.text });
      }

      return;
    }

    if (current.type === 'type_identifier') {
      found.push({ typeName: current.text, qualifier: null, text: current.text });
    }

    for (const child of children(current)) {
      walk(child);
    }
  };

  walk(node);

  const seen = new Set<string>();

  return found.filter((entry) => {
    const key = `${entry.qualifier ?? ''}.${entry.typeName}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/**
 * Reads an `import` declaration.
 *
 * Go's forms, each mapped to the binding kind that says what it binds:
 *
 * ```go
 * import "net/http"              // namespace: bound as `http`, the path's last segment
 * import h "net/http"            // namespace, bound as `h`
 * import . "net/http"            // namespace with no qualifier at all
 * import _ "net/http"            // side effect only; binds nothing
 * ```
 *
 * The specifier keeps its quotes stripped and nothing else changed — turning a module path into a
 * directory is resolution.
 */
function readImports(node: SyntaxNode, file: NodeId): readonly ImportIR[] {
  const found: ImportIR[] = [];

  const readSpec = (spec: SyntaxNode): void => {
    const pathNode = fieldNode(spec, 'path') ?? children(spec).find((child) => child.type === 'interpreted_string_literal');

    if (pathNode === undefined || pathNode === null) {
      return;
    }

    const specifier = pathNode.text.replaceAll('"', '').replaceAll('`', '');
    const alias = fieldNode(spec, 'name')?.text ?? null;

    if (alias === '_') {
      // A blank import runs the package's initialisers and binds no name.
      found.push({
        fileId: file,
        moduleSpecifier: specifier,
        isTypeOnly: false,
        bindings: [],
        location: rangeOf(spec),
      });

      return;
    }

    const localName = alias ?? (specifier.split('/').at(-1) as string);

    found.push({
      fileId: file,
      moduleSpecifier: specifier,
      isTypeOnly: false,
      bindings: [{ kind: 'namespace', importedName: null, localName, isTypeOnly: false }],
      location: rangeOf(spec),
    });
  };

  for (const child of children(node)) {
    if (child.type === 'import_spec') {
      readSpec(child);
      continue;
    }

    if (child.type === 'import_spec_list') {
      for (const spec of childrenOfType(child, 'import_spec')) {
        readSpec(spec);
      }
    }
  }

  return found;
}

/**
 * A call's arguments, in the IR's shape.
 *
 * Recorded because a Go route registration puts its path and its handler in argument positions —
 * `r.GET("/users", listUsers)` — and neither is recoverable from the callee alone. `stringValue` is
 * set only for an interpreted string literal, which is what makes a route path readable without
 * parsing expression text.
 */
function argumentsOf(node: SyntaxNode): CallSiteIR['arguments'] {
  const list = fieldNode(node, 'arguments');

  if (list === null) {
    return [];
  }

  return children(list)
    .filter((child) => child.type !== ',' && child.type !== '(' && child.type !== ')')
    .map((child) => ({
      text: child.text,
      stringValue:
        child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal'
          ? child.text.slice(1, -1)
          : null,
    }));
}

/** A call site, in the IR's language-independent shape. */
function callSiteOf(node: SyntaxNode, file: NodeId, owner: NodeId | null): CallSiteIR | null {
  const functionNode = fieldNode(node, 'function');

  if (functionNode === null) {
    return null;
  }

  if (functionNode.type === 'selector_expression') {
    const operand = fieldNode(functionNode, 'operand');
    const member = fieldNode(functionNode, 'field')?.text ?? null;

    // The *immediate* receiver, not the leftmost identifier. `s.store.Save()` is a call on `store`,
    // whose type decides the target; `s` only says where `store` was found. `CallSiteIR` carries a root
    // and a member, which is two segments — so for a longer chain the last two are the ones that
    // determine the callee, and taking the leftmost bound `Save` against `s`'s type and failed.
    const root =
      operand === null
        ? null
        : operand.type === 'selector_expression'
          ? (fieldNode(operand, 'field')?.text ?? leftmostIdentifier(operand))
          : leftmostIdentifier(operand);

    if (member === null) {
      return null;
    }

    return {
      fileId: file,
      enclosingDeclarationId: owner,
      calleeText: functionNode.text,
      calleeRootName: root,
      calleeMemberName: member,
      arguments: argumentsOf(node),
      location: rangeOf(node),
      isConstruction: false,
    };
  }

  const root = leftmostIdentifier(functionNode);

  if (root === null) {
    return null;
  }

  return {
    fileId: file,
    enclosingDeclarationId: owner,
    calleeText: functionNode.text,
    calleeRootName: root,
    calleeMemberName: null,
    arguments: argumentsOf(node),
    location: rangeOf(node),
    isConstruction: false,
  };
}
