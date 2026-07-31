import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnalysisRegistry, resetAnalysisIds } from './analysis-registry.js';
import { RepositoryAnalyzer, type AnalysisOutcome, type StageListener } from './repository-analyzer.js';
import type { AnalysisRequest } from './repository-analyzer.js';

/**
 * The job registry.
 *
 * What matters here is the contract the HTTP layer depends on: accepting work without blocking, refusing
 * a second analysis while one is running, and never leaving a job stuck in `running` however the
 * workflow ends.
 */

/** An analyzer whose completion the test controls. */
class ControlledAnalyzer extends RepositoryAnalyzer {
  release!: (outcome: AnalysisOutcome) => void;
  fail!: (cause: Error) => void;
  started = 0;

  override async analyze(_request: AnalysisRequest, onStage: StageListener = () => {}): Promise<AnalysisOutcome> {
    this.started += 1;
    onStage(RepositoryAnalyzer.initialStages());

    return new Promise<AnalysisOutcome>((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
  }
}

const SUCCESS: AnalysisOutcome = {
  repository: {
    owner: 'facebook',
    name: 'react',
    slug: 'facebook/react',
    cloneUrl: 'https://github.com/facebook/react.git',
    htmlUrl: 'https://github.com/facebook/react',
  },
  result: {
    repository: 'react',
    slug: 'facebook/react',
    htmlUrl: 'https://github.com/facebook/react',
    files: 10,
    declarations: 20,
    nodes: 30,
    edges: 40,
    routes: 0,
    environmentVariables: 0,
    externalPackages: 1,
    callEdges: 5,
    unresolvedCalls: 1,
    unresolvedReferences: 2,
  },
  failure: null,
  workspaceWarning: null,
};

const REQUEST: AnalysisRequest = {
  url: 'https://github.com/facebook/react',
  databasePath: '/tmp/does-not-matter.db',
  createdAt: '1970-01-01T00:00:00.000Z',
};

let analyzer: ControlledAnalyzer;
let registry: AnalysisRegistry;
let clock: number;

beforeEach(() => {
  resetAnalysisIds();
  clock = 1000;
  analyzer = new ControlledAnalyzer();
  registry = new AnalysisRegistry({ analyzer, now: () => clock });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnalysisRegistry', () => {
  it('accepts work and returns before it finishes', () => {
    const outcome = registry.start(REQUEST);

    // Running, not queued: with one slot the work starts immediately, so there is nothing to wait in a
    // queue for. `queued` stays in the vocabulary for when a real queue exists — see the registry.
    expect(outcome.accepted).toBe(true);
    expect(outcome.job.status).toBe('running');
    expect(outcome.job.result).toBeNull();
    expect(outcome.job.stages.every((stage) => stage.status === 'pending')).toBe(true);
  });

  it('reports the job as running once the workflow has begun', async () => {
    const { job } = registry.start(REQUEST);

    await Promise.resolve();

    expect(registry.get(job.id)?.status).toBe('running');
    expect(registry.running()?.id).toBe(job.id);
  });

  /** A scan replaces the whole database, so two at once would race for one file. */
  it('refuses a second analysis while one is running, handing back the running job', async () => {
    const first = registry.start(REQUEST);

    await Promise.resolve();

    const second = registry.start({ ...REQUEST, url: 'https://github.com/vercel/next.js' });

    expect(second.accepted).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(analyzer.started).toBe(1);
  });

  it('records the result and frees the slot on success', async () => {
    const { job } = registry.start(REQUEST);

    await Promise.resolve();
    clock = 5000;
    analyzer.release(SUCCESS);
    await Promise.resolve();
    await Promise.resolve();

    const finished = registry.get(job.id);

    expect(finished?.status).toBe('succeeded');
    expect(finished?.result?.slug).toBe('facebook/react');
    expect(finished?.elapsedMs).toBe(4000);
    expect(registry.running()).toBeNull();
  });

  it('records a failure as a failed job, not as a rejection', async () => {
    const { job } = registry.start(REQUEST);

    await Promise.resolve();
    analyzer.release({
      repository: null,
      result: null,
      failure: { code: 'repository-not-found', detail: 'gone', hint: 'check it' },
      workspaceWarning: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.get(job.id)?.status).toBe('failed');
    expect(registry.get(job.id)?.error?.code).toBe('repository-not-found');
    expect(registry.running()).toBeNull();
  });

  /** A defect inside the workflow must not leave a job running for ever. */
  it('settles the job even when the workflow throws', async () => {
    const { job } = registry.start(REQUEST);

    await Promise.resolve();
    analyzer.fail(new Error('unexpected'));
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.get(job.id)?.status).toBe('failed');
    expect(registry.get(job.id)?.error?.code).toBe('pipeline-failed');
    expect(registry.running()).toBeNull();
  });

  it('lets a new analysis start once the previous one has settled', async () => {
    registry.start(REQUEST);
    await Promise.resolve();
    analyzer.release(SUCCESS);
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.start(REQUEST).accepted).toBe(true);
    expect(analyzer.started).toBe(2);
  });

  it('reports elapsed time, and stops the clock once finished', async () => {
    const { job } = registry.start(REQUEST);

    clock = 3000;
    expect(registry.get(job.id)?.elapsedMs).toBe(2000);

    await Promise.resolve();
    clock = 4000;
    analyzer.release(SUCCESS);
    await Promise.resolve();
    await Promise.resolve();

    clock = 99_000;
    // Finished jobs report how long they took, not how long ago they ran.
    expect(registry.get(job.id)?.elapsedMs).toBe(3000);
  });

  it('keeps finished jobs available to poll, newest first', async () => {
    for (let index = 0; index < 3; index += 1) {
      registry.start(REQUEST);
      await Promise.resolve();
      analyzer.release(SUCCESS);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(registry.list()).toHaveLength(3);
    expect(registry.list()[0]?.id).toBe('analysis-3');
  });

  it('drops the oldest finished jobs beyond its history', async () => {
    const small = new AnalysisRegistry({ analyzer, history: 2, now: () => clock });

    for (let index = 0; index < 4; index += 1) {
      small.start(REQUEST);
      await Promise.resolve();
      analyzer.release(SUCCESS);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(small.list().length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for an id it never issued', () => {
    expect(registry.get('analysis-does-not-exist')).toBeUndefined();
  });

  it('cancels a running analysis, and refuses to cancel a finished one', async () => {
    const { job } = registry.start(REQUEST);

    await Promise.resolve();
    expect(registry.cancel(job.id)).toBe(true);

    analyzer.release(SUCCESS);
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.cancel(job.id)).toBe(false);
  });
});
