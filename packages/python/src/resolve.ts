import type { CallGraph, CallRelationship, ExternalCall, UnresolvedCall } from '@traceiq/call-graph';
import type { DeclarationIR, RepositoryIR } from '@traceiq/ir';
import type {
  ExternalOrigin,
  ResolvedRelationship,
  ResolvedRepository,
  UnresolvedReference,
} from '@traceiq/resolver';
import { fileId } from '@traceiq/shared';
import type { Ecosystem, NodeId } from '@traceiq/types';

import type { HeritageFact, LocalAssignmentFact } from './extract.js';
import { resolveRelative, type ModuleIndex } from './module-index.js';
import { isStandardLibraryModule } from './stdlib.js';

const PRODUCER = 'python';

/**
 * An imported name that leaves the repository, and what it leaves into.
 *
 * The three fields are exactly what an external identity is minted from, copied from the
 * classification the IMPORTS edge already used — so a call edge onto `requests` and the import
 * edge onto `requests` name the same node rather than two spellings of it.
 */
interface ExternalRootBinding {
  readonly origin: ExternalOrigin;
  readonly name: string | null;
  readonly ecosystem: Ecosystem | null;
  readonly specifier: string;
}

/** Everything the extractor found, keyed by the file it came from. */
export interface ModuleInput {
  readonly path: string;
  readonly moduleName: string | null;
  readonly isPackage: boolean;
  readonly heritage: readonly HeritageFact[];
  readonly localAssignments: readonly LocalAssignmentFact[];
}

/**
 * Binds Python's names across modules.
 *
 * **What can be established statically, and nothing beyond it.** Python resolves attribute access,
 * inheritance and even imports at runtime; a name can be rebound, a class patched, a module
 * replaced in `sys.modules`. So the rules here are deliberately few and each one is a rule a reader
 * could check by hand:
 *
 * - an import whose module is a file in this repository resolves to that file
 * - an imported name that matches a top-level declaration in that file resolves to the declaration
 * - a call to a bare name resolves to a declaration in the same module, or to an imported name
 * - a call to `self.x` resolves to a member of the enclosing class
 * - a base class resolves the same way a bare name does
 *
 * Everything else is reported unresolved with a reason. In particular **no attribute call on an
 * arbitrary object is bound**: `svc.run()` needs the type of `svc`, and Python offers no static
 * answer, so claiming one would be a guess dressed as a fact.
 *
 * Confidence follows the same discipline as the TypeScript path. An import bound to a file in this
 * repository is `RESOLVED` — the file is there and the module name maps to it. A call bound by name
 * is `INFERRED`, because a local of the same name could shadow the declaration matched.
 */
export function resolvePython(input: {
  readonly ir: RepositoryIR;
  readonly modules: readonly ModuleInput[];
  readonly index: ModuleIndex;
}): { readonly resolved: ResolvedRepository; readonly callGraph: CallGraph } {
  const byPath = new Map(input.modules.map((module) => [module.path, module]));
  const pathByFileId = new Map(input.ir.files.map((file) => [file.id, file.path]));

  const topLevel = new Map<string, Map<string, NodeId>>();
  const members = new Map<string, NodeId>();
  const declarationById = new Map<NodeId, DeclarationIR>();

  for (const declaration of input.ir.declarations) {
    declarationById.set(declaration.id, declaration);

    const path = pathByFileId.get(declaration.fileId);

    if (path === undefined) {
      continue;
    }

    if (declaration.containerChain.length === 1) {
      const bucket = topLevel.get(path) ?? new Map<string, NodeId>();

      bucket.set(declaration.name, declaration.id);
      topLevel.set(path, bucket);
    }

    if (declaration.containerChain.length > 1) {
      const owner = declaration.containerChain.slice(0, -1).join('.');

      members.set(`${path}#${owner}#${declaration.name}`, declaration.id);
    }
  }

  const relationships: ResolvedRelationship[] = [];
  const unresolved: UnresolvedReference[] = [];

  /** Local name → declaration, per file, built from imports as they resolve. */
  const importedNames = new Map<string, Map<string, NodeId>>();
  /** Local name → module file path, for `import pkg` style bindings. */
  const importedModules = new Map<string, Map<string, string>>();
  /** Local name → the distribution or standard-library module it was imported from, per file. */
  const externalRoots = new Map<string, Map<string, ExternalRootBinding>>();

  for (const statement of input.ir.imports) {
    const path = pathByFileId.get(statement.fileId);
    const module = path === undefined ? undefined : byPath.get(path);

    if (path === undefined || module === undefined) {
      continue;
    }

    const target = resolveModuleSpecifier({
      specifier: statement.moduleSpecifier,
      module,
      index: input.index,
    });

    if (target === null) {
      // Leaves the repository, which is a *resolution* rather than a failure — the same treatment a
      // bare JavaScript specifier gets. Recording these as unresolved was the reason a Python reader
      // could see the dependencies a manifest declared and never the ones a file actually imported.
      const external = classifyPythonSpecifier(statement.moduleSpecifier);

      if (external === null) {
        unresolved.push({
          type: 'IMPORTS',
          sourceId: statement.fileId,
          name: null,
          reason: 'module-not-resolved',
          text: statement.moduleSpecifier,
          provenance: {
            resolver: 'imports',
            fileId: statement.fileId,
            evidence: `'${statement.moduleSpecifier}' names no module in this repository and no module outside it that could be identified`,
          },
          location: statement.location,
        });

        continue;
      }

      relationships.push({
        type: 'IMPORTS',
        sourceId: statement.fileId,
        target: external.target,
        name: null,
        // Never RESOLVED: nothing was read from site-packages, so this is what the *name* says rather
        // than what an interpreter would load. A local module on `sys.path` could shadow either.
        confidence: 'INFERRED',
        candidateGroup: null,
        provenance: {
          resolver: 'imports',
          fileId: statement.fileId,
          evidence: external.evidence,
        },
        location: statement.location,
      });

      // Every name the statement binds, so a call through one becomes an edge onto the
      // distribution rather than a `root-not-bound` that blames the reader's own module.
      // `import requests` binds `requests`; `from flask import Flask` binds `Flask`; both
      // name the same boundary and both are stated by the source.
      const bucket = externalRoots.get(path) ?? new Map<string, ExternalRootBinding>();

      for (const binding of statement.bindings) {
        bucket.set(binding.localName, {
          origin: external.target.origin,
          name: external.target.name,
          ecosystem: external.target.ecosystem,
          specifier: statement.moduleSpecifier,
        });
      }

      externalRoots.set(path, bucket);

      continue;
    }

    relationships.push({
      type: 'IMPORTS',
      sourceId: statement.fileId,
      target: { kind: 'file', fileId: fileId(target) },
      name: null,
      confidence: 'RESOLVED',
      candidateGroup: null,
      provenance: {
        resolver: 'imports',
        fileId: statement.fileId,
        evidence: `'${statement.moduleSpecifier}' resolves to ${target}`,
      },
      location: statement.location,
    });

    const exported = topLevel.get(target) ?? new Map<string, NodeId>();

    for (const binding of statement.bindings) {
      if (binding.kind === 'namespace') {
        const bucket = importedModules.get(path) ?? new Map<string, string>();

        bucket.set(binding.localName, target);
        importedModules.set(path, bucket);
        continue;
      }

      const declaration = exported.get(binding.importedName ?? binding.localName);

      if (declaration === undefined) {
        // The module resolved but the name did not. Frequently a re-export through `__init__.py`,
        // which needs `import *` semantics this analyser deliberately does not simulate.
        unresolved.push({
          type: 'IMPORTS',
          sourceId: statement.fileId,
          name: binding.localName,
          reason: 'no-declaration',
          text: `${binding.importedName ?? binding.localName} from ${statement.moduleSpecifier}`,
          provenance: {
            resolver: 'imports',
            fileId: statement.fileId,
            evidence: `${target} declares no top-level '${binding.importedName ?? binding.localName}'`,
          },
          location: statement.location,
        });

        continue;
      }

      relationships.push({
        type: 'IMPORTS',
        sourceId: statement.fileId,
        target: { kind: 'declaration', declarationId: declaration },
        name: binding.localName,
        confidence: 'RESOLVED',
        candidateGroup: null,
        provenance: {
          resolver: 'imports',
          fileId: statement.fileId,
          evidence: `'${binding.localName}' is imported from ${target}, which declares it at module level`,
        },
        location: statement.location,
      });

      const bucket = importedNames.get(path) ?? new Map<string, NodeId>();

      bucket.set(binding.localName, declaration);
      importedNames.set(path, bucket);
    }
  }

  // Inheritance, bound with the same name rules as a call's root.
  for (const module of input.modules) {
    for (const base of module.heritage) {
      const target =
        topLevel.get(module.path)?.get(base.rootName) ??
        importedNames.get(module.path)?.get(base.rootName);

      if (target === undefined) {
        unresolved.push({
          type: 'EXTENDS',
          sourceId: base.declarationId,
          name: base.rootName,
          reason: 'no-declaration',
          text: base.text,
          provenance: {
            resolver: 'heritage',
            fileId: fileId(module.path),
            evidence: `'${base.rootName}' matches no declaration in this module and no resolved import`,
          },
          location: base.location,
        });

        continue;
      }

      relationships.push({
        type: 'EXTENDS',
        sourceId: base.declarationId,
        target: { kind: 'declaration', declarationId: target },
        name: base.rootName,
        confidence: 'RESOLVED',
        candidateGroup: null,
        provenance: {
          resolver: 'heritage',
          fileId: fileId(module.path),
          evidence: `base class '${base.text}' binds to this declaration`,
        },
        location: base.location,
      });
    }
  }

  // Resolved bases, so a `self.x()` call can look up the inheritance chain. Built from the EXTENDS
  // relationships just established, which is the only base information that was actually proven.
  const basesOf = new Map<NodeId, NodeId[]>();

  for (const relationship of relationships) {
    if (relationship.type !== 'EXTENDS' || relationship.target.kind !== 'declaration') {
      continue;
    }

    const bucket = basesOf.get(relationship.sourceId) ?? [];

    bucket.push(relationship.target.declarationId);
    basesOf.set(relationship.sourceId, bucket);
  }

  const calls: CallRelationship[] = [];
  const externalCalls: ExternalCall[] = [];
  const unresolvedCalls: UnresolvedCall[] = [];

  /**
   * Locals bound to a construction, by the function that declares them.
   *
   * Built here rather than in the extractor because deciding that `Store()` constructs a class —
   * and is not a function call whose result has no knowable type — needs the declarations, which
   * only exist at this point. A local bound from a function keeps no entry, so `result.method()`
   * stays honestly unbound.
   */
  const instanceTypeOf = new Map<NodeId, Map<string, NodeId>>();

  for (const module of input.modules) {
    for (const local of module.localAssignments) {
      if (local.calleeRootName === null) {
        continue;
      }

      const constructed =
        local.calleeMemberName === null
          ? (topLevel.get(module.path)?.get(local.calleeRootName) ??
            importedNames.get(module.path)?.get(local.calleeRootName))
          : topLevel
              .get(importedModules.get(module.path)?.get(local.calleeRootName) ?? '')
              ?.get(local.calleeMemberName);

      if (constructed === undefined || declarationById.get(constructed)?.kind !== 'class') {
        continue;
      }

      const bucket = instanceTypeOf.get(local.ownerId) ?? new Map<string, NodeId>();

      // First wins. Python rebinds freely and a later assignment may change the type, so the
      // earliest statement is taken rather than a guess at which one a call site sees.
      if (!bucket.has(local.name)) {
        bucket.set(local.name, constructed);
      }

      instanceTypeOf.set(local.ownerId, bucket);
    }
  }

  for (const site of input.ir.callSites) {
    const path = pathByFileId.get(site.fileId);

    if (path === undefined) {
      continue;
    }

    const sourceId = site.enclosingDeclarationId ?? site.fileId;

    // A call rooted at a name this module imported from outside the repository is a call into
    // that distribution. Checked before the binding rules, because none of them can reach a
    // declaration that was never read — and reporting it as `root-not-bound` was, until this
    // milestone, the single largest category of unresolved call in every Python repository
    // measured.
    const externalRoot =
      site.calleeRootName === null ? undefined : externalRoots.get(path)?.get(site.calleeRootName);

    if (externalRoot !== undefined) {
      externalCalls.push({
        sourceId,
        origin: externalRoot.origin,
        name: externalRoot.name,
        ecosystem: externalRoot.ecosystem,
        calleeText: site.calleeText,
        // Python rebinds names at runtime, so this is what the source says rather than what the
        // interpreter is guaranteed to do — the same discipline every other Python edge follows.
        confidence: 'INFERRED',
        provenance: {
          producer: PRODUCER,
          fileId: site.fileId,
          evidence: `'${site.calleeRootName ?? ''}' is imported from '${externalRoot.specifier}', so this call leaves the repository into that dependency`,
        },
        location: site.location,
      });

      continue;
    }

    const bound = bindCall({ site, path, topLevel, importedNames, importedModules, members, declarationById, basesOf, pathByFileId, instanceTypeOf });

    if (typeof bound === 'string') {
      unresolvedCalls.push({
        sourceId,
        calleeText: site.calleeText,
        reason: bound,
        provenance: { producer: PRODUCER, fileId: site.fileId, evidence: explain(bound, site.calleeText) },
        location: site.location,
      });

      continue;
    }

    calls.push({
      sourceId,
      targetId: bound.targetId,
      kind: bound.kind,
      calleeText: site.calleeText,
      // Never RESOLVED. Python binds names at runtime, so every one of these is the most plausible
      // reading of the source rather than the reading the interpreter is guaranteed to take.
      confidence: 'INFERRED',
      provenance: { producer: PRODUCER, fileId: site.fileId, evidence: bound.evidence },
      location: site.location,
      candidateGroup: null,
    });
  }

  return {
    resolved: {
      repository: input.ir.repository,
      declarations: [],
      relationships,
      unresolved,
    },
    callGraph: { calls, externalCalls, unresolved: unresolvedCalls },
  };
}

type Binding = { readonly targetId: NodeId; readonly kind: CallRelationship['kind']; readonly evidence: string };

function bindCall(input: {
  readonly site: RepositoryIR['callSites'][number];
  readonly path: string;
  readonly topLevel: ReadonlyMap<string, Map<string, NodeId>>;
  readonly importedNames: ReadonlyMap<string, Map<string, NodeId>>;
  readonly importedModules: ReadonlyMap<string, Map<string, string>>;
  readonly members: ReadonlyMap<string, NodeId>;
  readonly declarationById: ReadonlyMap<NodeId, DeclarationIR>;
  readonly basesOf: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly pathByFileId: ReadonlyMap<NodeId, string>;
  readonly instanceTypeOf: ReadonlyMap<NodeId, ReadonlyMap<string, NodeId>>;
}): Binding | 'callee-not-addressable' | 'root-not-bound' | 'root-type-unknown' | 'member-not-found' {
  const { site, path } = input;
  const root = site.calleeRootName;

  if (root === null) {
    return 'callee-not-addressable';
  }

  // A bare name: a module-level declaration here, or something imported.
  if (site.calleeMemberName === null) {
    const local = input.topLevel.get(path)?.get(root);

    if (local !== undefined) {
      return { targetId: local, kind: 'local', evidence: `'${root}' is declared at module level in this file` };
    }

    const imported = input.importedNames.get(path)?.get(root);

    return imported === undefined
      ? 'root-not-bound'
      : { targetId: imported, kind: 'imported', evidence: `'${root}' is imported into this module and bound to this declaration` };
  }

  // `self.method()` — a member of the class enclosing the call.
  if (root === 'self' || root === 'cls') {
    const enclosing = site.enclosingDeclarationId;
    const declaration = enclosing === null ? undefined : input.declarationById.get(enclosing);
    const owner = declaration?.containerChain.slice(0, -1).join('.');

    if (owner === undefined || owner === '') {
      return 'root-type-unknown';
    }

    const own = input.members.get(`${path}#${owner}#${site.calleeMemberName}`);

    if (own !== undefined) {
      return {
        targetId: own,
        kind: 'this-member',
        evidence: `'${site.calleeMemberName}' is a member of the enclosing class`,
      };
    }

    // Not declared on this class — try the classes it was *proven* to extend. Only resolved bases
    // are walked, so a base from a third-party package ends the search rather than being guessed past.
    const ownerId = ownerIdOf(path, owner, input.declarationById);
    const inherited =
      ownerId === null
        ? undefined
        : findInherited({
            classId: ownerId,
            member: site.calleeMemberName,
            basesOf: input.basesOf,
            members: input.members,
            declarationById: input.declarationById,
            pathByFileId: input.pathByFileId,
          });

    return inherited === undefined
      ? 'member-not-found'
      : {
          targetId: inherited.targetId,
          kind: 'this-member',
          evidence: `'${site.calleeMemberName}' is inherited from '${inherited.className}'`,
        };
  }

  // `mod.func()` where `mod` was bound by `import mod`.
  const moduleFile = input.importedModules.get(path)?.get(root);

  if (moduleFile !== undefined) {
    const member = input.topLevel.get(moduleFile)?.get(site.calleeMemberName);

    return member === undefined
      ? 'member-not-found'
      : { targetId: member, kind: 'namespace-member', evidence: `'${root}' is an imported module declaring '${site.calleeMemberName}'` };
  }

  // `Klass.method()` where `Klass` is a class in scope.
  const owner = input.topLevel.get(path)?.get(root) ?? input.importedNames.get(path)?.get(root);
  const ownerDeclaration = owner === undefined ? undefined : input.declarationById.get(owner);

  if (ownerDeclaration?.kind === 'class') {
    const ownerPath = ownerDeclaration.containerChain.join('.');

    for (const [key, id] of input.members) {
      if (key.endsWith(`#${ownerPath}#${site.calleeMemberName}`)) {
        return { targetId: id, kind: 'static-member', evidence: `'${root}' names a class declaring '${site.calleeMemberName}'` };
      }
    }

    return 'member-not-found';
  }

  // `store.save()` where `store = Store()` earlier in this function.
  const constructed =
    site.enclosingDeclarationId === null
      ? undefined
      : input.instanceTypeOf.get(site.enclosingDeclarationId)?.get(root);

  if (constructed !== undefined) {
    const ownerChain = input.declarationById.get(constructed)?.containerChain.join('.');
    const own =
      ownerChain === undefined
        ? undefined
        : input.members.get(`${memberPathOf(constructed)}#${ownerChain}#${site.calleeMemberName}`);

    if (own !== undefined) {
      return {
        targetId: own,
        kind: 'instance-member',
        evidence: `'${root}' was constructed from a class declaring '${site.calleeMemberName}'`,
      };
    }

    const inherited = findInherited({
      classId: constructed,
      member: site.calleeMemberName,
      basesOf: input.basesOf,
      members: input.members,
      declarationById: input.declarationById,
      pathByFileId: input.pathByFileId,
    });

    return inherited === undefined
      ? 'member-not-found'
      : {
          targetId: inherited.targetId,
          kind: 'instance-member',
          evidence: `'${root}' was constructed from a class inheriting '${site.calleeMemberName}' from '${inherited.className}'`,
        };
  }

  // Anything else needs the runtime type of the receiver, which Python does not offer statically.
  return 'root-type-unknown';
}

/** `sym:src/a.py#Klass` → `src/a.py`, which is how the member map is keyed. */
function memberPathOf(declarationId: NodeId): string {
  const withoutPrefix = declarationId.slice('sym:'.length);
  const hash = withoutPrefix.indexOf('#');

  return hash === -1 ? withoutPrefix : withoutPrefix.slice(0, hash);
}

/** The declaration id of the class named by a container chain in one file. */
function ownerIdOf(
  path: string,
  owner: string,
  declarationById: ReadonlyMap<NodeId, DeclarationIR>,
): NodeId | null {
  for (const [id, declaration] of declarationById) {
    if (
      declaration.kind === 'class' &&
      declaration.containerChain.join('.') === owner &&
      id.startsWith(`sym:${path}#`)
    ) {
      return id;
    }
  }

  return null;
}

/**
 * Walks the resolved inheritance chain for a member, breadth-first.
 *
 * Breadth-first because Python's own method resolution order visits nearer bases first, so the
 * nearest declaration is the one an interpreter would reach. Cycles cannot occur in valid Python,
 * but the visited set guards against them anyway — malformed input must not hang a scan.
 */
function findInherited(input: {
  readonly classId: NodeId;
  readonly member: string;
  readonly basesOf: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly members: ReadonlyMap<string, NodeId>;
  readonly declarationById: ReadonlyMap<NodeId, DeclarationIR>;
  readonly pathByFileId: ReadonlyMap<NodeId, string>;
}): { readonly targetId: NodeId; readonly className: string } | undefined {
  const visited = new Set<NodeId>([input.classId]);
  const queue = [...(input.basesOf.get(input.classId) ?? [])];

  while (queue.length > 0) {
    const baseId = queue.shift() as NodeId;

    if (visited.has(baseId)) {
      continue;
    }

    visited.add(baseId);

    const base = input.declarationById.get(baseId);
    const basePath = base === undefined ? undefined : input.pathByFileId.get(base.fileId);

    if (base !== undefined && basePath !== undefined) {
      const found = input.members.get(
        `${basePath}#${base.containerChain.join('.')}#${input.member}`,
      );

      if (found !== undefined) {
        return { targetId: found, className: base.name };
      }
    }

    queue.push(...(input.basesOf.get(baseId) ?? []));
  }

  return undefined;
}

function explain(reason: string, calleeText: string): string {
  switch (reason) {
    case 'callee-not-addressable':
      return `'${calleeText}' is not rooted at an identifier, so there is no name to bind`;

    case 'root-not-bound':
      return `'${calleeText}' matches no module-level declaration and no resolved import — most often a local, a parameter, or a builtin`;

    case 'member-not-found':
      return `the root of '${calleeText}' bound, but no matching member was declared`;

    default:
      return `binding '${calleeText}' would need the runtime type of its receiver, which Python does not establish statically`;
  }
}

/**
 * Turns an import specifier into a repository file, or `null` for anything outside it.
 *
 * A third-party or standard-library import returns `null` and is reported unresolved with a reason
 * saying so — which is accurate. TraceIQ does not read site-packages, and pretending `fastapi`
 * resolves to something would be worse than saying it leaves the repository.
 */
function resolveModuleSpecifier(input: {
  readonly specifier: string;
  readonly module: ModuleInput;
  readonly index: ModuleIndex;
}): string | null {
  const { specifier, module, index } = input;

  if (!specifier.startsWith('.')) {
    return index.fileFor(specifier);
  }

  if (module.moduleName === null) {
    return null;
  }

  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const absolute = resolveRelative({
    fromModule: module.moduleName,
    fromIsPackage: module.isPackage,
    dots,
    suffix: specifier.slice(dots),
  });

  return absolute === null ? null : index.fileFor(absolute);
}

/**
 * Classifies an import that leaves the repository.
 *
 * The name recorded is the **top-level module name as written**, not a distribution name. `import yaml`
 * is shipped by the distribution `PyYAML`, and mapping one to the other needs installed metadata this
 * analyser deliberately does not read — so `ext:python:yaml` says exactly what the source says and no
 * more. A reader comparing it against the `Dependency` nodes a manifest declared can see the
 * difference, which is the point of keeping those two node kinds apart.
 *
 * `null` for a relative specifier that resolved to nothing: `from . import missing` names a module
 * inside the repository that is not there, which is a genuine dead end rather than an external.
 */
function classifyPythonSpecifier(specifier: string): {
  readonly target: {
    readonly kind: 'external';
    readonly origin: ExternalOrigin;
    readonly name: string;
    readonly ecosystem: Ecosystem;
  };
  readonly evidence: string;
} | null {
  if (specifier.startsWith('.') || specifier.trim().length === 0) {
    return null;
  }

  const root = specifier.split('.')[0] as string;

  if (isStandardLibraryModule(specifier)) {
    return {
      target: { kind: 'external', origin: 'standard-library', name: root, ecosystem: 'python' },
      evidence: `'${root}' is a Python standard-library module name`,
    };
  }

  return {
    target: { kind: 'external', origin: 'package', name: root, ecosystem: 'python' },
    evidence: `'${specifier}' names no module in this repository, so '${root}' is read as an installed distribution`,
  };
}
