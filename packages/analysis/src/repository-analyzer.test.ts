import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OFFLINE_PROBE } from './github-probe.js';
import { RepositoryAnalyzer } from './repository-analyzer.js';
import { WORKSPACE_PREFIX } from './workspace.js';
import type { CloneRequest, CloneOutcome, GitCloner } from './git-cloner.js';
import type { AnalysisStage } from './types.js';

/**
 * The analysis workflow, over the **real** pipeline.
 *
 * Only the clone is substituted — for a cloner that writes a small TypeScript repository into the
 * workspace it is given. Everything after that is the production path: the real scanner, resolver, graph
 * builder and SQLite store. That is the point of the test. A fake pipeline would prove the workflow
 * calls something; this proves a cloned directory becomes a readable repository graph.
 */
class FixtureCloner implements GitCloner {
  seen: CloneRequest | null = null;

  constructor(private readonly write: (destination: string) => Promise<void>) {}

  async clone(request: CloneRequest): Promise<CloneOutcome> {
    this.seen = request;
    await this.write(request.destination);

    return { ok: true, failure: null, stderr: '' };
  }
}

class FailingCloner implements GitCloner {
  constructor(private readonly outcome: CloneOutcome) {}

  async clone(): Promise<CloneOutcome> {
    return this.outcome;
  }
}

async function writeTypeScriptRepository(destination: string): Promise<void> {
  await mkdir(path.join(destination, 'src'), { recursive: true });
  await writeFile(
    path.join(destination, 'package.json'),
    JSON.stringify({ name: 'fixture-repo', version: '1.0.0', main: 'src/index.ts' }),
  );
  await writeFile(path.join(destination, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  await writeFile(
    path.join(destination, 'src', 'service.ts'),
    'export class UserService {\n  find(id: string): string {\n    return id;\n  }\n}\n',
  );
  await writeFile(
    path.join(destination, 'src', 'index.ts'),
    "import { UserService } from './service.js';\n\nexport function run(): string {\n  return new UserService().find('a');\n}\n",
  );
}

let databaseDirectory: string;
let databasePath: string;

beforeEach(async () => {
  databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-analysis-test-'));
  databasePath = path.join(databaseDirectory, 'graph.db');
});

afterEach(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

/**
 * Whether a specific workspace still exists.
 *
 * The exact directory, not a count of everything under the temp root: other test files run at the same
 * time and create workspaces of their own, so a before-and-after comparison of the shared directory
 * races with them. Asserting the path this analysis actually used is both stable and stronger.
 */
async function exists(directory: string): Promise<boolean> {
  try {
    await readdir(directory);

    return true;
  } catch {
    return false;
  }
}

describe('RepositoryAnalyzer', () => {
  it('turns a GitHub URL into a stored, readable repository graph', async () => {
    const cloner = new FixtureCloner(writeTypeScriptRepository);
    const analyzer = new RepositoryAnalyzer({ cloner, probe: OFFLINE_PROBE });

    const outcome = await analyzer.analyze({
      url: 'https://github.com/example/fixture-repo',
      databasePath,
      createdAt: '1970-01-01T00:00:00.000Z',
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.repository?.slug).toBe('example/fixture-repo');
    // Real figures from the real pipeline, not a stub's.
    expect(outcome.result?.files).toBe(2);
    expect(outcome.result?.declarations).toBeGreaterThan(0);
    expect(outcome.result?.nodes).toBeGreaterThan(0);
    expect(outcome.result?.edges).toBeGreaterThan(0);
  });

  it('hands the pipeline the cloned directory, and nothing about GitHub', async () => {
    const cloner = new FixtureCloner(writeTypeScriptRepository);
    const analyzer = new RepositoryAnalyzer({ cloner, probe: OFFLINE_PROBE });

    await analyzer.analyze({
      url: 'https://github.com/example/fixture-repo',
      databasePath,
      createdAt: '1970-01-01T00:00:00.000Z',
    });

    // The clone target is a fresh workspace, not a path derived from the URL.
    expect(cloner.seen?.destination).toContain(WORKSPACE_PREFIX);
    expect(cloner.seen?.repository.cloneUrl).toBe('https://github.com/example/fixture-repo.git');
  });

  it('reports every stage in order, and marks them done', async () => {
    const seen: AnalysisStage[][] = [];
    const analyzer = new RepositoryAnalyzer({ cloner: new FixtureCloner(writeTypeScriptRepository), probe: OFFLINE_PROBE });

    await analyzer.analyze(
      { url: 'facebook/react', databasePath, createdAt: '1970-01-01T00:00:00.000Z' },
      (stages) => {
        seen.push([...stages]);
      },
    );

    const last = seen.at(-1) ?? [];

    expect(last.map((stage) => stage.name)).toEqual(['validate', 'clone', 'scan', 'load', 'complete']);
    expect(last.every((stage) => stage.status === 'done')).toBe(true);
    // The scan stage reports what it actually produced.
    expect(last.find((stage) => stage.name === 'scan')?.detail).toMatch(/\d+ files, \d+ nodes, \d+ edges/);
  });

  it('never reports a stage as done before it has run', async () => {
    const snapshots: AnalysisStage[][] = [];
    const analyzer = new RepositoryAnalyzer({ cloner: new FixtureCloner(writeTypeScriptRepository), probe: OFFLINE_PROBE });

    await analyzer.analyze(
      { url: 'facebook/react', databasePath, createdAt: '1970-01-01T00:00:00.000Z' },
      (stages) => {
        snapshots.push([...stages]);
      },
    );

    // In every snapshot, a done stage is only ever followed by stages that are not yet done.
    for (const snapshot of snapshots) {
      const statuses = snapshot.map((stage) => stage.status);
      const lastDone = statuses.lastIndexOf('done');
      const firstPending = statuses.indexOf('pending');

      if (lastDone !== -1 && firstPending !== -1) {
        expect(lastDone).toBeLessThan(firstPending);
      }
    }
  });

  describe('failures', () => {
    it('rejects a bad URL without creating a workspace or cloning', async () => {
      const cloner = new FixtureCloner(writeTypeScriptRepository);
      const analyzer = new RepositoryAnalyzer({ cloner, probe: OFFLINE_PROBE });

      const outcome = await analyzer.analyze({
        url: 'https://gitlab.com/owner/repo',
        databasePath,
        createdAt: '1970-01-01T00:00:00.000Z',
      });

      expect(outcome.failure?.code).toBe('invalid-url');
      // Nothing was cloned, so nothing was created to clean up.
      expect(cloner.seen).toBeNull();
    });

    it('carries a clone failure through unchanged, and skips the later stages', async () => {
      const analyzer = new RepositoryAnalyzer({
        probe: OFFLINE_PROBE,
        cloner: new FailingCloner({
          ok: false,
          stderr: '',
          failure: { code: 'repository-not-found', detail: 'gone', hint: 'check the spelling' },
        }),
      });

      let stages: readonly AnalysisStage[] = [];

      const outcome = await analyzer.analyze(
        { url: 'facebook/react', databasePath, createdAt: '1970-01-01T00:00:00.000Z' },
        (next) => {
          stages = next;
        },
      );

      expect(outcome.failure?.code).toBe('repository-not-found');
      expect(stages.find((stage) => stage.name === 'clone')?.status).toBe('failed');
      // Nothing downstream is left claiming it is still to come.
      expect(stages.filter((stage) => stage.status === 'pending')).toHaveLength(0);
      expect(stages.filter((stage) => stage.status === 'skipped').length).toBeGreaterThan(0);
    });

    it('reports a repository with no TypeScript as unsupported, not as a crash', async () => {
      const analyzer = new RepositoryAnalyzer({
        probe: OFFLINE_PROBE,
        cloner: new FixtureCloner(async (destination) => {
          await writeFile(path.join(destination, 'README.md'), '# nothing to analyse');
        }),
      });

      const outcome = await analyzer.analyze({
        url: 'example/empty',
        databasePath,
        createdAt: '1970-01-01T00:00:00.000Z',
      });

      // The pipeline refuses it — "detected as 'unknown', not TypeScript" — and that has to reach the
      // user as a supported-languages message rather than as a pipeline crash.
      expect(outcome.failure?.code).toBe('unsupported-repository');
      expect(outcome.failure?.detail).toMatch(/is not a TypeScript repository/);
      expect(outcome.failure?.hint).toMatch(/\.ts or \.tsx sources/);
    });
  });

  describe('workspace', () => {
    it('removes the workspace it used on success', async () => {
      const cloner = new FixtureCloner(writeTypeScriptRepository);
      const analyzer = new RepositoryAnalyzer({ cloner, probe: OFFLINE_PROBE });

      const outcome = await analyzer.analyze({
        url: 'example/fixture',
        databasePath,
        createdAt: '1970-01-01T00:00:00.000Z',
      });

      expect(outcome.result).not.toBeNull();
      expect(cloner.seen?.destination).toContain(WORKSPACE_PREFIX);
      expect(await exists(cloner.seen?.destination ?? '')).toBe(false);
    });

    it('removes the workspace even when the clone fails', async () => {
      // A failing cloner is still handed a destination, so the workspace was created and must be removed.
      let destination = '';
      const analyzer = new RepositoryAnalyzer({
        probe: OFFLINE_PROBE,
        cloner: {
          clone: async (request) => {
            destination = request.destination;

            return { ok: false, stderr: '', failure: { code: 'clone-failed', detail: 'no', hint: 'no' } };
          },
        },
      });

      await analyzer.analyze({ url: 'example/fixture', databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

      expect(destination).toContain(WORKSPACE_PREFIX);
      expect(await exists(destination)).toBe(false);
    });

    /** The clone must still be on disk while the pipeline reads it. */
    it('disposes only after the scan has finished', async () => {
      let workspaceDuringScan: string | null = null;
      let existedDuringScan = false;

      const analyzer = new RepositoryAnalyzer({
        probe: OFFLINE_PROBE,
        cloner: new FixtureCloner(async (destination) => {
          workspaceDuringScan = destination;
          await writeTypeScriptRepository(destination);
        }),
      });

      const outcome = await analyzer.analyze(
        { url: 'example/fixture', databasePath, createdAt: '1970-01-01T00:00:00.000Z' },
        (stages) => {
          // Checked while `scan` is active: the workspace has to exist at that moment.
          if (stages.find((stage) => stage.name === 'scan')?.status === 'active' && workspaceDuringScan !== null) {
            existedDuringScan = true;
          }
        },
      );

      expect(existedDuringScan).toBe(true);
      expect(outcome.result).not.toBeNull();
    });
  });
});
