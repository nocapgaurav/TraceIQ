/**
 * The relationship vocabulary of the Knowledge Graph.
 *
 * Every relationship must state exactly what it means. There is deliberately no
 * generic USES relationship: a catch-all edge becomes the place extractors dump
 * whatever they could not classify, and once that happens no query can tell the
 * cases apart again.
 *
 * **The second block exists because every type in the first block needs a declaration at one end.** A
 * repository's YAML, its Dockerfile, its workflows and its README could therefore hold a node and never
 * an edge — which is how a file that configures the whole deployment came to look less connected than a
 * one-line type alias. Each type below is produced from a *deterministic reading of the artefact's own
 * text*, and each states one thing that reading establishes. None is inferred from a filename, a
 * directory position or proximity.
 */
export const RELATIONSHIP_TYPES = [
  'DECLARES',
  'IMPORTS',
  'EXPORTS',
  'CALLS',
  'IMPLEMENTS',
  'EXTENDS',
  'REFERENCES_TYPE',
  'HANDLED_BY',
  'READS',
  'WRITES',
  'DEPENDS_ON',
  'CONTINUES_TO',
  'TESTS',
  /**
   * Structural containment inside one artefact: a workflow contains a job, a job contains a step, a
   * compose file contains a service.
   *
   * The artefact counterpart of `DECLARES`, and separate from it for the reason `DECLARES` is separate
   * from `IMPORTS`: a declaration comes from a parsed language, and this comes from a structural read of
   * a configuration format. Consumers that measure coupling exclude both, because containment is not a
   * reference — see `REFERENCE_TYPES` in `@traceiq/health`.
   */
  'CONTAINS',
  /**
   * An artefact names a path, and that path resolves to a file the repository holds.
   *
   * The weakest of the artefact relationships and the most common one. It says only that the text of one
   * file names another; what the naming *means* is what the four types below are for, and a reference
   * that cannot be classified further stays here rather than being promoted.
   */
  'REFERENCES',
  /**
   * A command inside an artefact invokes a file the repository holds.
   *
   * Established from the command's own text — a CI step's `run:`, a package script, a compose
   * `command:`, a shell script's invocation — and never from ordering or position. It is what lets a
   * workflow question be answered with an execution relationship instead of a directory listing.
   *
   * It is emphatically **not** an ordering. That one step runs `build.sh` and another runs `deploy.sh`
   * says nothing about which happens first; only an artefact's own declared prerequisites do, and those
   * are recorded as `DEPENDS_ON` between the steps themselves.
   */
  'RUNS',
  /**
   * A configuration artefact configures a technology the repository was detected to use.
   *
   * A restatement of the technology detector's own evidence read from the other direction:
   * `next.config.js` is *why* Next.js was detected, so the edge carries that same evidence line. It
   * makes "what does this file do" answerable for a configuration file whose entire content is one
   * exported object.
   */
  'CONFIGURES',
  /**
   * A documentation artefact links to a file the repository holds.
   *
   * Distinct from `REFERENCES` because the reverse direction is a question people actually ask — what
   * documents this module — and because a link in prose is a deliberate statement about a file where a
   * path inside a configuration value may be incidental.
   */
  'DOCUMENTS',
  /**
   * An artefact names an environment variable.
   *
   * Distinct from `READS`, which records source code reading one at runtime. A compose file listing
   * `DATABASE_URL` under `environment:` is *supplying* the variable rather than reading it, and merging
   * the two would let configuration look like behaviour — the exact transformation the entailment guard
   * rejects in prose.
   */
  'USES_ENV',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Relationships produced by reading a non-code artefact rather than by compiling source.
 *
 * Named as a set so a consumer can ask "is this fact from artefact analysis" without listing the types
 * again. `DEPENDS_ON` is absent although artefact analysis produces it: a manifest declaring a
 * dependency produced it before this existed, and the set is here to identify the new capability rather
 * than to partition the vocabulary.
 */
export const ARTIFACT_RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'CONTAINS',
  'REFERENCES',
  'RUNS',
  'CONFIGURES',
  'DOCUMENTS',
  'USES_ENV',
];
