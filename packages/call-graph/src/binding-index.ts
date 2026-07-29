import type { RepositoryIR } from '@traceiq/ir';
import type { ResolvedRepository } from '@traceiq/resolver';
import type { NodeId } from '@traceiq/types';

/**
 * Everything needed to bind a callee name, indexed once.
 *
 * Built in a single pass over the IR and the resolved relationships, so binding a call
 * site is a handful of constant-time lookups rather than a search. That is what keeps the
 * whole stage linear in the number of call sites.
 */
export interface BindingIndex {
  /**
   * Every declaration by `<fileId>#<dotted chain>`.
   *
   * Keyed by full chain rather than by name so a lookup can walk outwards through nesting,
   * which is how a call inside a nested function finds a sibling before a file-level name.
   */
  readonly declarationByPath: ReadonlyMap<string, NodeId>;
  /** Each declaration's chain and file, for walking outwards from a call. */
  readonly chainOf: ReadonlyMap<NodeId, readonly string[]>;
  readonly fileOf: ReadonlyMap<NodeId, NodeId>;
  /** Members, by `<ownerDeclarationId>#<name>`. */
  readonly members: ReadonlyMap<string, NodeId>;
  /** Import bindings that resolved to a declaration, by `<fileId>#<localName>`. */
  readonly importedDeclarations: ReadonlyMap<string, NodeId>;
  /** Namespace import bindings, by `<fileId>#<localName>`, mapping to the module's file. */
  readonly importedModules: ReadonlyMap<string, NodeId>;
  /** A module's exported declarations, by `<fileId>#<exportedName>`. */
  readonly moduleExports: ReadonlyMap<string, NodeId>;
  /**
   * Import bindings that name something outside the analysed set, by
   * `<fileId>#<localName>`.
   *
   * Held so that calling `path.join` or `expect` is explained as leaving the repository
   * rather than reported as a name nothing could bind.
   */
  readonly importedExternals: ReadonlySet<string>;
  /** The declaration containing each declaration, where it has one. */
  readonly containerOf: ReadonlyMap<NodeId, NodeId>;
  /** Every declaration's kind, used to tell a container from a value. */
  readonly kindOf: ReadonlyMap<NodeId, string>;
}

/**
 * Kinds that own members a call can name.
 *
 * A `Variable` or `Function` root is deliberately absent: `svc.run()` needs the *type* of
 * `svc`, which this stage has no way to determine. Treating it as a container would report
 * a missing member when the real problem is a missing type.
 */
export const MEMBER_OWNER_KINDS: readonly string[] = [
  'class',
  'interface',
  'enum',
  'namespace',
];

export function key(scope: string, name: string): string {
  return `${scope}#${name}`;
}

export function buildBindingIndex(input: {
  readonly ir: RepositoryIR;
  readonly resolved: ResolvedRepository;
}): BindingIndex {
  const declarationByPath = new Map<string, NodeId>();
  const chainOf = new Map<NodeId, readonly string[]>();
  const fileOf = new Map<NodeId, NodeId>();
  const members = new Map<string, NodeId>();
  const containerOf = new Map<NodeId, NodeId>();
  const kindOf = new Map<NodeId, string>();

  for (const declaration of input.ir.declarations) {
    const chain = declaration.containerChain;
    const name = chain.at(-1);

    if (name === undefined) {
      continue;
    }

    kindOf.set(declaration.id, declaration.kind);
    chainOf.set(declaration.id, chain);
    fileOf.set(declaration.id, declaration.fileId);
    declarationByPath.set(key(declaration.fileId, chain.join('.')), declaration.id);

    if (chain.length === 1) {
      continue;
    }

    // A member's owner is its chain minus the last segment, which is exactly the
    // identifier the IR would have issued for that container.
    const ownerId = `sym:${pathOf(declaration.fileId)}#${chain.slice(0, -1).join('.')}` as NodeId;

    members.set(key(ownerId, name), declaration.id);
    containerOf.set(declaration.id, ownerId);
  }

  const importedDeclarations = new Map<string, NodeId>();
  const importedModules = new Map<string, NodeId>();
  const moduleExports = new Map<string, NodeId>();
  const importedExternals = new Set<string>();

  // Two signals, because neither alone is complete. A bare or `node:` specifier is
  // external by syntax, which holds even when the package is not installed and the
  // Resolver could bind nothing. A relative specifier resolving to an external target
  // catches the rest — declaration output outside the analysed set, for instance.
  for (const statement of input.ir.imports) {
    if (isExternalSpecifier(statement.moduleSpecifier)) {
      for (const binding of statement.bindings) {
        importedExternals.add(key(statement.fileId, binding.localName));
      }
    }
  }

  for (const relationship of input.resolved.relationships) {
    const { name, target } = relationship;

    if (name === null) {
      continue;
    }

    const fileId = relationship.provenance.fileId;

    if (relationship.type === 'IMPORTS') {
      // A named import resolves to a declaration; a namespace import resolves to the
      // module itself. The Resolver already made that distinction.
      if (target.kind === 'declaration') {
        importedDeclarations.set(key(fileId, name), target.declarationId);
      } else if (target.kind === 'file') {
        importedModules.set(key(fileId, name), target.fileId);
      } else if (target.kind === 'external') {
        importedExternals.add(key(fileId, name));
      }

      continue;
    }

    if (relationship.type === 'EXPORTS' && target.kind === 'declaration') {
      moduleExports.set(key(fileId, name), target.declarationId);
    }
  }

  return {
    declarationByPath,
    chainOf,
    fileOf,
    members,
    importedDeclarations,
    importedModules,
    moduleExports,
    importedExternals,
    containerOf,
    kindOf,
  };
}

/**
 * Finds the declaration a name refers to, walking outwards through nesting.
 *
 * A call inside `outer.deeper` sees `outer.deeper.name`, then `outer.name`, then a
 * file-level `name` — which is how JavaScript scoping reads, approximated without a
 * checker. Shadowing by a parameter or a block-scoped value it cannot see is exactly why
 * every binding is `INFERRED`.
 */
export function lookupScoped(
  index: BindingIndex,
  fileId: NodeId,
  chain: readonly string[],
  name: string,
): NodeId | undefined {
  for (let depth = chain.length; depth >= 0; depth -= 1) {
    const found = index.declarationByPath.get(key(fileId, [...chain.slice(0, depth), name].join('.')));

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/** A specifier naming a package or a Node builtin rather than a file in this repository. */
function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** `file:src/a.ts` → `src/a.ts`. The prefix is fixed by the contract. */
function pathOf(fileId: NodeId): string {
  return fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
}
