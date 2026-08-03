import { describe, expect, it } from 'vitest';
import { SYSTEM_ARTIFACT_KINDS } from '@traceiq/types';

import { artifactDigestsOf, artifactSummariesOf, artifactViewOf } from './artifacts.js';
import { ExplorerContext } from './explorer-context.js';
import { FakeGraph, edge, node, unresolved } from './fake-graph.test-helper.js';
import { fileViewOf } from './views.js';
import type { NodeId } from '@traceiq/types';

/**
 * The Explorer's artefact view: what a reader is shown for a file that declares no code.
 *
 * **The property under test is that a count is never the answer.** Every assertion here is about a file
 * whose declaration count is zero, and every one of them checks that something *specific and checkable*
 * reaches a reader instead — the jobs, the prerequisite one declares, the script a command runs, the
 * variable it supplies, and where the reading stopped.
 */

/** A workflow, a script it runs, a document that links to it, and a technology it configures. */
function graph(): FakeGraph {
  const workflow = 'file:.github/workflows/ci.yml';
  const build = 'art:.github/workflows/ci.yml#job:jobs:build';
  const publish = 'art:.github/workflows/ci.yml#job:jobs:publish';
  const command = 'art:.github/workflows/ci.yml#command:jobs.build:make test';

  return new FakeGraph()
    .addNode(
      node({
        id: workflow,
        kind: 'File',
        artifactKind: 'ci-workflow',
        language: 'yaml',
        fileRole: 'configuration',
        evidence:
          'found by the Repository Scanner; identified as yaml; read by artefact analysis as a ci-workflow declaring 2 jobs. Template expansion was not performed.',
      }),
    )
    .addNode(node({ id: 'file:Makefile', kind: 'File', artifactKind: 'build-configuration' }))
    .addNode(node({ id: 'file:README.md', kind: 'File', artifactKind: 'documentation' }))
    .addNode(node({ id: 'file:src/a.ts', kind: 'File', language: 'typescript', fileRole: 'source' }))
    .addNode(
      node({
        id: build,
        kind: 'ArtifactElement',
        name: 'build',
        artifactKind: 'job',
        containerChain: 'jobs',
        fileId: workflow,
        line: 4,
      }),
    )
    .addNode(
      node({
        id: publish,
        kind: 'ArtifactElement',
        name: 'publish',
        artifactKind: 'job',
        containerChain: 'jobs',
        fileId: workflow,
        line: 9,
      }),
    )
    .addNode(
      node({
        id: command,
        kind: 'ArtifactElement',
        name: 'make test',
        artifactKind: 'command',
        containerChain: 'jobs.build',
        fileId: workflow,
        line: 6,
        evidence: '.github/workflows/ci.yml line 6 declares this command: make test',
      }),
    )
    .addNode(node({ id: 'env:CI', kind: 'EnvironmentVariable', name: 'CI' }))
    .addEdge(edge({ type: 'CONTAINS', sourceId: workflow, targetId: build }))
    .addEdge(edge({ type: 'CONTAINS', sourceId: workflow, targetId: publish }))
    .addEdge(edge({ type: 'CONTAINS', sourceId: workflow, targetId: command }))
    .addEdge(edge({ type: 'DEPENDS_ON', sourceId: publish, targetId: build }))
    .addEdge(edge({ type: 'RUNS', sourceId: command, targetId: 'file:Makefile' }))
    .addEdge(edge({ type: 'USES_ENV', sourceId: workflow, targetId: 'env:CI' }))
    .addEdge(edge({ type: 'DOCUMENTS', sourceId: 'file:README.md', targetId: workflow }))
    .addUnresolved(unresolved({ type: 'RUNS', sourceId: workflow, text: './gone.sh', reason: 'artefact-path-matches-no-file' }));
}

const view = (id: string) => {
  const context = new ExplorerContext(graph());
  const file = context.node(id as NodeId);

  if (file === null) {
    throw new Error(`no node ${id}`);
  }

  return artifactViewOf(context, file);
};

describe('the artefact view of a file with no declarations', () => {
  const workflow = view('file:.github/workflows/ci.yml');

  it('names the family and the format rather than reporting a count', () => {
    expect(workflow?.kind).toBe('ci-workflow');
    expect(workflow?.format).toBe('yaml');
    // The scanner's role is kept beside the family, so a reader can see the refinement rather than a
    // relabelling.
    expect(workflow?.role).toBe('configuration');
  });

  it('groups elements by the section the artefact declared them under, in file order', () => {
    expect(workflow?.sections.map((section) => section.title)).toEqual(['jobs', 'jobs.build']);
    expect(workflow?.sections[0]?.elements.map((element) => element.name)).toEqual(['build', 'publish']);
  });

  it('shows the prerequisite the artefact declared, and nothing about the order elements appear in', () => {
    const publish = workflow?.sections[0]?.elements.find((element) => element.name === 'publish');
    const build = workflow?.sections[0]?.elements.find((element) => element.name === 'build');

    expect(publish?.requires.map((required) => required.name)).toEqual(['build']);
    expect(build?.requires).toEqual([]);
  });

  it('recovers the element’s own text, so a reader can check it against the file', () => {
    const command = workflow?.sections[1]?.elements[0];

    expect(command?.detail).toBe('make test');
  });

  it('lists what it reaches and what reaches it, with the evidence for each', () => {
    expect(workflow?.references.entries.map((link) => [link.type, link.node.id])).toContainEqual(['RUNS', 'file:Makefile']);
    expect(workflow?.references.entries.map((link) => [link.type, link.node.id])).toContainEqual(['USES_ENV', 'env:CI']);
    expect(workflow?.referencedBy.entries.map((link) => link.node.id)).toEqual(['file:README.md']);
    expect(workflow?.references.entries.every((link) => link.evidence !== '')).toBe(true);
  });

  it('attributes a relationship to the element that carried it, where one did', () => {
    const runs = workflow?.references.entries.find((link) => link.type === 'RUNS');

    expect(runs?.via?.name).toBe('make test');
  });

  it('excludes containment from the reference list, since the structure already carries it', () => {
    expect(workflow?.references.entries.some((link) => link.type === 'CONTAINS')).toBe(false);
  });

  it('shows what the artefact named that resolved to nothing', () => {
    expect(workflow?.unresolved.entries.map((entry) => entry.text)).toEqual(['./gone.sh']);
  });

  it('carries the analysis boundary verbatim, which is what makes an empty artefact honest', () => {
    expect(workflow?.boundary).toContain('Template expansion was not performed');
  });
});

describe('the deterministic summary', () => {
  const summary = view('file:.github/workflows/ci.yml')?.summary;

  it('counts what the artefact defines, by element kind', () => {
    expect(summary?.defines).toEqual([
      { kind: 'job', count: 2 },
      { kind: 'command', count: 1 },
    ]);
  });

  it('separates what it reaches from what it configures and what it names', () => {
    expect(summary?.reaches).toEqual([{ type: 'RUNS', count: 1 }]);
    expect(summary?.variables).toEqual(['CI']);
    expect(summary?.referencedBy).toBe(1);
  });

  it('says where the artefact sits in the repository', () => {
    expect(summary?.position).toContain('.github/workflows');
  });

  it('says whether anything was established at all', () => {
    expect(summary?.established).toBe(true);
    // The field exists so a renderer can distinguish "read and declares nothing" from "nobody looked",
    // which a zero cannot express.
    expect(view('file:Makefile')?.summary.established).toBe(false);
  });
});

describe('a source file', () => {
  it('has no artefact view, because its structure belongs to the language analysers', () => {
    // `null` is not a degradation: a line reader's account of a TypeScript file would be strictly worse
    // than the compiler-backed one the graph already holds.
    expect(view('file:src/a.ts')).toBeNull();
  });
});

describe('the file view', () => {
  it('carries the artefact beside the declarations rather than instead of them', () => {
    const context = new ExplorerContext(graph());
    const file = fileViewOf(context, 'file:.github/workflows/ci.yml' as NodeId);

    expect(file?.declarations.entries).toEqual([]);
    // The two together are the point: a zero declaration count is now accompanied by what the file does
    // declare, in its own vocabulary.
    expect(file?.artifact?.kind).toBe('ci-workflow');
    expect(fileViewOf(context, 'file:src/a.ts' as NodeId)?.artifact).toBeNull();
  });
});

describe('the repository-wide roster', () => {
  it('counts artefacts by family, largest first', () => {
    const families = artifactSummariesOf(new ExplorerContext(graph()));

    expect(families.map((family) => family.kind)).toEqual([
      'build-configuration',
      'ci-workflow',
      'documentation',
    ]);
    expect(families.find((family) => family.kind === 'ci-workflow')?.elements).toBe(3);
  });

  it('digests only the families that describe the repository, with what each declares', () => {
    const digests = artifactDigestsOf(new ExplorerContext(graph()), SYSTEM_ARTIFACT_KINDS);

    // `build-configuration` holds the most files but says nothing about the running system, so it is
    // absent — the digest is chosen by what a family *means*, never by how much of it there is.
    expect(digests.map((digest) => digest.kind)).toEqual(['ci-workflow', 'documentation']);

    const workflow = digests[0];

    expect(workflow?.names).toEqual(['job build', 'job publish']);
    expect(workflow?.ordering).toEqual(['publish → build']);
    expect(workflow?.reaches).toEqual([{ type: 'RUNS', path: 'Makefile' }]);
    expect(workflow?.variables).toEqual(['CI']);
  });

  it('is deterministic', () => {
    const once = JSON.stringify(artifactDigestsOf(new ExplorerContext(graph()), SYSTEM_ARTIFACT_KINDS));
    const twice = JSON.stringify(artifactDigestsOf(new ExplorerContext(graph()), SYSTEM_ARTIFACT_KINDS));

    expect(once).toBe(twice);
  });
});
