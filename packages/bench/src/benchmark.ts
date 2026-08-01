import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RepositoryPipeline } from '@traceiq/pipeline';

import { measureQuality } from './metrics.js';
import type { QualityReport } from './types.js';

/**
 * Scans one repository and measures the graph it produced.
 *
 * The scan goes into a fresh temporary database that is deleted afterwards, so running
 * the benchmark never touches a repository's real `.traceiq` graph and two runs cannot
 * observe each other. The database is the only artefact; the repository is read-only
 * throughout.
 *
 * `createdAt` is fixed rather than taken from the clock. It is stamped into the stored
 * revision, and a benchmark whose output changed with the time of day would be useless
 * for comparing two runs.
 */
export async function benchmarkRepository(repositoryPath: string): Promise<QualityReport> {
  const absolutePath = path.resolve(repositoryPath);
  const directory = await mkdtemp(path.join(tmpdir(), 'traceiq-bench-'));
  const databasePath = path.join(directory, 'graph.db');

  try {
    const pipeline = new RepositoryPipeline();

    const startedAt = process.hrtime.bigint();
    const summary = await pipeline.scan({
      repositoryPath: absolutePath,
      databasePath,
      createdAt: FIXED_CREATED_AT,
    });
    const scanMillis = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

    const session = pipeline.open(databasePath);

    try {
      return measureQuality(session.api, {
        repository: summary.repository,
        repositoryPath: absolutePath,
        files: summary.files,
        nodes: summary.nodes,
        scanMillis,
      });
    } finally {
      session.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';
