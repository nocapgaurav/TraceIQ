import { describe, expect, it } from 'vitest';

import { analyseArtifacts } from './analyse.js';
import { classify } from './classify.js';
import type { Artifact, RepositoryArtifacts } from './types.js';

/**
 * Artefact reading, against seven synthetic repositories of deliberately different shapes.
 *
 * **Every fixture here is a *style* rather than a repository.** None of them is a copy of anything in the
 * validation corpus, and none of them contains a name from one: the whole claim of this milestone is that
 * behaviour derives from artefact structure rather than from recognising a project, and a fixture that
 * reproduced a real repository's filenames would let a rule that keyed on them pass.
 *
 * The seven are the ones the milestone names: an ordinary application, a CI-heavy repository, a container
 * repository, a monorepo, a documentation repository, a library, and one whose structure says almost
 * nothing. Each asserts the two properties that matter: useful facts come out of files with no
 * declarations, and where nothing can be read the boundary says so rather than the file reading as empty.
 */

function repository(files: Readonly<Record<string, string>>): {
  readonly files: readonly { readonly path: string; readonly language: string | null; readonly role: string; readonly bytes: number }[];
  readonly readFile: (path: string) => Promise<string | null>;
} {
  return {
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      language: languageOf(path),
      role: roleOf(path),
      bytes: contents.length,
    })),
    readFile: async (path) => files[path] ?? null,
  };
}

/** The scanner's own rules, reproduced narrowly enough for a fixture. The real ones are tested there. */
function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();

  if (name === 'dockerfile' || name.startsWith('dockerfile.')) {
    return 'dockerfile';
  }

  const byExtension: Readonly<Record<string, string>> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    py: 'python',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    toml: 'toml',
    sql: 'sql',
    sh: 'shell',
    tf: 'terraform',
    xml: 'xml',
    prisma: 'prisma',
  };

  return byExtension[name.split('.').pop() ?? ''] ?? null;
}

function roleOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const language = languageOf(path);

  if (['package.json', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pom.xml'].includes(name)) {
    return 'manifest';
  }

  if (name === 'pnpm-lock.yaml' || name.endsWith('.lock')) {
    return 'build';
  }

  if (name === 'makefile') {
    return 'build';
  }

  if (language === 'dockerfile' || name.startsWith('docker-compose') || language === 'terraform') {
    return 'infrastructure';
  }

  if (/\.(test|spec)\./.test(name) || path.includes('/tests/') || path.startsWith('tests/')) {
    return 'test';
  }

  if (language === 'markdown') {
    return 'documentation';
  }

  if (language === 'yaml' || language === 'json' || language === 'toml' || language === 'xml') {
    return 'configuration';
  }

  return language === null ? 'other' : 'source';
}

const found = (result: RepositoryArtifacts, path: string): Artifact => {
  const artifact = result.artifacts.find((entry) => entry.path === path);

  if (artifact === undefined) {
    throw new Error(`no artefact was recorded for ${path}; got ${result.artifacts.map((entry) => entry.path).join(', ')}`);
  }

  return artifact;
};

const names = (artifact: Artifact, kind: string): readonly string[] =>
  artifact.elements.filter((element) => element.kind === kind).map((element) => element.name);

// ---------------------------------------------------------------------------------------------
// 1. An ordinary application
// ---------------------------------------------------------------------------------------------

describe('an ordinary application', () => {
  const input = repository({
    'package.json': JSON.stringify({
      name: 'shop',
      main: 'src/index.ts',
      scripts: { build: 'tsc -b', migrate: 'node scripts/migrate.js' },
      dependencies: { express: '^4' },
    }),
    'src/index.ts': 'export const start = () => {};',
    'scripts/migrate.js': 'console.log("migrating");',
    '.env.example': 'DATABASE_URL=postgres://localhost/shop\nSTRIPE_KEY=sk_test_do_not_record_this',
    'db/schema.sql':
      'CREATE TABLE orders (id serial primary key);\nCREATE INDEX orders_by_customer ON orders (customer_id);\nCREATE TABLE customers (id serial);',
  });

  it('reads a manifest for what nothing else reads: its scripts and its entry point', async () => {
    const manifest = found(await analyseArtifacts(input), 'package.json');

    expect(manifest.kind).toBe('package-manifest');
    expect(names(manifest, 'script-target')).toEqual(['build', 'migrate']);
    expect(manifest.elements.some((element) => element.name === 'main: src/index.ts')).toBe(true);
  });

  it('resolves a script a manifest command invokes, and leaves a bare script name alone', async () => {
    const manifest = found(await analyseArtifacts(input), 'package.json');
    const invoked = manifest.references.filter((reference) => reference.kind === 'command').flatMap((entry) => entry.candidates);

    // `node scripts/migrate.js` names a file; `tsc -b` names a binary, and treating it as a path would
    // fabricate a reference to something the repository does not contain.
    expect(invoked).toEqual(['scripts/migrate.js']);
  });

  it('records environment variable names and never their values', async () => {
    const env = found(await analyseArtifacts(input), '.env.example');

    expect(names(env, 'variable')).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    // The one hard rule in this package: a `.env` holds live credentials in a great many repositories,
    // and a value recorded here would reach the graph, then a prompt, then an answer.
    expect(JSON.stringify(env)).not.toContain('sk_test_do_not_record_this');
    expect(JSON.stringify(env)).not.toContain('postgres://');
  });

  it('reads a schema for its entities and indexes', async () => {
    const schema = found(await analyseArtifacts(input), 'db/schema.sql');

    expect(schema.kind).toBe('schema');
    expect(names(schema, 'entity')).toEqual(['orders', 'customers']);
    expect(names(schema, 'index')).toEqual(['orders_by_customer']);
  });

  it('describes no source file, because the language analysers do that better', async () => {
    const result = await analyseArtifacts(input);

    expect(result.artifacts.map((entry) => entry.path)).not.toContain('src/index.ts');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. A CI-heavy repository
// ---------------------------------------------------------------------------------------------

describe('a CI-heavy repository', () => {
  const input = repository({
    '.github/workflows/release.yml': [
      'name: Release',
      'on:',
      '  push:',
      '    branches: [main]',
      'env:',
      '  NODE_ENV: production',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Checkout',
      '        uses: actions/checkout@v4',
      '      - name: Compile',
      '        run: |',
      '          npm ci',
      '          bash scripts/build.sh',
      '  publish:',
      '    needs: build',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Publish',
      '        run: bash scripts/release.sh',
      '        env:',
      '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    ].join('\n'),
    'scripts/build.sh': '#!/usr/bin/env bash\nset -e\nnpm run compile',
    'scripts/release.sh': '#!/usr/bin/env bash\nBUILD_ID=1\nbash scripts/build.sh',
    'README.md': '# Templates\n\nSee [the build script](scripts/build.sh).',
  });

  it('reads jobs, steps and commands out of a file with no declarations at all', async () => {
    const workflow = found(await analyseArtifacts(input), '.github/workflows/release.yml');

    expect(workflow.kind).toBe('ci-workflow');
    expect(names(workflow, 'job')).toEqual(['build', 'publish']);
    expect(names(workflow, 'step')).toContain('Checkout');
    expect(names(workflow, 'step')).toContain('Publish');
    expect(workflow.elements.filter((element) => element.kind === 'command').length).toBeGreaterThan(0);
  });

  it('records the prerequisite the workflow declares, and nothing about the order steps appear in', async () => {
    const workflow = found(await analyseArtifacts(input), '.github/workflows/release.yml');
    const publish = workflow.elements.find((element) => element.kind === 'job' && element.name === 'publish');
    const build = workflow.elements.find((element) => element.kind === 'job' && element.name === 'build');

    expect(publish?.requires).toEqual(['build']);
    // `build` is written above `publish` and declares no prerequisite. Position is not evidence.
    expect(build?.requires).toEqual([]);
  });

  it('resolves the scripts a step invokes', async () => {
    const workflow = found(await analyseArtifacts(input), '.github/workflows/release.yml');
    const invoked = workflow.references.filter((entry) => entry.kind === 'command').flatMap((entry) => entry.candidates);

    expect(invoked).toContain('scripts/build.sh');
    expect(invoked).toContain('scripts/release.sh');
  });

  it('records the variables the workflow supplies, from both spellings', async () => {
    const workflow = found(await analyseArtifacts(input), '.github/workflows/release.yml');
    const variables = workflow.references.filter((entry) => entry.kind === 'environment').map((entry) => entry.text);

    expect(variables).toContain('NODE_ENV');
    expect(variables).toContain('NPM_TOKEN');
  });

  it('reads a shell script for what it invokes, and states that it did not follow control flow', async () => {
    const script = found(await analyseArtifacts(input), 'scripts/release.sh');

    expect(script.kind).toBe('script');
    expect(script.references.some((entry) => entry.candidates.includes('scripts/build.sh'))).toBe(true);
    expect(script.boundary).toMatch(/control flow is not followed/i);
  });

  it('reads documentation for its headings and its links', async () => {
    const readme = found(await analyseArtifacts(input), 'README.md');

    expect(readme.kind).toBe('documentation');
    expect(names(readme, 'heading')).toEqual(['Templates']);
    expect(readme.references.flatMap((entry) => entry.candidates)).toContain('scripts/build.sh');
  });
});

// ---------------------------------------------------------------------------------------------
// 3. A container repository
// ---------------------------------------------------------------------------------------------

describe('a container repository', () => {
  const input = repository({
    Dockerfile: [
      'FROM node:20-alpine AS deps',
      'WORKDIR /app',
      'COPY package.json ./',
      'RUN npm ci',
      '',
      'FROM node:20-alpine AS runtime',
      'COPY --from=deps /app/node_modules ./node_modules',
      'ENV PORT=3000',
      'EXPOSE 3000',
      'CMD ["node", "server.js"]',
    ].join('\n'),
    'docker-compose.yml': [
      'services:',
      '  api:',
      '    build:',
      '      context: .',
      '    ports:',
      '      - "3000:3000"',
      '    environment:',
      '      DATABASE_URL: postgres://db/app',
      '    depends_on:',
      '      - db',
      '  db:',
      '    image: postgres:16',
      '    volumes:',
      '      - ./data:/var/lib/postgresql/data',
      'volumes:',
      '  pgdata:',
    ].join('\n'),
    'package.json': JSON.stringify({ name: 'svc' }),
    'k8s/deployment.yaml': [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: api',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: api',
      '          image: registry.example/api:1',
      '          ports:',
      '            - containerPort: 3000',
    ].join('\n'),
  });

  it('reads a Dockerfile as stages, images, ports and commands', async () => {
    const image = found(await analyseArtifacts(input), 'Dockerfile');

    expect(image.kind).toBe('container-image');
    expect(names(image, 'stage')).toEqual(['deps', 'runtime']);
    // Once per stage: each `FROM` is that stage declaring what it builds from, and merging them would
    // lose which stage the runtime image belongs to.
    expect(names(image, 'image')).toEqual(['node:20-alpine', 'node:20-alpine']);
    expect(names(image, 'port')).toEqual(['3000']);
    expect(names(image, 'variable')).toEqual(['PORT']);
  });

  it('reads a cross-stage copy as the build ordering the Dockerfile states', async () => {
    const image = found(await analyseArtifacts(input), 'Dockerfile');
    const copy = image.elements.find((element) => element.name === 'copy from deps');

    expect(copy?.requires).toEqual(['deps']);
  });

  it('tells a stage apart from a registry image in a cross-stage copy', async () => {
    /*
     * `COPY --from=` names either an earlier stage or an image pulled from a registry, and only the first is
     * this build declaring its own order. Recording the second as a prerequisite produced one dangling
     * `DEPENDS_ON` per Dockerfile across a repository of container examples — every one pointing at a stage
     * that does not exist.
     */
    const withImage = await analyseArtifacts(
      repository({
        Dockerfile: ['FROM node:20 AS deps', 'FROM node:20 AS runtime', 'COPY --from=someorg/sometool / /'].join('\n'),
      }),
    );
    const image = found(withImage, 'Dockerfile');

    expect(image.elements.filter((element) => element.requires.length > 0)).toEqual([]);
    expect(names(image, 'image')).toContain('someorg/sometool');
  });

  it('reads compose as services, with the prerequisites it declares between them', async () => {
    const compose = found(await analyseArtifacts(input), 'docker-compose.yml');

    expect(compose.kind).toBe('container-compose');
    expect(names(compose, 'service')).toEqual(['api', 'db']);
    expect(compose.elements.find((element) => element.name === 'api')?.requires).toEqual(['db']);
    expect(names(compose, 'image')).toEqual(['postgres:16']);
  });

  it('classifies a Kubernetes-style resource from what it declares, not from its path', async () => {
    const resource = found(await analyseArtifacts(input), 'k8s/deployment.yaml');

    // The path says `k8s`, which is a convention; `apiVersion` plus `kind` is the document saying so.
    expect(resource.kind).toBe('orchestration-resource');
    expect(names(resource, 'resource')).toEqual(['Deployment api']);
    expect(names(resource, 'image')).toEqual(['registry.example/api:1']);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. A monorepo
// ---------------------------------------------------------------------------------------------

describe('a monorepo', () => {
  const input = repository({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/core/package.json': JSON.stringify({ name: '@x/core', main: 'src/index.ts' }),
    'packages/web/package.json': JSON.stringify({ name: '@x/web', scripts: { dev: 'next dev' } }),
    'packages/core/src/index.ts': 'export const core = 1;',
  });

  it('records each package manifest separately, so a unit is not merged into its parent', async () => {
    const result = await analyseArtifacts(input);
    const manifests = result.artifacts.filter((entry) => entry.kind === 'package-manifest');

    expect(manifests.map((entry) => entry.path)).toEqual([
      'package.json',
      'packages/core/package.json',
      'packages/web/package.json',
    ]);
  });

  it('reads the workspace members the root manifest claims', async () => {
    const root = found(await analyseArtifacts(input), 'package.json');

    expect(names(root, 'member')).toEqual(['packages/*']);
  });

  it('reads a workspace file as a workspace, not as generic configuration', async () => {
    const workspace = found(await analyseArtifacts(input), 'pnpm-workspace.yaml');

    expect(workspace.kind).toBe('workspace-configuration');
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A documentation repository
// ---------------------------------------------------------------------------------------------

describe('a documentation repository', () => {
  const input = repository({
    'README.md': '# Handbook\n\n## Getting started\n\nRead [the setup guide](docs/setup.md) first.\n',
    'docs/setup.md': 'Setup\n=====\n\nInstall it.\n\n```bash\n# not a heading\nnpm i\n```\n\n## Next\n',
    'docs/adr/0001-choice.md': '# Choice\n\nWe chose it.\n',
  });

  it('reads both heading syntaxes and ignores a hash inside a code fence', async () => {
    const setup = found(await analyseArtifacts(input), 'docs/setup.md');

    expect(names(setup, 'heading')).toEqual(['Setup', 'Next']);
  });

  it('offers both readings of a path as one reference, never as two', async () => {
    /*
     * A path inside a nested artefact has two readings and only one is right. Emitting them as two
     * references made the unchosen one a phantom dead link, which put 431 of them on one documentation
     * repository — every one a link that resolves perfectly well.
     */
    const nested = await analyseArtifacts(
      repository({ 'docs/setup.md': 'See [the guide](guide.md).', 'docs/guide.md': '# Guide' }),
    );
    const links = found(nested, 'docs/setup.md').references.filter((entry) => entry.kind === 'link');

    expect(links).toHaveLength(1);
    expect(links[0]?.candidates).toEqual(['guide.md', 'docs/guide.md']);
  });

  it('resolves a relative link to the file it names', async () => {
    const readme = found(await analyseArtifacts(input), 'README.md');
    const links = readme.references.filter((entry) => entry.kind === 'link');

    expect(links.flatMap((entry) => entry.candidates)).toEqual(['docs/setup.md']);
    expect(links[0]?.element).toBe('Getting started');
  });

  it('says that it did not interpret the prose', async () => {
    const readme = found(await analyseArtifacts(input), 'README.md');

    // The boundary is what stops a heading list reading as an understanding of the document.
    expect(readme.boundary).toMatch(/the prose itself is not interpreted/i);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. A library
// ---------------------------------------------------------------------------------------------

describe('a library', () => {
  const input = repository({
    'pyproject.toml': [
      '[project]',
      'name = "widget"',
      'version = "1.0"',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
    ].join('\n'),
    'tests/test_widget.py': 'def test_builds():\n    assert True\n\ndef test_fails():\n    assert False\n',
    'src/widget/__init__.py': 'VERSION = "1.0"',
    'poetry.lock': 'x'.repeat(500),
  });

  it('reads a TOML manifest as sections and settings', async () => {
    const manifest = found(await analyseArtifacts(input), 'pyproject.toml');

    expect(manifest.kind).toBe('package-manifest');
    expect(names(manifest, 'section')).toEqual(['project', 'tool.pytest.ini_options']);
    expect(names(manifest, 'setting')).toContain('name');
  });

  it('reads a test file as the suites and cases it names', async () => {
    const test = found(await analyseArtifacts(input), 'tests/test_widget.py');

    expect(test.kind).toBe('test');
    expect(names(test, 'step')).toEqual(['test_builds', 'test_fails']);
  });

  it('records a lockfile as present and states that it was deliberately not read', async () => {
    const lock = found(await analyseArtifacts(input), 'poetry.lock');

    expect(lock.kind).toBe('lockfile');
    expect(lock.read).toBe(false);
    expect(lock.elements).toEqual([]);
    expect(lock.boundary).toMatch(/deliberately not read/i);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. A repository whose structure says almost nothing
// ---------------------------------------------------------------------------------------------

describe('a repository with weak structure', () => {
  const input = repository({
    LICENSE: 'MIT',
    'data/fixture.bin': '\u0000\u0001binary',
    'notes.txt': 'some notes',
    'config/unknown.yaml': 'colour: blue\nsize: 3\n',
  });

  it('degrades gracefully: a family, a boundary, and no invented structure', async () => {
    const result = await analyseArtifacts(input);
    const licence = found(result, 'LICENSE');

    expect(licence.kind).toBe('unknown-artifact');
    expect(licence.read).toBe(false);
    expect(licence.elements).toEqual([]);
    // The whole difference between "we did not look" and "there is nothing here".
    expect(licence.boundary).toMatch(/TraceIQ has no reader for this format/i);
    expect(licence.summary).not.toBe('');
  });

  it('refuses to name a consumer for YAML that names none', async () => {
    const unknown = found(await analyseArtifacts(input), 'config/unknown.yaml');

    // `data`, not `tool-configuration`: claiming a tool nobody named would be inventing one.
    expect(unknown.kind).toBe('data');
    expect(names(unknown, 'setting')).toEqual(['colour', 'size']);
  });

  it('counts what it could not read, so the gap is visible without opening a graph', async () => {
    const result = await analyseArtifacts(input);

    expect(result.unread).toBeGreaterThan(0);
    expect(result.artifacts.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------
// Cross-cutting properties
// ---------------------------------------------------------------------------------------------

describe('properties that hold for every repository', () => {
  it('never returns an artefact with an empty boundary or an empty summary', async () => {
    const result = await analyseArtifacts(
      repository({
        'a.yml': 'jobs:\n  x:\n    steps:\n      - run: echo hi\n',
        Dockerfile: 'FROM scratch',
        'b.md': '# T',
        'c.unknownext': 'x',
        'package.json': '{ "name": "n" }',
      }),
    );

    for (const artifact of result.artifacts) {
      expect(artifact.boundary.length).toBeGreaterThan(20);
      expect(artifact.summary.length).toBeGreaterThan(5);
    }
  });

  it('is deterministic: the same repository reads to the same artefacts', async () => {
    const input = repository({
      '.github/workflows/a.yml': 'jobs:\n  b:\n    steps:\n      - run: make test\n',
      'Makefile': 'test:\n\tpytest\n',
    });

    const first = await analyseArtifacts(input);
    const second = await analyseArtifacts(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('classifies a YAML file from its content rather than from its name', () => {
    const asWorkflow = classify({
      path: 'deploy.yml',
      language: 'yaml',
      role: 'configuration',
      contents: 'jobs:\n  a:\n    steps: []\n',
    });
    const asCompose = classify({
      path: 'deploy.yml',
      language: 'yaml',
      role: 'configuration',
      contents: 'services:\n  a:\n    image: x\n',
    });

    // The same filename, two families. Nothing keyed on the name could tell these apart.
    expect(asWorkflow.kind).toBe('ci-workflow');
    expect(asCompose.kind).toBe('container-compose');
  });

  it('caps its own output rather than letting one file dominate the graph', async () => {
    const headings = Array.from({ length: 300 }, (_unused, index) => `# Heading ${index}`).join('\n\n');
    const result = await analyseArtifacts(repository({ 'huge.md': headings }));
    const huge = found(result, 'huge.md');

    expect(huge.elements.length).toBeLessThanOrEqual(60);
    // The cap is reported rather than applied silently, which is the same obligation every capped list
    // in TraceIQ carries.
    expect(result.droppedElements).toBeGreaterThan(0);
  });
});
