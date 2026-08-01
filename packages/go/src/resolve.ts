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

import {
  isExportedName,
  type EmbeddingFact,
  type LocalVariableFact,
  type ReceiverFact,
  type ResultTypeFact,
  type TypeReferenceFact,
} from './extract.js';
import { directoryOf, type GoPackageIndex } from './package-index.js';
import { isGoStandardLibrary } from './stdlib.js';

const PRODUCER = 'go';

/** What the extractor found for one file, as the resolver consumes it. */
export interface FileInput {
  readonly path: string;
  readonly packageName: string | null;
  readonly embeddings: readonly EmbeddingFact[];
  readonly typeReferences: readonly TypeReferenceFact[];
  readonly receivers: readonly ReceiverFact[];
  readonly localVariables: readonly LocalVariableFact[];
  readonly resultTypes: readonly ResultTypeFact[];
  /** Local name → import path, from this file's imports. */
  readonly importAliases: ReadonlyMap<string, string>;
}

/**
 * Binds Go's names across files.
 *
 * **Go's package rule is exact, and that is what raises the confidence here above the other
 * grammar-backed analysers.** An import path resolves to a directory by arithmetic on the module path,
 * with no search path and no ambiguity — so an import bound this way is `RESOLVED`, not inferred. What
 * stays inferred is anything needing a *value's* type:
 *
 * - an import path inside this repository's modules resolves to that directory — RESOLVED
 * - an import path elsewhere resolves to an external, in the Go ecosystem or the standard library
 * - an embedded type resolves the way a type name resolves in the file that wrote it
 * - a type in a signature resolves the same way
 * - a call to a bare name resolves to a package-level declaration in the same package
 * - `pkg.Func()` resolves through the import alias to that package's exported declaration — RESOLVED,
 *   because the qualifier names a package and packages are unambiguous
 * - `recv.Method()` resolves when `recv` is the method's own receiver, or a field whose type is known
 *
 * Everything else is unresolved with a reason. A call on a local whose type came from a function's
 * return value is not bound: Go's inference is real but reproducing it needs full type checking.
 */
export function resolveGo(input: {
  readonly ir: RepositoryIR;
  readonly files: readonly FileInput[];
  readonly index: GoPackageIndex;
}): { readonly resolved: ResolvedRepository; readonly callGraph: CallGraph } {
  const pathByFileId = new Map(input.ir.files.map((file) => [file.id, file.path]));
  const declarationById = new Map(input.ir.declarations.map((entry) => [entry.id, entry]));
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));

  const relationships: ResolvedRelationship[] = [];
  const unresolved: UnresolvedReference[] = [];

  // ---- imports ------------------------------------------------------------------------------
  for (const statement of input.ir.imports) {
    const path = pathByFileId.get(statement.fileId);

    if (path === undefined) {
      continue;
    }

    const directory = input.index.directoryFor(statement.moduleSpecifier);

    if (directory !== null) {
      relationships.push({
        type: 'IMPORTS',
        sourceId: statement.fileId,
        // A package is a directory, and a directory is not a node. The package's declarations are, so
        // the honest target for the *statement* is the package clause's own directory — represented by
        // whichever file declares it. Pointing at one file of several would be arbitrary, so the
        // statement binds to the package's exported declarations below instead.
        target: { kind: 'declaration', declarationId: packageAnchorOf(directory, input) },
        name: statement.bindings[0]?.localName ?? null,
        // Exact: the module path plus the directory is the import path, with no search involved.
        confidence: 'RESOLVED',
        candidateGroup: null,
        provenance: {
          resolver: 'imports',
          fileId: statement.fileId,
          evidence: `'${statement.moduleSpecifier}' is this repository's module path plus '${directory}'`,
        },
        location: statement.location,
      });

      continue;
    }

    const external = classifyGoImport(statement.moduleSpecifier);

    relationships.push({
      type: 'IMPORTS',
      sourceId: statement.fileId,
      target: external.target,
      name: statement.bindings[0]?.localName ?? null,
      // Never RESOLVED: no module cache was read, so this is what the path says.
      confidence: 'INFERRED',
      candidateGroup: null,
      provenance: { resolver: 'imports', fileId: statement.fileId, evidence: external.evidence },
      location: statement.location,
    });
  }

  // ---- embedded types, which is how Go composes ---------------------------------------------
  const embeddedOf = new Map<NodeId, NodeId[]>();

  for (const file of input.files) {
    for (const embedding of file.embeddings) {
      const resolvedTarget = lookupTypeName({
        typeName: embedding.typeName,
        qualifier: embedding.qualifier,
        file,
        index: input.index,
        declarationById,
      });

      if (resolvedTarget === null) {
        const external = classifyGoTypeName(embedding.qualifier, file);

        if (external === null) {
          unresolved.push({
            type: 'EXTENDS',
            sourceId: embedding.declarationId,
            name: embedding.typeName,
            reason: 'no-declaration',
            text: embedding.text,
            provenance: {
              resolver: 'heritage',
              fileId: fileId(file.path),
              evidence: `'${embedding.text}' embeds a type this repository does not declare and no import identifies`,
            },
            location: embedding.location,
          });

          continue;
        }

        relationships.push({
          type: 'EXTENDS',
          sourceId: embedding.declarationId,
          target: external.target,
          name: embedding.typeName,
          confidence: 'INFERRED',
          candidateGroup: null,
          provenance: { resolver: 'heritage', fileId: fileId(file.path), evidence: external.evidence },
          location: embedding.location,
        });

        continue;
      }

      // EXTENDS because promotion is what embedding does: a method on the embedded type is reachable
      // through the embedder, which is the relationship a reader is looking for.
      relationships.push({
        type: 'EXTENDS',
        sourceId: embedding.declarationId,
        target: { kind: 'declaration', declarationId: resolvedTarget },
        name: embedding.typeName,
        confidence: 'RESOLVED',
        candidateGroup: null,
        provenance: {
          resolver: 'heritage',
          fileId: fileId(file.path),
          evidence: `'${embedding.text}' embeds a type this repository declares, promoting its methods`,
        },
        location: embedding.location,
      });

      const bucket = embeddedOf.get(embedding.declarationId) ?? [];

      bucket.push(resolvedTarget);
      embeddedOf.set(embedding.declarationId, bucket);
    }
  }

  // ---- type references ----------------------------------------------------------------------
  for (const file of input.files) {
    for (const reference of file.typeReferences) {
      const resolvedTarget = lookupTypeName({
        typeName: reference.typeName,
        qualifier: reference.qualifier,
        file,
        index: input.index,
        declarationById,
      });

      if (resolvedTarget === null) {
        const external = classifyGoTypeName(reference.qualifier, file);

        if (external === null) {
          unresolved.push({
            type: 'REFERENCES_TYPE',
            sourceId: reference.declarationId,
            name: reference.typeName,
            reason: 'no-declaration',
            text: reference.text,
            provenance: {
              resolver: 'type-references',
              fileId: fileId(file.path),
              evidence: `'${reference.typeName}' names no type in this package and no imported package; it may be a builtin or a type parameter`,
            },
            location: reference.location,
          });

          continue;
        }

        relationships.push({
          type: 'REFERENCES_TYPE',
          sourceId: reference.declarationId,
          target: external.target,
          name: reference.typeName,
          confidence: 'INFERRED',
          candidateGroup: null,
          provenance: {
            resolver: 'type-references',
            fileId: fileId(file.path),
            evidence: external.evidence,
          },
          location: reference.location,
        });

        continue;
      }

      relationships.push({
        type: 'REFERENCES_TYPE',
        sourceId: reference.declarationId,
        target: { kind: 'declaration', declarationId: resolvedTarget },
        name: reference.typeName,
        confidence: 'RESOLVED',
        candidateGroup: null,
        provenance: {
          resolver: 'type-references',
          fileId: fileId(file.path),
          evidence:
            reference.qualifier === null
              ? `'${reference.typeName}' is declared in this package`
              : `'${reference.qualifier}.${reference.typeName}' is exported by an imported package in this repository`,
        },
        location: reference.location,
      });
    }
  }

  // ---- calls --------------------------------------------------------------------------------
  const calls: CallRelationship[] = [];
  const externalCalls: ExternalCall[] = [];
  const unresolvedCalls: UnresolvedCall[] = [];

  /** A field's declared type, so `s.store.Save()` can bind. From the references just proven. */
  const fieldTypeOf = new Map<NodeId, NodeId>();

  for (const relationship of relationships) {
    if (relationship.type !== 'REFERENCES_TYPE' || relationship.target.kind !== 'declaration') {
      continue;
    }

    const declaration = declarationById.get(relationship.sourceId);

    if (declaration?.kind === 'property' && !fieldTypeOf.has(relationship.sourceId)) {
      fieldTypeOf.set(relationship.sourceId, relationship.target.declarationId);
    }
  }

  /** Receiver variable → its type's declaration, per method, so `s.field` and `s.Method()` bind. */
  const receiverTypeOf = new Map<NodeId, { variable: string | null; typeId: NodeId }>();

  for (const file of input.files) {
    for (const receiver of file.receivers) {
      const typeId = lookupTypeName({
        typeName: receiver.typeName,
        qualifier: null,
        file,
        index: input.index,
        declarationById,
      });

      if (typeId !== null) {
        receiverTypeOf.set(receiver.declarationId, { variable: receiver.variableName, typeId });
      }
    }
  }

  /** A function's or method's first result type, so `x := NewThing()` gives `x` a type. */
  const resultTypeOf = new Map<NodeId, { typeName: string; qualifier: string | null }>();

  for (const file of input.files) {
    for (const result of file.resultTypes) {
      resultTypeOf.set(result.declarationId, {
        typeName: result.typeName,
        qualifier: result.qualifier,
      });
    }
  }

  /** Locals by the function that declares them, then by name. */
  const localsByOwner = new Map<NodeId, Map<string, LocalVariableFact>>();

  for (const file of input.files) {
    for (const local of file.localVariables) {
      const bucket = localsByOwner.get(local.ownerId) ?? new Map<string, LocalVariableFact>();

      // First wins. A `:=` in a nested block may redeclare a name, but neither shadows the other at
      // any single call site, and choosing the later one would be no more right than the earlier.
      if (!bucket.has(local.name)) {
        bucket.set(local.name, local);
      }

      localsByOwner.set(local.ownerId, bucket);
    }
  }

  for (const site of input.ir.callSites) {
    const path = pathByFileId.get(site.fileId);
    const file = path === undefined ? undefined : fileByPath.get(path);

    if (path === undefined || file === undefined) {
      continue;
    }

    const sourceId = site.enclosingDeclarationId ?? site.fileId;

    // `fmt.Println()`, `gin.New()` — the qualifier is an import alias for a package outside this
    // repository. Go's package rule makes that exact: the alias names one import path and no
    // search is involved. Until this milestone these were reported `root-not-bound`, which was
    // both the wrong reason and the largest single category in every Go repository measured —
    // 4,082 of gin's 7,254 unresolved calls, 13,135 of client-go's 30,891.
    const externalPath =
      site.calleeMemberName !== null && site.calleeRootName !== null
        ? externalImportPathOf(site.calleeRootName, file, input.index)
        : null;

    if (externalPath !== null) {
      const classified = classifyGoImport(externalPath);

      externalCalls.push({
        sourceId,
        origin: classified.target.origin,
        name: classified.target.name,
        ecosystem: classified.target.ecosystem,
        calleeText: site.calleeText,
        // The same confidence the *internal* package-qualified rule earns, and for the same
        // reason: a package qualifier is unambiguous. What is not proven is that the package
        // declares this member, which is why the edge names the package rather than a
        // declaration inside it.
        confidence: 'RESOLVED',
        provenance: {
          producer: PRODUCER,
          fileId: site.fileId,
          evidence: `'${site.calleeRootName ?? ''}' is the imported package '${externalPath}', which is outside this repository's modules`,
        },
        location: site.location,
      });

      continue;
    }

    const bound = bindCall({
      site,
      file,
      index: input.index,
      declarationById,
      embeddedOf,
      fieldTypeOf,
      receiverTypeOf,
      localsByOwner,
      resultTypeOf,
    });

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
      confidence: bound.confidence,
      provenance: { producer: PRODUCER, fileId: site.fileId, evidence: bound.evidence },
      location: site.location,
      candidateGroup: null,
    });
  }

  return {
    resolved: { repository: input.ir.repository, declarations: [], relationships, unresolved },
    callGraph: { calls, externalCalls, unresolved: unresolvedCalls },
  };
}

type Binding = {
  readonly targetId: NodeId;
  readonly kind: CallRelationship['kind'];
  readonly confidence: 'RESOLVED' | 'INFERRED';
  readonly evidence: string;
};

type CallFailure = 'callee-not-addressable' | 'root-not-bound' | 'root-type-unknown' | 'member-not-found';

function bindCall(input: {
  readonly site: RepositoryIR['callSites'][number];
  readonly file: FileInput;
  readonly index: GoPackageIndex;
  readonly declarationById: ReadonlyMap<NodeId, DeclarationIR>;
  readonly embeddedOf: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly fieldTypeOf: ReadonlyMap<NodeId, NodeId>;
  readonly receiverTypeOf: ReadonlyMap<NodeId, { variable: string | null; typeId: NodeId }>;
  readonly localsByOwner: ReadonlyMap<NodeId, ReadonlyMap<string, LocalVariableFact>>;
  readonly resultTypeOf: ReadonlyMap<NodeId, { typeName: string; qualifier: string | null }>;
}): Binding | CallFailure {
  const { site, file, index } = input;
  const root = site.calleeRootName;

  if (root === null) {
    return 'callee-not-addressable';
  }

  const ownDirectory = directoryOf(file.path);

  // A bare `helper()` — a package-level declaration in this package.
  if (site.calleeMemberName === null) {
    const local = index.exported(ownDirectory, root)[0];

    return local === undefined
      ? 'root-not-bound'
      : {
          targetId: local,
          kind: 'local',
          // Exact: Go's package scope is the directory, and the name is declared in it.
          confidence: 'RESOLVED',
          evidence: `'${root}' is declared at package level in this package`,
        };
  }

  // `pkg.Func()` — the root is an import alias.
  const importPath = file.importAliases.get(root);

  if (importPath !== undefined) {
    const directory = index.directoryFor(importPath);

    if (directory === null) {
      return 'root-not-bound';
    }

    const found = index.exported(directory, site.calleeMemberName)[0];

    return found === undefined
      ? 'member-not-found'
      : {
          targetId: found,
          kind: 'namespace-member',
          // A package qualifier is unambiguous, and the name is exported by that package.
          confidence: 'RESOLVED',
          evidence: `'${root}' is the package '${importPath}', which declares '${site.calleeMemberName}'`,
        };
  }

  const receiver = site.enclosingDeclarationId === null ? undefined : input.receiverTypeOf.get(site.enclosingDeclarationId);

  // `s.Method()` where `s` is this method's own receiver.
  if (receiver !== undefined && receiver.variable === root) {
    const own = memberOf(receiver.typeId, site.calleeMemberName, input);

    if (own !== null) {
      return {
        targetId: own,
        kind: 'this-member',
        // A method set is decided at compile time, but an interface value dispatches at runtime.
        confidence: 'INFERRED',
        evidence: `'${site.calleeMemberName}' is a method on the receiver's type`,
      };
    }

    const promoted = promotedMember(receiver.typeId, site.calleeMemberName, input);

    if (promoted !== null) {
      return {
        targetId: promoted.targetId,
        kind: 'this-member',
        confidence: 'INFERRED',
        evidence: `'${site.calleeMemberName}' is promoted from the embedded type '${promoted.typeName}'`,
      };
    }

    // `s.field.Method()` is a selector on a selector, which arrives here as `s.field`; the member is
    // then the field rather than a method.
    const field = memberOf(receiver.typeId, root, input);

    if (field !== null) {
      return 'member-not-found';
    }

    return 'member-not-found';
  }

  // `x.Method()` where `x` is a field of the enclosing type whose declared type is known.
  if (receiver !== undefined) {
    const field = memberOf(receiver.typeId, root, input);
    const fieldType = field === null ? undefined : input.fieldTypeOf.get(field);

    if (fieldType !== undefined) {
      const found =
        memberOf(fieldType, site.calleeMemberName, input) ??
        promotedMember(fieldType, site.calleeMemberName, input)?.targetId ??
        null;

      return found === null
        ? 'member-not-found'
        : {
            targetId: found,
            kind: 'namespace-member',
            confidence: 'INFERRED',
            evidence: `'${root}' is a field whose declared type provides '${site.calleeMemberName}'`,
          };
    }
  }

  // `x.Method()` where `x` is a local whose type the source establishes.
  const localType = localTypeOf(site.enclosingDeclarationId, root, input);

  if (localType !== null) {
    const found =
      memberOf(localType.typeId, site.calleeMemberName, input) ??
      promotedMember(localType.typeId, site.calleeMemberName, input)?.targetId ??
      null;

    return found === null
      ? 'member-not-found'
      : {
          targetId: found,
          kind: 'instance-member',
          // A method set is fixed at compile time, but the variable may hold an interface value, so
          // this reaches the method a reader would expect rather than the one that must run.
          confidence: 'INFERRED',
          evidence: `'${root}' is a local ${localType.evidence}`,
        };
  }

  // Anything else needs the type of a local Go infers from something this reader cannot follow — a
  // range variable, a channel receive, a type assertion, a multi-value call.
  return 'root-type-unknown';
}

/**
 * The declaration a local variable's type resolves to, and why.
 *
 * Three rules in decreasing strength, first answer wins. Each is a statement the source makes:
 * `var s Server` writes the type, `s := Server{}` constructs it, `s := NewServer()` takes it from a
 * signature. A factory whose function this repository does not declare ends the search rather than
 * being guessed past.
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

  const resolve = (typeName: string | null, qualifier: string | null): NodeId | null =>
    typeName === null
      ? null
      : lookupTypeName({
          typeName,
          qualifier,
          file: input.file,
          index: input.index,
          declarationById: input.declarationById,
        });

  const declared = resolve(local.declaredTypeName, local.declaredQualifier);

  if (declared !== null) {
    return { typeId: declared, evidence: `declared as '${String(local.declaredTypeName)}'` };
  }

  const composite = resolve(local.compositeTypeName, local.compositeQualifier);

  if (composite !== null) {
    return {
      typeId: composite,
      evidence: `initialised with a '${String(local.compositeTypeName)}' literal`,
    };
  }

  if (local.factory === null) {
    return null;
  }

  const factoryId = factoryDeclarationOf(local.factory, input);
  const result = factoryId === null ? undefined : input.resultTypeOf.get(factoryId);

  if (result === undefined || factoryId === null) {
    return null;
  }

  // Resolved in the *factory's* package, not the caller's. `func New() *Store` in package `store`
  // names `Store` with no qualifier because it is local to that package; looking the bare name up
  // where the call was written searches the caller's directory, which does not declare it. This is
  // why `inner := store.New()` followed by `inner.Load()` stayed unbound.
  const returned = input.index
    .exported(directoryOf(pathOfDeclaration(factoryId)), result.typeName)
    .find((id) => {
      const kind = input.declarationById.get(id)?.kind;

      return kind === 'class' || kind === 'interface';
    });

  return returned === undefined
    ? null
    : {
        typeId: returned,
        evidence: `initialised from '${local.factory.rootName}${local.factory.memberName === null ? '' : `.${local.factory.memberName}`}()', which returns '${result.typeName}'`,
      };
}

/** The declaration a factory call names: a function in this package, or one in an imported one. */
function factoryDeclarationOf(
  factory: { readonly rootName: string; readonly memberName: string | null },
  input: Parameters<typeof bindCall>[0],
): NodeId | null {
  if (factory.memberName === null) {
    return input.index.exported(directoryOf(input.file.path), factory.rootName)[0] ?? null;
  }

  const importPath = input.file.importAliases.get(factory.rootName);
  const directory = importPath === undefined ? null : input.index.directoryFor(importPath);

  return directory === null ? null : (input.index.exported(directory, factory.memberName)[0] ?? null);
}

/** A member declared on a type, by name. */
function memberOf(
  typeId: NodeId,
  memberName: string,
  input: Parameters<typeof bindCall>[0],
): NodeId | null {
  const owner = input.declarationById.get(typeId);

  if (owner === undefined) {
    return null;
  }

  const filePrefix = typeId.slice(0, typeId.indexOf('#') + 1);
  const candidate = `${filePrefix}${[...owner.containerChain, memberName].join('.')}` as NodeId;

  if (input.declarationById.has(candidate)) {
    return candidate;
  }

  // A method may be declared in a *different file* of the same package from the type it is on. The
  // package index is keyed by directory for exactly this reason, and skipping it would lose most of a
  // real Go repository's methods.
  const directory = directoryOf(filePrefix.slice('sym:'.length).replace(/#$/, ''));
  const chained = `${owner.containerChain.join('.')}.${memberName}`;

  for (const candidateId of input.index.exported(directory, memberName)) {
    const declaration = input.declarationById.get(candidateId);

    if (declaration !== undefined && declaration.containerChain.join('.') === chained) {
      return candidateId;
    }
  }

  return null;
}

/**
 * Walks the embedded-type chain for a promoted member, breadth-first.
 *
 * Go promotes a method from an embedded type onto the embedder, and the shallowest promotion wins —
 * which is why this is breadth-first. Only embeddings that were *proven* are walked: a type embedded
 * from a dependency ends the search rather than being guessed past.
 */
function promotedMember(
  typeId: NodeId,
  memberName: string,
  input: Parameters<typeof bindCall>[0],
): { readonly targetId: NodeId; readonly typeName: string } | null {
  const visited = new Set<NodeId>([typeId]);
  const queue = [...(input.embeddedOf.get(typeId) ?? [])];

  while (queue.length > 0) {
    const current = queue.shift() as NodeId;

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    const found = memberOf(current, memberName, input);

    if (found !== null) {
      return { targetId: found, typeName: input.declarationById.get(current)?.name ?? 'an embedded type' };
    }

    queue.push(...(input.embeddedOf.get(current) ?? []));
  }

  return null;
}

/** Resolves a type name, local or package-qualified, to a declaration in this repository. */
function lookupTypeName(input: {
  readonly typeName: string;
  readonly qualifier: string | null;
  readonly file: FileInput;
  readonly index: GoPackageIndex;
  readonly declarationById: ReadonlyMap<NodeId, DeclarationIR>;
}): NodeId | null {
  const isType = (id: NodeId): boolean => {
    const kind = input.declarationById.get(id)?.kind;

    return kind === 'class' || kind === 'interface';
  };

  if (input.qualifier === null) {
    // A local type: declared somewhere in this package, which is this directory.
    return input.index.exported(directoryOf(input.file.path), input.typeName).find(isType) ?? null;
  }

  const importPath = input.file.importAliases.get(input.qualifier);
  const directory = importPath === undefined ? null : input.index.directoryFor(importPath);

  if (directory === null) {
    return null;
  }

  return input.index.exported(directory, input.typeName).find(isType) ?? null;
}

/**
 * Something to attach a package-level import edge to.
 *
 * A Go package is a directory, and a directory is not a graph node. The package's first exported
 * declaration by identifier order is used as a stable anchor so the *statement* has a target — chosen
 * deterministically rather than by discovery order, so two scans agree.
 */
function packageAnchorOf(
  directory: string,
  input: { readonly ir: RepositoryIR; readonly index: GoPackageIndex },
): NodeId {
  const candidates = input.ir.declarations
    .filter(
      (declaration) =>
        declaration.containerChain.length === 1 &&
        isExportedName(declaration.name) &&
        directoryOf(pathOfDeclaration(declaration.id)) === directory,
    )
    .map((declaration) => declaration.id)
    .sort();

  return (
    candidates[0] ??
    // A package with nothing exported still exists. Its first declaration of any visibility anchors the
    // edge; a package with no declarations at all cannot be imported meaningfully in the first place.
    (input.ir.declarations
      .filter((declaration) => directoryOf(pathOfDeclaration(declaration.id)) === directory)
      .map((declaration) => declaration.id)
      .sort()[0] as NodeId)
  );
}

function pathOfDeclaration(declarationId: NodeId): string {
  // The identifier carries the path: `sym:<path>#<chain>`.
  const withoutPrefix = declarationId.slice('sym:'.length);
  const hash = withoutPrefix.indexOf('#');

  return hash === -1 ? withoutPrefix : withoutPrefix.slice(0, hash);
}

function explain(reason: CallFailure, calleeText: string): string {
  switch (reason) {
    case 'callee-not-addressable':
      return `'${calleeText}' is not rooted at an identifier, so there is no name to bind`;

    case 'root-not-bound':
      return `'${calleeText}' matches no package-level declaration in this package and no import alias`;

    case 'member-not-found':
      return `the receiver of '${calleeText}' was identified, but it provides no matching method in analysed source`;

    default:
      return `binding '${calleeText}' would need the inferred type of a local, which Go establishes and this analyser does not reproduce`;
  }
}

/**
 * Classifies an import path outside this repository's modules.
 *
 * A path with no dot in its first segment is standard library — `net/http`, `fmt`, `os` — because the
 * Go toolchain reserves exactly those. Everything else is a module, named by its path, which is what a
 * Go dependency *is*: `github.com/gin-gonic/gin` is both the import path and the module identity, so
 * no mapping is needed and none is invented.
 */
function classifyGoImport(importPath: string): {
  readonly target: {
    readonly kind: 'external';
    readonly origin: ExternalOrigin;
    readonly name: string;
    readonly ecosystem: Ecosystem;
  };
  readonly evidence: string;
} {
  if (isGoStandardLibrary(importPath)) {
    return {
      target: { kind: 'external', origin: 'standard-library', name: importPath, ecosystem: 'go' },
      evidence: `'${importPath}' has no dot in its first segment, which the Go toolchain reserves for the standard library`,
    };
  }

  return {
    target: { kind: 'external', origin: 'package', name: importPath, ecosystem: 'go' },
    evidence: `'${importPath}' names a module outside this repository`,
  };
}

/**
 * The import path a qualifier names, when that path lies outside this repository's modules.
 *
 * `null` when the qualifier is not an import alias at all — a receiver variable, a local, a
 * package-level name — or when it names a package this repository does hold, which `bindCall`
 * resolves to a declaration instead.
 */
function externalImportPathOf(
  qualifier: string,
  file: FileInput,
  index: GoPackageIndex,
): string | null {
  const importPath = file.importAliases.get(qualifier);

  if (importPath === undefined) {
    return null;
  }

  return index.directoryFor(importPath) === null ? importPath : null;
}

/** Classifies a *type name* whose package this repository does not hold. */
function classifyGoTypeName(
  qualifier: string | null,
  file: FileInput,
): ReturnType<typeof classifyGoImport> | null {
  if (qualifier === null) {
    // An unqualified name that resolved to nothing is a Go builtin — `string`, `error`, `int` — or a
    // type parameter. Neither is a dependency, and claiming one would fabricate it.
    return null;
  }

  const importPath = file.importAliases.get(qualifier);

  return importPath === undefined ? null : classifyGoImport(importPath);
}
