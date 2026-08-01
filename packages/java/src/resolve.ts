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

import type {
  HeritageFact,
  LocalVariableFact,
  MethodReturnFact,
  TypeReferenceFact,
} from './extract.js';
import { isJavaLangType, isJavaStandardLibrary, javaPackageOf } from './stdlib.js';
import {
  buildFileScope,
  buildTypeIndex,
  lookupType,
  type FileScope,
  type JavaTypeIndex,
  type TypeEntry,
} from './type-index.js';

const PRODUCER = 'java';

/** What the extractor found for one compilation unit, as the resolver consumes it. */
export interface UnitInput {
  readonly path: string;
  readonly packageName: string | null;
  readonly heritage: readonly HeritageFact[];
  readonly typeReferences: readonly TypeReferenceFact[];
  readonly localVariables: readonly LocalVariableFact[];
  readonly methodReturns: readonly MethodReturnFact[];
  readonly imports: readonly {
    readonly specifier: string;
    readonly isWildcard: boolean;
    readonly isStatic: boolean;
  }[];
}

/**
 * Binds Java's names across compilation units.
 *
 * **Statically typed does not mean statically resolved — not without a classpath.** javac answers every
 * question here by consulting compiled dependencies; this analyser reads source and nothing else. So
 * the rules are few and each is one a reader could check by hand:
 *
 * - an import naming a type this repository declares resolves to that declaration
 * - an import naming anything else resolves to an external, in the Maven ecosystem or the standard library
 * - a supertype resolves the way a type name resolves in the file that wrote it
 * - a type in a signature resolves the same way
 * - a call to a bare name resolves to a member of the enclosing type or one it was proven to extend
 * - a call on `this` or `super` resolves through that same chain
 * - a call on a field or a local whose *declared type* is known resolves to a member of that type
 *
 * Everything else is unresolved with a reason. In particular **a call on a value whose type was never
 * declared in reachable source is not bound**: `svc.run()` where `svc` came from a factory needs
 * inference this analyser does not perform, and guessing would put a wrong edge in the graph.
 *
 * Confidence is assigned per rule, not per language. A type resolved through an explicit import is
 * `RESOLVED` — the source names it and the declaration is there. A call bound through a declared field
 * type is `INFERRED`: the field could hold a subclass, and Java dispatches on the runtime type, so the
 * declaration matched is the most plausible reading rather than a proven one.
 */
export function resolveJava(input: {
  readonly ir: RepositoryIR;
  readonly units: readonly UnitInput[];
}): { readonly resolved: ResolvedRepository; readonly callGraph: CallGraph } {
  const pathByFileId = new Map(input.ir.files.map((file) => [file.id, file.path]));
  const declarationById = new Map(input.ir.declarations.map((entry) => [entry.id, entry]));
  const unitByPath = new Map(input.units.map((unit) => [unit.path, unit]));

  const scopes = new Map<string, FileScope>();

  for (const unit of input.units) {
    scopes.set(
      unit.path,
      buildFileScope({ filePath: unit.path, packageName: unit.packageName, imports: unit.imports }),
    );
  }

  const index = buildIndex({ ir: input.ir, pathByFileId, units: input.units });

  const relationships: ResolvedRelationship[] = [];
  const unresolved: UnresolvedReference[] = [];

  // ---- imports ------------------------------------------------------------------------------
  for (const statement of input.ir.imports) {
    const path = pathByFileId.get(statement.fileId);
    const scope = path === undefined ? undefined : scopes.get(path);

    if (path === undefined || scope === undefined) {
      continue;
    }

    const declared = index.byQualifiedName(statement.moduleSpecifier);

    if (declared.length > 0) {
      for (const entry of declared) {
        relationships.push({
          type: 'IMPORTS',
          sourceId: statement.fileId,
          target: { kind: 'declaration', declarationId: entry.declarationId },
          name: entry.simpleName,
          // The source names the type and the repository declares it. Nothing is being guessed.
          confidence: declared.length === 1 ? 'RESOLVED' : 'AMBIGUOUS',
          candidateGroup: declared.length === 1 ? null : `import:${path}:${statement.moduleSpecifier}`,
          provenance: {
            resolver: 'imports',
            fileId: statement.fileId,
            evidence: `'${statement.moduleSpecifier}' names a type declared in this repository`,
          },
          location: statement.location,
        });
      }

      continue;
    }

    // A wildcard whose package this repository owns is a real dependency on that package, but there is
    // no single declaration to point at. The file edge would be arbitrary — a package spans files — so
    // it is recorded unresolved with a reason saying exactly that, rather than pointing somewhere.
    const external = classifyJavaImport(statement.moduleSpecifier);

    relationships.push({
      type: 'IMPORTS',
      sourceId: statement.fileId,
      target: external.target,
      name: null,
      // Never RESOLVED: no jar was opened, so this is what the name says rather than what javac would
      // load. A shaded or relocated dependency would say otherwise.
      confidence: 'INFERRED',
      candidateGroup: null,
      provenance: {
        resolver: 'imports',
        fileId: statement.fileId,
        evidence: external.evidence,
      },
      location: statement.location,
    });
  }

  // ---- heritage -----------------------------------------------------------------------------
  /** Supertypes that were actually proven, so a member lookup can walk them. */
  const superTypesOf = new Map<NodeId, NodeId[]>();

  for (const unit of input.units) {
    const scope = scopes.get(unit.path);

    if (scope === undefined) {
      continue;
    }

    for (const clause of unit.heritage) {
      const lookup = lookupType({ name: clause.rootName, scope, index });
      const type = clause.kind === 'extends' ? 'EXTENDS' : 'IMPLEMENTS';

      if (lookup.outcome === 'unresolved') {
        const external = classifyJavaTypeName(clause.rootName, scope);

        if (external === null) {
          unresolved.push({
            type,
            sourceId: clause.declarationId,
            name: clause.rootName,
            reason: 'no-declaration',
            text: clause.text,
            provenance: {
              resolver: 'heritage',
              fileId: fileId(unit.path),
              evidence: `'${clause.rootName}' names no type this repository declares and no import that identifies one`,
            },
            location: clause.location,
          });

          continue;
        }

        relationships.push({
          type,
          sourceId: clause.declarationId,
          target: external.target,
          name: clause.rootName,
          confidence: 'INFERRED',
          candidateGroup: null,
          provenance: {
            resolver: 'heritage',
            fileId: fileId(unit.path),
            evidence: external.evidence,
          },
          location: clause.location,
        });

        continue;
      }

      const entries = lookup.outcome === 'resolved' ? [lookup.entry] : lookup.entries;
      const group = lookup.outcome === 'resolved' ? null : `heritage:${clause.declarationId}:${clause.rootName}`;

      for (const entry of entries) {
        relationships.push({
          type,
          sourceId: clause.declarationId,
          target: { kind: 'declaration', declarationId: entry.declarationId },
          name: clause.rootName,
          confidence: lookup.outcome === 'resolved' ? 'RESOLVED' : 'AMBIGUOUS',
          candidateGroup: group,
          provenance: {
            resolver: 'heritage',
            fileId: fileId(unit.path),
            evidence: lookup.evidence,
          },
          location: clause.location,
        });

        if (lookup.outcome === 'resolved') {
          const bucket = superTypesOf.get(clause.declarationId) ?? [];

          bucket.push(entry.declarationId);
          superTypesOf.set(clause.declarationId, bucket);
        }
      }
    }
  }

  // ---- type references ----------------------------------------------------------------------
  for (const unit of input.units) {
    const scope = scopes.get(unit.path);

    if (scope === undefined) {
      continue;
    }

    for (const reference of unit.typeReferences) {
      const lookup = lookupType({ name: reference.rootName, scope, index });

      if (lookup.outcome === 'unresolved') {
        const external = classifyJavaTypeName(reference.rootName, scope);

        if (external === null) {
          unresolved.push({
            type: 'REFERENCES_TYPE',
            sourceId: reference.declarationId,
            name: reference.rootName,
            reason: 'no-declaration',
            text: reference.text,
            provenance: {
              resolver: 'type-references',
              fileId: fileId(unit.path),
              evidence: `'${reference.rootName}' names no type this repository declares; it may be a type parameter or an unimported type`,
            },
            location: reference.location,
          });

          continue;
        }

        relationships.push({
          type: 'REFERENCES_TYPE',
          sourceId: reference.declarationId,
          target: external.target,
          name: reference.rootName,
          confidence: 'INFERRED',
          candidateGroup: null,
          provenance: {
            resolver: 'type-references',
            fileId: fileId(unit.path),
            evidence: external.evidence,
          },
          location: reference.location,
        });

        continue;
      }

      const entries = lookup.outcome === 'resolved' ? [lookup.entry] : lookup.entries;

      for (const entry of entries) {
        relationships.push({
          type: 'REFERENCES_TYPE',
          sourceId: reference.declarationId,
          target: { kind: 'declaration', declarationId: entry.declarationId },
          name: reference.rootName,
          confidence: lookup.outcome === 'resolved' ? 'RESOLVED' : 'AMBIGUOUS',
          candidateGroup:
            lookup.outcome === 'resolved'
              ? null
              : `type:${reference.declarationId}:${reference.rootName}`,
          provenance: {
            resolver: 'type-references',
            fileId: fileId(unit.path),
            evidence: lookup.evidence,
          },
          location: reference.location,
        });
      }
    }
  }

  // ---- calls --------------------------------------------------------------------------------
  const calls: CallRelationship[] = [];
  const externalCalls: ExternalCall[] = [];
  const unresolvedCalls: UnresolvedCall[] = [];

  // A field's declared type, so `this.repo.save()` can be bound. Read from the REFERENCES_TYPE edges
  // just proven, which is the only type information that was actually established.
  const fieldTypeOf = new Map<NodeId, NodeId>();

  for (const relationship of relationships) {
    if (
      relationship.type !== 'REFERENCES_TYPE' ||
      relationship.target.kind !== 'declaration' ||
      relationship.confidence === 'AMBIGUOUS'
    ) {
      continue;
    }

    const declaration = declarationById.get(relationship.sourceId);

    if (declaration?.kind === 'property' && !fieldTypeOf.has(relationship.sourceId)) {
      fieldTypeOf.set(relationship.sourceId, relationship.target.declarationId);
    }
  }

  // A method's declared return type name, so a factory initialiser gives its local a type.
  const returnTypeNameOf = new Map<NodeId, string>();

  for (const unit of input.units) {
    for (const returned of unit.methodReturns) {
      returnTypeNameOf.set(returned.declarationId, returned.typeName);
    }
  }

  // Local variables by the method that declares them, then by name. Built once rather than searched
  // per call site, so binding stays linear in the number of calls.
  const localsByOwner = new Map<NodeId, Map<string, LocalVariableFact>>();

  for (const unit of input.units) {
    for (const local of unit.localVariables) {
      const bucket = localsByOwner.get(local.ownerId) ?? new Map<string, LocalVariableFact>();

      // First declaration wins. Java forbids redeclaring a local in the same scope, so a second entry
      // means two sibling blocks — and neither shadows the other at any single call site.
      if (!bucket.has(local.name)) {
        bucket.set(local.name, local);
      }

      localsByOwner.set(local.ownerId, bucket);
    }
  }

  for (const site of input.ir.callSites) {
    const path = pathByFileId.get(site.fileId);
    const scope = path === undefined ? undefined : scopes.get(path);

    if (path === undefined || scope === undefined) {
      continue;
    }

    const sourceId = site.enclosingDeclarationId ?? site.fileId;
    const bound = bindCall({
      site,
      scope,
      index,
      declarationById,
      superTypesOf,
      fieldTypeOf,
      unitByPath,
      localsByOwner,
      returnTypeNameOf,
    });

    if (typeof bound === 'string') {
      // Nothing in this repository declares the receiver's type, but the file's imports may still say
      // where it comes from. `logger.info(…)` in a file importing `org.slf4j.Logger` is a call into
      // slf4j, and saying so is the difference between a Java reader seeing its dependencies used and
      // seeing only the ones a pom declared.
      const external = externalCalleeOf({
        site,
        scope,
        index,
        localsByOwner,
        declarationById,
        fieldTypeOf,
      });

      if (external !== null) {
        externalCalls.push({
          sourceId,
          origin: external.target.origin,
          name: external.target.name,
          ecosystem: external.target.ecosystem,
          calleeText: site.calleeText,
          // No jar was opened. The import names the package and the source names the member; that
          // the package declares that member is what a classpath would prove and this does not.
          confidence: 'INFERRED',
          provenance: { producer: PRODUCER, fileId: site.fileId, evidence: external.evidence },
          location: site.location,
        });

        continue;
      }

      unresolvedCalls.push({
        sourceId,
        calleeText: site.calleeText,
        reason: bound,
        provenance: {
          producer: PRODUCER,
          fileId: site.fileId,
          evidence: explain(bound, site.calleeText),
        },
        location: site.location,
      });

      continue;
    }

    calls.push({
      sourceId,
      targetId: bound.targetId,
      kind: bound.kind,
      calleeText: site.calleeText,
      // Never RESOLVED. Java dispatches on the runtime type, so a call bound through a declared type
      // reaches the declaration a reader would expect rather than the one that will necessarily run.
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

/**
 * Where a call goes when this repository declares nothing that could receive it.
 *
 * Three routes, each grounded in an import statement the file actually wrote:
 *
 * - the receiver is a local or a field whose declared type name is imported from outside;
 * - the receiver names an imported type directly, as in `Assertions.assertEquals(…)`;
 * - the callee is a bare name a `import static` brought in from a type outside the repository.
 *
 * `null` when none applies, which keeps the unresolved reason honest for the cases that really are
 * unbound — a local whose type was never written down stays `root-type-unknown`.
 */
function externalCalleeOf(input: {
  readonly site: RepositoryIR['callSites'][number];
  readonly scope: FileScope;
  readonly index: JavaTypeIndex;
  readonly localsByOwner: ReadonlyMap<NodeId, ReadonlyMap<string, LocalVariableFact>>;
  readonly declarationById: ReadonlyMap<NodeId, DeclarationIR>;
  readonly fieldTypeOf: ReadonlyMap<NodeId, NodeId>;
}): { readonly target: JavaExternalTarget; readonly evidence: string } | null {
  const { site, scope } = input;
  const root = site.calleeRootName;

  if (root === null) {
    return null;
  }

  if (site.calleeMemberName === null) {
    // A bare call. Only a static import can send one outside the repository; anything else is a
    // member of the enclosing type, and if that failed to bind it is genuinely unbound.
    const owner = scope.staticImports.get(root);

    if (owner === undefined || input.index.byQualifiedName(owner).length > 0) {
      return null;
    }

    const classified = classifyJavaImport(owner);

    return {
      target: classified.target,
      evidence: `'${root}' is statically imported from '${owner}', which is outside this repository`,
    };
  }

  // A local or a field whose *declared type* the file imported from outside.
  const enclosing = site.enclosingDeclarationId;
  const local = enclosing === null ? undefined : input.localsByOwner.get(enclosing)?.get(root);
  const receiverTypeName = local?.declaredTypeName ?? local?.constructedTypeName ?? null;

  if (receiverTypeName !== null) {
    const external = classifyJavaTypeName(receiverTypeName, scope);

    return external === null
      ? null
      : {
          target: external.target,
          evidence: `'${root}' is a local declared as '${receiverTypeName}', which this file imports from outside the repository`,
        };
  }

  // `Type.staticMethod()` where the type is imported rather than declared here.
  const external = classifyJavaTypeName(root, scope);

  return external === null
    ? null
    : {
        target: external.target,
        evidence: `'${root}' names a type this file imports from outside the repository`,
      };
}

type Binding = {
  readonly targetId: NodeId;
  readonly kind: CallRelationship['kind'];
  readonly evidence: string;
};

type CallFailure =
  | 'callee-not-addressable'
  | 'root-not-bound'
  | 'root-type-unknown'
  | 'member-not-found';

function bindCall(input: {
  readonly site: RepositoryIR['callSites'][number];
  readonly scope: FileScope;
  readonly index: JavaTypeIndex;
  readonly declarationById: ReadonlyMap<NodeId, DeclarationIR>;
  readonly superTypesOf: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly fieldTypeOf: ReadonlyMap<NodeId, NodeId>;
  readonly unitByPath: ReadonlyMap<string, UnitInput>;
  readonly localsByOwner: ReadonlyMap<NodeId, ReadonlyMap<string, LocalVariableFact>>;
  readonly returnTypeNameOf: ReadonlyMap<NodeId, string>;
}): Binding | CallFailure {
  const { site, scope, index } = input;
  const root = site.calleeRootName;

  if (root === null) {
    return 'callee-not-addressable';
  }

  const enclosingType = enclosingTypeOf(site.enclosingDeclarationId, input.declarationById);

  // `super(...)` and `this(...)`: a constructor delegating. Bound through the proven heritage chain.
  if (site.calleeMemberName === null && (root === 'super' || root === 'this')) {
    if (enclosingType === null) {
      return 'root-type-unknown';
    }

    if (root === 'this') {
      const own = memberOf(enclosingType, constructorNameOf(enclosingType, input.declarationById), input);

      return own === null
        ? 'member-not-found'
        : { targetId: own, kind: 'this-member', evidence: 'delegates to another constructor of this class' };
    }

    for (const superType of input.superTypesOf.get(enclosingType) ?? []) {
      const found = memberOf(superType, constructorNameOf(superType, input.declarationById), input);

      if (found !== null) {
        return {
          targetId: found,
          kind: 'this-member',
          evidence: "calls the superclass constructor, through a supertype this file's imports proved",
        };
      }
    }

    return 'member-not-found';
  }

  // A bare `helper()`: a member of the enclosing type, or of something it was proven to extend.
  if (site.calleeMemberName === null) {
    if (site.isConstruction) {
      // `new Foo()` — the root is the type, and the target is its constructor when it declares one.
      return bindConstruction(root, input);
    }

    if (enclosingType !== null) {
      const own = memberOf(enclosingType, root, input);

      if (own !== null) {
        return { targetId: own, kind: 'this-member', evidence: `'${root}' is a member of the enclosing type` };
      }

      const inherited = inheritedMember(enclosingType, root, input);

      if (inherited !== null) {
        return {
          targetId: inherited.targetId,
          kind: 'this-member',
          evidence: `'${root}' is inherited from '${inherited.typeName}'`,
        };
      }
    }

    // A statically imported member: `import static Assertions.assertEquals`.
    const staticOwner = scope.staticImports.get(root);

    if (staticOwner !== undefined) {
      const owner = index.byQualifiedName(staticOwner)[0];
      const found = owner === undefined ? null : memberOf(owner.declarationId, root, input);

      if (found !== null) {
        return {
          targetId: found,
          kind: 'imported',
          evidence: `'${root}' is statically imported from '${staticOwner}'`,
        };
      }
    }

    return 'root-not-bound';
  }

  // `Type.staticMethod()` — the root names a type in scope.
  const asType = lookupType({ name: root, scope, index });

  if (asType.outcome === 'resolved') {
    const found = memberOf(asType.entry.declarationId, site.calleeMemberName, input);

    if (found !== null) {
      return {
        targetId: found,
        kind: 'static-member',
        evidence: `'${root}' names a type declaring '${site.calleeMemberName}'`,
      };
    }

    const inherited = inheritedMember(asType.entry.declarationId, site.calleeMemberName, input);

    return inherited === null
      ? 'member-not-found'
      : {
          targetId: inherited.targetId,
          kind: 'static-member',
          evidence: `'${site.calleeMemberName}' is inherited by '${root}' from '${inherited.typeName}'`,
        };
  }

  // `this.field.method()` or `field.method()` — the receiver is a field whose declared type is known.
  if (enclosingType !== null) {
    const receiver = root === 'this' ? site.calleeMemberName : root;
    const fieldId = root === 'this' ? null : memberOf(enclosingType, receiver, input);

    if (root === 'this') {
      // `this.method()` is a member call on the enclosing type itself.
      const own = memberOf(enclosingType, site.calleeMemberName, input);

      if (own !== null) {
        return {
          targetId: own,
          kind: 'this-member',
          evidence: `'${site.calleeMemberName}' is a member of the enclosing type`,
        };
      }

      const inherited = inheritedMember(enclosingType, site.calleeMemberName, input);

      return inherited === null
        ? 'member-not-found'
        : {
            targetId: inherited.targetId,
            kind: 'this-member',
            evidence: `'${site.calleeMemberName}' is inherited from '${inherited.typeName}'`,
          };
    }

    if (fieldId !== null) {
      const fieldType = input.fieldTypeOf.get(fieldId);

      if (fieldType !== undefined) {
        const found = memberOf(fieldType, site.calleeMemberName, input);

        if (found !== null) {
          return {
            targetId: found,
            kind: 'namespace-member',
            evidence: `'${root}' is a field whose declared type declares '${site.calleeMemberName}'`,
          };
        }

        const inherited = inheritedMember(fieldType, site.calleeMemberName, input);

        if (inherited !== null) {
          return {
            targetId: inherited.targetId,
            kind: 'namespace-member',
            evidence: `'${root}' is a field whose type inherits '${site.calleeMemberName}' from '${inherited.typeName}'`,
          };
        }
      }

      return 'member-not-found';
    }
  }

  // `local.method()` — the receiver is a local variable whose type the source establishes.
  const localType = localTypeOf(site.enclosingDeclarationId, root, input);

  if (localType !== null) {
    const found =
      memberOf(localType.typeId, site.calleeMemberName, input) ??
      inheritedMember(localType.typeId, site.calleeMemberName, input)?.targetId ??
      null;

    return found === null
      ? 'member-not-found'
      : {
          targetId: found,
          kind: 'instance-member',
          evidence: `'${root}' is a local ${localType.evidence}`,
        };
  }

  // Anything else needs the type of a chained expression or of a local the source never typed —
  // a lambda parameter, an enhanced-for variable over an inferred element type. Java has an answer;
  // reading it needs a classpath and full type checking.
  return 'root-type-unknown';
}

/**
 * The declaration a local variable's type resolves to, and why.
 *
 * Three rules in decreasing strength, and the first that answers wins — which is also the order in
 * which the source states the type most plainly:
 *
 * 1. `Foo foo = …` — the declared type. Written down, so nothing is inferred beyond the lookup.
 * 2. `var foo = new Foo()` — the constructed type. The initialiser states it.
 * 3. `var foo = Bar.make()` — `make`'s declared return type, resolvable only when `Bar.make` is a
 *    method this repository declares. A factory in a dependency ends the search rather than being
 *    guessed past.
 */
function localTypeOf(
  enclosingId: NodeId | null,
  name: string,
  input: Parameters<typeof bindCall>[0],
): { readonly typeId: NodeId; readonly evidence: string } | null {
  if (enclosingId === null) {
    return null;
  }

  const local = input.localsByOwner.get(enclosingId)?.get(name);

  if (local === undefined) {
    return null;
  }

  const declared = resolveTypeName(local.declaredTypeName, input);

  if (declared !== null) {
    return { typeId: declared, evidence: `declared as '${String(local.declaredTypeName)}'` };
  }

  const constructed = resolveTypeName(local.constructedTypeName, input);

  if (constructed !== null) {
    return {
      typeId: constructed,
      evidence: `initialised with 'new ${String(local.constructedTypeName)}()'`,
    };
  }

  if (local.factory === null) {
    return null;
  }

  const factoryOwner = resolveTypeName(local.factory.rootName, input);

  if (factoryOwner === null) {
    return null;
  }

  const factoryMethod =
    memberOf(factoryOwner, local.factory.memberName, input) ??
    inheritedMember(factoryOwner, local.factory.memberName, input)?.targetId ??
    null;
  const returnTypeName = factoryMethod === null ? undefined : input.returnTypeNameOf.get(factoryMethod);
  const returned = resolveTypeName(returnTypeName ?? null, input);

  return returned === null
    ? null
    : {
        typeId: returned,
        evidence: `initialised from '${local.factory.rootName}.${local.factory.memberName}()', which returns '${String(returnTypeName)}'`,
      };
}

/** A type name resolved unambiguously to a declaration in this repository, or `null`. */
function resolveTypeName(
  name: string | null,
  input: Parameters<typeof bindCall>[0],
): NodeId | null {
  if (name === null) {
    return null;
  }

  const lookup = lookupType({ name, scope: input.scope, index: input.index });

  return lookup.outcome === 'resolved' ? lookup.entry.declarationId : null;
}

function bindConstruction(
  typeName: string,
  input: Parameters<typeof bindCall>[0],
): Binding | CallFailure {
  const lookup = lookupType({ name: typeName, scope: input.scope, index: input.index });

  if (lookup.outcome !== 'resolved') {
    return 'root-not-bound';
  }

  const constructor = memberOf(
    lookup.entry.declarationId,
    constructorNameOf(lookup.entry.declarationId, input.declarationById),
    input,
  );

  if (constructor !== null) {
    return {
      targetId: constructor,
      kind: 'imported',
      evidence: `constructs '${typeName}', which declares a constructor`,
    };
  }

  // A default constructor is generated rather than written, so there is no declaration to point at.
  // The type itself is the honest target: construction genuinely depends on it.
  return {
    targetId: lookup.entry.declarationId,
    kind: 'imported',
    evidence: `constructs '${typeName}', which declares no explicit constructor`,
  };
}

/** The type a declaration sits inside, walking up its container chain. */
function enclosingTypeOf(
  declarationId: NodeId | null,
  declarationById: ReadonlyMap<NodeId, DeclarationIR>,
): NodeId | null {
  if (declarationId === null) {
    return null;
  }

  const declaration = declarationById.get(declarationId);

  if (declaration === undefined) {
    return null;
  }

  if (isTypeKind(declaration.kind)) {
    return declarationId;
  }

  // The chain is the addressable path, so the owner is every segment but the last. Walking upwards
  // rather than assuming one level handles a method on a nested class.
  const filePrefix = declarationId.slice(0, declarationId.indexOf('#') + 1);

  for (let depth = declaration.containerChain.length - 1; depth > 0; depth -= 1) {
    const candidate = `${filePrefix}${declaration.containerChain.slice(0, depth).join('.')}` as NodeId;
    const owner = declarationById.get(candidate);

    if (owner !== undefined && isTypeKind(owner.kind)) {
      return candidate;
    }
  }

  return null;
}

function isTypeKind(kind: DeclarationIR['kind']): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'enum';
}

/** A member declared directly on a type, by simple name. `null` when the type declares none. */
function memberOf(
  typeId: NodeId,
  memberName: string | null,
  input: Parameters<typeof bindCall>[0],
): NodeId | null {
  if (memberName === null) {
    return null;
  }

  const owner = input.declarationById.get(typeId);

  if (owner === undefined) {
    return null;
  }

  const filePrefix = typeId.slice(0, typeId.indexOf('#') + 1);
  const candidate = `${filePrefix}${[...owner.containerChain, memberName].join('.')}` as NodeId;

  return input.declarationById.has(candidate) ? candidate : null;
}

/** A type's own constructor name, which in Java is the type's simple name. */
function constructorNameOf(
  typeId: NodeId,
  declarationById: ReadonlyMap<NodeId, DeclarationIR>,
): string | null {
  return declarationById.get(typeId)?.name ?? null;
}

/**
 * Walks the proven supertype chain for a member, breadth-first.
 *
 * Breadth-first because Java resolves the nearest override, so the closest declaration is the one a
 * reader would reach. Only supertypes that were *proven* are walked: a base class from a jar ends the
 * search rather than being guessed past. The visited set guards against a cycle, which valid Java
 * cannot contain but malformed input can — and must not hang a scan.
 */
function inheritedMember(
  typeId: NodeId,
  memberName: string,
  input: Parameters<typeof bindCall>[0],
): { readonly targetId: NodeId; readonly typeName: string } | null {
  const visited = new Set<NodeId>([typeId]);
  const queue = [...(input.superTypesOf.get(typeId) ?? [])];

  while (queue.length > 0) {
    const current = queue.shift() as NodeId;

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    const found = memberOf(current, memberName, input);

    if (found !== null) {
      return { targetId: found, typeName: input.declarationById.get(current)?.name ?? 'a supertype' };
    }

    queue.push(...(input.superTypesOf.get(current) ?? []));
  }

  return null;
}

function explain(reason: CallFailure, calleeText: string): string {
  switch (reason) {
    case 'callee-not-addressable':
      return `'${calleeText}' is not rooted at an identifier, so there is no name to bind`;

    case 'root-not-bound':
      return `'${calleeText}' matches no member of the enclosing type, no proven supertype and no static import`;

    case 'member-not-found':
      return `the receiver of '${calleeText}' was identified, but it declares no matching member in analysed source`;

    default:
      return `binding '${calleeText}' would need the declared type of its receiver, which is a local or a chained expression this analyser does not infer`;
  }
}

/** Builds the type index from the IR, pairing each type with the members it declares. */
function buildIndex(input: {
  readonly ir: RepositoryIR;
  readonly pathByFileId: ReadonlyMap<NodeId, string>;
  readonly units: readonly UnitInput[];
}): JavaTypeIndex {
  const packageByPath = new Map(input.units.map((unit) => [unit.path, unit.packageName]));
  const membersByOwner = new Map<string, Map<string, NodeId[]>>();

  for (const declaration of input.ir.declarations) {
    if (declaration.containerChain.length < 2) {
      continue;
    }

    const path = input.pathByFileId.get(declaration.fileId);

    if (path === undefined) {
      continue;
    }

    const ownerKey = `${path}#${declaration.containerChain.slice(0, -1).join('.')}`;
    const bucket = membersByOwner.get(ownerKey) ?? new Map<string, NodeId[]>();
    const names = bucket.get(declaration.name) ?? [];

    names.push(declaration.id);
    bucket.set(declaration.name, names);
    membersByOwner.set(ownerKey, bucket);
  }

  const types = input.ir.declarations
    .filter((declaration) => isTypeKind(declaration.kind))
    .flatMap((declaration) => {
      const path = input.pathByFileId.get(declaration.fileId);

      if (path === undefined) {
        return [];
      }

      return [
        {
          declarationId: declaration.id,
          filePath: path,
          packageName: packageByPath.get(path) ?? null,
          chain: declaration.containerChain,
          members:
            membersByOwner.get(`${path}#${declaration.containerChain.join('.')}`) ??
            new Map<string, readonly NodeId[]>(),
        },
      ];
    });

  return buildTypeIndex(types);
}

/**
 * Classifies an import that names nothing this repository declares.
 *
 * `java.*` and `javax.*` are the standard library — a fact about the platform, not a guess. Everything
 * else is read as a Maven coordinate's package, which is what an unresolved Java import almost always
 * is. The *name* recorded is the package prefix rather than a Maven `group:artifact`: mapping one to
 * the other needs the dependency's metadata, and this analyser opens no jars.
 */
interface JavaExternalTarget {
  readonly kind: 'external';
  readonly origin: ExternalOrigin;
  readonly name: string;
  readonly ecosystem: Ecosystem;
}

function classifyJavaImport(specifier: string): {
  readonly target: JavaExternalTarget;
  readonly evidence: string;
} {
  if (isJavaStandardLibrary(specifier)) {
    return {
      target: {
        kind: 'external',
        origin: 'standard-library',
        name: javaPackageOf(specifier),
        ecosystem: 'maven',
      },
      evidence: `'${specifier}' is in the Java standard library`,
    };
  }

  return {
    target: {
      kind: 'external',
      origin: 'package',
      name: javaPackageOf(specifier),
      ecosystem: 'maven',
    },
    evidence: `'${specifier}' names no type in this repository, so its package is read as an external dependency`,
  };
}

/**
 * Classifies a *type name* that resolved to nothing, using what the file imported.
 *
 * `null` when the name cannot be attributed to anything outside the repository either — an unimported
 * simple name is most often a type parameter, and calling it a dependency would fabricate one.
 */
function classifyJavaTypeName(
  name: string,
  scope: FileScope,
): { readonly target: JavaExternalTarget; readonly evidence: string } | null {
  const imported = scope.singleTypeImports.get(name);

  if (imported !== undefined) {
    return classifyJavaImport(imported);
  }

  if (name.includes('.')) {
    return classifyJavaImport(name);
  }

  // `String`, `Object`, `Integer` and friends need no import: `java.lang` is implicit, and that is a
  // property of the language rather than of this file.
  //
  // Checked against the actual `java.lang` list, not against the `java.` prefix. Asking whether
  // `java.lang.<name>` looks standard would answer yes for *every* bare name — so a type parameter
  // `T` would have been recorded as a dependency on java.lang, in every generic class in the
  // repository.
  if (isJavaLangType(name)) {
    return {
      target: {
        kind: 'external',
        origin: 'standard-library',
        name: 'java.lang',
        ecosystem: 'maven',
      },
      evidence: `'${name}' is implicitly available from java.lang`,
    };
  }

  return null;
}

/** Also used by the framework reader, which needs the same view of a file's imports. */
export { buildFileScope };
export type { TypeEntry };
