import { DeclarationCollector } from '@traceiq/ir';
import type { CallSiteIR, DeclarationIR, ImportIR, SourceRange } from '@traceiq/ir';
import { fileId, symbolId } from '@traceiq/shared';
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

/** A base class or implemented interface, before anything is bound. */
export interface HeritageFact {
  /** The declaration the clause belongs to. */
  readonly declarationId: NodeId;
  readonly kind: 'extends' | 'implements';
  /** Exactly as written, generics included: `List<String>`. */
  readonly text: string;
  /** The leftmost identifier, which is the name a binder can look up. */
  readonly rootName: string;
  readonly location: SourceRange;
}

/** An annotation applied to a declaration, which is how every Java framework marks its own. */
export interface AnnotationFact {
  readonly declarationId: NodeId;
  /** Simple name, without the `@` and without any package qualification: `GetMapping`. */
  readonly name: string;
  /** The whole annotation as written, so an argument can be read without a second parse. */
  readonly text: string;
  readonly location: SourceRange;
}

/** A type named in a signature or a field, which becomes a REFERENCES_TYPE candidate. */
export interface TypeReferenceFact {
  /** The declaration whose signature names the type. */
  readonly declarationId: NodeId;
  readonly rootName: string;
  readonly text: string;
  readonly location: SourceRange;
}

/**
 * A local variable declared inside a method body, and whatever the source says about its type.
 *
 * **This is the single largest source of unbound calls in Java, and it is recoverable.** Java is
 * statically typed and a local's type is written down — `PetRepository repo = ...` — or inferable
 * from what initialises it. Without this the analyser could bind a call on a *field* and not on a
 * local, which in practice meant most calls inside any method that used a temporary: petclinic
 * reported 868 `root-type-unknown` against 106 bound calls.
 *
 * Three shapes, in decreasing strength:
 *
 * - `declaredTypeName` — `Foo foo = anything()`. The source states the type. Nothing is inferred.
 * - `constructedTypeName` — `var foo = new Foo()`. The initialiser states it.
 * - `factory` — `var foo = Bar.make()`. The type is `make`'s return type, which is known only when
 *   `Bar.make` is declared in this repository. Resolution decides; the extractor records the call.
 *
 * A local whose type is none of these — a lambda parameter, a loop variable over an inferred
 * element type — yields no fact, so binding through it correctly fails rather than guessing.
 */
export interface LocalVariableFact {
  /** The method, constructor or initialiser the local lives in. */
  readonly ownerId: NodeId;
  readonly name: string;
  /** The declared type's root name, or `null` for `var`. */
  readonly declaredTypeName: string | null;
  /** The type named by a `new T(...)` initialiser, or `null`. */
  readonly constructedTypeName: string | null;
  /** A `Root.member(...)` initialiser, whose return type is the local's type. */
  readonly factory: { readonly rootName: string; readonly memberName: string } | null;
  readonly location: SourceRange;
}

/**
 * A method's declared return type, so a factory call's result has a type.
 *
 * Recorded apart from `TypeReferenceFact` even though the return type is also one of those: a type
 * reference says "this declaration names that type" and carries no role, so a method with a
 * parameter and a return type produces two indistinguishable facts. Which one is the *return* type
 * is the only thing a factory inference can use.
 */
export interface MethodReturnFact {
  readonly declarationId: NodeId;
  /** The return type's root name. `null` is not recorded — a void method yields no fact. */
  readonly typeName: string;
}

export interface CompilationUnitFacts {
  /** The `package` declaration's dotted name, or `null` for the default package. */
  readonly packageName: string | null;
  readonly declarations: readonly DeclarationIR[];
  readonly imports: readonly ImportIR[];
  readonly callSites: readonly CallSiteIR[];
  readonly heritage: readonly HeritageFact[];
  readonly annotations: readonly AnnotationFact[];
  readonly typeReferences: readonly TypeReferenceFact[];
  readonly localVariables: readonly LocalVariableFact[];
  readonly methodReturns: readonly MethodReturnFact[];
}

const NO_MODIFIERS = {
  isExported: false,
  isStatic: false,
  isAbstract: false,
  isReadonly: false,
  isOptional: false,
  isAsync: false,
} as const;

/** The five things Java declares that can contain members. */
const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

/**
 * Reads one Java compilation unit.
 *
 * **One pass, and only what the syntax establishes.** Java is statically typed, which makes it
 * tempting to resolve more than a parser can justify — but nothing here has a classpath, so a type
 * named in a signature is a *name*, not a proven target. Every fact recorded is one a reader could
 * confirm by looking at this file alone; binding across files is `resolve.ts`, and it says which of
 * its answers are proven and which are read from a name.
 *
 * The container chain is the addressable path within the file — `OuterClass.Inner.method` — and
 * deliberately *not* the fully-qualified name. The identifier already contains the file path, and a
 * package prefix would repeat what the path says while breaking the moment a file moved.
 *
 * Overloads fold onto one declaration, as they must: `symbolId` is a symbol path with no room for a
 * signature, so three `of(...)` methods share one identifier. `DeclarationCollector` is the shared
 * rule for that, the same one TypeScript and Python use.
 */
export function extractCompilationUnit(input: {
  readonly repoRelativePath: string;
  readonly root: SyntaxNode;
}): CompilationUnitFacts {
  const file = fileId(input.repoRelativePath);
  const collector = new DeclarationCollector();
  /** Kind by identifier, first site winning, so "is this chain a type?" is a lookup not a scan. */
  const kindById = new Map<NodeId, DeclarationIR['kind']>();

  const imports: ImportIR[] = [];
  const callSites: CallSiteIR[] = [];
  const heritage: HeritageFact[] = [];
  const annotations: AnnotationFact[] = [];
  const typeReferences: TypeReferenceFact[] = [];
  const localVariables: LocalVariableFact[] = [];
  const methodReturns: MethodReturnFact[] = [];

  let packageName: string | null = null;

  const add = (input2: {
    readonly chain: readonly string[];
    readonly kind: DeclarationIR['kind'];
    readonly name: string;
    readonly node: SyntaxNode;
    readonly visibility: DeclarationIR['visibility'];
    readonly modifiers: DeclarationIR['modifiers'];
  }): NodeId => {
    const { id } = collector.add({
      repoRelativePath: input.repoRelativePath,
      fileId: file,
      kind: input2.kind,
      name: input2.name,
      containerChain: input2.chain,
      visibility: input2.visibility,
      modifiers: input2.modifiers,
      locations: [rangeOf(input2.node)],
    });

    if (!kindById.has(id)) {
      kindById.set(id, input2.kind);
    }

    return id;
  };

  /**
   * Walks a node, attributing everything inside it to `owner`.
   *
   * `chain` is where a new declaration would sit; `owner` is the declaration a call or a type
   * reference belongs to. They differ for a body: a method's statements are owned by the method, but
   * a class declared inside that body would nest under it.
   */
  const visit = (node: SyntaxNode, chain: readonly string[], owner: NodeId | null): void => {
    for (const child of children(node)) {
      if (child.type === 'package_declaration') {
        packageName = dottedNameOf(child);
        continue;
      }

      if (child.type === 'import_declaration') {
        const statement = readImport(child, file);

        if (statement !== null) {
          imports.push(statement);
        }

        continue;
      }

      if (TYPE_DECLARATIONS.has(child.type)) {
        visitType(child, chain);
        continue;
      }

      if (
        child.type === 'method_declaration' ||
        child.type === 'constructor_declaration' ||
        child.type === 'compact_constructor_declaration'
      ) {
        visitMethod(child, chain);
        continue;
      }

      if (child.type === 'field_declaration' || child.type === 'constant_declaration') {
        visitField(child, chain);
        continue;
      }

      if (child.type === 'enum_constant') {
        const name = fieldText(child, 'name');

        if (name !== null) {
          add({
            chain: [...chain, name],
            kind: 'enum-member',
            name,
            node: child,
            visibility: 'public',
            // An enum constant is implicitly `public static final`, which is worth recording because
            // it is what makes it addressable as `Colour.RED` from anywhere.
            modifiers: { ...NO_MODIFIERS, isStatic: true, isReadonly: true, isExported: true },
          });
        }

        continue;
      }

      // `Foo foo = …;` inside a body. Not a declaration — the graph models no locals, for any
      // language — but its declared type is what makes `foo.bar()` bindable.
      if (child.type === 'local_variable_declaration' && owner !== null) {
        localVariables.push(...localVariablesOf(child, owner));
      }

      // A call, a `new`, or a method reference. Recorded against whatever declaration encloses it.
      if (
        child.type === 'method_invocation' ||
        child.type === 'object_creation_expression' ||
        child.type === 'explicit_constructor_invocation'
      ) {
        const site = callSiteOf(child, file, owner);

        if (site !== null) {
          callSites.push(site);
        }
      }

      visit(child, chain, owner);
    }
  };

  const visitType = (node: SyntaxNode, chain: readonly string[]): void => {
    const name = fieldText(node, 'name');

    if (name === null) {
      return;
    }

    const modifiers = modifiersOf(node);
    const nextChain = [...chain, name];
    const id = add({
      chain: nextChain,
      kind: kindOfType(node.type),
      name,
      node,
      visibility: visibilityOf(node),
      modifiers,
    });

    for (const annotation of annotationsOf(node)) {
      annotations.push({ declarationId: id, ...annotation });
    }

    // `extends` and `implements`, kept apart because they mean different things: a class may extend
    // one class and implement many interfaces, and IMPLEMENTS is a distinct relationship type.
    for (const clause of heritageOf(node)) {
      heritage.push({ declarationId: id, ...clause });
    }

    // A supertype's generic arguments are *references*, not supertypes. `implements Formatter<PetType>`
    // means this type implements `Formatter`; `PetType` is merely named. Recording it as heritage said
    // the class implements `PetType`, which the graph rejected — correctly, and it cost the whole
    // repository its Java analysis until the two were told apart.
    for (const clause of heritageArgumentsOf(node)) {
      typeReferences.push({ declarationId: id, ...clause });
    }

    // A record's header parameters are its fields, and they are the record's whole public shape.
    const parameters = fieldNode(node, 'parameters');

    if (node.type === 'record_declaration' && parameters !== null) {
      for (const parameter of childrenOfType(parameters, 'formal_parameter')) {
        const parameterName = fieldText(parameter, 'name');

        if (parameterName === null) {
          continue;
        }

        const fieldIdentity = add({
          chain: [...nextChain, parameterName],
          kind: 'property',
          name: parameterName,
          node: parameter,
          visibility: 'private',
          modifiers: { ...NO_MODIFIERS, isReadonly: true },
        });

        recordTypeReference(fieldIdentity, fieldNode(parameter, 'type'));
      }
    }

    const body = fieldNode(node, 'body');

    if (body !== null) {
      visit(body, nextChain, id);
    }
  };

  const visitMethod = (node: SyntaxNode, chain: readonly string[]): void => {
    const isConstructor =
      node.type === 'constructor_declaration' || node.type === 'compact_constructor_declaration';
    const name = fieldText(node, 'name');

    if (name === null) {
      return;
    }

    const modifiers = modifiersOf(node);
    const id = add({
      chain: [...chain, name],
      kind: isConstructor ? 'constructor' : 'method',
      name,
      node,
      visibility: visibilityOf(node),
      modifiers,
    });

    for (const annotation of annotationsOf(node)) {
      annotations.push({ declarationId: id, ...annotation });
    }

    // The return type and every parameter type. These are what make a Java graph useful — a service's
    // dependencies are visible in its constructor signature long before any call is bound.
    const returnTypeNode = fieldNode(node, 'type');

    recordTypeReference(id, returnTypeNode);

    // A constructor's "return type" is its own class, which the construction rule already knows. Only
    // a method's is worth recording, and only when it names a type rather than `void`.
    if (!isConstructor && returnTypeNode !== null) {
      const returned = typeNamesOf(returnTypeNode)[0];

      if (returned !== undefined) {
        methodReturns.push({ declarationId: id, typeName: returned.rootName });
      }
    }

    const parameters = fieldNode(node, 'parameters');

    if (parameters !== null) {
      for (const parameter of children(parameters)) {
        if (parameter.type === 'formal_parameter' || parameter.type === 'spread_parameter') {
          recordTypeReference(id, fieldNode(parameter, 'type'));
        }
      }
    }

    const body = fieldNode(node, 'body');

    if (body !== null) {
      // Owned by the method: a statement's calls belong to it, not to the enclosing class. The chain
      // stays the method's, so a class declared in the body nests correctly.
      visit(body, [...chain, name], id);
    }

  };

  const visitField = (node: SyntaxNode, chain: readonly string[]): void => {
    const modifiers = modifiersOf(node);
    const visibility = visibilityOf(node);
    const typeNode = fieldNode(node, 'type');

    // One `field_declaration` may declare several fields: `private int a, b;`. Each is addressable,
    // so each is a declaration.
    for (const declarator of childrenOfType(node, 'variable_declarator')) {
      const name = fieldText(declarator, 'name');

      if (name === null) {
        continue;
      }

      const id = add({
        chain: [...chain, name],
        kind: 'property',
        name,
        node: declarator,
        visibility,
        modifiers,
      });

      for (const annotation of annotationsOf(node)) {
        annotations.push({ declarationId: id, ...annotation });
      }

      recordTypeReference(id, typeNode);

      // An initialiser can call things: `private final Foo foo = new Foo();`.
      const value = fieldNode(declarator, 'value');

      if (value !== null) {
        visit(value, chain, id);
      }
    }

  };

  function recordTypeReference(declarationId: NodeId, typeNode: SyntaxNode | null): void {
    if (typeNode === null) {
      return;
    }

    // A primitive is not a declaration anywhere and never will be, so recording it would add an
    // unresolvable reference per `int`.
    if (typeNode.type === 'integral_type' || typeNode.type === 'floating_point_type') {
      return;
    }

    if (typeNode.type === 'boolean_type' || typeNode.type === 'void_type') {
      return;
    }

    // `List<Foo>` names both `List` and `Foo`; the argument is recorded too, because a repository's
    // own type inside a collection is exactly the edge a reader wants.
    for (const named of typeNamesOf(typeNode)) {
      typeReferences.push({
        declarationId,
        rootName: named.rootName,
        text: named.text,
        location: rangeOf(typeNode),
      });
    }
  }

  visit(input.root, [], null);

  return {
    packageName,
    declarations: collector.toArray(),
    imports,
    callSites,
    heritage,
    annotations,
    typeReferences,
    localVariables,
    methodReturns,
  };
}

/**
 * Reads one `local_variable_declaration` into a fact per name it declares.
 *
 * `int a = 1, b = 2;` declares two, and each gets its own entry — the same rule `visitField`
 * applies to `private int a, b;`, because both are one statement declaring several things.
 *
 * A primitive or `void` type yields `declaredTypeName: null` rather than `"int"`: no repository
 * declares `int`, so recording it would produce a lookup that always fails, and it must not be
 * confused with `var`, whose type genuinely comes from the initialiser.
 */
function localVariablesOf(node: SyntaxNode, ownerId: NodeId): readonly LocalVariableFact[] {
  const typeNode = fieldNode(node, 'type');
  const named =
    typeNode === null || isPrimitiveTypeNode(typeNode) ? null : (typeNamesOf(typeNode)[0]?.rootName ?? null);
  // `var` is spelled as a type identifier but names no type. Left `null` so the initialiser rules
  // below decide, rather than resolving a type called "var" that no repository declares.
  const declaredTypeName = named === 'var' ? null : named;

  const found: LocalVariableFact[] = [];

  for (const declarator of childrenOfType(node, 'variable_declarator')) {
    const name = fieldText(declarator, 'name');

    if (name === null) {
      continue;
    }

    const value = fieldNode(declarator, 'value');

    found.push({
      ownerId,
      name,
      declaredTypeName,
      constructedTypeName:
        value !== null && value.type === 'object_creation_expression'
          ? (typeNamesOf(fieldNode(value, 'type') ?? value)[0]?.rootName ?? null)
          : null,
      factory: value === null ? null : factoryCallOf(value),
      location: rangeOf(declarator),
    });
  }

  return found;
}

/** A `Root.member(...)` initialiser, whose declared return type is the local's type. */
function factoryCallOf(
  value: SyntaxNode,
): { readonly rootName: string; readonly memberName: string } | null {
  if (value.type !== 'method_invocation') {
    return null;
  }

  const object = fieldNode(value, 'object');
  const memberName = fieldText(value, 'name');

  if (object === null || memberName === null) {
    return null;
  }

  // Only a simple `Root.member()`. A chained receiver would need the type of the chain, which is the
  // very thing this inference is trying to establish, and following it would recurse without a base.
  const rootName = object.type === 'identifier' ? object.text : null;

  return rootName === null ? null : { rootName, memberName };
}

function isPrimitiveTypeNode(node: SyntaxNode): boolean {
  return (
    node.type === 'integral_type' ||
    node.type === 'floating_point_type' ||
    node.type === 'boolean_type' ||
    node.type === 'void_type'
  );
}

/** Kinds, mapped onto the IR's language-independent vocabulary. */
function kindOfType(nodeType: string): DeclarationIR['kind'] {
  switch (nodeType) {
    case 'interface_declaration':
      return 'interface';

    // An `@interface` *is* an interface — `@interface Tag` declares one, and a type may implement it.
    // Calling it a class made `class X implements Tag` an IMPLEMENTS edge onto a Class, which the graph
    // rejected and which cost Apache Commons Lang its entire Java analysis.
    case 'annotation_type_declaration':
      return 'interface';

    case 'enum_declaration':
      return 'enum';

    // A record is a final class with a generated constructor and accessors. `class` is the honest
    // label: the IR has no `record`, and inventing one would mean every consumer had to learn it.
    default:
      return 'class';
  }
}

function visibilityOf(node: SyntaxNode): DeclarationIR['visibility'] {
  const text = modifierTextOf(node);

  if (text.includes('public')) {
    return 'public';
  }

  if (text.includes('protected')) {
    return 'protected';
  }

  if (text.includes('private')) {
    return 'private';
  }

  // Package-private, which Java spells by saying nothing. `null` rather than `public`: the graph's
  // three levels have no word for it, and calling it public would overstate its reach.
  return null;
}

function modifiersOf(node: SyntaxNode): DeclarationIR['modifiers'] {
  const text = modifierTextOf(node);

  return {
    // `public` is Java's nearest equivalent to an export: it is what makes a declaration reachable
    // from another package.
    isExported: text.includes('public'),
    isStatic: text.includes('static'),
    isAbstract: text.includes('abstract'),
    isReadonly: text.includes('final'),
    isOptional: false,
    // Java has no `async` keyword. Recording one would invent a construct the language lacks.
    isAsync: false,
  };
}

function modifierTextOf(node: SyntaxNode): readonly string[] {
  const modifiers = children(node).find((child) => child.type === 'modifiers');

  if (modifiers === undefined) {
    return [];
  }

  // Annotation text is excluded so `@interface`-style names cannot be mistaken for keywords, and so
  // an annotation called `Static` never marks a declaration static.
  return children(modifiers)
    .filter((child: SyntaxNode) => !child.type.includes('annotation'))
    .map((child: SyntaxNode) => child.text)
    .concat(
      modifiers.text
        .split(/\s+/)
        .filter((word: string) => !word.startsWith('@'))
        .map((word: string) => word.trim()),
    );
}

function annotationsOf(node: SyntaxNode): readonly Omit<AnnotationFact, 'declarationId'>[] {
  const modifiers = children(node).find((child) => child.type === 'modifiers');

  if (modifiers === undefined) {
    return [];
  }

  const found: Omit<AnnotationFact, 'declarationId'>[] = [];

  for (const child of children(modifiers)) {
    if (child.type !== 'annotation' && child.type !== 'marker_annotation') {
      continue;
    }

    const name = fieldText(child, 'name');

    if (name === null) {
      continue;
    }

    found.push({
      // `@org.springframework.web.bind.annotation.GetMapping` and `@GetMapping` name the same thing.
      // The simple name is what a framework reader matches on, so the qualification is dropped here
      // rather than in every consumer.
      name: name.split('.').at(-1) as string,
      text: child.text,
      location: rangeOf(child),
    });
  }

  return found;
}

function heritageOf(node: SyntaxNode): readonly Omit<HeritageFact, 'declarationId'>[] {
  const found: Omit<HeritageFact, 'declarationId'>[] = [];

  const record = (target: SyntaxNode, kind: HeritageFact['kind']): void => {
    // The *outermost* name only. See `heritageArgumentsOf` for why the arguments are not supertypes.
    const root = leftmostIdentifier(target);

    if (root !== null) {
      found.push({ kind, text: target.text, rootName: root, location: rangeOf(target) });
    }
  };

  for (const child of children(node)) {
    // `class A extends B` — the superclass field, or a `superclass` node wrapping it.
    if (child.type === 'superclass') {
      for (const target of children(child)) {
        record(target, 'extends');
      }

      continue;
    }

    // `class A implements B, C` and `interface A extends B, C`. The grammar calls both of these
    // `super_interfaces` / `extends_interfaces`, and an interface extending an interface *is* an
    // implements-shaped relationship in the graph's vocabulary — but EXTENDS is the truer word for
    // what the source says, so the node type decides rather than the declaration's kind.
    if (child.type === 'super_interfaces') {
      for (const list of children(child)) {
        for (const target of children(list)) {
          record(target, 'implements');
        }
      }

      continue;
    }

    if (child.type === 'extends_interfaces') {
      for (const list of children(child)) {
        for (const target of children(list)) {
          record(target, 'extends');
        }
      }

      continue;
    }

    if (child.type === 'permits') {
      // A `permits` clause names subclasses rather than supertypes. Recording it as heritage would
      // point the edge the wrong way, so it is skipped.
      continue;
    }
  }

  return found;
}

/**
 * Every type name inside a type node, outermost first.
 *
 * `Map<String, List<Foo>>` yields `Map`, `String`, `List` and `Foo`. All four are real references
 * that a reader would expect to follow, and dropping the arguments would hide a repository's own
 * types wherever they appear inside a collection — which in Java is nearly everywhere.
 */
function typeNamesOf(node: SyntaxNode): readonly { readonly rootName: string; readonly text: string }[] {
  const found: { rootName: string; text: string }[] = [];

  const walk = (current: SyntaxNode): void => {
    if (
      current.type === 'type_identifier' ||
      current.type === 'scoped_type_identifier' ||
      current.type === 'generic_type'
    ) {
      const root = leftmostIdentifier(current);

      if (root !== null) {
        found.push({ rootName: root, text: current.text });
      }
    }

    for (const child of children(current)) {
      // A wildcard `?` and a primitive carry nothing to bind.
      walk(child);
    }
  };

  walk(node);

  // Deduplicated by name so `Map<String, String>` records `String` once: it is one reference to one
  // type, not two facts.
  const seen = new Set<string>();

  return found.filter((entry) => {
    if (seen.has(entry.rootName)) {
      return false;
    }

    seen.add(entry.rootName);

    return true;
  });
}

/**
 * Reads an `import` statement.
 *
 * Java's four forms, each mapped to the binding kind that says what it actually binds:
 *
 * ```java
 * import java.util.List;              // named: one type
 * import java.util.*;                 // namespace: a whole package
 * import static java.util.Map.entry;  // named: one static member
 * import static java.util.Map.*;      // namespace: a type's static members
 * ```
 *
 * The specifier is the dotted text as written, exactly as every other analyser records it — turning it
 * into a file is resolution and belongs to `resolve.ts`.
 */
function readImport(node: SyntaxNode, file: NodeId): ImportIR | null {
  const dotted = dottedNameOf(node);

  if (dotted === null) {
    return null;
  }

  const isWildcard = node.text.includes('*');
  const segments = dotted.split('.').filter((segment) => segment.length > 0);
  const last = segments.at(-1);

  if (isWildcard || last === undefined) {
    return {
      fileId: file,
      moduleSpecifier: dotted,
      isTypeOnly: false,
      // A wildcard binds no name a reader can point at; it makes a whole package's names available.
      bindings: [{ kind: 'namespace', importedName: null, localName: dotted, isTypeOnly: false }],
      location: rangeOf(node),
    };
  }

  return {
    fileId: file,
    moduleSpecifier: dotted,
    isTypeOnly: false,
    bindings: [{ kind: 'named', importedName: last, localName: last, isTypeOnly: false }],
    location: rangeOf(node),
  };
}

/** The dotted name a `package` or `import` node states, ignoring keywords and the semicolon. */
function dottedNameOf(node: SyntaxNode): string | null {
  const parts = children(node)
    .filter((child) => child.type === 'identifier' || child.type === 'scoped_identifier')
    .map((child) => child.text);

  const dotted = parts.at(-1) ?? null;

  return dotted === null || dotted.length === 0 ? null : dotted;
}

/**
 * A call site, in the IR's language-independent shape.
 *
 * Three Java forms become one: `foo.bar()`, `new Foo()` and `super(...)`. All three transfer control
 * to a declaration, which is what a call graph is for.
 */
function callSiteOf(node: SyntaxNode, file: NodeId, owner: NodeId | null): CallSiteIR | null {
  if (node.type === 'object_creation_expression') {
    const typeNode = fieldNode(node, 'type');
    const root = typeNode === null ? null : leftmostIdentifier(typeNode);

    if (root === null) {
      return null;
    }

    return {
      fileId: file,
      enclosingDeclarationId: owner,
      // A constructor is addressed by the type's own name, which is what the source writes and what
      // the binder looks up.
      calleeText: `new ${typeNode?.text ?? root}`,
      calleeRootName: root,
      calleeMemberName: null,
      arguments: [],
      location: rangeOf(node),
      isConstruction: true,
    };
  }

  if (node.type === 'explicit_constructor_invocation') {
    // `super(...)` and `this(...)`. The root is the keyword, which the binder resolves against the
    // enclosing class's heritage rather than against a name in scope.
    const constructor = fieldNode(node, 'constructor');
    const root = constructor?.text ?? null;

    if (root === null) {
      return null;
    }

    return {
      fileId: file,
      enclosingDeclarationId: owner,
      calleeText: node.text.split('(')[0] ?? root,
      calleeRootName: root,
      calleeMemberName: null,
      arguments: [],
      location: rangeOf(node),
      isConstruction: false,
    };
  }

  const name = fieldText(node, 'name');
  const object = fieldNode(node, 'object');

  if (name === null) {
    return null;
  }

  // A bare `helper()` has no object: the receiver is `this` or the enclosing class, which the binder
  // decides. A qualified `svc.run()` has both.
  //
  // `this` and `super` are keywords rather than identifiers, so `leftmostIdentifier` returns null for
  // them and every `this.save()` in the repository was reported `callee-not-addressable` — a call
  // with the *most* determinable receiver in the language, filed under having no name to bind. The
  // resolver has always had rules for both roots; nothing ever reached them.
  const root =
    object === null
      ? name
      : object.type === 'this' || object.type === 'super'
        ? object.type
        : leftmostIdentifier(object);

  return {
    fileId: file,
    enclosingDeclarationId: owner,
    calleeText: object === null ? name : `${object.text}.${name}`,
    calleeRootName: root,
    calleeMemberName: object === null ? null : name,
    arguments: [],
    location: rangeOf(node),
    isConstruction: false,
  };
}

/** Exposed for the resolver, which needs the same notion of "the name a clause is rooted at". */
export { symbolId };

/**
 * The generic arguments of a heritage clause, as type references rather than supertypes.
 *
 * `class Repo implements CrudRepository<Owner, Integer>` implements one interface and names two other
 * types. Both facts matter — `Owner` appearing in a supertype's arguments is a real reference a reader
 * would follow — but they are different facts, and recording the arguments as heritage claimed the
 * class implemented `Owner`.
 */
function heritageArgumentsOf(
  node: SyntaxNode,
): readonly Omit<TypeReferenceFact, 'declarationId'>[] {
  const found: Omit<TypeReferenceFact, 'declarationId'>[] = [];

  const collectFrom = (target: SyntaxNode): void => {
    const outermost = leftmostIdentifier(target);

    for (const named of typeNamesOf(target)) {
      if (named.rootName === outermost) {
        continue;
      }

      found.push({ rootName: named.rootName, text: named.text, location: rangeOf(target) });
    }
  };

  for (const child of children(node)) {
    if (
      child.type === 'superclass' ||
      child.type === 'super_interfaces' ||
      child.type === 'extends_interfaces'
    ) {
      for (const nested of children(child)) {
        if (nested.type === 'type_list') {
          for (const target of children(nested)) {
            collectFrom(target);
          }
        } else {
          collectFrom(nested);
        }
      }
    }
  }

  return found;
}
