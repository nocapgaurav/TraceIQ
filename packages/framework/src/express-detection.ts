import type { CallSiteIR, RepositoryIR } from '@traceiq/ir';
import type { ResolvedRepository } from '@traceiq/resolver';
import type { NodeId } from '@traceiq/types';

const EXPRESS_MODULE = 'express';

export interface ExpressFileFacts {
  /** Local names bound from the `express` module: `express`, `Router`. */
  readonly expressBindings: ReadonlySet<string>;
  /**
   * Local names holding an application or router, traced from an express binding
   * through a call in a variable initializer — `const router = Router()`.
   */
  readonly routerNames: ReadonlySet<string>;
  /**
   * True when the Resolver confirmed the specifier resolves to the express package,
   * rather than only that the text reads `'express'`.
   */
  readonly resolverConfirmed: boolean;
}

export interface ExpressFacts {
  readonly detected: boolean;
  readonly byFile: ReadonlyMap<NodeId, ExpressFileFacts>;
  /** Call sites grouped by file, built once and shared by every annotator. */
  readonly callSitesByFile: ReadonlyMap<NodeId, readonly CallSiteIR[]>;
}

/**
 * Reads what a repository says about Express, from syntax and from the Resolver's
 * module resolution.
 *
 * Express offers no base class, no decorator and no interface to key on, so the one
 * reliable anchor is the import. Binding names come from the IR, because they are
 * syntactic and always available. The Resolver then says whether the specifier actually
 * resolved to the express *package* — which distinguishes the real thing from a local
 * module that happens to be called `express`.
 *
 * A router variable is traced through a complete syntactic chain: a binding from
 * express, a call to that binding, and the variable the call initialises. That chain is
 * evidence, not proof — a later reassignment would invalidate it, and the IR records no
 * assignments. Which is why every annotation built on it is `INFERRED` and says so.
 */
export function readExpressFacts(input: {
  readonly ir: RepositoryIR;
  readonly resolved: ResolvedRepository;
}): ExpressFacts {
  const callSitesByFile = groupCallSitesByFile(input.ir);
  const bindingsByFile = new Map<NodeId, Set<string>>();

  for (const statement of input.ir.imports) {
    if (statement.moduleSpecifier !== EXPRESS_MODULE) {
      continue;
    }

    const names = bindingsByFile.get(statement.fileId) ?? new Set<string>();

    for (const binding of statement.bindings) {
      names.add(binding.localName);
    }

    bindingsByFile.set(statement.fileId, names);
  }

  const confirmed = filesResolvingExpress(input.resolved);
  const declarations = declarationIndex(input.ir);
  const byFile = new Map<NodeId, ExpressFileFacts>();

  for (const [fileId, expressBindings] of bindingsByFile) {
    byFile.set(fileId, {
      expressBindings,
      routerNames: routerNamesIn({
        calls: callSitesByFile.get(fileId) ?? [],
        expressBindings,
        declarations,
      }),
      resolverConfirmed: confirmed.has(fileId),
    });
  }

  return { detected: byFile.size > 0, byFile, callSitesByFile };
}

interface DeclarationFacts {
  readonly nameById: ReadonlyMap<NodeId, string>;
  readonly kindById: ReadonlyMap<NodeId, string>;
}

function routerNamesIn(input: {
  readonly calls: readonly CallSiteIR[];
  readonly expressBindings: ReadonlySet<string>;
  readonly declarations: DeclarationFacts;
}): ReadonlySet<string> {
  const names = new Set<string>();

  for (const call of input.calls) {
    if (call.calleeRootName === null || call.enclosingDeclarationId === null) {
      continue;
    }

    if (!input.expressBindings.has(call.calleeRootName)) {
      continue;
    }

    // The call has to be initialising a variable for that variable to be the router.
    if (input.declarations.kindById.get(call.enclosingDeclarationId) !== 'variable') {
      continue;
    }

    const name = input.declarations.nameById.get(call.enclosingDeclarationId);

    if (name !== undefined) {
      names.add(name);
    }
  }

  return names;
}

/** Files with a module-level import that resolved to the express package. */
function filesResolvingExpress(resolved: ResolvedRepository): ReadonlySet<NodeId> {
  const files = new Set<NodeId>();

  for (const relationship of resolved.relationships) {
    if (relationship.type !== 'IMPORTS' || relationship.name !== null) {
      continue;
    }

    const { target } = relationship;

    if (target.kind === 'external' && target.origin === 'package' && target.name === EXPRESS_MODULE) {
      files.add(relationship.provenance.fileId);
    }
  }

  return files;
}

function groupCallSitesByFile(ir: RepositoryIR): ReadonlyMap<NodeId, readonly CallSiteIR[]> {
  const grouped = new Map<NodeId, CallSiteIR[]>();

  for (const call of ir.callSites) {
    const existing = grouped.get(call.fileId);

    if (existing === undefined) {
      grouped.set(call.fileId, [call]);
    } else {
      existing.push(call);
    }
  }

  return grouped;
}

function declarationIndex(ir: RepositoryIR): DeclarationFacts {
  const nameById = new Map<NodeId, string>();
  const kindById = new Map<NodeId, string>();

  for (const declaration of ir.declarations) {
    nameById.set(declaration.id, declaration.name);
    kindById.set(declaration.id, declaration.kind);
  }

  return { nameById, kindById };
}
