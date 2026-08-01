import { ECOSYSTEMS, type Ecosystem } from '@traceiq/types';

/**
 * Language identification by file extension and filename.
 *
 * Extension is weak evidence, and deliberately the only evidence used here. Reading a
 * file to confirm its language would mean the scanner parses, which is the boundary this
 * package exists to hold: it reports what a repository *contains*, and a language
 * analyser decides what that means.
 *
 * The consequence is stated rather than hidden — a `.h` could be C or C++, and a `.ts`
 * could be a Qt translation file. Both are reported by extension, and a language
 * analyser that cares must confirm for itself.
 */

/**
 * Languages TraceIQ can name.
 *
 * Naming a language is not a claim to analyse it. This list exists so a repository's
 * composition can be reported honestly — including for languages that will never get a
 * semantic analyser — and it is deliberately wider than the set anything can parse.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'java',
  'kotlin',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'scala',
  'shell',
  'sql',
  'html',
  'css',
  'markdown',
  'json',
  'yaml',
  'toml',
  'xml',
  'terraform',
  'dockerfile',
  'make',
  'gradle',
  'protobuf',
  'graphql',
] as const;

export type LanguageName = (typeof LANGUAGES)[number];

/**
 * What a file is *for*, as distinct from what it is written in.
 *
 * A repository's shape is carried as much by this as by language: `src/main.py` and
 * `tests/test_main.py` are both Python, and telling them apart is what lets a source root
 * be distinguished from a test root without parsing anything.
 */
export const FILE_ROLES = [
  'source',
  'test',
  'documentation',
  'configuration',
  /** A dependency or project manifest: package.json, pyproject.toml, go.mod. */
  'manifest',
  /** A lockfile, build script or task runner input: Makefile, build.gradle, yarn.lock. */
  'build',
  /** Deployment and provisioning: Dockerfile, docker-compose.yml, *.tf, Kubernetes YAML. */
  'infrastructure',
  /** Recognised as a file, with nothing further defensibly claimable. */
  'other',
] as const;

export type FileRole = (typeof FILE_ROLES)[number];

const BY_EXTENSION: Readonly<Record<string, LanguageName>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  rst: 'markdown',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  tf: 'terraform',
  tfvars: 'terraform',
  gradle: 'gradle',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
};

/** Files whose name, not extension, identifies them. */
const BY_FILENAME: Readonly<Record<string, LanguageName>> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  gnumakefile: 'make',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

/**
 * The language a file is written in, or `null` when none is recognised.
 *
 * `null` is a real answer and is kept as one. A binary, a licence or a lockfile has no
 * language, and inventing one would put fiction into the language distribution.
 */
export function languageOf(repoRelativePath: string): LanguageName | null {
  const name = basename(repoRelativePath).toLowerCase();

  const byName = BY_FILENAME[name];

  if (byName !== undefined) {
    return byName;
  }

  // `Dockerfile.prod` and `Dockerfile.dev` are Dockerfiles; so is `api.Dockerfile`.
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) {
    return 'dockerfile';
  }

  const extension = name.includes('.') ? (name.split('.').pop() as string) : '';

  return BY_EXTENSION[extension] ?? null;
}

/**
 * Manifest filenames, mapped to the ecosystem that reads them.
 *
 * A manifest is the strongest structural signal a repository gives without being parsed:
 * it names a project, usually declares dependencies, and marks the directory as the root
 * of something. Technology regions are anchored on exactly these.
 */
/**
 * Re-exported from `@traceiq/types` rather than declared here.
 *
 * The resolver and the graph need the same list — an external node's identity carries the ecosystem it
 * came from — and three copies of a closed vocabulary is three chances to drift. The name is kept
 * because it reads correctly at the call sites in this package, which are all about manifests.
 */
export const MANIFEST_ECOSYSTEMS = ECOSYSTEMS;

export type { Ecosystem };

const MANIFEST_FILENAMES: Readonly<Record<string, Ecosystem>> = {
  'package.json': 'npm',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  pipfile: 'python',
  'setup.py': 'python',
  'setup.cfg': 'python',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'settings.gradle': 'gradle',
  'settings.gradle.kts': 'gradle',
  'go.mod': 'go',
  'cargo.toml': 'cargo',
  'composer.json': 'composer',
  gemfile: 'bundler',
};

/** The ecosystem whose manifest this file is, or `null`. */
export function manifestEcosystemOf(repoRelativePath: string): Ecosystem | null {
  const name = basename(repoRelativePath).toLowerCase();

  if (name.endsWith('.csproj') || name.endsWith('.fsproj')) {
    return 'nuget';
  }

  return MANIFEST_FILENAMES[name] ?? null;
}

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

const BUILD_NAMES = new Set([
  'makefile',
  'gnumakefile',
  'rakefile',
  'justfile',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'mvnw',
  'cmakelists.txt',
  'meson.build',
  'bazel.build',
  'build.bazel',
  'workspace',
]);

const INFRASTRUCTURE_NAMES = new Set([
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'vagrantfile',
  'procfile',
]);

/** Directory names whose contents are tests, whatever the files are called. */
const TEST_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'testing',
  '__mocks__',
]);

/** Directory names whose contents are documentation. */
const DOCUMENTATION_DIRECTORIES = new Set(['doc', 'docs', 'documentation']);

/** Directory names conventionally holding infrastructure definitions. */
const INFRASTRUCTURE_DIRECTORIES = new Set([
  'infra',
  'infrastructure',
  'terraform',
  'deploy',
  'deployment',
  'k8s',
  'kubernetes',
  'helm',
  'charts',
]);

/**
 * Classifies what a file is for.
 *
 * Order matters and encodes precedence: an explicit filename beats a directory
 * convention, which beats the language. `docs/Dockerfile` is infrastructure, not
 * documentation, because naming a Dockerfile is a stronger signal than the folder it sits
 * in; `tests/conftest.py` is a test because the directory is a stronger signal than
 * Python's being a source language.
 *
 * Every rule is a convention rather than a proof, which is why the graph records these
 * with `INFERRED` confidence and names the rule that fired.
 */
export function roleOf(repoRelativePath: string, language: LanguageName | null): FileRole {
  const name = basename(repoRelativePath).toLowerCase();
  const segments = repoRelativePath.toLowerCase().split('/').slice(0, -1);

  if (manifestEcosystemOf(repoRelativePath) !== null) {
    return 'manifest';
  }

  if (LOCKFILE_NAMES.has(name) || BUILD_NAMES.has(name)) {
    return 'build';
  }

  if (INFRASTRUCTURE_NAMES.has(name) || language === 'dockerfile' || language === 'terraform') {
    return 'infrastructure';
  }

  if (segments.some((segment) => TEST_DIRECTORIES.has(segment)) || isTestFileName(name)) {
    return 'test';
  }

  if (segments.some((segment) => INFRASTRUCTURE_DIRECTORIES.has(segment))) {
    return 'infrastructure';
  }

  if (language === 'markdown') {
    return 'documentation';
  }

  if (segments.some((segment) => DOCUMENTATION_DIRECTORIES.has(segment))) {
    return 'documentation';
  }

  if (language === null) {
    return 'other';
  }

  if (CONFIGURATION_LANGUAGES.has(language)) {
    return 'configuration';
  }

  return PROGRAMMING_LANGUAGES.has(language) ? 'source' : 'other';
}

/**
 * Languages that describe rather than execute.
 *
 * `sql` is absent deliberately: a schema or a migration is closer to source than to
 * configuration, and grouping it with YAML would hide it.
 */
const CONFIGURATION_LANGUAGES: ReadonlySet<LanguageName> = new Set<LanguageName>([
  'json',
  'yaml',
  'toml',
  'xml',
]);

/** Languages a semantic analyser could one day be written for. */
const PROGRAMMING_LANGUAGES: ReadonlySet<LanguageName> = new Set<LanguageName>([
  'typescript',
  'javascript',
  'python',
  'java',
  'kotlin',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'scala',
  'shell',
  'sql',
  'html',
  'css',
  'protobuf',
  'graphql',
]);

/** `x.test.ts`, `x_test.go`, `test_x.py`, `XTest.java`, `x.spec.js`. */
function isTestFileName(name: string): boolean {
  const withoutExtension = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;

  return (
    withoutExtension.endsWith('.test') ||
    withoutExtension.endsWith('.spec') ||
    withoutExtension.endsWith('_test') ||
    withoutExtension.endsWith('test') ||
    withoutExtension.endsWith('tests') ||
    withoutExtension.startsWith('test_') ||
    withoutExtension === 'conftest'
  );
}

function basename(repoRelativePath: string): string {
  return repoRelativePath.slice(repoRelativePath.lastIndexOf('/') + 1);
}
