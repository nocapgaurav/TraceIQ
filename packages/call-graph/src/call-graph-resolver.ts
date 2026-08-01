import type { CallSiteIR, RepositoryIR } from '@traceiq/ir';
import type { ProjectContext } from '@traceiq/project-host';
import type { DeclarationIndex, ResolvedRepository } from '@traceiq/resolver';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

import { CheckerBinder, type CheckerOutcome } from './checker-binder.js';

import {
  MEMBER_OWNER_KINDS,
  buildBindingIndex,
  key,
  lookupScoped,
  type BindingIndex,
  type ExternalRoot,
} from './binding-index.js';
import type {
  CallGraph,
  CallKind,
  CallRelationship,
  ExternalCall,
  UnresolvedCall,
  UnresolvedCallReason,
} from './types.js';

const THIS_PREFIX = 'this.';

const UNBOUND: CheckerOutcome = { kind: 'unbound', reason: null };

interface Binding {
  readonly targetId: NodeId;
  readonly kind: CallKind;
  readonly evidence: string;
}

/**
 * Binds the IR's call sites into `CALLS` relationships.
 *
 * **Two tiers, strongest first.**
 *
 * The type checker is asked first, when a `ProjectContext` is supplied. It binds symbols
 * rather than names: it knows the type of a receiver, so it reaches the declaration the
 * compiler itself would invoke, through a variable, a parameter, a factory result or an
 * interface. Those bindings are `RESOLVED`.
 *
 * The name rules run for whatever the checker declined. Each is a lookup over syntax the
 * IR recorded and targets the Resolver already resolved, and each matches a *plausible*
 * declaration rather than a proven one — a local of the same name could shadow it. Those
 * bindings stay `INFERRED`.
 *
 * The tiers are additive on purpose. The checker declines a genuinely dynamic callee, as
 * it should; the name rules still bind many of those to the one declaration in scope with
 * that name, which is worth recording as long as the weaker confidence says so.
 *
 * **Still static, and still incomplete.** Nothing here infers runtime dispatch or picks
 * between implementations of an interface. A call neither tier can bind is reported
 * unresolved rather than guessed at.
 *
 * The context is borrowed for the duration of `resolve` and never retained, so no compiler
 * state outlives the stage. Called without one, this behaves exactly as it did before the
 * checker tier existed.
 */
export class CallGraphResolver {
  resolve(input: {
    readonly ir: RepositoryIR;
    readonly resolved: ResolvedRepository;
    /** Omitted, every binding falls to the name rules and is `INFERRED`. */
    readonly context?: ProjectContext;
    /**
     * The declaration index the checker tier binds against, when this IR is one bounded
     * compilation of several. Defaults to one built from `ir` alone.
     */
    readonly index?: DeclarationIndex;
  }): CallGraph {
    const index = buildBindingIndex(input);
    const checker =
      input.context === undefined
        ? null
        : CheckerBinder.create({
            context: input.context,
            ir: input.ir,
            ...(input.index === undefined ? {} : { index: input.index }),
          });

    // Constructed instances are collected first: binding `svc.run()` needs to know that
    // `svc` was constructed from `Service`, which is established by a construction
    // elsewhere in the file.
    const instances = collectInstances(input.ir, index);

    const calls: CallRelationship[] = [];
    const externalCalls: ExternalCall[] = [];
    const unresolved: UnresolvedCall[] = [];

    // Call sites arrive in file then source order, and nothing here reorders, so the
    // output is deterministic without sorting.
    for (const site of input.ir.callSites) {
      // A call at module level is attributed to its file: it still happens, and dropping
      // it would lose every top-level invocation.
      const sourceId = site.enclosingDeclarationId ?? site.fileId;
      const checked = checker?.bind(site) ?? UNBOUND;

      if (checked.kind === 'declaration') {
        calls.push(
          relationship({
            site,
            sourceId,
            targetId: checked.targetId,
            kind: 'checked',
            confidence: 'RESOLVED',
            evidence: checked.evidence,
          }),
        );

        continue;
      }

      if (checked.kind === 'external') {
        externalCalls.push({
          sourceId,
          origin: checked.origin,
          name: checked.name,
          ecosystem: checked.ecosystem,
          calleeText: site.calleeText,
          confidence: 'RESOLVED',
          provenance: {
            producer: 'call-graph',
            fileId: site.fileId,
            evidence: checked.evidence,
          },
          location: site.location,
        });

        continue;
      }

      // The checker answered, and the answer was that no edge belongs here. Recorded
      // directly rather than falling through, because a name rule could otherwise bind
      // `map` or `parse` to an unrelated local declaration of that name.
      if (checked.reason !== null) {
        unresolved.push({
          sourceId,
          calleeText: site.calleeText,
          reason: checked.reason,
          provenance: {
            producer: 'call-graph',
            fileId: site.fileId,
            evidence: explainFailure(checked.reason, site),
          },
          location: site.location,
        });

        continue;
      }

      const binding = bind(site, sourceId, index, instances);

      // The name rules recognised the root as an imported external. That is not a failure to
      // bind — it is a bound call whose callee is a dependency, and the import statement is
      // the evidence. Recording it as unresolved was why a repository with no `node_modules`
      // installed showed no dependency call edges at all: express had 137 of these and dash
      // 3,656, every one of them a fact the source states plainly.
      if (binding === 'root-is-external' && site.calleeRootName !== null) {
        const external = index.importedExternals.get(key(site.fileId, site.calleeRootName));

        if (external !== undefined) {
          externalCalls.push(externalCallFrom(site, sourceId, external));
          continue;
        }
      }

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

      calls.push(
        relationship({
          site,
          sourceId,
          targetId: binding.targetId,
          kind: binding.kind,
          confidence: 'INFERRED',
          evidence: binding.evidence,
        }),
      );
    }

    return { calls, externalCalls, unresolved };
  }
}

/**
 * An external call bound by the name rules rather than by the checker.
 *
 * `INFERRED`, not `RESOLVED`, and the difference is real. The checker tier resolves the call's
 * signature to a declaration that happens to sit in a package, so it knows the callee exists.
 * This rule knows only that the callee's root name was imported from that package — which the
 * import statement proves, but a local rebinding of the same name would defeat.
 */
function externalCallFrom(
  site: CallSiteIR,
  sourceId: NodeId,
  external: ExternalRoot,
): ExternalCall {
  return {
    sourceId,
    origin: external.origin,
    name: external.name,
    ecosystem: external.ecosystem,
    calleeText: site.calleeText,
    confidence: 'INFERRED',
    provenance: {
      producer: 'call-graph',
      fileId: site.fileId,
      evidence: `'${String(site.calleeRootName)}' is imported from '${external.specifier}', so this call leaves the repository into that dependency`,
    },
    location: site.location,
  };
}

function relationship(input: {
  readonly site: CallSiteIR;
  readonly sourceId: NodeId;
  readonly targetId: NodeId;
  readonly kind: CallKind;
  readonly confidence: ConfidenceLevel;
  readonly evidence: string;
}): CallRelationship {
  return {
    sourceId: input.sourceId,
    targetId: input.targetId,
    kind: input.kind,
    calleeText: input.site.calleeText,
    confidence: input.confidence,
    provenance: {
      producer: 'call-graph',
      fileId: input.site.fileId,
      evidence: input.evidence,
    },
    location: input.site.location,
    // One rule fires per call site and each yields a single target, so no call site
    // currently produces alternatives. The field exists because the graph's ambiguity
    // mechanism requires it, not because this stage populates it.
    candidateGroup: null,
  };
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

  // A CommonJS module binding is a *variable* as well as an import: `const path = require('node:path')`
  // declares `path` at file level, so `resolveRoot` finds the declaration and the rule below reports
  // `root-type-unknown` — for a call whose destination the import statement states plainly. The
  // import wins, because that is what the name means.
  if (index.importedExternals.has(key(site.fileId, root))) {
    return 'root-is-external';
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

    case 'callee-is-language-builtin':
      return `the type checker resolved '${site.calleeText}' to a TypeScript library declaration, which is language rather than a dependency`;

    case 'callee-outside-analysis':
      return `the type checker resolved '${site.calleeText}' outside the analysed set, and no package name was recoverable`;
  }
}
