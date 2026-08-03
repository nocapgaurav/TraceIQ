import { describe, expect, it } from 'vitest';

import { GraphBuilder } from './graph-builder.js';
import { NO_CAPABILITIES } from './capabilities.js';
import type { RepositoryGraph } from './types.js';
import type { UniversalArtifact, UniversalFacts } from './universal-facts.js';

/**
 * Artefacts becoming graph rows, and the properties that make those rows trustworthy.
 *
 * **The build is exercised through `GraphBuilder` rather than through the translator alone**, because the
 * claim being tested is not "the translator returns objects" — it is that a repository with *no analysable
 * source at all* produces a graph with nodes at both ends of real edges, and that the constraint validator
 * accepts it. Calling the translator directly would skip the validation, which is the half most likely to
 * reject a new relationship.
 */

function universal(input: {
  readonly files: readonly string[];
  readonly artifacts: readonly UniversalArtifact[];
  readonly technologies?: UniversalFacts['technologies'];
}): UniversalFacts {
  return {
    repository: { name: 'fixture', rootPath: '/fixture' },
    files: input.files.map((path) => ({ path, language: null, role: 'other', bytes: 10 })),
    manifests: [],
    technologies: input.technologies ?? [],
    artifacts: input.artifacts,
    capabilities: NO_CAPABILITIES,
  };
}

const artifact = (overrides: Partial<UniversalArtifact> & { readonly path: string }): UniversalArtifact => ({
  kind: 'ci-workflow',
  read: true,
  boundary: 'read as indentation structure',
  summary: 'a ci-workflow declaring 1 job',
  elements: [],
  references: [],
  ...overrides,
});

const build = (facts: UniversalFacts): RepositoryGraph => new GraphBuilder().build({ universal: facts });

const edgesOf = (graph: RepositoryGraph, type: string): readonly { source: string; target: string }[] =>
  graph.edges
    .filter((edge) => edge.type === type)
    .map((edge) => ({ source: edge.sourceId, target: edge.targetId }));

describe('a repository whose only content is artefacts', () => {
  const facts = universal({
    files: ['.github/workflows/ci.yml', 'scripts/build.sh', 'README.md'],
    artifacts: [
      artifact({
        path: '.github/workflows/ci.yml',
        elements: [
          { kind: 'job', name: 'build', section: 'jobs', detail: 'runs on ubuntu', line: 4, requires: [] },
          { kind: 'job', name: 'publish', section: 'jobs', detail: 'runs on ubuntu', line: 9, requires: ['build'] },
          { kind: 'command', name: 'bash scripts/build.sh', section: 'jobs.build', detail: 'bash scripts/build.sh', line: 6, requires: [] },
        ],
        references: [
          {
            kind: 'command',
            text: 'scripts/build.sh',
            candidates: ['scripts/build.sh'],
            element: 'bash scripts/build.sh',
            line: 6,
            evidence: 'invoked by build',
            confidence: 'INFERRED',
          },
          {
            kind: 'environment',
            text: 'NPM_TOKEN',
            candidates: [],
            element: 'publish',
            line: 10,
            evidence: 'declared under env',
            confidence: 'CERTAIN',
          },
          {
            kind: 'path',
            text: './missing/thing.sh',
            candidates: ['missing/thing.sh'],
            element: null,
            line: 12,
            evidence: 'named as a working directory',
            confidence: 'INFERRED',
          },
        ],
      }),
      artifact({
        path: 'README.md',
        kind: 'documentation',
        elements: [{ kind: 'heading', name: 'Setup', section: '', detail: 'level 1 heading', line: 1, requires: [] }],
        references: [
          {
            kind: 'link',
            text: 'scripts/build.sh',
            candidates: ['scripts/build.sh'],
            element: 'Setup',
            line: 3,
            evidence: 'linked from this document',
            confidence: 'RESOLVED',
          },
        ],
      }),
    ],
  });

  const graph = build(facts);

  it('validates, which is the first thing a new relationship has to do', () => {
    // `GraphBuilder.build` throws on a constraint violation, so reaching here is the assertion. The counts
    // guard against a silently empty translation passing for the same reason.
    expect(graph.nodes.length).toBeGreaterThan(3);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('marks the file with its artefact family, and leaves an unread file null', () => {
    const workflow = graph.nodes.find((node) => node.id === 'file:.github/workflows/ci.yml');
    const script = graph.nodes.find((node) => node.id === 'file:scripts/build.sh');

    expect(workflow?.artifactKind).toBe('ci-workflow');
    // No artefact was supplied for it, so `null` — which every consumer reads as "not analysed" rather
    // than as "has no purpose".
    expect(script?.artifactKind).toBeNull();
  });

  it('carries the reading and its boundary in the file’s provenance, verbatim', () => {
    const workflow = graph.nodes.find((node) => node.id === 'file:.github/workflows/ci.yml');

    expect(workflow?.provenance.evidence).toContain('a ci-workflow declaring 1 job');
    // The sentence that stops an artefact holding no elements from reading as a file that does nothing.
    expect(workflow?.provenance.evidence).toContain('read as indentation structure');
  });

  it('mints one node per element, under its own identifier prefix', () => {
    const elements = graph.nodes.filter((node) => node.kind === 'ArtifactElement');

    expect(elements.length).toBe(4);
    // `art:` rather than `sym:`: a consumer listing declarations filters on `sym:`, and sharing the prefix
    // would put workflow jobs in that list with nothing downstream able to tell them apart.
    expect(elements.every((node) => node.id.startsWith('art:'))).toBe(true);
    expect(elements.every((node) => node.fileId !== null)).toBe(true);
  });

  it('links each element to its artefact with CONTAINS', () => {
    expect(edgesOf(graph, 'CONTAINS')).toContainEqual({
      source: 'file:.github/workflows/ci.yml',
      target: 'art:.github/workflows/ci.yml#job:jobs:build',
    });
  });

  it('records the prerequisite the artefact declares, and only that', () => {
    const ordering = edgesOf(graph, 'DEPENDS_ON');

    expect(ordering).toEqual([
      {
        source: 'art:.github/workflows/ci.yml#job:jobs:publish',
        target: 'art:.github/workflows/ci.yml#job:jobs:build',
      },
    ]);
  });

  it('resolves an invoked path to a RUNS edge against the file that exists', () => {
    expect(edgesOf(graph, 'RUNS')).toContainEqual({
      source: 'art:.github/workflows/ci.yml#command:jobs.build:bash scripts/build.sh',
      target: 'file:scripts/build.sh',
    });
  });

  it('records a documentation link as DOCUMENTS, sourced at the document', () => {
    expect(edgesOf(graph, 'DOCUMENTS')).toEqual([{ source: 'file:README.md', target: 'file:scripts/build.sh' }]);
  });

  it('mints an environment variable and links it with USES_ENV rather than READS', () => {
    expect(graph.nodes.some((node) => node.id === 'env:NPM_TOKEN' && node.kind === 'EnvironmentVariable')).toBe(true);
    // A compose file supplying a variable is not source code reading one, and merging the two would let
    // configuration look like behaviour.
    expect(edgesOf(graph, 'USES_ENV').map((edge) => edge.target)).toContain('env:NPM_TOKEN');
    expect(edgesOf(graph, 'READS')).toEqual([]);
  });

  it('records a path that matches no file as unresolved rather than dropping it', () => {
    const unresolved = graph.unresolved.filter((entry) => entry.reason === 'artefact-path-matches-no-file');

    expect(unresolved.map((entry) => entry.text)).toEqual(['./missing/thing.sh']);
    // A workflow invoking a script that no longer exists is a real finding, and the absence of a RUNS edge
    // must stay distinguishable from the absence of a command.
    expect(unresolved[0]?.provenance.evidence).toContain('no file in the repository matches missing/thing.sh');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(build(facts))).toBe(JSON.stringify(build(facts)));
  });
});

describe('configuration and technology', () => {
  it('links a configuration file to the technology its own presence proved', () => {
    const graph = build(
      universal({
        files: ['next.config.js'],
        technologies: [
          {
            id: 'nextjs',
            name: 'Next.js',
            category: 'frontend',
            regionPath: '',
            confidence: 'CERTAIN',
            evidence: [{ path: 'next.config.js', detail: 'a Next.js configuration file' }],
          },
        ],
        artifacts: [
          artifact({
            path: 'next.config.js',
            kind: 'tool-configuration',
            references: [
              {
                kind: 'technology',
                text: 'Next.js',
                candidates: [],
                element: null,
                line: 0,
                evidence: 'this file is the evidence Next.js was detected from',
                confidence: 'CERTAIN',
              },
            ],
          }),
        ],
      }),
    );

    expect(edgesOf(graph, 'CONFIGURES')).toEqual([
      { source: 'file:next.config.js', target: 'tech::nextjs' },
    ]);
  });
});

describe('an artefact that was read and declares nothing', () => {
  const graph = build(
    universal({
      files: ['.editorconfig'],
      artifacts: [
        artifact({
          path: '.editorconfig',
          kind: 'tool-configuration',
          summary: 'a tool-configuration from which nothing structural was extracted',
          boundary: 'Read as bracketed sections and key/value lines. No schema for this format was applied.',
        }),
      ],
    }),
  );

  it('still carries a family and a boundary, so nothing reads as an empty file', () => {
    const node = graph.nodes.find((entry) => entry.id === 'file:.editorconfig');

    expect(node?.artifactKind).toBe('tool-configuration');
    expect(node?.provenance.evidence).toContain('nothing structural was extracted');
    expect(node?.provenance.evidence).toContain('No schema for this format was applied');
  });

  it('produces no element and no edge, which is the honest outcome rather than a failure', () => {
    expect(graph.nodes.filter((node) => node.kind === 'ArtifactElement')).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
