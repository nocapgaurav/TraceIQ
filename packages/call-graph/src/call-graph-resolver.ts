import type { CallSiteIR, RepositoryIR } from '@traceiq/ir';
import type { ResolvedRepository } from '@traceiq/resolver';
import type { NodeId } from '@traceiq/types';

import {
  MEMBER_OWNER_KINDS,
  buildBindingIndex,
  key,
  lookupScoped,
  type BindingIndex,
} from './binding-index.js';
import type {
  CallGraph,
  CallKind,
  CallRelationship,
  UnresolvedCall,
  UnresolvedCallReason,
} from './types.js';

const THIS_PREFIX = 'this.';

interface Binding {
  readonly targetId: NodeId;
  readonly kind: CallKind;
  readonly evidence: string;
}

/**
 * Binds the IR's call sites into `CALLS` relationships.
 *
 * A pure function of its inputs: no filesystem, no compiler, no database, no graph. It
 * modifies neither input.
 *
 * **Static calls only.** Five rules, each a name lookup over syntax the IR recorded and
 * targets the Resolver already resolved. Nothing here infers runtime dispatch, walks an
 * inheritance chain, or reasons about a dynamic callee — a call it cannot bind by one of
 * those rules is reported unresolved rather than guessed at.
 *
 * **No type checker.** This stage receives a `RepositoryIR` and a `ResolvedRepository`,
 * not a `ProjectContext`, so it binds names rather than symbols. That is why every
 * relationship is `INFERRED`, and why an instance method reached through a constructed
 * variable cannot be bound at all — see the README.
 */
export class CallGraphResolver {
  resolve(input: {
    readonly ir: RepositoryIR;
    readonly resolved: ResolvedRepository;
  }): CallGraph {
    const index = buildBindingIndex(input);

    // Constructed instances are collected first: binding `svc.run()` needs to know that
    // `svc` was constructed from `Service`, which is established by a construction
    // elsewhere in the file.
    const instances = collectInstances(input.ir, index);

    const calls: CallRelationship[] = [];
    const unresolved: UnresolvedCall[] = [];

    // Call sites arrive in file then source order, and nothing here reorders, so the
    // output is deterministic without sorting.
    for (const site of input.ir.callSites) {
      // A call at module level is attributed to its file: it still happens, and dropping
      // it would lose every top-level invocation.
      const sourceId = site.enclosingDeclarationId ?? site.fileId;
      const binding = bind(site, sourceId, index, instances);

      if (typeof binding === 'string') {
        unresolved.push({
          sourceId,
          calleeText: site.calleeText,
          reason: binding,
          provenance: {
            producer: 'call-graph',
            fileId: site.fileId,
            evidence: explainFailure(binding, site),
          },
          location: site.location,
        });

        continue;
      }

      calls.push({
        sourceId,
        targetId: binding.targetId,
        kind: binding.kind,
        calleeText: site.calleeText,
        confidence: 'INFERRED',
        provenance: {
          producer: 'call-graph',
          fileId: site.fileId,
          evidence: binding.evidence,
        },
        location: site.location,
        // One rule fires per call site and each yields a single target, so no call site
        // currently produces alternatives. The field exists because the graph's ambiguity
        // mechanism requires it, not because this stage populates it.
        candidateGroup: null,
      });
    }

    return { calls, unresolved };
  }
}

/**
 * Applies the binding rules in order, returning a binding or the reason none applied.
 *
 * The rules are disjoint on the shape of the callee, so order is for readability rather
 * than precedence: a member call never matches a bare-name rule and vice versa.
 */
function bind(
  site: CallSiteIR,
  sourceId: NodeId,
  index: BindingIndex,
  instances: ReadonlyMap<NodeId, NodeId>,
): Binding | UnresolvedCallReason {
  if (site.isConstruction) {
    return bindConstruction(site, sourceId, index);
  }

  if (site.calleeMemberName === null) {
    return bindBareName(site, sourceId, index);
  }

  if (site.calleeText.startsWith(THIS_PREFIX)) {
    return bindThisMember(site, sourceId, index);
  }

  if (site.calleeRootName === null) {
    return 'callee-not-addressable';
  }

  return bindRootedMember(site, sourceId, index, instances);
}

/**
 * `new Service()` — the constructor of the class the root names.
 *
 * A class without a declared constructor still gets an edge, to the class itself: the
 * construction happens, and pointing at the class is more useful than reporting nothing.
 */
function bindConstruction(
  site: CallSiteIR,
  sourceId: NodeId,
  index: BindingIndex,
): Binding | UnresolvedCallReason {
  const target = resolveRoot(site, sourceId, index);

  if (target === undefined) {
    return unboundReason(site, index);
  }

  const constructor = index.members.get(key(target, 'constructor'));

  return {
    targetId: constructor ?? target,
    kind: 'construction',
    evidence:
      constructor === undefined
        ? `'${String(site.calleeRootName)}' names a class with no declared constructor, so the construction points at the class`
        : `'${String(site.calleeRootName)}' names a class, and the construction invokes its constructor`,
  };
}

/** The declaration a callee root refers to: a name in scope, or an import. */
function resolveRoot(
  site: CallSiteIR,
  sourceId: NodeId,
  index: BindingIndex,
): NodeId | undefined {
  const root = site.calleeRootName;

  if (root === null) {
    return undefined;
  }

  const scoped = lookupScoped(index, site.fileId, index.chainOf.get(sourceId) ?? [], root);

  return scoped ?? index.importedDeclarations.get(key(site.fileId, root));
}

/**
 * Which class each variable was constructed from.
 *
 * Read from constructions whose enclosing declaration is the variable they initialise —
 * `const svc = new Service()`. The IR attributes the construction there, which is what
 * makes the link recoverable without a type checker.
 */
function collectInstances(
  ir: RepositoryIR,
  index: BindingIndex,
): ReadonlyMap<NodeId, NodeId> {
  const instances = new Map<NodeId, NodeId>();

  for (const site of ir.callSites) {
    if (!site.isConstruction || site.enclosingDeclarationId === null) {
      continue;
    }

    const holder = site.enclosingDeclarationId;

    if (index.kindOf.get(holder) !== 'variable') {
      continue;
    }

    const constructed = resolveRoot(site, holder, index);

    if (constructed !== undefined && MEMBER_OWNER_KINDS.includes(index.kindOf.get(constructed) ?? '')) {
      instances.set(holder, constructed);
    }
  }

  return instances;
}

/** `helper()` — a name in scope in this file, or a name it imports. */
function bindBareName(
  site: CallSiteIR,
  sourceId: NodeId,
  index: BindingIndex,
): Binding | UnresolvedCallReason {
  if (site.calleeRootName === null) {
    return 'callee-not-addressable';
  }

  const local = lookupScoped(
    index,
    site.fileId,
    index.chainOf.get(sourceId) ?? [],
    site.calleeRootName,
  );

  if (local !== undefined) {
    return {
      targetId: local,
      kind: 'local',
      evidence: `'${site.calleeRootName}' names a declaration in scope in this file`,
    };
  }

  const imported = index.importedDeclarations.get(key(site.fileId, site.calleeRootName));

  if (imported !== undefined) {
    return {
      targetId: imported,
      kind: 'imported',
      evidence: `'${site.calleeRootName}' is imported into this file, and the Resolver bound that import to this declaration`,
    };
  }

  return unboundReason(site, index);
}

/** `this.helper()` — a member of the class enclosing the call. */
function bindThisMember(
  site: CallSiteIR,
  sourceId: NodeId,
  index: BindingIndex,
): Binding | UnresolvedCallReason {
  const owner = index.containerOf.get(sourceId);

  if (owner === undefined || site.calleeMemberName === null) {
    return 'no-enclosing-container';
  }

  const member = index.members.get(key(owner, site.calleeMemberName));

  if (member === undefined) {
    return 'member-not-found';
  }

  return {
    targetId: member,
    kind: 'this-member',
    evidence: `'${site.calleeMemberName}' is a member of the container enclosing this call`,
  };
}

/**
 * `Service.make()` or `ns.helper()`.
 *
 * The root is tried as a declaration first, then as a module bound by a namespace import.
 * A name cannot legally be both in one file, so the two cannot compete.
 */
function bindRootedMember(
  site: CallSiteIR,
  sourceId: NodeId,
  index: BindingIndex,
  instances: ReadonlyMap<NodeId, NodeId>,
): Binding | UnresolvedCallReason {
  const root = site.calleeRootName;
  const memberName = site.calleeMemberName;

  if (root === null || memberName === null) {
    return 'callee-not-addressable';
  }

  const owner = resolveRoot(site, sourceId, index);

  if (owner !== undefined) {
    // A variable constructed from a class dispatches to that class's members. Checked
    // before the container gate, because the variable itself owns no members.
    const constructed = instances.get(owner);

    if (constructed !== undefined) {
      const member = index.members.get(key(constructed, memberName));

      return member === undefined
        ? 'member-not-found'
        : {
            targetId: member,
            kind: 'instance-member',
            evidence: `'${root}' was constructed from a class declaring '${memberName}'`,
          };
    }

    // A variable or function root owns no members: what `svc.run()` needs is the type of
    // `svc`, and saying "no member" would blame the wrong thing.
    if (!MEMBER_OWNER_KINDS.includes(index.kindOf.get(owner) ?? '')) {
      return 'root-type-unknown';
    }

    const member = index.members.get(key(owner, memberName));

    return member === undefined
      ? 'member-not-found'
      : {
          targetId: member,
          kind: 'static-member',
          evidence: `'${root}' names a declaration in scope, and '${memberName}' is a member of it`,
        };
  }

  const module = index.importedModules.get(key(site.fileId, root));

  if (module === undefined) {
    return unboundReason(site, index);
  }

  const exported = index.moduleExports.get(key(module, memberName));

  return exported === undefined
    ? 'member-not-found'
    : {
        targetId: exported,
        kind: 'namespace-member',
        evidence: `'${root}' is a namespace import of a module that exports '${memberName}'`,
      };
}

/**
 * Separates "there is nothing to bind" from "we could not bind it".
 *
 * A root that resolves to a package, a Node builtin or a TypeScript built-in has no
 * repository declaration behind it, so no `CALLS` edge should exist. Reporting that as an
 * unbound name would blame the analysis for a call that leaves the repository.
 */
function unboundReason(site: CallSiteIR, index: BindingIndex): UnresolvedCallReason {
  if (site.calleeRootName === null) {
    return 'root-not-bound';
  }

  return index.importedExternals.has(key(site.fileId, site.calleeRootName))
    ? 'root-is-external'
    : 'root-not-bound';
}

function explainFailure(reason: UnresolvedCallReason, site: CallSiteIR): string {
  switch (reason) {
    case 'callee-not-addressable':
      return `'${site.calleeText}' is not rooted at an identifier, so there is no name to bind`;

    case 'root-not-bound':
      return `'${String(site.calleeRootName)}' matches no top-level declaration, import or namespace binding in this file — most often a local, a parameter or a language global`;

    case 'root-is-external':
      return `'${String(site.calleeRootName)}' is imported from outside the analysed set, so the call leaves the repository and has no declaration to point at`;

    case 'member-not-found':
      return `the root of '${site.calleeText}' bound to a container, but it has no member named '${String(site.calleeMemberName)}'`;

    case 'root-type-unknown':
      return `'${String(site.calleeRootName)}' names a value rather than a container, so binding '${String(site.calleeMemberName)}' would need its type`;

    case 'no-enclosing-container':
      return `'${site.calleeText}' uses 'this' where the enclosing declaration has no container`;
  }
}
