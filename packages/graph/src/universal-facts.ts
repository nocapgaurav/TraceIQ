import type { RepositoryCapabilities } from '@traceiq/graph-api';
import { fileId } from '@traceiq/shared';
import type { NodeId } from '@traceiq/types';

/**
 * What the Graph Builder needs about a repository before any language analyser has run.
 *
 * This is the input that makes the graph universal. Everything here comes from the
 * Repository Scanner — paths, extensions, manifest contents — and none of it requires a
 * compiler, so it exists for a Python repository, a documentation repository and a
 * polyglot one exactly as it does for TypeScript.
 *
 * A language analyser's output is layered *on top*: its declarations attach to the file
 * nodes built from here, which is why file identity is derived the same way in both and
 * why the IR's files must be a subset of these.
 */
export interface UniversalFacts {
  readonly repository: { readonly name: string; readonly rootPath: string };
  readonly files: readonly UniversalFile[];
  readonly manifests: readonly UniversalManifest[];
  /**
   * The technologies detected, with the files that prove each.
   *
   * Universal for the same reason the rest of this is: a Dockerfile, a `next` dependency and a
   * Terraform file are readable without a compiler, so they exist for a repository in a language
   * TraceIQ has no analyser for exactly as they do for TypeScript.
   */
  readonly technologies: readonly UniversalTechnology[];
  readonly capabilities: RepositoryCapabilities;
}

/** One detected technology, flattened to what the graph stores. */
export interface UniversalTechnology {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** The region it was found in; `''` is the repository root. */
  readonly regionPath: string;
  readonly confidence: string;
  /** Repository-relative paths that prove it, with what was found in each. */
  readonly evidence: readonly { readonly path: string; readonly detail: string }[];
}

/**
 * A technology's node identifier.
 *
 * Scoped by region, because `apps/web` being React and `apps/api` being React are two facts about
 * two projects. A repository-wide identity would merge them and lose the only thing an
 * architecture view needs — which is also why the region path is in the identifier rather than
 * only in a column.
 */
export function technologyId(regionPath: string, id: string): NodeId {
  return `tech:${regionPath}:${id}` as NodeId;
}

export interface UniversalFile {
  /** Repository-relative, POSIX-separated. */
  readonly path: string;
  readonly language: string | null;
  readonly role: string;
  readonly bytes: number;
}

export interface UniversalManifest {
  readonly path: string;
  readonly ecosystem: string;
  /** Dependency names the manifest declares, sorted. */
  readonly declaredDependencies: readonly string[];
}

/** The node identifier for a manifest's declared dependency. */
export function dependencyId(ecosystem: string, name: string): NodeId {
  return `dep:${ecosystem}:${name}` as NodeId;
}

/**
 * A manifest's node identifier.
 *
 * A manifest is also a file, and gets a `File` node too. The two are deliberately
 * separate nodes rather than one node wearing two kinds: `File` carries the repository's
 * structure and `Manifest` carries what the file *declares*, and a consumer listing files
 * should not have to filter out manifests, nor a consumer walking dependencies have to
 * filter out files.
 */
export function manifestId(repoRelativePath: string): NodeId {
  return `manifest:${repoRelativePath}` as NodeId;
}

/**
 * Universal facts for a graph built from a language analyser's output alone.
 *
 * Used when no scanner inventory is supplied — a language analyser's own tests, and any
 * caller holding an IR but no repository. The claim it makes is narrow and true: the
 * files the analyser read are the files this graph knows about.
 *
 * It is deliberately *not* what the pipeline uses. A real scan supplies the scanner's
 * inventory, which covers every file including those no analyser can read; deriving facts
 * from the IR instead would reintroduce exactly the blindness this milestone removed.
 */
export function universalFactsFromAnalysedFiles(input: {
  readonly repository: { readonly name: string; readonly rootPath: string };
  readonly files: readonly { readonly path: string; readonly language: string | null }[];
  readonly capabilities: RepositoryCapabilities;
}): UniversalFacts {
  return {
    repository: input.repository,
    files: input.files.map((file) => ({
      path: file.path,
      language: file.language,
      role: 'source',
      bytes: 0,
    })),
    manifests: [],
    technologies: [],
    capabilities: input.capabilities,
  };
}

/** Re-exported so callers build file identity through one definition. */
export { fileId };
