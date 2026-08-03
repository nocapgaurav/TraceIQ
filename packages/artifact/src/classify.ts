import type { ArtifactKind } from '@traceiq/types';

import { scanYaml, topLevelKeys } from './yaml-scan.js';

/**
 * Which artefact family a file belongs to.
 *
 * **Content decides wherever content can, and the path only where it cannot.** A YAML file's family is not
 * knowable from its name: `deploy.yml` is a workflow in one repository, a Kubernetes manifest in the next
 * and an Ansible playbook in the third. What *is* knowable is what its top level declares — `jobs`,
 * `services`, `apiVersion` + `kind` — and that is a reading rather than a convention. Every rule below
 * that does rest on a path says so, and none of them names a repository.
 *
 * The scanner's `fileRole` is the floor rather than the answer. It already distinguishes a manifest from a
 * test from documentation, correctly and for every repository, so this refines it: `configuration` becomes
 * `ci-workflow`, `container-compose`, `tool-configuration` or `orchestration-resource` depending on what
 * the file says, and `unknown-artifact` where it says nothing recognisable. Refining never contradicts —
 * a file the scanner called a manifest stays `package-manifest`.
 */
export interface Classification {
  readonly kind: ArtifactKind;
  /** Why this family, in words a reader can check against the file. */
  readonly evidence: string;
}

/**
 * Top-level YAML keys that identify a pipeline, and nothing else does.
 *
 * `jobs` is GitHub Actions and Azure Pipelines; `stages` is GitLab CI and Azure; `steps` is a single-job
 * Azure or Bitbucket pipeline; `pipelines` is Bitbucket; `workflows` is CircleCI. A compose file declares
 * none of them, and a Kubernetes resource declares `apiVersion` — which is checked first, because a
 * Tekton or Argo resource declares both and is a resource that happens to describe a pipeline.
 */
const PIPELINE_KEYS = ['jobs', 'stages', 'steps', 'pipelines', 'workflows'];

/** Marker filenames whose *name* is the technology they configure. Conventions, never repository names. */
const TOOL_CONFIG = /^(\.?[\w.-]*?)(eslintrc|prettierrc|babelrc|browserslistrc|stylelintrc|editorconfig|npmrc|nvmrc|dockerignore|gitattributes|gitignore|swcrc)(\.[\w]+)?$/i;

const TOOL_CONFIG_SUFFIX =
  /\.(config|conf|rc)\.(js|cjs|mjs|ts|mts|cts|json|jsonc|json5|yaml|yml|toml)$/i;

const TOOL_CONFIG_NAMES = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'vitest.config.ts',
  'jest.config.js',
  'renovate.json',
  'dependabot.yml',
  'dependabot.yaml',
  'codecov.yml',
  'sonar-project.properties',
]);

/** Workspace and project layout definitions, by the conventional filename each ecosystem uses. */
const WORKSPACE_NAMES = new Set([
  'pnpm-workspace.yaml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'rush.json',
  'go.work',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

/**
 * Environment files, whose **names** are read and whose **values** never are.
 *
 * A `.env` holds live credentials in a great many repositories. Recording that `DATABASE_URL` is supplied
 * is useful and safe; recording what it is set to would put a secret into a database, into a prompt and
 * into an answer. The reader enforces this, and `envFile` is where the decision is made once.
 */
const ENVIRONMENT_NAMES = /^\.env(\.[\w.-]+)?$|^env(\.[\w-]+)?\.(example|sample|template)$/i;

const IAC_NAMES = new Set(['chart.yaml', 'chart.yml', 'values.yaml', 'values.yml', 'ansible.cfg', 'pulumi.yaml', 'serverless.yml', 'serverless.yaml', 'template.yaml', 'template.yml']);

/** Schema and migration conventions across ecosystems. */
const SCHEMA_NAMES = /(^|\/)(schema\.(sql|prisma|graphql|gql)|migrations?\.sql)$/i;

export function envFile(path: string): boolean {
  return ENVIRONMENT_NAMES.test(basename(path));
}

/**
 * Classifies one file.
 *
 * `contents` is `null` where the file was not read — too large, unreadable, or a format with no reader —
 * and the classification then rests on the path alone and says so in its evidence.
 */
export function classify(input: {
  readonly path: string;
  readonly language: string | null;
  /** The scanner's role: `source`, `test`, `documentation`, `configuration`, `manifest`, `build`, … */
  readonly role: string;
  readonly contents: string | null;
}): Classification {
  const name = basename(input.path).toLowerCase();
  const path = input.path.toLowerCase();

  if (LOCKFILE_NAMES.has(name)) {
    return { kind: 'lockfile', evidence: `${name} is a resolved dependency set` };
  }

  if (input.role === 'manifest') {
    return { kind: 'package-manifest', evidence: `${name} is a dependency manifest` };
  }

  if (envFile(input.path)) {
    return { kind: 'environment-configuration', evidence: `${name} supplies environment variables` };
  }

  if (input.language === 'dockerfile') {
    return { kind: 'container-image', evidence: `${name} is a container image build recipe` };
  }

  if (input.language === 'terraform' || IAC_NAMES.has(name) || /(^|\/)(helm|charts?|terraform|ansible|pulumi|cloudformation)(\/|$)/.test(path)) {
    return { kind: 'infrastructure-as-code', evidence: 'it is an infrastructure definition' };
  }

  if (input.language === 'sql' || SCHEMA_NAMES.test(path) || /(^|\/)migrations?(\/|$)/.test(path) || name.endsWith('.prisma')) {
    return { kind: 'schema', evidence: 'it defines or evolves a data schema' };
  }

  if (input.language === 'yaml') {
    return yamlKind(name, input.contents);
  }

  if (WORKSPACE_NAMES.has(name)) {
    return { kind: 'workspace-configuration', evidence: `${name} defines the workspace layout` };
  }

  if (input.role === 'test') {
    return { kind: 'test', evidence: 'its path follows a test naming convention' };
  }

  if (input.language === 'markdown' || input.role === 'documentation') {
    return { kind: 'documentation', evidence: 'it is prose meant to be read' };
  }

  if (input.language === 'shell') {
    return { kind: 'script', evidence: 'it is a shell script' };
  }

  if (input.role === 'build') {
    return { kind: 'build-configuration', evidence: `${name} orchestrates the build` };
  }

  if (TOOL_CONFIG.test(name) || TOOL_CONFIG_SUFFIX.test(name) || TOOL_CONFIG_NAMES.has(name)) {
    return { kind: 'tool-configuration', evidence: `${name} configures a development tool` };
  }

  if (input.role === 'configuration') {
    // Recognisably configuration, with nothing saying which tool reads it. `data` rather than
    // `tool-configuration`, because claiming a tool nobody named would be inventing one.
    return { kind: 'data', evidence: `it is structured ${input.language ?? 'data'} with no recognised consumer` };
  }

  if (input.language !== null && ANALYSED_LANGUAGES.has(input.language)) {
    /*
     * A language TraceIQ parses. Not an artefact this layer describes, and the caller skips it.
     *
     * **Decided by language rather than by role, and that distinction was a defect.** Skipping every file
     * the scanner called `source` also skipped shell scripts and SQL schemas, because the scanner counts
     * both as source languages — correctly, since they execute — while no analyser exists for either. So
     * the two file kinds most likely to *be* a repository's deployment went undescribed by anything.
     */
    return { kind: 'unknown-artifact', evidence: 'it is source code, described by its language analyser' };
  }

  if (input.role === 'source') {
    // A source language with neither an analyser nor a reader here: HTML, CSS, protobuf, GraphQL. Recorded
    // so it exists in the graph with a boundary, rather than described wrongly or not at all.
    return {
      kind: 'unknown-artifact',
      evidence: `it is ${input.language ?? 'source'}, for which TraceIQ has neither a language analyser nor an artefact reader`,
    };
  }

  return { kind: 'unknown-artifact', evidence: 'nothing about this file identifies what reads it' };
}

/**
 * Languages a TraceIQ analyser parses, whose files this layer must not describe.
 *
 * **The list is of analysers rather than of "programming languages", and the difference is load-bearing.**
 * A line reader's account of a TypeScript file would be strictly worse than the compiler-backed one the
 * graph already holds, so describing it twice would give the graph two answers to one question. A shell
 * script has no such account, so reading what it invokes is the only description it will ever get.
 *
 * Languages an analyser may arrive for later are absent until it does: while none exists, an artefact
 * reading is more than the nothing the alternative provides.
 */
const ANALYSED_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
]);

/**
 * A YAML file's family, from what its first document declares.
 *
 * Ordered by how strongly the declaration commits. `apiVersion` plus `kind` is a Kubernetes-style
 * resource and is checked first, because a Tekton pipeline declares `apiVersion`, `kind` *and* something
 * pipeline-shaped, and it is a resource that describes a pipeline rather than a CI configuration.
 */
function yamlKind(name: string, contents: string | null): Classification {
  if (contents === null) {
    return { kind: 'unknown-artifact', evidence: `${name} was not read, so its structure is unknown` };
  }

  const keys = topLevelKeys(scanYaml(contents));

  if (keys.has('apiVersion') && keys.has('kind')) {
    return { kind: 'orchestration-resource', evidence: 'it declares apiVersion and kind at the top level' };
  }

  if (keys.has('services')) {
    return { kind: 'container-compose', evidence: 'it declares services at the top level' };
  }

  if (PIPELINE_KEYS.some((key) => keys.has(key))) {
    const declared = PIPELINE_KEYS.filter((key) => keys.has(key)).join(', ');

    return { kind: 'ci-workflow', evidence: `it declares ${declared} at the top level` };
  }

  if (WORKSPACE_NAMES.has(name)) {
    return { kind: 'workspace-configuration', evidence: `${name} defines the workspace layout` };
  }

  if (keys.has('resources') || keys.has('resource')) {
    return { kind: 'infrastructure-as-code', evidence: 'it declares resources at the top level' };
  }

  if (TOOL_CONFIG_SUFFIX.test(name) || TOOL_CONFIG_NAMES.has(name)) {
    return { kind: 'tool-configuration', evidence: `${name} configures a development tool` };
  }

  return {
    kind: 'data',
    // Deliberately not `tool-configuration`: the file is YAML and says nothing about what reads it, and
    // naming a consumer would be inventing one.
    evidence: 'it is YAML whose top level declares nothing that identifies its purpose',
  };
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
