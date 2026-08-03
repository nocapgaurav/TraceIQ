import type { ArtifactKind } from '@traceiq/types';

import { classify } from './classify.js';
import { READERS, type ReadInput } from './readers.js';
import type { Artifact, RepositoryArtifacts } from './types.js';

/**
 * Reads every non-code artefact a repository holds.
 *
 * **A pure function of its inputs, exactly as the technology detector is.** The file inventory and a
 * `readFile` callback come in; artefacts come out. There is no `node:fs` here, which is what lets the
 * whole layer be tested against a synthetic repository that never touches a disk, and what keeps the
 * package's dependency list to two entries.
 *
 * **Source files are skipped and that is deliberate.** A `.ts` file's structure is what the language
 * analysers exist to produce, at far greater fidelity than a line reader could, and describing it twice
 * would give the graph two answers to one question. What this reads is everything the analysers cannot:
 * the workflows, the compose file, the Dockerfile, the schema, the prose, the scripts and the
 * configuration — which on a great many repositories is most of the files and, before this, all of the
 * silence.
 */
export interface ArtifactInput {
  /** Every file the scan found, with the language and role the scanner assigned. */
  readonly files: readonly {
    readonly path: string;
    readonly language: string | null;
    readonly role: string;
    readonly bytes: number;
  }[];
  /**
   * Technologies detected in this repository, with the files that prove each.
   *
   * Used for one thing: a `CONFIGURES` relationship from a configuration file to the technology whose
   * detection that file *was the evidence for*. The claim is therefore the detector's own, restated from
   * the file's side, rather than a second guess about what reads the file.
   */
  readonly technologies?: readonly {
    readonly name: string;
    readonly evidence: readonly { readonly path: string }[];
  }[];
  /** Reads a repository file as text, or returns `null` where it cannot be read. */
  readonly readFile: (path: string) => Promise<string | null>;
}

/**
 * A file larger than this has its family recorded and its contents left unread.
 *
 * A generated OpenAPI document, a fixture dataset or a vendored bundle can be megabytes, and every reader
 * here is linear in input size. The limit is generous relative to a hand-written artefact — the largest
 * workflow in the validation corpus is 34 KB — and the file is still described, with its boundary
 * sentence saying why nothing structural was read.
 */
const READ_BYTE_LIMIT = 512 * 1024;

/**
 * Families whose contents are read.
 *
 * A closed list rather than "everything with a reader", because the decision is about **cost** rather than
 * about capability: `unknown-artifact` covers binaries, images, fonts and archives, and reading a
 * megabyte of PNG to extract nothing is a cost every scan would pay on every repository.
 */
const READ_FAMILIES: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'ci-workflow',
  'container-compose',
  'orchestration-resource',
  'container-image',
  'infrastructure-as-code',
  'package-manifest',
  'build-configuration',
  'workspace-configuration',
  'environment-configuration',
  'tool-configuration',
  'schema',
  'documentation',
  'script',
  'test',
  'data',
]);

/**
 * Formats whose family cannot be decided without looking inside.
 *
 * YAML only, and it is the whole reason the classification takes a `contents` argument: a YAML file's name
 * says nothing about whether it is a pipeline, a compose file or a Kubernetes resource, while a
 * `Dockerfile` and a `package.json` announce themselves.
 */
function needsContentToClassify(language: string | null): boolean {
  return language === 'yaml';
}

export async function analyseArtifacts(input: ArtifactInput): Promise<RepositoryArtifacts> {
  const configuresByPath = new Map<string, string[]>();

  for (const technology of input.technologies ?? []) {
    for (const proof of technology.evidence) {
      const held = configuresByPath.get(proof.path) ?? [];

      held.push(technology.name);
      configuresByPath.set(proof.path, held);
    }
  }

  const artifacts: Artifact[] = [];
  let unread = 0;
  let droppedElements = 0;

  for (const file of input.files) {
    const tooLarge = file.bytes > READ_BYTE_LIMIT;

    // Read at most once, and only where the classification or a reader will actually use it.
    const probe = tooLarge || !needsContentToClassify(file.language) ? null : await input.readFile(file.path);
    const classification = classify({
      path: file.path,
      language: file.language,
      role: file.role,
      contents: probe,
    });

    /*
     * A file a language analyser describes. Skipped here so the graph holds one account of it, not two.
     *
     * Recognised by the classification's own evidence rather than by re-testing the language, so there is
     * one place that decides which languages this layer stays out of — see `ANALYSED_LANGUAGES`.
     */
    if (classification.evidence.startsWith('it is source code')) {
      continue;
    }

    const reader = READERS[classification.kind];
    const readable = reader !== undefined && READ_FAMILIES.has(classification.kind) && !tooLarge;

    /*
     * A presence-only family gets its reader called with no contents.
     *
     * A lockfile and a generated file each have a reader whose whole output is a boundary sentence saying
     * why it was not read, and those sentences are far better than the generic one below — "a machine-written
     * resolution of the manifest beside it, whose pinned versions answer no question about what the
     * repository is" says something; "not read" does not. Calling the reader without opening the file gets
     * the sentence without the megabytes.
     */
    if (reader !== undefined && !readable && !tooLarge) {
      const presence = reader({ path: file.path, contents: '', configures: [] });

      unread += 1;
      artifacts.push({
        path: file.path,
        kind: classification.kind,
        format: file.language,
        read: false,
        boundary: presence.boundary,
        summary: `${presence.summary} — ${classification.evidence}`,
        elements: [],
        references: [],
      });

      continue;
    }

    const contents = readable ? (probe ?? (await input.readFile(file.path))) : null;

    if (contents === null || reader === undefined) {
      unread += 1;
      artifacts.push({
        path: file.path,
        kind: classification.kind,
        format: file.language,
        read: false,
        boundary: boundaryFor({ tooLarge, hasReader: reader !== undefined, unreadable: readable && contents === null }),
        summary: `${indefinite(classification.kind)} ${classification.kind.replace(/-/g, ' ')} — ${classification.evidence}`,
        elements: [],
        references: [],
      });

      continue;
    }

    const readInput: ReadInput = {
      path: file.path,
      contents,
      configures: configuresByPath.get(file.path) ?? [],
    };
    const result = reader(readInput);

    droppedElements += result.dropped;

    artifacts.push({
      path: file.path,
      kind: classification.kind,
      format: file.language,
      read: true,
      boundary: result.boundary,
      // The classification's evidence leads, because "why do you call this a workflow" is the first
      // question a reader has about the label, and the reader's own summary follows it.
      summary: `${result.summary} — ${classification.evidence}`,
      elements: result.elements,
      references: [
        ...result.references,
        ...readInput.configures.map((name) => ({
          kind: 'technology' as const,
          text: name,
          candidates: [] as readonly string[],
          element: null,
          line: 0,
          evidence: `this file is the evidence ${name} was detected from`,
          confidence: 'CERTAIN' as const,
        })),
      ],
    });
  }

  return {
    artifacts: [...artifacts].sort((left, right) => left.path.localeCompare(right.path)),
    unread,
    droppedElements,
  };
}

/** Why a file's contents were not read, in words a reader of the product sees verbatim. */
function boundaryFor(input: {
  readonly tooLarge: boolean;
  readonly hasReader: boolean;
  readonly unreadable: boolean;
}): string {
  if (input.tooLarge) {
    return `Not read: the file is larger than the ${READ_BYTE_LIMIT / 1024} KB artefact reading limit. Its presence and family are recorded; its structure is not.`;
  }

  if (input.unreadable) {
    return 'Not read: the file could not be opened. Its presence and family are recorded; its structure is not.';
  }

  return input.hasReader
    ? 'Not read: this family is recorded by presence rather than by structure.'
    : 'Not read: TraceIQ has no reader for this format. Its presence, its language and its position in the repository are recorded; nothing about its contents is claimed.';
}

function indefinite(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
