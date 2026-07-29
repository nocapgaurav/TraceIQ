import type { NodeId } from '@traceiq/types';
import {
  ModuleDeclarationKind,
  Node,
  type ClassDeclaration,
  type EnumDeclaration,
  type InterfaceDeclaration,
  type ModuleDeclaration,
  type SourceFile,
  type VariableStatement,
} from 'ts-morph';

import { isAddressableName } from './addressable-name.js';
import { nestedFunctionOf, nestedVariableOf } from './nested-declaration-extractor.js';
import type { DeclarationCollector } from './declaration-collector.js';
import { modifiers, visibilityOf } from './modifiers.js';
import { sourceRangeOf } from './source-range.js';
import type {
  DeclarationKind,
  DeclarationModifiers,
  ExportIR,
  Visibility,
} from './types.js';

export interface ExtractionSink {
  readonly declarations: DeclarationCollector;
  /** Exports written as a modifier on a top-level declaration. */
  readonly inlineExports: ExportIR[];
  /**
   * Every declaration node recorded, mapped to its identifier.
   *
   * Expression extraction uses this to attribute a call or access to the declaration
   * containing it, without restating which nodes the IR chose to record.
   */
  readonly declarationIdByNode: Map<Node, NodeId>;
}

interface ExtractionContext {
  readonly fileId: NodeId;
  readonly repoRelativePath: string;
  readonly sink: ExtractionSink;
}

interface DeclarationDetails {
  readonly visibility: Visibility | null;
  readonly modifiers: DeclarationModifiers;
  /** Only classes and functions can carry `export default` inline. */
  readonly isDefaultExport?: boolean;
}

/** A node that can hold statements: a file, or a namespace body. */
type StatementedContainer = SourceFile | ModuleDeclaration;

/**
 * Walks a file's structural declarations.
 *
 * Traversal is over statements and class, interface, enum and namespace members,
 * in source order. It deliberately does not enter function bodies: a declaration
 * local to a function is not part of the repository's structure, and including
 * locals would multiply the IR for no consumer's benefit.
 *
 * Overload signatures need no special handling. Each appears as its own statement
 * or member and resolves to the same symbol path, so the collector folds them into
 * one declaration with several locations.
 */
export function extractDeclarations(input: {
  readonly file: SourceFile;
  readonly fileId: NodeId;
  readonly repoRelativePath: string;
  readonly sink: ExtractionSink;
}): void {
  extractStatements(input.file, [], {
    fileId: input.fileId,
    repoRelativePath: input.repoRelativePath,
    sink: input.sink,
  });
}

function extractStatements(
  container: StatementedContainer,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  for (const statement of container.getStatements()) {
    if (Node.isClassDeclaration(statement)) {
      extractClass(statement, chain, context);
    } else if (Node.isInterfaceDeclaration(statement)) {
      extractInterface(statement, chain, context);
    } else if (Node.isEnumDeclaration(statement)) {
      extractEnum(statement, chain, context);
    } else if (Node.isModuleDeclaration(statement)) {
      extractNamespace(statement, chain, context);
    } else if (Node.isTypeAliasDeclaration(statement)) {
      record([statement.getName()], 'type-alias', statement, chain, context, {
        visibility: null,
        modifiers: modifiers({ isExported: statement.isExported() }),
      });
    } else if (Node.isFunctionDeclaration(statement)) {
      const name = nameOrDefault(statement.getName(), statement.isDefaultExport());

      if (name !== null) {
        const functionChain = record([name], 'function', statement, chain, context, {
          visibility: null,
          modifiers: modifiers({
            isExported: statement.isExported(),
            isAsync: statement.isAsync(),
          }),
          isDefaultExport: statement.isDefaultExport(),
        });

        if (functionChain !== null) {
          extractBody(statement.getBody() ?? null, functionChain, context);
        }
      }
    } else if (Node.isVariableStatement(statement)) {
      extractVariables(statement, chain, context);
    }
  }
}

function extractClass(
  declaration: ClassDeclaration,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  const name = nameOrDefault(declaration.getName(), declaration.isDefaultExport());

  if (name === null) {
    return;
  }

  const classChain = record([name], 'class', declaration, chain, context, {
    visibility: null,
    modifiers: modifiers({
      isExported: declaration.isExported(),
      isAbstract: declaration.isAbstract(),
    }),
    isDefaultExport: declaration.isDefaultExport(),
  });

  if (classChain === null) {
    return;
  }

  for (const member of declaration.getMembers()) {
    if (Node.isConstructorDeclaration(member)) {
      const constructorChain = record(['constructor'], 'constructor', member, classChain, context, {
        visibility: visibilityOf(member.getScope(), 'constructor'),
        modifiers: modifiers(),
      });

      if (constructorChain !== null) {
        extractBody(member.getBody() ?? null, constructorChain, context);
      }
    } else if (Node.isMethodDeclaration(member)) {
      const memberName = member.getName();

      const methodChain = record([memberName], 'method', member, classChain, context, {
        visibility: visibilityOf(member.getScope(), memberName),
        modifiers: modifiers({
          isStatic: member.isStatic(),
          isAbstract: member.isAbstract(),
          isAsync: member.isAsync(),
          isOptional: member.hasQuestionToken(),
        }),
      });

      if (methodChain !== null) {
        extractBody(member.getBody() ?? null, methodChain, context);
      }
    } else if (Node.isPropertyDeclaration(member)) {
      const memberName = member.getName();

      record([memberName], 'property', member, classChain, context, {
        visibility: visibilityOf(member.getScope(), memberName),
        modifiers: modifiers({
          isStatic: member.isStatic(),
          isAbstract: member.isAbstract(),
          isReadonly: member.isReadonly(),
          isOptional: member.hasQuestionToken(),
        }),
      });
    } else if (Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
      const memberName = member.getName();

      const accessorChain = record([memberName], 'accessor', member, classChain, context, {
        visibility: visibilityOf(member.getScope(), memberName),
        modifiers: modifiers({
          isStatic: member.isStatic(),
          isAbstract: member.isAbstract(),
        }),
      });

      if (accessorChain !== null) {
        extractBody(member.getBody() ?? null, accessorChain, context);
      }
    }
  }
}

function extractInterface(
  declaration: InterfaceDeclaration,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  const interfaceChain = record(
    [declaration.getName()],
    'interface',
    declaration,
    chain,
    context,
    {
      visibility: null,
      modifiers: modifiers({ isExported: declaration.isExported() }),
    },
  );

  if (interfaceChain === null) {
    return;
  }

  for (const member of declaration.getMembers()) {
    // An interface has no visibility modifiers, so visibility is not applicable
    // rather than public.
    if (Node.isMethodSignature(member)) {
      record([member.getName()], 'method', member, interfaceChain, context, {
        visibility: null,
        modifiers: modifiers({ isOptional: member.hasQuestionToken() }),
      });
    } else if (Node.isPropertySignature(member)) {
      record([member.getName()], 'property', member, interfaceChain, context, {
        visibility: null,
        modifiers: modifiers({
          isReadonly: member.isReadonly(),
          isOptional: member.hasQuestionToken(),
        }),
      });
    }
  }
}

function extractEnum(
  declaration: EnumDeclaration,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  const enumChain = record([declaration.getName()], 'enum', declaration, chain, context, {
    visibility: null,
    modifiers: modifiers({ isExported: declaration.isExported() }),
  });

  if (enumChain === null) {
    return;
  }

  for (const member of declaration.getMembers()) {
    record([member.getName()], 'enum-member', member, enumChain, context, {
      visibility: null,
      modifiers: modifiers(),
    });
  }
}

/**
 * Extracts a namespace and its contents.
 *
 * Only `namespace` declarations are entered. An ambient `declare module 'x'`
 * block or a `declare global` augmentation describes an external or global shape
 * rather than this repository's structure, and its name — quoted, and free to
 * contain dots — is not a valid identifier chain segment.
 *
 * A dotted namespace (`namespace A.B {}`) becomes nested chain segments, which is
 * what it means. The intermediate `A` gets no declaration of its own, because the
 * source declares none.
 */
function extractNamespace(
  declaration: ModuleDeclaration,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  if (declaration.getDeclarationKind() !== ModuleDeclarationKind.Namespace) {
    return;
  }

  const namespaceChain = record(
    declaration.getName().split('.'),
    'namespace',
    declaration,
    chain,
    context,
    {
      visibility: null,
      modifiers: modifiers({ isExported: declaration.isExported() }),
    },
  );

  if (namespaceChain === null) {
    return;
  }

  extractStatements(declaration, namespaceChain, context);
}

function extractVariables(
  statement: VariableStatement,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  for (const declaration of statement.getDeclarations()) {
    const variableChain = record([declaration.getName()], 'variable', declaration, chain, context, {
      visibility: null,
      modifiers: modifiers({ isExported: statement.isExported() }),
    });

    // A variable holding a function has a body of its own, which may nest further.
    const nested = nestedVariableOf(declaration);

    if (variableChain !== null && nested !== null) {
      extractBody(nested.body, variableChain, context);
    }
  }
}

/**
 * Records the named functions declared inside a body, and descends through them.
 *
 * Declaration extraction otherwise stays out of bodies, because a local holding a value is
 * not part of a repository's structure. A local *function* is different: it is invocable, so
 * a call graph needs a declaration to point at. A local holding a constructed instance is
 * recorded for the same reason — its methods are invocable through it.
 *
 * An anonymous callback cannot be recorded: the identifier format needs a name.
 *
 * The walk skips a nested function's subtree after recursing into it explicitly, so no node
 * is visited twice regardless of how deeply functions nest.
 */
function extractBody(
  body: Node | null,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  if (body === null) {
    return;
  }

  body.forEachDescendant((node, traversal) => {
    const nestedFunction = nestedFunctionOf(node);

    if (nestedFunction !== null) {
      recordNested(nestedFunction, chain, context);
      traversal.skip();

      return;
    }

    if (!Node.isVariableDeclaration(node)) {
      return;
    }

    const nested = nestedVariableOf(node);

    if (nested === null) {
      return;
    }

    recordNested(nested, chain, context);

    // A function's body was descended into by recordNested; an instance has none, and its
    // arguments may still contain something worth recording.
    if (nested.body !== null) {
      traversal.skip();
    }
  });
}

function recordNested(
  nested: ReturnType<typeof nestedFunctionOf>,
  chain: readonly string[],
  context: ExtractionContext,
): void {
  if (nested === null || !isAddressableName(nested.name)) {
    return;
  }

  const nestedChain = record([nested.name], nested.kind, nested.node, chain, context, {
    visibility: null,
    modifiers: modifiers(),
  });

  if (nestedChain !== null) {
    extractBody(nested.body, nestedChain, context);
  }
}

/**
 * Records a declaration, returning its chain so members can nest under it, or
 * `null` when its name cannot be addressed.
 *
 * `nameSegments` is usually one name. A dotted namespace contributes several, and
 * the declared name is the last of them.
 *
 * An inline export is recorded only for a newly collected top-level declaration.
 * Emitting per site would export an overload set three times, and a merged
 * interface twice. TypeScript requires merged declarations to agree on `export`,
 * so the first site is authoritative. An `export` inside a namespace exports from
 * the namespace rather than the module, so only file top level counts.
 */
function record(
  nameSegments: readonly string[],
  kind: DeclarationKind,
  node: Node,
  chain: readonly string[],
  context: ExtractionContext,
  details: DeclarationDetails,
): readonly string[] | null {
  const name = nameSegments.at(-1);
  // The name entering the enclosing scope. Same as `name` except for a dotted
  // namespace, where `namespace A.B {}` introduces `A`.
  const outerName = nameSegments[0];

  if (name === undefined || outerName === undefined || !nameSegments.every(isAddressableName)) {
    return null;
  }

  const containerChain = [...chain, ...nameSegments];
  const location = sourceRangeOf(node);

  const collected = context.sink.declarations.add({
    repoRelativePath: context.repoRelativePath,
    fileId: context.fileId,
    kind,
    name,
    containerChain,
    visibility: details.visibility,
    modifiers: details.modifiers,
    locations: [location],
  });

  // Recorded for every site, not only the first, so an overload signature or a merged
  // interface attributes its expressions to the same declaration.
  context.sink.declarationIdByNode.set(node, collected.id);

  if (collected.isNew && chain.length === 0 && details.modifiers.isExported) {
    const isDefault = details.isDefaultExport === true;

    context.sink.inlineExports.push({
      fileId: context.fileId,
      kind: isDefault ? 'default' : 'declaration',
      exportedName: isDefault ? 'default' : outerName,
      localName: outerName,
      // A dotted namespace exports its outermost segment, which the source never
      // declares on its own, so there is no declaration to point at.
      declarationId: nameSegments.length === 1 ? collected.id : null,
      moduleSpecifier: null,
      isTypeOnly: false,
      location,
    });
  }

  return containerChain;
}

function nameOrDefault(name: string | undefined, isDefaultExport: boolean): string | null {
  if (name !== undefined) {
    return name;
  }

  // An anonymous default export still needs a stable path. TypeScript calls this
  // symbol `default`, so the IR does too.
  return isDefaultExport ? 'default' : null;
}
