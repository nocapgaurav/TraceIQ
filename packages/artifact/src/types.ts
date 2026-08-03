import type { ArtifactElementKind, ArtifactKind, ConfidenceLevel } from '@traceiq/types';

/**
 * What reading one non-code artefact establishes.
 *
 * **The shape is uniform across every format on purpose, and that is what makes the abstraction
 * extensible.** A Dockerfile reader, a compose reader and a Markdown reader each know one format and each
 * produce exactly this: a family, a flat list of elements, a list of references, and a sentence saying
 * what was *not* read. A new reader is one file plus one entry in the table in `read.ts`; nothing
 * downstream changes, because nothing downstream knows which reader produced what it is showing.
 *
 * **The `boundary` field is the honesty mechanism and it is required, never optional.** Every reader is
 * shallow by design — none of them is a conforming parser for its format — so every reader has something
 * it did not look at, and the field states it in words a reader of the product sees verbatim. An artefact
 * with no elements and a boundary sentence is a completely different claim from an artefact with no
 * elements and nothing said: the first means "this was read and it declares nothing of these kinds", and
 * the second would mean "nobody looked".
 */
export interface Artifact {
  /** Repository-relative, POSIX-separated. */
  readonly path: string;
  readonly kind: ArtifactKind;
  /** The format the reader read it as, in the scanner's language vocabulary, or `null`. */
  readonly format: string | null;
  /**
   * Whether a format-specific reader ran, as opposed to the family being decided from the path alone.
   *
   * `false` is a real and common answer — a lockfile, a binary, an unrecognised extension — and it is what
   * the Explorer shows as an analysis boundary rather than as an empty file.
   */
  readonly read: boolean;
  /** One sentence naming what the reading did not cover. Never empty. */
  readonly boundary: string;
  /** What the artefact is, in one deterministic clause assembled from what was read. Never empty. */
  readonly summary: string;
  readonly elements: readonly ArtifactElement[];
  readonly references: readonly ArtifactReference[];
}

/**
 * One structural piece of an artefact.
 *
 * `section` is the path inside the artefact the element was found under — `jobs.build`, `services.api`,
 * `stage 1` — so an element can be grouped without a reader having to emit a tree. A flat list with a
 * section path is what a renderer wants and what a fact line can carry; a tree would have to be walked by
 * both.
 */
export interface ArtifactElement {
  readonly kind: ArtifactElementKind;
  readonly name: string;
  /** The containing section path, or `''` for a top-level element. */
  readonly section: string;
  /**
   * The element's own text, shown to a reader verbatim.
   *
   * Truncated to a stated length by the reader, because a `run:` block can be forty lines and the graph
   * is not a copy of the repository. Never a value from an environment file — see `envFile`.
   */
  readonly detail: string;
  /** 1-based line the element starts at, or `0` where the reader cannot say. */
  readonly line: number;
  /**
   * Names of sibling elements this one declares it needs, if the format states any.
   *
   * The **only** ordering evidence artefact analysis produces. A workflow's `needs:` and a compose
   * service's `depends_on:` are the repository stating an order; one step being written above another is
   * not, and is never recorded here.
   */
  readonly requires: readonly string[];
}

export const ARTIFACT_REFERENCE_KINDS = [
  /** A path the artefact names, with nothing more specific established. */
  'path',
  /** A path a command in the artefact invokes. */
  'command',
  /** A link in prose. */
  'link',
  /** An environment or configuration variable name. */
  'environment',
  /** A technology the artefact configures, by the detector's own identifier. */
  'technology',
] as const;

export type ArtifactReferenceKind = (typeof ARTIFACT_REFERENCE_KINDS)[number];

/**
 * Something the artefact names that may exist elsewhere in the repository.
 *
 * **Resolution is not this package's job.** A reference carries the literal text and the kind of naming
 * it was; whether `./scripts/build.sh` is a file the repository holds is a question about the repository's
 * inventory, and the graph builder answers it. Keeping them apart is what lets an unresolvable reference
 * be recorded as unresolved rather than silently dropped — the same discipline the resolver already
 * follows for an import that binds to nothing.
 */
export interface ArtifactReference {
  readonly kind: ArtifactReferenceKind;
  /** The text as the artefact wrote it. */
  readonly text: string;
  /**
   * The repository-relative paths this text could denote, most plausible first. Empty where it denotes none.
   *
   * **A list rather than one value, because one reference has two readings and only one of them is right.**
   * `scripts/build.sh` inside `.github/workflows/ci.yml` means either the repository root or the workflow's
   * own directory, and which one a runner takes depends on a working directory the file may not state. The
   * reader offers both and the consumer resolves against the repository's actual inventory; emitting them as
   * *two references* instead recorded the loser as unresolved, which put 431 phantom dead links on one
   * documentation-heavy repository — every one of them a link that resolves perfectly well.
   *
   * Normalisation is mechanical — resolve `./` and `../` against the artefact's own directory, strip a
   * trailing `#anchor` or `?query` — and it never guesses at an extension or a directory index. A reference
   * that is not a path at all (`https://…`, a variable name) has no candidates and carries its meaning in
   * `kind`.
   */
  readonly candidates: readonly string[];
  /** The element this reference came from, by name, or `null` where the artefact itself named it. */
  readonly element: string | null;
  readonly line: number;
  /** Why the reference is claimed, shown to a reader verbatim. */
  readonly evidence: string;
  readonly confidence: ConfidenceLevel;
}

/** Everything artefact analysis establishes about one repository. */
export interface RepositoryArtifacts {
  /** One entry per file the analysis classified, sorted by path. */
  readonly artifacts: readonly Artifact[];
  /** Files whose family was decided but whose contents were not read, and why. */
  readonly unread: number;
  /** Elements dropped by a per-artefact cap, so the cap is never silent. */
  readonly droppedElements: number;
}
