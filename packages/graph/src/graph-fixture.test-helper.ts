import type {
  DeclarationIR,
  DeclarationKind,
  DeclarationModifiers,
  FileIR,
  RepositoryIR,
  SourceRange,
} from '@traceiq/ir';
import type {
  ResolutionTarget,
  ResolvedDeclaration,
  ResolvedRelationship,
  ResolvedRelationshipType,
  ResolvedRepository,
  UnresolvedReference,
} from '@traceiq/resolver';
import type {
  EnvironmentVariableAnnotation,
  FrameworkAnnotations,
  RoleAnnotation,
  RouteAnnotation,
} from '@traceiq/framework';
import type { ConfidenceLevel, NodeId, Role } from '@traceiq/types';

/**
 * Synthetic inputs for the Graph Builder.
 *
 * The Builder is a pure function of an IR and a `ResolvedRepository`, so its tests
 * construct those directly. That keeps each test precise about the one fact it is
 * checking, and needs no TypeScript program. The end-to-end path is covered
 * separately in `pipeline.test.ts`.
 */

export const ROOT_PATH = '/repo';

const NO_MODIFIERS: DeclarationModifiers = {
  isExported: false,
  isStatic: false,
  isAbstract: false,
  isReadonly: false,
  isOptional: false,
  isAsync: false,
};

export const range = (startLine: number): SourceRange => ({
  startLine,
  startColumn: 1,
  endLine: startLine,
  endColumn: 20,
});

export function file(path: string, isDeclarationFile = false): FileIR {
  return { id: `file:${path}` as NodeId, path, isDeclarationFile };
}

export function declaration(input: {
  readonly path: string;
  readonly chain: readonly string[];
  readonly kind?: DeclarationKind;
  readonly visibility?: DeclarationIR['visibility'];
  readonly modifiers?: Partial<DeclarationModifiers>;
  readonly lines?: readonly number[];
}): DeclarationIR {
  const chain = input.chain;

  return {
    id: `sym:${input.path}#${chain.join('.')}` as NodeId,
    fileId: `file:${input.path}` as NodeId,
    kind: input.kind ?? 'class',
    name: chain[chain.length - 1] ?? 'anonymous',
    containerChain: chain,
    visibility: input.visibility ?? null,
    modifiers: { ...NO_MODIFIERS, ...input.modifiers },
    locations: (input.lines ?? [1]).map(range),
  };
}

export function ir(input: {
  readonly files: readonly FileIR[];
  readonly declarations?: readonly DeclarationIR[];
}): RepositoryIR {
  return {
    repository: { name: 'repo', rootPath: ROOT_PATH },
    files: input.files,
    declarations: input.declarations ?? [],
    imports: [],
    exports: [],
    callSites: [],
    memberAccesses: [],
  };
}

export function declarationTarget(id: string): ResolutionTarget {
  return { kind: 'declaration', declarationId: id as NodeId };
}

export function fileTarget(path: string): ResolutionTarget {
  return { kind: 'file', fileId: `file:${path}` as NodeId };
}

export function externalTarget(
  origin: 'package' | 'node-builtin' | 'typescript-lib' | 'outside-analysis',
  name: string | null = null,
): ResolutionTarget {
  return { kind: 'external', origin, name };
}

export function relationship(input: {
  readonly type: ResolvedRelationshipType;
  readonly sourceId: string;
  readonly target: ResolutionTarget;
  readonly name?: string | null;
  readonly confidence?: ConfidenceLevel;
  readonly fileId?: string;
  readonly line?: number;
  readonly candidateGroup?: string | null;
}): ResolvedRelationship {
  return {
    type: input.type,
    sourceId: input.sourceId as NodeId,
    target: input.target,
    name: input.name ?? null,
    confidence: input.confidence ?? 'RESOLVED',
    provenance: {
      resolver: 'imports',
      fileId: (input.fileId ?? 'file:a.ts') as NodeId,
      evidence: 'synthetic relationship for testing',
    },
    location: range(input.line ?? 1),
    candidateGroup: input.candidateGroup ?? null,
  };
}

export function enrichment(input: {
  readonly declarationId: string;
  readonly hasSymbol?: boolean;
  readonly isExportedFromModule?: boolean;
}): ResolvedDeclaration {
  return {
    declarationId: input.declarationId as NodeId,
    hasSymbol: input.hasSymbol ?? true,
    isExportedFromModule: input.isExportedFromModule ?? false,
    provenance: {
      resolver: 'declarations',
      fileId: 'file:a.ts' as NodeId,
      evidence: 'synthetic enrichment for testing',
    },
  };
}

export function unresolvedReference(input: {
  readonly sourceId: string;
  readonly type?: ResolvedRelationshipType;
  readonly reason?: UnresolvedReference['reason'];
  readonly text?: string;
  readonly fileId?: string;
}): UnresolvedReference {
  return {
    type: input.type ?? 'IMPORTS',
    sourceId: input.sourceId as NodeId,
    name: null,
    reason: input.reason ?? 'module-not-resolved',
    text: input.text ?? './nowhere',
    provenance: {
      resolver: 'imports',
      fileId: (input.fileId ?? 'file:a.ts') as NodeId,
      evidence: 'synthetic unresolved reference for testing',
    },
    location: range(1),
  };
}

export function resolved(input: {
  readonly declarations?: readonly ResolvedDeclaration[];
  readonly relationships?: readonly ResolvedRelationship[];
  readonly unresolved?: readonly UnresolvedReference[];
}): ResolvedRepository {
  return {
    repository: { name: 'repo', rootPath: ROOT_PATH },
    declarations: input.declarations ?? [],
    relationships: input.relationships ?? [],
    unresolved: input.unresolved ?? [],
  };
}

/** A role annotation as the Framework Extractor would produce it. */
export function roleAnnotation(input: {
  readonly declarationId: string;
  readonly role: Role;
  readonly fileId?: string;
}): RoleAnnotation {
  return {
    declarationId: input.declarationId as NodeId,
    role: input.role,
    confidence: 'INFERRED',
    provenance: {
      annotator: 'roles',
      fileId: (input.fileId ?? 'file:src/a.ts') as NodeId,
      evidence: 'synthetic role annotation for testing',
    },
    location: range(1),
  };
}

export function routeAnnotation(input: {
  readonly method: RouteAnnotation['method'];
  readonly path: string;
  readonly handlers: readonly { readonly text: string; readonly declarationId: string | null }[];
  readonly fileId?: string;
  readonly line?: number;
  readonly registeredIn?: string | null;
}): RouteAnnotation {
  return {
    method: input.method,
    path: input.path,
    handlers: input.handlers.map((handler, ordinal) => ({
      text: handler.text,
      ordinal,
      declarationId: handler.declarationId as NodeId | null,
    })),
    registeredInDeclarationId: (input.registeredIn ?? null) as NodeId | null,
    confidence: 'INFERRED',
    provenance: {
      annotator: 'routes',
      fileId: (input.fileId ?? 'file:src/a.ts') as NodeId,
      evidence: 'synthetic route annotation for testing',
    },
    location: range(input.line ?? 1),
  };
}

export function environmentAnnotation(input: {
  readonly name: string;
  readonly usedIn?: string | null;
  readonly fileId?: string;
  readonly line?: number;
}): EnvironmentVariableAnnotation {
  return {
    name: input.name,
    usedInDeclarationId: (input.usedIn ?? null) as NodeId | null,
    confidence: 'INFERRED',
    provenance: {
      annotator: 'environment',
      fileId: (input.fileId ?? 'file:src/a.ts') as NodeId,
      evidence: 'synthetic environment annotation for testing',
    },
    location: range(input.line ?? 1),
  };
}

export function annotations(input: {
  readonly roles?: readonly RoleAnnotation[];
  readonly routes?: readonly RouteAnnotation[];
  readonly environmentVariables?: readonly EnvironmentVariableAnnotation[];
  readonly framework?: 'express' | null;
}): FrameworkAnnotations {
  return {
    framework: input.framework ?? (input.routes === undefined ? null : 'express'),
    roles: input.roles ?? [],
    routes: input.routes ?? [],
    environmentVariables: input.environmentVariables ?? [],
  };
}
