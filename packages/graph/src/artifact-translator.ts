import { environmentVariableId, fileId } from '@traceiq/shared';
import type { NodeId } from '@traceiq/types';

import type { GraphEdge, GraphNode, GraphUnresolvedReference } from './types.js';
import { artifactElementId, technologyId, type UniversalArtifact, type UniversalFacts } from './universal-facts.js';

/**
 * Translates artefact analysis into graph rows.
 *
 * Pure translation, like every other translator here: nothing is inferred, no confidence is recomputed,
 * and the only derived values are node identities. The **one** judgement it makes is resolution — an
 * artefact says `./scripts/deploy.sh` and this decides whether the repository holds a file by that name —
 * and that judgement is a set membership test against the scan's own inventory rather than a guess.
 *
 * **An unresolvable reference is recorded, not dropped.** A workflow naming a script that does not exist
 * is a real fact about the repository, frequently an interesting one, and the graph has held a place for
 * exactly this since the resolver was written. So it lands in `unresolved_references` with its literal
 * text and the reason, and the absence of a `RUNS` edge stays distinguishable from the absence of a
 * command.
 *
 * **A reference with two candidates resolves to at most one.** `scripts/build.sh` in a workflow at
 * `.github/workflows/ci.yml` might mean the repository root or the workflow's own directory; both
 * candidates are offered by the reader, this takes the first that exists, and the edge's evidence names
 * which. Where both exist the root wins, because that is what a CI runner's default working directory is —
 * and the edge says so rather than leaving a reader to assume it.
 */

const PRODUCER = '@traceiq/graph (artefacts)';

const ORIGIN = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } as const;

export interface ArtifactTranslation {
  /** `ArtifactElement` nodes, plus any `EnvironmentVariable` no other capability had minted. */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly GraphUnresolvedReference[];
  /**
   * What artefact analysis established per file, for the `File` nodes the builder is about to make.
   *
   * The summary and the boundary travel with the family because they belong on the file rather than on an
   * element: they describe the *reading of the whole artefact*, and the boundary in particular is the
   * sentence that stops an artefact holding no elements from reading as an artefact that declares nothing.
   */
  readonly artifactByPath: ReadonlyMap<string, ArtifactFileFacts>;
}

export interface ArtifactFileFacts {
  readonly kind: string;
  readonly summary: string;
  readonly boundary: string;
}

export function translateArtifacts(input: {
  readonly artifacts: readonly UniversalArtifact[];
  /** Every file the scan found, so a reference can be resolved against what exists. */
  readonly filePaths: ReadonlySet<string>;
  /** Technologies, so a `CONFIGURES` edge can name the node the detector already minted. */
  readonly technologies: UniversalFacts['technologies'];
  /** Environment variables other capabilities already minted, so this does not duplicate them. */
  readonly existingVariableIds: ReadonlySet<NodeId>;
}): ArtifactTranslation {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolved: GraphUnresolvedReference[] = [];
  const artifactByPath = new Map<string, ArtifactFileFacts>();
  const mintedVariables = new Set<NodeId>();
  const seenEdges = new Set<string>();

  // A technology's node identity is region-scoped, so the same display name may exist in several
  // regions. The evidence path is what ties a configuration file to the *right* one.
  const technologyByEvidence = new Map<string, NodeId>();

  for (const technology of input.technologies) {
    for (const proof of technology.evidence) {
      technologyByEvidence.set(`${proof.path}|${technology.name}`, technologyId(technology.regionPath, technology.id));
    }
  }

  const push = (edge: GraphEdge): void => {
    if (seenEdges.has(edge.id)) {
      return;
    }

    seenEdges.add(edge.id);
    edges.push(edge);
  };

  for (const artifact of input.artifacts) {
    artifactByPath.set(artifact.path, {
      kind: artifact.kind,
      summary: artifact.summary,
      boundary: artifact.boundary,
    });

    const source = fileId(artifact.path);
    const elementIds = new Map<string, NodeId>();

    for (const element of artifact.elements) {
      const id = artifactElementId({
        path: artifact.path,
        kind: element.kind,
        section: element.section,
        name: element.name,
      });

      if (elementIds.has(nameKey(element.kind, element.name))) {
        // Two elements of one kind and name in different sections. The first keeps the name key, which
        // only affects which one a `requires` reference binds to; both nodes exist.
        continue;
      }

      elementIds.set(nameKey(element.kind, element.name), id);

      nodes.push({
        ...BLANK,
        id,
        kind: 'ArtifactElement',
        name: element.name,
        fileId: source,
        containerChain: element.section === '' ? null : element.section,
        artifactKind: element.kind,
        // A structural reading of the format's own syntax. The element is there in the text; what it
        // *means* at runtime is not claimed, which is what the boundary sentence exists to say.
        confidence: 'CERTAIN',
        provenance: {
          producer: PRODUCER,
          fileId: source,
          evidence:
            `${artifact.path}${element.line === 0 ? '' : ` line ${element.line}`} declares this ${element.kind}` +
            (element.detail === '' ? '' : `: ${element.detail}`),
        },
        locations: element.line === 0 ? [] : [{ startLine: element.line, startColumn: 1, endLine: element.line, endColumn: 1 }],
      });

      push({
        id: `edge:CONTAINS|${source}|${id}`,
        type: 'CONTAINS',
        sourceId: source,
        targetId: id,
        name: element.kind,
        confidence: 'CERTAIN',
        candidateGroup: null,
        ordinal: null,
        provenance: {
          producer: PRODUCER,
          fileId: source,
          evidence: `${artifact.path} declares the ${element.kind} '${element.name}'`,
        },
        location: ORIGIN,
      });
    }

    /*
     * Declared prerequisites, between elements of the same artefact.
     *
     * **The only ordering evidence artefact analysis produces, and the reason it is worth having.** A
     * workflow's `needs: build` is the repository stating that one job must precede another; the
     * entailment guard rejects an execution-order claim unless a relationship licenses it, and this is
     * that relationship. A prerequisite naming an element the artefact does not declare is recorded as
     * unresolved rather than dropped or invented.
     */
    for (const element of artifact.elements) {
      const from = elementIds.get(nameKey(element.kind, element.name));

      if (from === undefined) {
        continue;
      }

      for (const need of element.requires) {
        const target =
          elementIds.get(nameKey(element.kind, need)) ??
          [...elementIds.entries()].find(([key]) => key.endsWith(`|${need}`))?.[1];

        if (target === undefined || target === from) {
          unresolved.push({
            id: `unresolved|DEPENDS_ON|${from}|${need}`,
            type: 'DEPENDS_ON',
            sourceId: from,
            name: need,
            reason: 'artefact-prerequisite-not-declared-here',
            text: need,
            provenance: {
              producer: PRODUCER,
              fileId: source,
              evidence: `${element.name} declares it needs '${need}', which this artefact does not declare`,
            },
            location: ORIGIN,
          });

          continue;
        }

        push({
          id: `edge:DEPENDS_ON|${from}|${target}`,
          type: 'DEPENDS_ON',
          sourceId: from,
          targetId: target,
          name: need,
          // The artefact states it. That the runner honours it is not something this observed.
          confidence: 'CERTAIN',
          candidateGroup: null,
          ordinal: null,
          provenance: {
            producer: PRODUCER,
            fileId: source,
            evidence: `${artifact.path} declares that '${element.name}' needs '${need}'`,
          },
          location: ORIGIN,
        });
      }
    }

    for (const reference of artifact.references) {
      const from = reference.element === null ? source : findElement(elementIds, reference.element) ?? source;

      if (reference.kind === 'technology') {
        const target = technologyByEvidence.get(`${artifact.path}|${reference.text}`);

        if (target !== undefined) {
          push({
            id: `edge:CONFIGURES|${source}|${target}`,
            type: 'CONFIGURES',
            sourceId: source,
            targetId: target,
            name: reference.text,
            confidence: 'CERTAIN',
            candidateGroup: null,
            ordinal: null,
            provenance: { producer: PRODUCER, fileId: source, evidence: reference.evidence },
            location: ORIGIN,
          });
        }

        continue;
      }

      if (reference.kind === 'environment') {
        const id = variableNode({
          name: reference.text,
          source,
          artifactPath: artifact.path,
          evidence: reference.evidence,
          existing: input.existingVariableIds,
          minted: mintedVariables,
          nodes,
          unresolved,
        });

        if (id !== null) {
          push({
            id: `edge:USES_ENV|${from}|${id}`,
            type: 'USES_ENV',
            sourceId: from,
            targetId: id,
            name: reference.text,
            confidence: 'CERTAIN',
            candidateGroup: null,
            ordinal: null,
            provenance: { producer: PRODUCER, fileId: source, evidence: reference.evidence },
            location: lineOf(reference.line),
          });
        }

        continue;
      }

      // The first candidate the scan actually found. Order is the reader's plausibility order — for a path
      // inside a nested artefact, the repository root before the artefact's own directory, because that is
      // what a runner's default working directory is.
      const resolved = reference.candidates.find((candidate) => input.filePaths.has(candidate)) ?? null;

      if (resolved === null) {
        unresolved.push({
          id: `unresolved|REFERENCES|${source}|${reference.text}|${reference.line}`,
          type: reference.kind === 'command' ? 'RUNS' : 'REFERENCES',
          sourceId: from,
          name: reference.text,
          reason: 'artefact-path-matches-no-file',
          text: reference.text,
          provenance: {
            producer: PRODUCER,
            fileId: source,
            evidence:
              `${reference.evidence}; no file in the repository matches ` +
              (reference.candidates.length === 0 ? 'this text' : reference.candidates.join(' or ')),
          },
          location: lineOf(reference.line),
        });

        continue;
      }

      const type = reference.kind === 'command' ? 'RUNS' : reference.kind === 'link' ? 'DOCUMENTS' : 'REFERENCES';
      // A link is a documentation relationship only where it comes from a document. Nothing else
      // produces `link` references today, and asserting the type from the reader rather than from the
      // artefact family would let a future reader silently claim to document something.
      const edgeType = type === 'DOCUMENTS' && artifact.kind !== 'documentation' ? 'REFERENCES' : type;
      const target = fileId(resolved);

      push({
        id: `edge:${edgeType}|${from}|${target}`,
        type: edgeType,
        sourceId: edgeType === 'DOCUMENTS' ? source : from,
        targetId: target,
        name: reference.text,
        confidence: reference.confidence as GraphNode['confidence'],
        candidateGroup: null,
        ordinal: null,
        provenance: { producer: PRODUCER, fileId: source, evidence: `${reference.evidence}; resolved to ${resolved}` },
        location: lineOf(reference.line),
      });
    }
  }

  return { nodes, edges, unresolved, artifactByPath };
}

/**
 * An `EnvironmentVariable` node for a name an artefact supplies, unless one already exists.
 *
 * **The reuse matters more than the minting.** A repository whose code reads `DATABASE_URL` and whose
 * compose file supplies it has one variable, reached two ways, and two nodes would make it look like two
 * variables — one configured and one read, with nothing connecting them. So the identity is the shared
 * `env:<NAME>` form and this only adds a node where nothing else did.
 *
 * A name the identity form cannot carry is recorded as unresolved rather than mangled, exactly as the
 * annotation translator does for `process.env['MY-VAR']`.
 */
function variableNode(input: {
  readonly name: string;
  readonly source: NodeId;
  readonly artifactPath: string;
  readonly evidence: string;
  readonly existing: ReadonlySet<NodeId>;
  readonly minted: Set<NodeId>;
  readonly nodes: GraphNode[];
  readonly unresolved: GraphUnresolvedReference[];
}): NodeId | null {
  let id: NodeId;

  try {
    id = environmentVariableId(input.name);
  } catch {
    input.unresolved.push({
      id: `unresolved|USES_ENV|${input.source}|${input.name}`,
      type: 'USES_ENV',
      sourceId: input.source,
      name: input.name,
      reason: 'unaddressable-environment-name',
      text: input.name,
      provenance: {
        producer: PRODUCER,
        fileId: input.source,
        evidence: `'${input.name}' cannot form an env: identifier`,
      },
      location: ORIGIN,
    });

    return null;
  }

  if (input.existing.has(id) || input.minted.has(id)) {
    return id;
  }

  input.minted.add(id);
  input.nodes.push({
    ...BLANK,
    id,
    kind: 'EnvironmentVariable',
    name: input.name,
    // A variable belongs to the process rather than to a file, so it settles no `fileId` — the same
    // rule the annotation translator follows, for the same reason.
    confidence: 'CERTAIN',
    provenance: { producer: PRODUCER, fileId: input.source, evidence: `${input.evidence} (${input.artifactPath})` },
  });

  return id;
}

function findElement(elementIds: ReadonlyMap<string, NodeId>, name: string): NodeId | undefined {
  return [...elementIds.entries()].find(([key]) => key.endsWith(`|${name}`))?.[1];
}

function nameKey(kind: string, name: string): string {
  return `${kind}|${name}`;
}

function lineOf(line: number): GraphEdge['location'] {
  return line <= 0 ? ORIGIN : { startLine: line, startColumn: 1, endLine: line, endColumn: 1 };
}

const BLANK = {
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
  artifactKind: null,
  locations: [],
} as const satisfies Partial<GraphNode>;
