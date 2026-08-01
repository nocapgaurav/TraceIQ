import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DECLARATION_NODE_KINDS, type RepositoryGraphApi } from '@traceiq/graph-api';
import { RepositoryPipeline } from '@traceiq/pipeline';
import { RELATIONSHIP_TYPES, type RelationshipType } from '@traceiq/types';

import { GROUND_TRUTH_CASES } from './ground-truth-cases.js';
import type { ExpectedFacts, FactScore, GroundTruthCase, GroundTruthReport } from './ground-truth-types.js';

/** How many examples of a miss to keep in a report. Enough to act on, short enough to read. */
const EXAMPLE_LIMIT = 8;

const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Runs every ground-truth case and measures each against its expectation.
 *
 * Sequential rather than parallel, deliberately: `scanMillis` and `heapBytes` are reported per case
 * and neither means anything if five scans are competing for the same cores and the same heap.
 */
export async function measureGroundTruth(
  cases: readonly GroundTruthCase[] = GROUND_TRUTH_CASES,
): Promise<readonly GroundTruthReport[]> {
  const reports: GroundTruthReport[] = [];

  for (const groundTruth of cases) {
    reports.push(await measureCase(groundTruth));
  }

  return reports;
}

/**
 * One case: write it to a temporary directory, scan it, score it, delete it.
 *
 * The directory is temporary because the fixture must not be part of the repository being measured.
 * TraceIQ's own scan is the baseline every regression comparison in this project rests on, and a
 * `.java` file committed inside `packages/bench` would appear in it as a new region — changing the
 * very number the comparison exists to hold still.
 */
async function measureCase(groundTruth: GroundTruthCase): Promise<GroundTruthReport> {
  const directory = await mkdtemp(path.join(tmpdir(), `traceiq-gt-${groundTruth.name}-`));
  const repositoryPath = path.join(directory, 'repo');
  const databasePath = path.join(directory, 'graph.db');

  try {
    for (const [relativePath, contents] of Object.entries(groundTruth.files)) {
      const absolute = path.join(repositoryPath, relativePath);

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, 'utf8');
    }

    const pipeline = new RepositoryPipeline();

    // Collected before and after rather than sampled: a scan this small completes faster than any
    // sampling interval would fire, so a peak-watching thread would report nothing at all.
    global.gc?.();

    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const summary = await pipeline.scan({
      repositoryPath,
      databasePath,
      createdAt: FIXED_CREATED_AT,
    });
    const scanMillis = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const heapAfter = process.memoryUsage().heapUsed;

    const session = pipeline.open(databasePath);

    try {
      return {
        name: groundTruth.name,
        description: groundTruth.description,
        files: summary.files,
        scanMillis,
        // A negative delta means a collection ran mid-scan, which makes the number meaningless
        // rather than small. Reported as unmeasurable instead of as a misleading figure.
        heapBytes: heapAfter > heapBefore ? heapAfter - heapBefore : null,
        ...scoreAgainst(session.api, groundTruth.expected),
      };
    } finally {
      session.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Scores a stored graph against an expectation.
 *
 * **Precision is only computed over fact kinds the case states an expectation for.** A case that
 * says nothing about `REFERENCES_TYPE` is not asserting that none exist; it is declining to
 * enumerate them, and counting every one as a false positive would make the number a measure of
 * how much the author wrote down rather than of how right the analyser is.
 */
function scoreAgainst(api: RepositoryGraphApi, expected: ExpectedFacts): Pick<
  GroundTruthReport,
  'declarations' | 'edges' | 'overall' | 'unresolvedByReason' | 'byConfidence'
> {
  // Every kind that comes from a declaration in source, which is what a case enumerates. Files,
  // externals, routes, manifests and dependency names are graph furniture rather than things the
  // author wrote down, and counting them would make every case's precision a function of how many
  // manifests the fixture happens to carry.
  const producedDeclarations = DECLARATION_NODE_KINDS.flatMap((kind) => api.getNodes(kind))
    .map((node) => node.id as string)
    .sort();

  const declarations = score(expected.declarations, producedDeclarations);
  const edges: (FactScore & { type: RelationshipType })[] = [];

  const byConfidence: Record<string, number> = {};

  for (const type of RELATIONSHIP_TYPES) {
    const produced = api.getEdges(type);

    for (const edge of produced) {
      byConfidence[edge.confidence] = (byConfidence[edge.confidence] ?? 0) + 1;
    }

    const expectation = expected.edges[type];

    if (expectation === undefined) {
      continue;
    }

    edges.push({
      type,
      // Deduplicated: one expectation states that an edge exists, and two call sites from the same
      // declaration to the same target are two edges asserting one fact. Counting both would put
      // recall above 100% or below it depending only on how many times the fixture called something.
      ...score(expectation, [...new Set(produced.map((edge) => `${edge.sourceId} -> ${edge.targetId}`))].sort()),
    });
  }

  const unresolvedCounts = new Map<string, number>();

  for (const reference of api.getUnresolved()) {
    unresolvedCounts.set(reference.reason, (unresolvedCounts.get(reference.reason) ?? 0) + 1);
  }

  return {
    declarations,
    edges,
    overall: combine([declarations, ...edges]),
    unresolvedByReason: [...unresolvedCounts]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    byConfidence,
  };
}

/** Precision and recall for one fact kind, with examples of each kind of miss. */
function score(expected: readonly string[], produced: readonly string[]): FactScore {
  const expectedSet = new Set(expected);
  const producedSet = new Set(produced);

  const matched = produced.filter((fact) => expectedSet.has(fact)).length;

  return {
    expected: expectedSet.size,
    produced: producedSet.size,
    matched,
    precision: producedSet.size === 0 ? null : matched / producedSet.size,
    recall: expectedSet.size === 0 ? null : matched / expectedSet.size,
    missing: expected.filter((fact) => !producedSet.has(fact)).slice(0, EXAMPLE_LIMIT),
    spurious: produced.filter((fact) => !expectedSet.has(fact)).slice(0, EXAMPLE_LIMIT),
  };
}

/**
 * The weighted total across every measured fact kind.
 *
 * Sums the raw counts and divides once, rather than averaging the per-kind ratios. A case with one
 * IMPLEMENTS edge and twenty CALLS edges is a test of the call graph, and a mean over kinds would
 * let the single inheritance edge move the headline as far as all twenty calls together.
 */
function combine(scores: readonly FactScore[]): FactScore {
  const expected = scores.reduce((total, entry) => total + entry.expected, 0);
  const produced = scores.reduce((total, entry) => total + entry.produced, 0);
  const matched = scores.reduce((total, entry) => total + entry.matched, 0);

  return {
    expected,
    produced,
    matched,
    precision: produced === 0 ? null : matched / produced,
    recall: expected === 0 ? null : matched / expected,
    missing: scores.flatMap((entry) => entry.missing).slice(0, EXAMPLE_LIMIT),
    spurious: scores.flatMap((entry) => entry.spurious).slice(0, EXAMPLE_LIMIT),
  };
}
