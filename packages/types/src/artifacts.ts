/**
 * What kinds of thing a repository is made of, beyond source code.
 *
 * **This vocabulary exists because "0 declarations" was being read as "does nothing".** A repository's
 * Dockerfile, its workflows, its compose file, its schema and its README each carry semantics a compiler
 * cannot see, and until this list existed the graph had exactly one word for all of them — the scanner's
 * `fileRole`, which says `configuration` for a Kubernetes manifest, a `tsconfig.json` and an
 * `.editorconfig` alike. A reader shown that word learns almost nothing, and a retrieval layer ranking by
 * it cannot tell the deployment of the system from the editor settings of whoever wrote it.
 *
 * Two lists, deliberately disjoint, and the disjointness is enforced by a test:
 *
 * - `ARTIFACT_KINDS` names what a **file** is — one term per file, the artefact *family*.
 * - `ARTIFACT_ELEMENT_KINDS` names what a **piece of a file** is — a job, a step, a service, a heading.
 *
 * They share one column in the graph (`nodes.artifact_kind`) because both answer the same question, "what
 * artefact term applies to this node", and the node's own `kind` says which of the two lists to read it
 * against. Overlapping words would make that ambiguous, so they may not overlap.
 *
 * **Every term must be decidable from a deterministic read.** `ci-workflow` is decidable — the file is
 * YAML and its top level declares `jobs`, `stages` or `steps`. `microservice` would not be, and is not
 * here. A file whose family cannot be decided is `unknown-artifact`, which is a real answer and is used.
 */
export const ARTIFACT_KINDS = [
  /** A CI or CD pipeline definition: jobs, stages or steps declared at the top level of a YAML file. */
  'ci-workflow',
  /** A container image build recipe. `Dockerfile`, `api.Dockerfile`, `Dockerfile.prod`. */
  'container-image',
  /** A multi-container definition: a YAML file whose top level declares `services`. */
  'container-compose',
  /** A Kubernetes-style resource: a YAML document declaring both `apiVersion` and `kind`. */
  'orchestration-resource',
  /** Infrastructure as code: Terraform, CloudFormation, Pulumi, Helm chart metadata. */
  'infrastructure-as-code',
  /** A dependency or project manifest, as the scanner already identifies it. */
  'package-manifest',
  /** A resolved dependency set. Recorded as present; its thousands of pinned versions are not read. */
  'lockfile',
  /** Build or task orchestration: a Makefile, a Gradle script, a task runner's input. */
  'build-configuration',
  /** A workspace or project layout definition: a workspace file, a project references file. */
  'workspace-configuration',
  /** Environment or secret *names* supplied to a process. Values are never read — see `envFile`. */
  'environment-configuration',
  /** Tool configuration: a linter, a formatter, a compiler, a bundler, a test runner. */
  'tool-configuration',
  /** A database schema, a model definition or a migration. */
  'schema',
  /** Prose meant to be read: Markdown, reStructuredText. */
  'documentation',
  /** A shell script or other hand-run automation. */
  'script',
  /** A test file, as the scanner already identifies it. */
  'test',
  /** Something a tool wrote, or somebody else's code kept in tree. */
  'generated',
  /** Structured data with no recognised role: a fixture, a dataset, a translation table. */
  'data',
  /** Recognised as a file, with nothing further defensibly claimable about it. */
  'unknown-artifact',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * What one piece of an artefact is.
 *
 * Each term is a structure the format itself names — a YAML key, a Dockerfile instruction, a Markdown
 * heading — so an element is a reading rather than an interpretation. The element's own text is carried
 * as its provenance evidence, which is what makes every one of these checkable by opening the file.
 */
export const ARTIFACT_ELEMENT_KINDS = [
  /** A named unit of work in a pipeline. */
  'job',
  /** One action inside a job. */
  'step',
  /** A command line the artefact states will be run. */
  'command',
  /** A named script the artefact exposes to be run by name. */
  'script-target',
  /** A long-running process the artefact defines. */
  'service',
  /** A named build stage. */
  'stage',
  /** An image the artefact builds from or runs. */
  'image',
  /** A port the artefact exposes or publishes. */
  'port',
  /** A volume or mount the artefact declares. */
  'volume',
  /** A network the artefact declares. */
  'network',
  /** An environment or configuration variable name the artefact states. */
  'variable',
  /** A trigger or schedule the artefact declares it responds to. */
  'trigger',
  /** A condition guarding whether something runs. */
  'condition',
  /** A declared input. */
  'input',
  /** A declared output. */
  'output',
  /** A provisioned resource. */
  'resource',
  /** A table, model or entity a schema defines. */
  'entity',
  /** An index a schema defines. */
  'index',
  /** A prose heading, with its level. */
  'heading',
  /** A top-level grouping the format names, where nothing more specific applies. */
  'section',
  /** A single named setting, where the section it sits in is worth naming. */
  'setting',
  /** A member of a workspace or project set. */
  'member',
] as const;

export type ArtifactElementKind = (typeof ARTIFACT_ELEMENT_KINDS)[number];

/** Every artefact term, for a consumer validating the shared column without knowing which list applies. */
export const ARTIFACT_TERMS: readonly string[] = [...ARTIFACT_KINDS, ...ARTIFACT_ELEMENT_KINDS];

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function isArtifactElementKind(value: string): value is ArtifactElementKind {
  return (ARTIFACT_ELEMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Artefact families whose semantics say something about the repository *as a whole*, in that order.
 *
 * **Named here rather than inside a retrieval heuristic**, so that "which artefacts matter for a
 * repository-wide question" is one list a reader can check rather than a condition buried in a projection
 * extractor. A repository's compose file, its workflows, its manifests and its README describe the system
 * and how to approach it; its `.editorconfig` does not, however carefully it is read.
 *
 * **The order is by what a family says about a repository, and it is never a ranking of importance within
 * one.** A compose file leads because it names what runs; documentation is last of the seven that matter
 * because it describes rather than constitutes — and it is present at all because an onboarding question
 * has no honest answer without it. Consumers cap *per family* as well as overall, so a repository with two
 * hundred workflows cannot spend a whole digest on workflows and leave its README unmentioned.
 */
export const SYSTEM_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'container-compose',
  'container-image',
  'orchestration-resource',
  'infrastructure-as-code',
  'ci-workflow',
  'schema',
  'package-manifest',
  'workspace-configuration',
  'documentation',
];
