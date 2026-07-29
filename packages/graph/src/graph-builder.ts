import type { DeclarationIR, DeclarationKind, RepositoryIR } from '@traceiq/ir';
import type {
  ResolutionTarget,
  ResolvedDeclaration,
  ResolvedRelationship,
  ResolvedRepository,
  UnresolvedReference,
} from '@traceiq/resolver';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

import { translateAnnotations } from './annotation-translator.js';
import { translateCallGraph } from './call-translator.js';
import { GraphConstraintError, validateGraph } from './constraints.js';
import { edgeIdentity, strongerConfidence } from './identity.js';
import { declaringNodeIdOf } from './declares.js';
import { externalIdentityOf } from './external-identity.js';
import {
  NO_FRAMEWORK_ANNOTATIONS,
  type ExternalIdKind,
  type GraphEdge,
  type GraphNode,
  type GraphUnresolvedReference,
  type NodeKind,
  type RepositoryGraph,
} from './types.js';
import type { CallGraph } from '@traceiq/call-graph';
import type { FrameworkAnnotations } from '@traceiq/framework';

/** Version 1 writes a fixed revision. Spec §8.3. */
export const PLACEHOLDER_REVISION_ID = 1;

const PRODUCER = 'graph-builder';

const NODE_KIND_BY_DECLARATION_KIND: Readonly<Record<DeclarationKind, NodeKind>> = {
  class: 'Class',
  interface: 'Interface',
  'type-alias': 'TypeAlias',
  enum: 'Enum',
  'enum-member': 'EnumMember',
  function: 'Function',
  method: 'Method',
  property: 'Property',
  accessor: 'Accessor',
  constructor: 'Constructor',
  variable: 'Variable',
  namespace: 'Namespace',
};

interface PendingExternal {
  readonly kind: ExternalIdKind;
  readonly name: string | null;
  confidence: ConfidenceLevel;
  references: number;
}

/**
 * Translates structured facts into the graph defined by `docs/04-graph-spec.md`.
 *
 * A pure function of its inputs: no filesystem, no compiler, no database, and no
 * state kept between calls. It resolves nothing, infers nothing, and recomputes no
 * edge's confidence. The only value it derives beyond a field copy is listed in
 * spec §0 — `DECLARES` parentage, external identity and its confidence, and edge
 * identity — and each is mechanical.
 *
 * The result is validated before it is returned, so an invalid graph is never handed
 * to the store.
 */
export class GraphBuilder {
  build(input: {
    readonly ir: RepositoryIR;
    readonly resolved: ResolvedRepository;
    readonly annotations?: FrameworkAnnotations;
    readonly callGraph?: CallGraph;
  }): RepositoryGraph {
    const annotations = input.annotations ?? NO_FRAMEWORK_ANNOTATIONS;
    const enrichment = new Map<NodeId, ResolvedDeclaration>(
      input.resolved.declarations.map((entry) => [entry.declarationId, entry]),
    );

    // File nodes come first so that a declaration's file_id always references a node
    // that already exists, which the store depends on when inserting.
    const nodes: GraphNode[] = input.ir.files.map((file) => fileNode(file));
    const declarationIds = new Set(input.ir.declarations.map((entry) => entry.id));

    for (const declaration of input.ir.declarations) {
      nodes.push(declarationNode(declaration, enrichment.get(declaration.id)));
    }

    const edges: GraphEdge[] = [];

    for (const declaration of input.ir.declarations) {
      edges.push(declaresEdge(declaration, declaringNodeIdOf(declaration, declarationIds)));
    }

    const externals = new Map<NodeId, PendingExternal>();

    for (const relationship of input.resolved.relationships) {
      edges.push(relationshipEdge(relationship, externals));
    }

    // Externals are discovered while walking relationships, so they are sorted by
    // identity to keep the output independent of discovery order.
    for (const id of [...externals.keys()].sort()) {
      const pending = externals.get(id);

      if (pending !== undefined) {
        nodes.push(externalNode(id, pending));
      }
    }

    const unresolved = input.resolved.unresolved.map((entry) => unresolvedRow(entry));

    // Framework annotations are translated last: their Route nodes and READS edges refer
    // to declarations and files, which by now all exist.
    const framework = translateAnnotations({ annotations });

    nodes.push(...framework.nodes);
    edges.push(...framework.edges);
    unresolved.push(...framework.unresolved);

    // Calls are translated last: every source and target is a declaration or file that
    // already exists by now.
    const calls = translateCallGraph(input.callGraph ?? { calls: [], unresolved: [] });

    edges.push(...calls.edges);
    unresolved.push(...calls.unresolved);

    validateGraph({
      nodes,
      edges,
      unresolvedSourceIds: unresolved.map((entry) => entry.sourceId),
      roleNodeIds: framework.roles.map((role) => role.nodeId),
    });

    return {
      repository: input.ir.repository,
      revisionId: PLACEHOLDER_REVISION_ID,
      fileIds: input.ir.files.map((file) => file.id),
      nodes,
      edges,
      unresolved,
      roles: framework.roles,
    };
  }
}

function fileNode(file: RepositoryIR['files'][number]): GraphNode {
  return {
    id: file.id,
    kind: 'File',
    name: file.path,
    fileId: null,
    containerChain: null,
    visibility: null,
    isExported: false,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
    isDeclarationFile: file.isDeclarationFile,
    hasSymbol: null,
    isExportedFromModule: null,
    externalKind: null,
    externalName: null,
    confidence: 'CERTAIN',
    provenance: {
      producer: PRODUCER,
      fileId: file.id,
      evidence: 'recorded by the IR Builder as a source file of this repository',
    },
    locations: [],
  };
}

/**
 * Enrichment is absent when the Resolver recorded none for a declaration. Both
 * enrichment fields then stay `null`, meaning *not established* rather than false —
 * substituting `0` would assert a checker result that was never obtained.
 */
function declarationNode(
  declaration: DeclarationIR,
  enrichment: ResolvedDeclaration | undefined,
): GraphNode {
  const base = `recorded by the IR Builder as a ${declaration.kind} declaration`;

  return {
    id: declaration.id,
    kind: NODE_KIND_BY_DECLARATION_KIND[declaration.kind],
    name: declaration.name,
    fileId: declaration.fileId,
    containerChain: declaration.containerChain.join('.'),
    visibility: declaration.visibility,
    isExported: declaration.modifiers.isExported,
    isStatic: declaration.modifiers.isStatic,
    isAbstract: declaration.modifiers.isAbstract,
    isReadonly: declaration.modifiers.isReadonly,
    isOptional: declaration.modifiers.isOptional,
    isAsync: declaration.modifiers.isAsync,
    isDeclarationFile: null,
    hasSymbol: enrichment?.hasSymbol ?? null,
    isExportedFromModule: enrichment?.isExportedFromModule ?? null,
    externalKind: null,
    externalName: null,
    confidence: 'CERTAIN',
    provenance: {
      producer: PRODUCER,
      fileId: declaration.fileId,
      evidence:
        enrichment === undefined ? base : `${base}; ${enrichment.provenance.evidence}`,
    },
    locations: declaration.locations,
  };
}

function externalNode(id: NodeId, pending: PendingExternal): GraphNode {
  return {
    id,
    kind: 'External',
    name: pending.name ?? pending.kind,
    fileId: null,
    containerChain: null,
    visibility: null,
    isExported: false,
    isStatic: false,
    isAbstract: false,
    isReadonly: false,
    isOptional: false,
    isAsync: false,
    isDeclarationFile: null,
    hasSymbol: null,
    isExportedFromModule: null,
    externalKind: pending.kind,
    externalName: pending.name,
    confidence: pending.confidence,
    provenance: {
      producer: PRODUCER,
      fileId: null,
      evidence: `introduced as the target of ${pending.references} resolved reference(s)`,
    },
    locations: [],
  };
}

function declaresEdge(declaration: DeclarationIR, parentId: NodeId): GraphEdge {
  // The IR guarantees at least one site. Failing here rather than substituting a
  // placeholder keeps a malformed input visible instead of persisting a fiction.
  const location = declaration.locations[0];

  if (location === undefined) {
    throw new GraphConstraintError(`declaration ${declaration.id} has no source location`);
  }

  return {
    id: edgeIdentity('DECLARES', parentId, declaration.id, null, declaration.fileId, location),
    type: 'DECLARES',
    sourceId: parentId,
    targetId: declaration.id,
    name: declaration.name,
    confidence: 'CERTAIN',
    candidateGroup: null,
    ordinal: null,
    provenance: {
      producer: PRODUCER,
      fileId: declaration.fileId,
      evidence: `declares the ${declaration.kind} '${declaration.name}', established syntactically`,
    },
    location,
  };
}

/**
 * Copies a resolved relationship into an edge.
 *
 * The confidence is copied verbatim — never recomputed. The only work here is
 * turning the Resolver's target union into a single target identity, which for an
 * external means minting its identity and recording that it exists.
 */
function relationshipEdge(
  relationship: ResolvedRelationship,
  externals: Map<NodeId, PendingExternal>,
): GraphEdge {
  const targetId = targetIdentity(relationship, externals);

  return {
    id: edgeIdentity(
      relationship.type,
      relationship.sourceId,
      targetId,
      relationship.name,
      relationship.provenance.fileId,
      relationship.location,
    ),
    type: relationship.type,
    sourceId: relationship.sourceId,
    targetId,
    name: relationship.name,
    confidence: relationship.confidence,
    candidateGroup: relationship.candidateGroup,
    ordinal: null,
    provenance: {
      producer: relationship.provenance.resolver,
      fileId: relationship.provenance.fileId,
      evidence: relationship.provenance.evidence,
    },
    location: relationship.location,
  };
}

function targetIdentity(
  relationship: ResolvedRelationship,
  externals: Map<NodeId, PendingExternal>,
): NodeId {
  const target: ResolutionTarget = relationship.target;

  if (target.kind === 'declaration') {
    return target.declarationId;
  }

  if (target.kind === 'file') {
    return target.fileId;
  }

  const identity = externalIdentityOf(target, relationship.name);
  const existing = externals.get(identity.id);

  if (existing === undefined) {
    externals.set(identity.id, {
      kind: identity.kind,
      name: identity.name,
      confidence: relationship.confidence,
      references: 1,
    });

    return identity.id;
  }

  // The only confidence the builder computes: an external exists with the strongest
  // confidence of any edge that introduced it, because the best evidence settles
  // whether a thing exists. Deterministic and order-independent.
  existing.confidence = strongerConfidence(existing.confidence, relationship.confidence);
  existing.references += 1;

  return identity.id;
}

function unresolvedRow(reference: UnresolvedReference): GraphUnresolvedReference {
  return {
    id: [
      'unresolved',
      reference.type,
      reference.sourceId,
      reference.name ?? '',
      reference.reason,
      reference.provenance.fileId,
      `${reference.location.startLine}:${reference.location.startColumn}`,
    ].join('|'),
    type: reference.type,
    sourceId: reference.sourceId,
    name: reference.name,
    reason: reference.reason,
    text: reference.text,
    provenance: {
      producer: reference.provenance.resolver,
      fileId: reference.provenance.fileId,
      evidence: reference.provenance.evidence,
    },
    location: reference.location,
  };
}
