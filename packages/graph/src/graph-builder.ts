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
import { translateCallGraph, translateExternalCalls } from './call-translator.js';
import { GraphConstraintError, validateGraph } from './constraints.js';
import { edgeIdentity, strongerConfidence } from './identity.js';
import { declaringNodeIdOf } from './declares.js';
import { externalIdentityOf } from './external-identity.js';
import { NO_CAPABILITIES } from './capabilities.js';
import { linkClientCallsToRoutes } from './client-route-linker.js';
import {
  dependencyId,
  technologyId,
  fileId,
  manifestId,
  universalFactsFromAnalysedFiles,
  type UniversalFacts,
} from './universal-facts.js';
import {
  NO_FRAMEWORK_ANNOTATIONS,
  type ExternalIdKind,
  type GraphEdge,
  type GraphNode,
  type GraphUnresolvedReference,
  type NodeKind,
  type RepositoryGraph,
} from './types.js';
import { EMPTY_CALL_GRAPH, type CallGraph } from '@traceiq/call-graph';
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
    /**
     * Structure, languages, manifests and capabilities, from the Repository Scanner.
     *
     * Required, and the reason a graph exists for a repository no analyser can read.
     * File nodes are built from here rather than from the IR, so a Python file and a
     * README are in the graph exactly as a `.ts` file is.
     *
     * Optional only so the builder can be exercised from an IR alone. Omitted, the files
     * the analyser read stand in for the repository's files and the graph reports
     * `universal` depth with no regions — true of what it was given, and never what a
     * real scan supplies.
     */
    readonly universal?: UniversalFacts;
    /**
     * One language analyser's contribution, for a caller that has exactly one.
     *
     * Equivalent to passing a single entry in `analyses`, and kept because most callers and every
     * existing test have one analyser. Prepended to `analyses` when both are given.
     */
    readonly ir?: RepositoryIR;
    readonly resolved?: ResolvedRepository;
    readonly annotations?: FrameworkAnnotations;
    readonly callGraph?: CallGraph;
    /**
     * Every language analyser's contribution, merged into one graph.
     *
     * This is what makes a polyglot repository a single graph rather than several. Merging is safe
     * because node identity is derived from repository-relative paths — `file:apps/web/src/a.ts`,
     * `sym:ml/app/main.py#Service.run` — so two analysers reading disjoint files cannot collide, and
     * the merge is concatenation rather than reconciliation.
     */
    readonly analyses?: readonly RepositoryAnalysis[];
  }): RepositoryGraph {
    const analyses = collectAnalyses(input);
    const annotations = mergeAnnotations(analyses);
    const resolved = mergeResolved(analyses);
    const declarations = analyses.flatMap((analysis) => analysis.ir.declarations);
    const callGraph = mergeCallGraphs(analyses);
    const universal = input.universal ?? universalFactsFromIr(input.ir);

    const enrichment = new Map<NodeId, ResolvedDeclaration>(
      resolved.declarations.map((entry) => [entry.declarationId, entry]),
    );

    // File nodes come first so that a declaration's file_id always references a node
    // that already exists, which the store depends on when inserting. They come from the
    // universal facts, which cover every file; the IR's files are a subset of these and
    // share their identity, so a declaration attaches to the node already built here.
    const declarationFiles = new Set(
      analyses
        .flatMap((analysis) => analysis.ir.files)
        .filter((file) => file.isDeclarationFile)
        .map((file) => file.path),
    );

    const nodes: GraphNode[] = universal.files.map((file) =>
      fileNode(file, declarationFiles.has(file.path)),
    );

    nodes.push(...manifestNodes(universal));
    nodes.push(...technologyNodes(universal));

    const declarationIds = new Set(declarations.map((entry) => entry.id));

    for (const declaration of declarations) {
      nodes.push(declarationNode(declaration, enrichment.get(declaration.id)));
    }

    const edges: GraphEdge[] = [...dependencyEdges(universal, nodes)];

    for (const declaration of declarations) {
      edges.push(declaresEdge(declaration, declaringNodeIdOf(declaration, declarationIds)));
    }

    const externals = new Map<NodeId, PendingExternal>();

    for (const relationship of resolved.relationships) {
      edges.push(relationshipEdge(relationship, externals));
    }

    // External calls are translated here rather than with the rest of the call graph
    // below, because they introduce External nodes and those must be minted before the
    // loop that emits them. They share the `externals` map with imports on purpose: a
    // package called *and* imported is one node, discovered twice.
    const externalCalls = translateExternalCalls(callGraph.externalCalls, (registration) =>
      registerExternal(externals, registration),
    );

    // Externals are discovered while walking relationships, so they are sorted by
    // identity to keep the output independent of discovery order.
    for (const id of [...externals.keys()].sort()) {
      const pending = externals.get(id);

      if (pending !== undefined) {
        nodes.push(externalNode(id, pending));
      }
    }

    const unresolved = resolved.unresolved.map((entry) => unresolvedRow(entry));

    // Framework annotations are translated last: their Route nodes and READS edges refer
    // to declarations and files, which by now all exist.
    const framework = translateAnnotations({ annotations });

    nodes.push(...framework.nodes);
    edges.push(...framework.edges);
    unresolved.push(...framework.unresolved);

    // Calls are translated last: every source and target is a declaration or file that
    // already exists by now.
    const calls = translateCallGraph(callGraph);

    edges.push(...calls.edges);
    edges.push(...externalCalls);

    // After routes exist as nodes: the linker matches a request's literal path against them, which
    // is what turns two language-scoped subgraphs into one system.
    edges.push(
      ...linkClientCallsToRoutes({
        clientCalls: annotations.clientCalls,
        routes: nodes.filter((node) => node.kind === 'Route'),
      }),
    );
    unresolved.push(...calls.unresolved);

    const distinctUnresolved = dedupeUnresolved(unresolved);

    validateGraph({
      nodes,
      edges,
      unresolvedSourceIds: distinctUnresolved.map((entry) => entry.sourceId),
      roleNodeIds: framework.roles.map((role) => role.nodeId),
    });

    return {
      repository: universal.repository,
      revisionId: PLACEHOLDER_REVISION_ID,
      fileIds: universal.files.map((file) => fileId(file.path)),
      nodes,
      edges,
      unresolved: distinctUnresolved,
      roles: framework.roles,
      capabilities: universal.capabilities,
    };
  }
}

/** One analyser's four structures, as the builder consumes them. */
export interface RepositoryAnalysis {
  readonly ir: RepositoryIR;
  readonly resolved: ResolvedRepository;
  readonly callGraph: CallGraph;
  readonly annotations: FrameworkAnnotations;
}

/** The singular convenience form, followed by any explicit analyses. */
function collectAnalyses(input: {
  readonly ir?: RepositoryIR;
  readonly resolved?: ResolvedRepository;
  readonly annotations?: FrameworkAnnotations;
  readonly callGraph?: CallGraph;
  readonly analyses?: readonly RepositoryAnalysis[];
}): readonly RepositoryAnalysis[] {
  const singular: readonly RepositoryAnalysis[] =
    input.ir === undefined
      ? []
      : [
          {
            ir: input.ir,
            resolved: input.resolved ?? EMPTY_RESOLVED,
            callGraph: input.callGraph ?? EMPTY_CALL_GRAPH,
            annotations: input.annotations ?? NO_FRAMEWORK_ANNOTATIONS,
          },
        ];

  return [...singular, ...(input.analyses ?? [])];
}

/**
 * Concatenates resolved facts across analysers.
 *
 * `repository` is taken from the first analyser and is not merged: it names the repository, which is
 * the same whichever analyser reports it, and the universal facts are the authority anyway.
 */
function mergeResolved(analyses: readonly RepositoryAnalysis[]): ResolvedRepository {
  if (analyses.length === 1) {
    return analyses[0]?.resolved ?? EMPTY_RESOLVED;
  }

  return {
    repository: analyses[0]?.resolved.repository ?? EMPTY_RESOLVED.repository,
    declarations: analyses.flatMap((analysis) => analysis.resolved.declarations),
    relationships: analyses.flatMap((analysis) => analysis.resolved.relationships),
    unresolved: analyses.flatMap((analysis) => analysis.resolved.unresolved),
  };
}

function mergeCallGraphs(analyses: readonly RepositoryAnalysis[]): CallGraph {
  if (analyses.length === 1) {
    return analyses[0]?.callGraph ?? EMPTY_CALL_GRAPH;
  }

  return {
    calls: analyses.flatMap((analysis) => analysis.callGraph.calls),
    externalCalls: analyses.flatMap((analysis) => analysis.callGraph.externalCalls),
    unresolved: analyses.flatMap((analysis) => analysis.callGraph.unresolved),
  };
}

/**
 * Merges framework annotations.
 *
 * `framework` keeps the first analyser that detected one. A polyglot repository genuinely has
 * several — Express in the frontend, FastAPI in the backend — and this single field cannot say so;
 * the routes themselves carry their files, and region capabilities carry which analyser reached
 * framework depth, so nothing is lost that a reader needs.
 */
function mergeAnnotations(analyses: readonly RepositoryAnalysis[]): FrameworkAnnotations {
  if (analyses.length === 1) {
    return analyses[0]?.annotations ?? NO_FRAMEWORK_ANNOTATIONS;
  }

  return {
    framework:
      analyses.map((analysis) => analysis.annotations.framework).find((name) => name !== null) ??
      null,
    roles: analyses.flatMap((analysis) => analysis.annotations.roles),
    clientCalls: analyses.flatMap((analysis) => analysis.annotations.clientCalls),
    routes: analyses.flatMap((analysis) => analysis.annotations.routes),
    environmentVariables: analyses.flatMap((analysis) => analysis.annotations.environmentVariables),
  };
}

/** Stands in for a scan when the builder is handed an IR and nothing else. */
function universalFactsFromIr(ir: RepositoryIR | undefined): UniversalFacts {
  return universalFactsFromAnalysedFiles({
    repository: ir?.repository ?? { name: '', rootPath: '' },
    files: (ir?.files ?? []).map((file) => ({ path: file.path, language: 'typescript' })),
    capabilities: NO_CAPABILITIES,
  });
}

/** A repository with no language analyser contributes no resolved facts at all. */
const EMPTY_RESOLVED: ResolvedRepository = {
  repository: { name: '', rootPath: '' },
  declarations: [],
  relationships: [],
  unresolved: [],
};

/**
 * One `Technology` node per technology detected in a region.
 *
 * **A technology is a node rather than a table row, and the distinction from a region is the
 * reason.** A region describes the *analysis* — how deeply TraceIQ read a directory — so making it
 * a node would put the analysis into search results alongside the code. A technology describes the
 * *repository*: that this project is built with Next.js is a fact about the software, of the same
 * kind as "this file declares that class", and a reader searching `next` should find it.
 *
 * The evidence travels in the provenance, which is where an explanation belongs and where every
 * other node in the graph carries one. Evidence files are not linked with edges: the vocabulary is
 * frozen and none of its members means "is proof of", and stretching `DEPENDS_ON` to cover it
 * would make that relationship unqueryable for what it does mean.
 */
function technologyNodes(universal: UniversalFacts): readonly GraphNode[] {
  return universal.technologies.map((technology) => ({
    ...BLANK_NODE,
    id: technologyId(technology.regionPath, technology.id),
    kind: 'Technology' as const,
    name: technology.name,
    // The region it was found in. A technology has no source position and no dotted chain, and the
    // region is genuinely what contains it — `apps/web` is where this Next.js is.
    containerChain: technology.regionPath === '' ? null : technology.regionPath,
    // The first proof anchors the node to a file, so Explorer and Navigation can reach it the way
    // they reach anything else. The rest are in the provenance.
    fileId: technology.evidence[0] === undefined ? null : fileId(technology.evidence[0].path),
    language: null,
    fileRole: null,
    externalKind: null,
    externalName: technology.id,
    category: technology.category,
    confidence: technology.confidence as GraphNode['confidence'],
    provenance: {
      producer: PRODUCER,
      fileId: technology.evidence[0] === undefined ? null : fileId(technology.evidence[0].path),
      evidence:
        `${technology.name} is used${technology.regionPath === '' ? '' : ` in ${technology.regionPath}`}: ` +
        technology.evidence.map((entry) => `${entry.path} ${entry.detail}`).join('; '),
    },
  }));
}

/**
 * One `Manifest` node per manifest, and one `Dependency` node per distinct declared name.
 *
 * Dependencies are pooled across manifests by ecosystem and name, so a monorepo declaring
 * `react` in six packages has one `Dependency` node with six `DEPENDS_ON` edges into it —
 * which is what makes "who depends on this" answerable.
 */
function manifestNodes(universal: UniversalFacts): readonly GraphNode[] {
  const nodes: GraphNode[] = [];
  const seenDependencies = new Set<NodeId>();

  for (const manifest of universal.manifests) {
    nodes.push({
      ...BLANK_NODE,
      id: manifestId(manifest.path),
      kind: 'Manifest',
      name: manifest.path,
      fileId: fileId(manifest.path),
      language: null,
      fileRole: 'manifest',
      category: null,
      // The file is there and its ecosystem follows from its name: both are observations,
      // not inferences. What it *declares* is weaker, and those edges say so.
      confidence: 'CERTAIN',
      provenance: {
        producer: PRODUCER,
        fileId: fileId(manifest.path),
        evidence: `a ${manifest.ecosystem} manifest found at ${manifest.path}`,
      },
    });

    for (const name of manifest.declaredDependencies) {
      const id = dependencyId(manifest.ecosystem, name);

      if (seenDependencies.has(id)) {
        continue;
      }

      seenDependencies.add(id);

      nodes.push({
        ...BLANK_NODE,
        id,
        kind: 'Dependency',
        name,
        externalKind: null,
        externalName: name,
        confidence: 'INFERRED',
        provenance: {
          producer: PRODUCER,
          fileId: fileId(manifest.path),
          evidence: `declared as a ${manifest.ecosystem} dependency; the manifest names it, which is not evidence that it is used`,
        },
      });
    }
  }

  return nodes;
}

/**
 * `DEPENDS_ON` from each manifest to what it declares.
 *
 * `INFERRED`, deliberately. A manifest naming a package is not proof the repository uses
 * it, and the graph already reserves `RESOLVED` for a reference the type checker bound.
 * Recording these at `CERTAIN` would let a declared-but-unused dependency look exactly
 * like a called one.
 */
function dependencyEdges(
  universal: UniversalFacts,
  nodes: readonly GraphNode[],
): readonly GraphEdge[] {
  const present = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];

  for (const manifest of universal.manifests) {
    const source = manifestId(manifest.path);

    for (const name of manifest.declaredDependencies) {
      const target = dependencyId(manifest.ecosystem, name);

      if (!present.has(target)) {
        continue;
      }

      edges.push({
        id: `edge:DEPENDS_ON|${source}|${target}`,
        type: 'DEPENDS_ON',
        sourceId: source,
        targetId: target,
        name,
        confidence: 'INFERRED',
        candidateGroup: null,
        ordinal: null,
        provenance: {
          producer: PRODUCER,
          fileId: fileId(manifest.path),
          evidence: `${manifest.path} declares '${name}' as a dependency`,
        },
        location: ORIGIN,
      });
    }
  }

  return edges;
}

/** A whole-file fact has no meaningful range; the origin stands for "the file itself". */
const ORIGIN = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } as const;

/** Every field a node must have, so a builder states only what distinguishes it. */
const BLANK_NODE = {
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
  externalKind: null,
  externalName: null,
  language: null,
  fileRole: null,
  category: null,
  locations: [],
} as const satisfies Partial<GraphNode>;

function fileNode(file: UniversalFacts['files'][number], isDeclarationFile: boolean): GraphNode {
  return {
    id: fileId(file.path),
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
    // Only a TypeScript declaration file is known to be one; for every other file the
    // question was never asked, and `null` says so rather than claiming false.
    isDeclarationFile: isDeclarationFile ? true : null,
    hasSymbol: null,
    isExportedFromModule: null,
    externalKind: null,
    externalName: null,
    language: file.language,
    fileRole: file.role,
    category: null,
    confidence: 'CERTAIN',
    provenance: {
      producer: PRODUCER,
      fileId: fileId(file.path),
      evidence: `found by the Repository Scanner; ${file.language === null ? 'no language recognised' : `identified as ${file.language}`} and classified as ${file.role} by extension and path`,
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
    language: null,
    fileRole: null,
    category: null,
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
    language: null,
    fileRole: null,
    category: null,
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

/**
 * Records that an external exists, pooling repeat sightings onto one node.
 *
 * Confidence is the strongest of any edge that introduced it, because the best evidence
 * settles whether a thing exists. Deterministic and independent of discovery order, which
 * is what lets imports and calls register into the same map in either sequence.
 */
function registerExternal(
  externals: Map<NodeId, PendingExternal>,
  input: {
    readonly id: NodeId;
    readonly kind: ExternalIdKind;
    readonly name: string | null;
    readonly confidence: ConfidenceLevel;
  },
): void {
  const existing = externals.get(input.id);

  if (existing === undefined) {
    externals.set(input.id, {
      kind: input.kind,
      name: input.name,
      confidence: input.confidence,
      references: 1,
    });

    return;
  }

  existing.confidence = strongerConfidence(existing.confidence, input.confidence);
  existing.references += 1;
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

/**
 * One row per distinct unresolved reference, first occurrence kept.
 *
 * An unresolved reference is a *fact* — this reference, at this place, could not be bound, for this
 * reason — and the identity above carries every part of that fact. Two rows sharing it are therefore
 * the same fact recorded twice, not two facts, and the graph's node and edge assembly already
 * follows exactly this rule.
 *
 * Not defensive tidying. `from dash import Dash, html, dcc, html, ...` names `html` twice in one
 * statement, which is legal Python, and each binding produced an identical row. The store's primary
 * key then rejected the write and the **whole scan failed** — 3,137 files lost to one redundant
 * import. Any analyser can produce a repeated binding, so this is enforced where identity is decided
 * rather than in each analyser.
 */
function dedupeUnresolved(
  rows: readonly GraphUnresolvedReference[],
): readonly GraphUnresolvedReference[] {
  const byId = new Map<string, GraphUnresolvedReference>();

  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }

  return [...byId.values()];
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
