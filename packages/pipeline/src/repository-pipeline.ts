import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { GraphStore, SqliteGraphApi } from '@traceiq/graph';
import {
  DECLARATION_NODE_KINDS,
  NODE_KINDS,
  type NodeKind,
  type RepositoryGraphApi,
} from '@traceiq/graph-api';
import { isEcosystem, RELATIONSHIP_TYPES } from '@traceiq/types';
import { RepositoryScanner } from '@traceiq/scanner';
import { planAnalysisUnits } from '@traceiq/project-host';
import { detectTechnologies } from '@traceiq/technology';

import { runAnalyzers, type LanguageAnalyzer } from '@traceiq/analyzer';
import { GoAnalyzer, preloadGoParser } from '@traceiq/go';
import { JavaAnalyzer, preloadJavaParser } from '@traceiq/java';
import { PythonAnalyzer, preloadPythonParser } from '@traceiq/python';
import type { RepositoryInventory } from '@traceiq/scanner';

import {
  encodeFingerprint,
  fingerprintRepository,
  isUnchanged,
  decodeFingerprint,
  type RepositoryFingerprint,
} from './repository-fingerprint.js';
import { buildTolerantly } from './tolerant-build.js';
import type { RepositorySession, ScanInput, ScanSummary } from './types.js';
import { TypeScriptAnalyzer } from './typescript-analyzer.js';

/**
 * The analysers TraceIQ runs, in order.
 *
 * A plain array, deliberately. Registration is the whole extension mechanism: a new language means
 * one more entry here and one more package implementing `LanguageAnalyzer`, with nothing downstream
 * to change. A discovery-based plugin system would buy nothing over a list the composition root can
 * read, and would make the set of analysers harder to know than easier.
 */
/**
 * The analysers for one repository, including those needing asynchronous preparation.
 *
 * The Python analyser reads its sources and loads a WASM grammar before it can run, and `analyze`
 * is synchronous by contract because the graph build is. Preparation happens here, once per scan.
 */
async function defaultAnalyzersFor(
  inventory: RepositoryInventory,
): Promise<readonly LanguageAnalyzer[]> {
  const analyzers: LanguageAnalyzer[] = [new TypeScriptAnalyzer()];

  if (inventory.files.some((file) => file.language === 'python')) {
    await preloadPythonParser();
    analyzers.push(await PythonAnalyzer.prepare(inventory));
  }

  if (inventory.files.some((file) => file.language === 'java')) {
    await preloadJavaParser();
    analyzers.push(await JavaAnalyzer.prepare(inventory));
  }

  if (inventory.files.some((file) => file.language === 'go')) {
    await preloadGoParser();
    analyzers.push(await GoAnalyzer.prepare(inventory));
  }

  return analyzers;
}

/**
 * The one repository TraceIQ still refuses.
 *
 * A checkout containing no files at all has nothing to describe: no structure, no
 * languages, no manifests. Every other repository — including one written entirely in a
 * language with no analyser — produces a graph, so this is the single honest failure.
 */
/** The database's path relative to the repository, for exclusion from the inventory. */
function databaseFileIn(input: ScanInput): string {
  return path
    .relative(path.resolve(input.repositoryPath), path.resolve(input.databasePath))
    .replaceAll('\\', '/');
}

export class EmptyRepositoryError extends Error {
  constructor(repositoryPath: string) {
    super(`Cannot scan repository at ${repositoryPath}: it contains no files`);
    this.name = 'EmptyRepositoryError';
  }
}

/**
 * The write path, and the only door onto a stored graph.
 *
 * Every analysis package already exists; this wires them in the one order they compose in, and hands
 * back an abstract `RepositoryGraphApi`. It exists so an **interface** — a CLI, an HTTP surface, a
 * context builder — can build and open a repository graph without importing the scanner, the compiler
 * host, the IR, the resolver, the graph builder, the store or SQLite.
 *
 * **It contains no analysis of its own.** Nothing here parses, resolves, infers or interprets: every
 * line delegates, and removing it would change no result, only who has to know the order.
 *
 * The pipeline is stateless. A scan takes its inputs and returns counts; an open returns a session the
 * caller closes. There is no singleton and nothing cached across calls, so two scans cannot interfere.
 */
export class RepositoryPipeline {
  /**
   * Builds the repository graph and stores it.
   *
   * scanner → universal facts → (optional TypeScript enrichment) → graph builder → store.
   *
   * **Discovery is universal; semantic analysis is enrichment.** The scan always produces
   * structure, languages, manifests, declared dependencies and technology regions. A
   * language analyser then adds declarations, imports, calls and types for the regions it
   * can read, and what it could not reach is recorded as a capability rather than lost.
   *
   * The compiler host is disposed inside the enrichment call, before the store is opened,
   * so no compiler state outlives the build.
   */
  async scan(input: ScanInput): Promise<ScanSummary> {
    // A scan must not describe its own output. `.traceiq/` is ignored by the scanner, but
    // a caller may put the database anywhere — including the repository root — and a
    // rescan would then find the file the previous scan wrote and report it as source.
    const inventory = await new RepositoryScanner().scan(input.repositoryPath, {
      excludeFiles: [databaseFileIn(input)],
    });

    // A repository with no files is the one honest failure left. Everything else — a
    // language with no analyser, a documentation repository, a polyglot system — is
    // describable, and rejecting it would be a statement about TraceIQ rather than
    // about the repository.
    if (inventory.files.length === 0) {
      throw new EmptyRepositoryError(input.repositoryPath);
    }

    /*
     * A rescan of an unchanged repository is pure waste, and for one large enough to need bounded
     * compilation that waste is minutes. The fingerprint is path, size and modification time over
     * every analysed source — the same triple every build tool uses, and cheap for the same reason:
     * hashing content would cost a full read of the repository, which is a large part of what a
     * scan costs in the first place.
     *
     * Skipping keeps the graph exactly as it was, which is the correct graph: the same sources
     * produce the same analysis, deterministically, by design.
     */
    const units = planAnalysisUnits(inventory);
    const fingerprint = fingerprintRepository({
      inventory,
      units,
      modifiedAt: await modificationTimes(inventory),
    });

    if (input.force !== true) {
      const reused = this.#reuseIfUnchanged(input, fingerprint, inventory);

      if (reused !== null) {
        return reused;
      }
    }

    // Every analyser runs, each isolated from the others: one throwing costs its own regions their
    // depth and nothing else. What each covered is what decides region capability below.
    const analyzers = input.analyzers ?? (await defaultAnalyzersFor(inventory));
    const outcomes = runAnalyzers({ analyzers, inventory });

    // Technologies are universal: a Dockerfile, a `next` dependency and a Terraform file are
    // readable without a compiler, so they exist for a repository in a language no analyser covers
    // exactly as they do for TypeScript. Detected after the analysers only because nothing here
    // depends on them, not because anything does.
    const profile = await detectTechnologies({
      files: inventory.files,
      manifests: inventory.manifests,
      regions: inventory.regions,
      readFile: async (relativePath) => {
        try {
          return await readFile(path.join(inventory.rootPath, relativePath), 'utf8');
        } catch {
          // Unreadable is not a finding. The technology simply goes undetected, which is the same
          // answer as the file not being there.
          return null;
        }
      },
    });

    // The build is isolated too. An analyser can also fail by *succeeding* and returning facts the
    // graph refuses, and that used to cost the whole scan — including the universal facts, which no
    // analyser produced. See `buildTolerantly`.
    const built = buildTolerantly({
      inventory,
      outcomes,
      universal: (capabilities) => ({
        repository: { name: inventory.name, rootPath: inventory.rootPath },
        files: inventory.files.map((file) => ({
          path: file.path,
          language: file.language,
          role: file.role,
          bytes: file.bytes,
        })),
        manifests: inventory.manifests.map((manifest) => ({
          path: manifest.path,
          ecosystem: manifest.ecosystem,
          declaredDependencies: manifest.declaredDependencies,
        })),
        technologies: profile.technologies.map((technology) => ({
          id: technology.id,
          name: technology.name,
          category: technology.category,
          regionPath: technology.regionPath,
          confidence: technology.confidence,
          evidence: technology.evidence,
        })),
        capabilities,
      }),
    });

    const graph = built.graph;
    const capabilities = graph.capabilities;
    const analyses = built.outcomes
      .map((outcome) => outcome.contribution)
      .filter((contribution) => contribution !== null);

    const store = GraphStore.open(input.databasePath);

    try {
      store.write(graph, input.createdAt, encodeFingerprint(fingerprint));
    } finally {
      store.close();
    }

    const kind = (name: string): number =>
      graph.nodes.filter((node) => node.kind === name).length;

    const callEdges = analyses.reduce((total, analysis) => total + analysis.callGraph.calls.length, 0);
    const unresolvedCalls = analyses.reduce(
      (total, analysis) => total + analysis.callGraph.unresolved.length,
      0,
    );

    return {
      repository: inventory.name,
      repositoryPath: input.repositoryPath,
      databasePath: input.databasePath,
      files: graph.fileIds.length,
      declarations:
        graph.nodes.length -
        kind('File') -
        kind('Route') -
        kind('EnvironmentVariable') -
        kind('External') -
        kind('Manifest') -
        kind('Dependency'),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolvedReferences: graph.unresolved.length,
      routes: kind('Route'),
      environmentVariables: kind('EnvironmentVariable'),
      // Every ecosystem, not just npm. Counting `externalKind === 'npm'` reported zero packages for a
      // Python, Java or Go repository whose files plainly import them, which is the same npm-shaped
      // assumption the external identity carried.
      externalPackages: graph.nodes.filter(
        (node) => node.externalKind !== null && isEcosystem(node.externalKind),
      ).length,
      callEdges,
      unresolvedCalls,
      languages: inventory.languages.map((entry) => ({
        language: entry.language,
        files: entry.files,
      })),
      regions: capabilities.regions.length,
      manifests: kind('Manifest'),
      declaredDependencies: kind('Dependency'),
      depth: capabilities.depth,
      isPolyglot: capabilities.isPolyglot,
      analyzerFailures: built.outcomes
        .filter((outcome) => outcome.failure !== null)
        .map((outcome) => ({ analyzer: outcome.analyzer, failure: outcome.failure as string })),
    };
  }

  /**
   * The summary of an existing graph, when the sources behind it have not moved.
   *
   * `null` when there is no stored graph, when it was written by a different schema version, or
   * when anything changed. Reading it back rather than returning a remembered value is deliberate:
   * the summary a caller receives must describe the graph that is actually on disk.
   */
  #reuseIfUnchanged(
    input: ScanInput,
    fingerprint: RepositoryFingerprint,
    inventory: RepositoryInventory,
  ): ScanSummary | null {
    let stored: string | null = null;

    try {
      const store = GraphStore.open(input.databasePath);

      try {
        stored = store.readSourceHash();
      } finally {
        store.close();
      }
    } catch {
      // No graph, an unreadable one, or one from another schema version. All mean the same thing
      // here — there is nothing to reuse — and none is a reason to fail a scan.
      return null;
    }

    if (!isUnchanged(decodeFingerprint(stored), fingerprint)) {
      return null;
    }

    try {
      const session = this.open(input.databasePath);

      try {
        return summaryOfStoredGraph(session.api, input, inventory.name);
      } finally {
        session.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Opens a stored graph.
   *
   * The caller receives a `RepositoryGraphApi` and a `close`, and never learns what implements it.
   */
  open(databasePath: string): RepositorySession {
    const api = SqliteGraphApi.open(databasePath);

    return {
      api,
      databasePath,
      close: () => {
        api.close();
      },
    };
  }
}

/**
 * Describes a graph that is already on disk, in the shape a fresh scan would have returned.
 *
 * Counted from the stored graph rather than remembered from the scan that wrote it, so a summary
 * always describes what a consumer will actually read. The two must agree, and reading is the only
 * way to be sure they do.
 */
function summaryOfStoredGraph(
  api: RepositoryGraphApi,
  input: ScanInput,
  name: string,
): ScanSummary {
  const capabilities = api.getCapabilities();
  const kind = (name: NodeKind): number => api.getNodes(name).length;
  const edges = RELATIONSHIP_TYPES.reduce((total, type) => total + api.getEdges(type).length, 0);
  const nodes = NODE_KINDS.reduce((total, name) => total + kind(name), 0);

  return {
    repository: name,
    repositoryPath: input.repositoryPath,
    databasePath: input.databasePath,
    files: kind('File'),
    declarations: DECLARATION_NODE_KINDS.reduce((total, name) => total + kind(name), 0),
    nodes,
    edges,
    unresolvedReferences: api.getUnresolved().length,
    routes: kind('Route'),
    environmentVariables: kind('EnvironmentVariable'),
    externalPackages: api
      .getNodes('External')
      .filter((node) => node.externalKind !== null && isEcosystem(node.externalKind)).length,
    callEdges: api.getEdges('CALLS').length,
    // Unresolved calls are stored as unresolved references of that type, which is where a fresh
    // scan's count would land too.
    unresolvedCalls: api.getUnresolved().filter((entry) => entry.type === 'CALLS').length,
    languages: capabilities.languages.map((entry) => ({
      language: entry.language,
      files: entry.files,
    })),
    regions: capabilities.regions.length,
    manifests: kind('Manifest'),
    declaredDependencies: kind('Dependency'),
    depth: capabilities.depth,
    isPolyglot: capabilities.isPolyglot,
    analyzerFailures: [],
  };
}

/**
 * Modification times for every analysed source, by repository-relative path.
 *
 * A file that cannot be stat'd contributes no time, which makes it look changed on every scan —
 * the safe direction. Reading a timestamp is a fraction of the cost of reading the file, which is
 * the whole reason the fingerprint uses one.
 */
async function modificationTimes(
  inventory: RepositoryInventory,
): Promise<ReadonlyMap<string, number>> {
  const times = new Map<string, number>();

  await Promise.all(
    inventory.files.map(async (file) => {
      try {
        const stats = await stat(path.join(inventory.rootPath, file.path));

        times.set(file.path, stats.mtimeMs);
      } catch {
        // Unreadable is not a finding here. The file simply looks changed, and a scan runs.
      }
    }),
  );

  return times;
}
