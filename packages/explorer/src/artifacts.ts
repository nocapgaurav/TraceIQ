import type { GraphEdge, GraphNode } from '@traceiq/graph-api';
import { ARTIFACT_RELATIONSHIP_TYPES } from '@traceiq/types';
import type { NodeId, RelationshipType } from '@traceiq/types';

import type { ExplorerContext } from './explorer-context.js';
import { packageOfNode } from './explorer-context.js';
import { byId, listing } from './listing.js';
import type {
  ArtifactDigest,
  ArtifactElementView,
  ArtifactLink,
  ArtifactSection,
  ArtifactSummary,
  ArtifactView,
  UnresolvedArtifactReference,
} from './types.js';

/**
 * The artefact view of one file, assembled from nodes and edges the graph already holds.
 *
 * **Deterministic and graph-backed throughout, which is the constraint that makes it trustworthy.** No
 * model runs here, nothing is ranked, and no sentence is written that is not a restatement of a stored
 * fact. That is the same discipline every other explorer view follows, and it matters more here because
 * this is the view a reader reaches for when a file has no declarations — the moment they are most
 * dependent on the product not filling a gap with plausible prose.
 *
 * Returns `null` where the file carries no artefact family, which is every source file. That is not a
 * degradation: a `.ts` file's structure is what the language analysers produce, at a fidelity a line
 * reader could not reach, and describing it twice would give the graph two answers to one question.
 */
export function artifactViewOf(context: ExplorerContext, file: GraphNode): ArtifactView | null {
  if (file.artifactKind === null) {
    return null;
  }

  const index = context.index();
  const elements = context.graph
    .getOutgoing(file.id, 'CONTAINS')
    .flatMap((edge) => {
      const node = index.nodeById.get(edge.targetId) ?? context.node(edge.targetId);

      return node === null || node === undefined ? [] : [node];
    });

  const byIdentity = new Map(elements.map((node) => [node.id, node]));
  const outgoing = artifactEdgesFrom(context, file, elements);
  const incoming = artifactEdgesInto(context, file);

  return {
    kind: file.artifactKind,
    format: file.language,
    role: file.fileRole,
    summary: summaryOf({ file, elements, outgoing, incoming, context }),
    sections: sectionsOf(context, elements, byIdentity),
    references: listing(outgoing),
    referencedBy: listing(incoming),
    unresolved: listing(unresolvedFrom(context, file, elements)),
    // Verbatim, and deliberately unparsed. It is the sentence that stops an artefact holding no elements
    // from reading as a file that does nothing.
    boundary: file.provenance.evidence,
  };
}

/**
 * The artefact's structure, grouped by the section path the reader recorded.
 *
 * Sections are ordered by where their first element sits in the file, and elements within a section by
 * line. **A file's own order is the only ordering shown**, because it is the only ordering that was
 * observed — and an element list sorted by name would silently reorder the steps of a pipeline into
 * something a reader would take for a sequence.
 */
function sectionsOf(
  context: ExplorerContext,
  elements: readonly GraphNode[],
  byIdentity: ReadonlyMap<NodeId, GraphNode>,
): readonly ArtifactSection[] {
  const grouped = new Map<string, ArtifactElementView[]>();

  for (const node of [...elements].sort(byLineThenId)) {
    const title = node.containerChain ?? '';
    const held = grouped.get(title) ?? [];

    held.push({
      node,
      kind: node.artifactKind ?? 'section',
      name: node.name,
      detail: detailOf(node),
      line: node.locations[0]?.startLine ?? 0,
      requires: context.graph
        .getOutgoing(node.id, 'DEPENDS_ON')
        .flatMap((edge) => {
          const target = byIdentity.get(edge.targetId);

          return target === undefined ? [] : [target];
        }),
    });

    grouped.set(title, held);
  }

  return [...grouped.entries()].map(([title, entries]) => ({ title, elements: entries }));
}

/**
 * The element's own text, recovered from the provenance sentence that carries it.
 *
 * The provenance reads `path line 12 declares this step: npm run build`, and the text after the colon is
 * what the reader recorded. Recovered rather than stored twice: the alternative is a column whose only
 * consumer is this line, and a duplicated field is a field that can disagree with itself.
 */
function detailOf(node: GraphNode): string {
  const marker = node.provenance.evidence.indexOf('declares this ');

  if (marker < 0) {
    return '';
  }

  const colon = node.provenance.evidence.indexOf(': ', marker);

  return colon < 0 ? '' : node.provenance.evidence.slice(colon + 2);
}

/** Artefact relationships out of this file and out of its own elements. */
function artifactEdgesFrom(
  context: ExplorerContext,
  file: GraphNode,
  elements: readonly GraphNode[],
): readonly ArtifactLink[] {
  const index = context.index();
  const links: ArtifactLink[] = [];
  const seen = new Set<string>();

  const consider = (edge: GraphEdge, via: GraphNode | null): void => {
    // Containment is the artefact's own structure, which `sections` already carries. Listing it as a
    // reference would report every element twice and make the count meaningless.
    if (edge.type === 'CONTAINS' || !isArtifactType(edge.type)) {
      return;
    }

    const node = index.nodeById.get(edge.targetId) ?? context.node(edge.targetId);
    const key = `${edge.type}|${edge.targetId}|${via?.id ?? ''}`;

    if (node === null || node === undefined || seen.has(key)) {
      return;
    }

    seen.add(key);
    links.push({ type: edge.type, node, via, confidence: edge.confidence, evidence: edge.provenance.evidence });
  };

  for (const edge of context.graph.getOutgoing(file.id)) {
    consider(edge, null);
  }

  for (const element of elements) {
    for (const edge of context.graph.getOutgoing(element.id)) {
      // A prerequisite between two elements of one artefact is ordering rather than reach, and it is
      // already shown on the element that declares it.
      if (edge.type !== 'DEPENDS_ON') {
        consider(edge, element);
      }
    }
  }

  return links.sort(byTypeThenName);
}

/** Artefact relationships into this file, from anywhere. */
function artifactEdgesInto(context: ExplorerContext, file: GraphNode): readonly ArtifactLink[] {
  const index = context.index();
  const links: ArtifactLink[] = [];

  for (const edge of context.graph.getIncoming(file.id)) {
    if (edge.type === 'CONTAINS' || !isArtifactType(edge.type)) {
      continue;
    }

    const source = index.nodeById.get(edge.sourceId) ?? context.node(edge.sourceId);

    if (source === null || source === undefined) {
      continue;
    }

    // An element is shown through the artefact that holds it, because "what references this file" is a
    // question about files and a bare step name would leave a reader with nowhere to go.
    const owner = source.kind === 'ArtifactElement' && source.fileId !== null ? context.node(source.fileId) : null;

    links.push({
      type: edge.type,
      node: owner ?? source,
      via: owner === null ? null : source,
      confidence: edge.confidence,
      evidence: edge.provenance.evidence,
    });
  }

  return links.sort(byTypeThenName);
}

/** References this artefact made that resolved to nothing, from the graph's unresolved record. */
function unresolvedFrom(
  context: ExplorerContext,
  file: GraphNode,
  elements: readonly GraphNode[],
): readonly UnresolvedArtifactReference[] {
  const owned = new Set<NodeId>([file.id, ...elements.map((element) => element.id)]);

  return context.graph
    .getUnresolved()
    .filter((entry) => owned.has(entry.sourceId) && (isArtifactType(entry.type) || entry.type === 'DEPENDS_ON'))
    .map((entry) => ({
      type: entry.type,
      text: entry.text,
      reason: entry.reason,
      evidence: entry.provenance.evidence,
    }))
    .sort((left, right) => left.type.localeCompare(right.type) || left.text.localeCompare(right.text));
}

/**
 * The deterministic summary: six questions, answered only where the graph answers them.
 *
 * **`established: false` is the whole point of the field.** An artefact that was read and yielded no
 * structure is a completely different thing from a file nobody looked at, and a renderer that cannot tell
 * them apart will show a zero for both.
 */
function summaryOf(input: {
  readonly file: GraphNode;
  readonly elements: readonly GraphNode[];
  readonly outgoing: readonly ArtifactLink[];
  readonly incoming: readonly ArtifactLink[];
  readonly context: ExplorerContext;
}): ArtifactSummary {
  const counts = new Map<string, number>();

  for (const element of input.elements) {
    const kind = element.artifactKind ?? 'section';

    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const reached = new Map<RelationshipType, number>();

  for (const link of input.outgoing) {
    if (link.type === 'CONFIGURES' || link.type === 'USES_ENV') {
      continue;
    }

    reached.set(link.type, (reached.get(link.type) ?? 0) + 1);
  }

  const segments = input.file.id.slice('file:'.length).split('/');

  return {
    kind: input.file.artifactKind ?? 'unknown-artifact',
    role: input.file.fileRole,
    defines: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    configures: input.outgoing.filter((link) => link.type === 'CONFIGURES').map((link) => link.node.name),
    reaches: [...reached.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
    referencedBy: input.incoming.length,
    variables: input.outgoing.filter((link) => link.type === 'USES_ENV').map((link) => link.node.name),
    position:
      segments.length === 1
        ? 'at the repository root'
        : `in ${packageOfNode(input.file) ?? segments.slice(0, -1).join('/')}, ${segments.length - 1} ${segments.length === 2 ? 'level' : 'levels'} deep`,
    established: input.elements.length > 0 || input.outgoing.length > 0,
  };
}

/**
 * Artefacts the repository holds, counted by family.
 *
 * On the overview because every surface needs it and because it is the shortest true answer to "what is
 * this repository made of" for a repository whose files are mostly not source. A repository of forty
 * workflows and one Python script is not a Python project, and until this existed nothing above the graph
 * could say so.
 */
export function artifactSummariesOf(context: ExplorerContext): readonly {
  readonly kind: string;
  readonly files: number;
  readonly elements: number;
  /** Up to three paths, identifier-ordered. Not a ranking — see `Listing` for why nothing here ranks. */
  readonly examples: readonly string[];
}[] {
  const index = context.index();
  const held = new Map<string, { files: GraphNode[]; elements: number }>();

  for (const file of index.files) {
    if (file.artifactKind === null) {
      continue;
    }

    const bucket = held.get(file.artifactKind) ?? { files: [], elements: 0 };

    bucket.files.push(file);
    held.set(file.artifactKind, bucket);
  }

  for (const element of index.nodesByKind.get('ArtifactElement') ?? []) {
    const owner = element.fileId === null ? null : index.nodeById.get(element.fileId);
    const family = owner?.artifactKind ?? null;

    if (family === null) {
      continue;
    }

    const bucket = held.get(family);

    if (bucket !== undefined) {
      bucket.elements += 1;
    }
  }

  return [...held.entries()]
    .map(([kind, bucket]) => ({
      kind,
      files: bucket.files.length,
      elements: bucket.elements,
      examples: byId(bucket.files)
        .slice(0, 3)
        .map((file) => file.id.slice('file:'.length)),
    }))
    .sort((left, right) => right.files - left.files || left.kind.localeCompare(right.kind));
}

/**
 * Element kinds worth naming in a repository-wide digest, in order of what they say about a system.
 *
 * **Fixed by what the kinds mean, never by how many there are.** A compose file's services are what the
 * system runs; its volumes are how one service keeps state. Ordering by count would let a file with
 * fourteen volumes and one service be described by its volumes, which is the same "largest is most
 * important" mistake the rest of this milestone exists to remove.
 */
const DIGEST_KINDS: readonly string[] = [
  'service',
  'job',
  'stage',
  'resource',
  'entity',
  'script-target',
  'member',
  'image',
  'trigger',
  'heading',
  /*
   * `setting` is admitted **only for the entry-point fields**, and that narrowness is the whole reason it
   * is admissible at all.
   *
   * A manifest's `main`, `bin` and `exports` are the repository stating where it is entered, which is one of
   * the four kinds of evidence an onboarding answer may rest on. Every other setting a manifest holds — a
   * licence, a version, a package manager — says nothing about approaching the repository, and admitting the
   * kind wholesale would fill a digest with them. Measured: without the filter below, a monorepo's manifests
   * contributed thirty-one settings and not one entry point.
   */
  'setting',
];

/** Settings worth naming in a digest: the fields that state where a package is entered. */
const DIGEST_SETTINGS = /^(main|module|types|bin|exports):/;

/** How many names, orderings, reached files and variables one digest carries. */
const DIGEST_NAMES = 10;
const DIGEST_REACHES = 6;
const DIGEST_VARIABLES = 8;

/** How many artefacts the repository-wide digest carries. Beyond this a projection is reading a listing. */
const DIGEST_LIMIT = 18;

/**
 * How many artefacts one family may contribute.
 *
 * **The per-family cap is what keeps the digest a description of the repository rather than of its largest
 * family.** A repository with two hundred workflows and one README would otherwise spend every slot on
 * workflows, and the one file an onboarding question can be answered from would never reach a projection.
 */
const DIGEST_PER_FAMILY = 4;

/**
 * The artefacts that describe the running system, each with what it declares.
 *
 * Restricted to the system families, so an editor configuration cannot displace a compose file, and capped
 * so a repository of two hundred workflows contributes its largest families rather than all of them. The
 * cap is reported by the `Listing` that wraps this, never silently applied.
 */
export function artifactDigestsOf(
  context: ExplorerContext,
  families: readonly string[],
): readonly ArtifactDigest[] {
  const index = context.index();
  const wanted = new Set(families);

  /**
   * Family order first, then **path depth**, then path.
   *
   * Depth is the discriminator that matters and it is not a ranking: a `README.md` at the repository root
   * is a statement about the repository, and the same file six directories down is a statement about that
   * directory. Sorting alphabetically instead put `docs/adr/0001-title.md` ahead of `README.md` on the
   * first repository this was tried against.
   */
  const depth = (file: GraphNode): number => file.id.split('/').length;
  const ordered = [...index.files]
    .filter((file) => file.artifactKind !== null && wanted.has(file.artifactKind))
    .sort(
      (left, right) =>
        families.indexOf(left.artifactKind ?? '') - families.indexOf(right.artifactKind ?? '') ||
        depth(left) - depth(right) ||
        left.id.localeCompare(right.id),
    );

  const perFamily = new Map<string, number>();
  const candidates = ordered.filter((file) => {
    const family = file.artifactKind ?? '';
    const taken = perFamily.get(family) ?? 0;

    if (taken >= DIGEST_PER_FAMILY) {
      return false;
    }

    perFamily.set(family, taken + 1);

    return true;
  });

  return candidates.slice(0, DIGEST_LIMIT).map((file) => {
    const view = artifactViewOf(context, file);
    const elements = view === null ? [] : view.sections.flatMap((section) => section.elements);

    const named = [...elements]
      .filter(
        (element) =>
          DIGEST_KINDS.includes(element.kind) &&
          (element.kind !== 'setting' || DIGEST_SETTINGS.test(element.name)),
      )
      .sort(
        (left, right) => DIGEST_KINDS.indexOf(left.kind) - DIGEST_KINDS.indexOf(right.kind) || left.line - right.line,
      )
      .slice(0, DIGEST_NAMES)
      .map((element) => `${element.kind} ${element.name}`);

    const ordering = elements
      .flatMap((element) => element.requires.map((need) => `${element.name} → ${need.name}`))
      .slice(0, DIGEST_NAMES);

    return {
      path: file.id.slice('file:'.length),
      kind: file.artifactKind ?? 'unknown-artifact',
      declares: view?.summary.defines ?? [],
      names: named,
      ordering,
      reaches: (view?.references.entries ?? [])
        .filter((link) => link.type === 'RUNS' || link.type === 'REFERENCES' || link.type === 'DOCUMENTS')
        .slice(0, DIGEST_REACHES)
        .map((link) => ({ type: link.type, path: link.node.id.slice('file:'.length) })),
      variables: (view?.summary.variables ?? []).slice(0, DIGEST_VARIABLES),
    };
  });
}

function isArtifactType(type: RelationshipType): boolean {
  return ARTIFACT_RELATIONSHIP_TYPES.includes(type);
}

function byLineThenId(left: GraphNode, right: GraphNode): number {
  const line = (node: GraphNode): number => node.locations[0]?.startLine ?? Number.MAX_SAFE_INTEGER;

  return line(left) - line(right) || left.id.localeCompare(right.id);
}

function byTypeThenName(left: ArtifactLink, right: ArtifactLink): number {
  return left.type.localeCompare(right.type) || left.node.id.localeCompare(right.node.id);
}
