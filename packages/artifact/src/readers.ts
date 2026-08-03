import type { ArtifactElementKind, ArtifactKind } from '@traceiq/types';

import { basename } from './classify.js';
import {
  ReferenceCollector,
  candidatesFor,
  environmentNames,
  invokedPaths,
} from './references.js';
import type { ArtifactElement, ArtifactReference } from './types.js';
import { documentCount, scanYaml, topLevelKeys, truncate, type YamlEntry } from './yaml-scan.js';

/**
 * One reader per artefact family.
 *
 * **Every reader is shallow, and each one says what it did not read.** None of these is a conforming
 * parser: the Dockerfile reader does not evaluate build arguments, the compose reader does not merge
 * `extends`, the Markdown reader does not resolve reference-style links, and the SQL reader does not
 * understand a dialect. What each does is read the structure the format states in its own syntax, which is
 * enough to answer "what does this file define" and is achievable deterministically for a dozen formats
 * in one package.
 *
 * **A reader may only report what the text says.** No reader infers ordering from position, importance
 * from size, or purpose from a filename. Where a format states a prerequisite — a workflow's `needs`, a
 * compose service's `depends_on` — it is recorded on the element as `requires`, and that is the only
 * ordering evidence this package produces.
 *
 * Adding a format is one function plus one row in `READERS`. Nothing else in TraceIQ changes, because
 * everything downstream consumes `ReadResult` and knows nothing about which reader produced it.
 */

export interface ReadResult {
  readonly elements: readonly ArtifactElement[];
  readonly references: readonly ArtifactReference[];
  /** What this reading did not cover. Never empty — see `Artifact.boundary`. */
  readonly boundary: string;
  /** What the artefact is, assembled from what was read. Never empty. */
  readonly summary: string;
  /** Elements a cap discarded. Reported, never silent. */
  readonly dropped: number;
}

export interface ReadInput {
  readonly path: string;
  readonly contents: string;
  /** Technologies the detector attributed to this exact file, by display name. */
  readonly configures: readonly string[];
}

/** How many elements one artefact may contribute to the graph. */
export const ELEMENT_LIMIT = 60;

/** How long an element's own text may be before it is truncated. */
const DETAIL_LIMIT = 160;

type Reader = (input: ReadInput) => ReadResult;

// ---------------------------------------------------------------------------------------------
// Element collection
// ---------------------------------------------------------------------------------------------

class Elements {
  readonly #entries: ArtifactElement[] = [];
  readonly #seen = new Set<string>();
  #dropped = 0;

  add(entry: {
    readonly kind: ArtifactElementKind;
    readonly name: string;
    readonly section?: string;
    readonly detail?: string;
    readonly line?: number;
    readonly requires?: readonly string[];
  }): void {
    const name = truncate(entry.name, 120);

    if (name === '') {
      return;
    }

    const section = entry.section ?? '';
    const key = `${entry.kind} ${section} ${name}`;

    if (this.#seen.has(key)) {
      return;
    }

    this.#seen.add(key);

    if (this.#entries.length >= ELEMENT_LIMIT) {
      this.#dropped += 1;

      return;
    }

    this.#entries.push({
      kind: entry.kind,
      name,
      section,
      detail: truncate(entry.detail ?? '', DETAIL_LIMIT),
      line: entry.line ?? 0,
      requires: entry.requires ?? [],
    });
  }

  get dropped(): number {
    return this.#dropped;
  }

  count(kind: ArtifactElementKind): number {
    return this.#entries.filter((entry) => entry.kind === kind).length;
  }

  entries(): readonly ArtifactElement[] {
    return this.#entries;
  }
}

/**
 * A summary clause per element kind that carries one.
 *
 * Deterministic and assembled rather than written, for the same reason `identity.purposeOf` is: the
 * sentence is shown to a reader as a finding, so every clause in it has to be a count of something that
 * was read.
 */
function summarise(kind: ArtifactKind, elements: Elements, extra: readonly string[] = []): string {
  const counted: readonly (readonly [ArtifactElementKind, string, string])[] = [
    ['job', 'job', 'jobs'],
    ['stage', 'build stage', 'build stages'],
    ['service', 'service', 'services'],
    ['resource', 'resource', 'resources'],
    ['entity', 'entity', 'entities'],
    ['step', 'step', 'steps'],
    ['script-target', 'named script', 'named scripts'],
    ['command', 'command', 'commands'],
    ['heading', 'section', 'sections'],
    ['variable', 'variable name', 'variable names'],
    ['member', 'workspace member', 'workspace members'],
    ['port', 'exposed port', 'exposed ports'],
    ['image', 'image', 'images'],
    ['section', 'section', 'sections'],
    ['setting', 'setting', 'settings'],
  ];

  const clauses = counted.flatMap(([elementKind, one, many]) => {
    const count = elements.count(elementKind);

    return count === 0 ? [] : [`${count} ${count === 1 ? one : many}`];
  });

  const body = [...clauses, ...extra].join(', ');

  return body === '' ? `a ${kind} from which nothing structural was extracted` : `a ${kind} declaring ${body}`;
}

// ---------------------------------------------------------------------------------------------
// YAML-backed readers
// ---------------------------------------------------------------------------------------------

/** The immediate children of a YAML path, as `[key, entry]`. */
function childrenOf(entries: readonly YamlEntry[], prefix: readonly string[]): readonly YamlEntry[] {
  return entries.filter(
    (entry) =>
      entry.path.length === prefix.length + 1 &&
      prefix.every((segment, index) => entry.path[index] === segment),
  );
}

/** Every entry beneath a YAML path, at any depth. */
function under(entries: readonly YamlEntry[], prefix: readonly string[]): readonly YamlEntry[] {
  return entries.filter(
    (entry) =>
      entry.path.length > prefix.length &&
      prefix.every((segment, index) => entry.path[index] === segment),
  );
}

/** A scalar value at an exact path, or `null`. */
function valueAt(entries: readonly YamlEntry[], path: readonly string[]): YamlEntry | null {
  return (
    entries.find(
      (entry) => entry.path.length === path.length && path.every((segment, index) => entry.path[index] === segment),
    ) ?? null
  );
}

/**
 * A list a YAML file spells either as a block sequence or as a flow scalar.
 *
 * `needs: [build, test]` and a three-line block sequence say the same thing, and a reader that handled
 * only one of them would report half of the repositories' declared prerequisites.
 */
function listAt(entries: readonly YamlEntry[], path: readonly string[]): readonly string[] {
  const scalar = valueAt(entries, path);

  if (scalar !== null && scalar.value !== '') {
    return scalar.value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter((part) => part !== '');
  }

  return (
    childrenOf(entries, path)
      .map((entry) => (entry.key === null ? entry.value : entry.key))
      // A bare sequence item keeps its quotes — `- "cloudflared"` — because only a mapping value passes
      // through the scanner's unquoting. A quoted prerequisite matched no sibling and was reported as a
      // dangling one.
      .map((value) => value.replace(/^["']|["']$/g, ''))
      .filter((value) => value !== '')
  );
}

/** A command's invocations and variables, recorded against the element that carries it. */
function recordCommand(
  references: ReferenceCollector,
  input: ReadInput,
  entry: { readonly value: string; readonly line: number },
  element: string,
): void {
  for (const invoked of invokedPaths(entry.value, input.path)) {
    references.add({
      kind: 'command',
      text: invoked.text,
      candidates: invoked.candidates,
      element,
      line: entry.line,
      evidence: `invoked by ${element}: ${truncate(entry.value, 120)}`,
      confidence: 'INFERRED',
    });
  }

  for (const name of environmentNames(entry.value)) {
    references.add({
      kind: 'environment',
      text: name,
      candidates: [],
      element,
      line: entry.line,
      evidence: `named in ${element}: ${truncate(entry.value, 120)}`,
      confidence: 'CERTAIN',
    });
  }
}

/**
 * A CI or CD pipeline.
 *
 * Jobs, their declared prerequisites, their steps and what each step runs. The prerequisite is the reason
 * this reader earns its place: a workflow's `needs:` is the repository *stating* an execution order, and it
 * is the only ordering evidence a repository with no analysable source ever gives.
 */
const readWorkflow: Reader = (input) => {
  const entries = scanYaml(input.contents);
  const elements = new Elements();
  const references = new ReferenceCollector();
  const keys = topLevelKeys(entries);

  for (const trigger of listAt(entries, ['on'])) {
    elements.add({ kind: 'trigger', name: trigger, detail: 'declared under on', line: valueAt(entries, ['on'])?.line ?? 0 });
  }

  // GitLab and Azure spell the trigger differently; the same reading applies.
  for (const key of ['trigger', 'pr', 'schedules'] as const) {
    for (const trigger of keys.has(key) ? listAt(entries, [key]) : []) {
      elements.add({ kind: 'trigger', name: trigger, detail: `declared under ${key}` });
    }
  }

  for (const stage of keys.has('stages') ? listAt(entries, ['stages']) : []) {
    elements.add({ kind: 'stage', name: stage, detail: 'declared under stages' });
  }

  const jobRoots = keys.has('jobs') ? childrenOf(entries, ['jobs']) : [];

  for (const job of jobRoots) {
    const name = job.key ?? job.value;

    if (name === '') {
      continue;
    }

    const jobPath = [...job.path];
    const requires = [...listAt(entries, [...jobPath, 'needs']), ...listAt(entries, [...jobPath, 'dependsOn'])];
    const runsOn = valueAt(entries, [...jobPath, 'runs-on'])?.value ?? valueAt(entries, [...jobPath, 'pool'])?.value ?? '';
    const guard = valueAt(entries, [...jobPath, 'if'])?.value ?? '';

    elements.add({
      kind: 'job',
      name,
      section: 'jobs',
      detail: runsOn === '' ? 'declared under jobs' : `runs on ${runsOn}`,
      line: job.line,
      requires,
    });

    if (guard !== '') {
      elements.add({ kind: 'condition', name: guard, section: `jobs.${name}`, detail: 'declared as if', line: job.line });
    }

    // Steps of this job. A step's identity is its `name`, then its `uses`, then its command — which is
    // the order of decreasing deliberateness, and the order a reader of the file would use.
    for (const step of under(entries, [...jobPath, 'steps'])) {
      if (step.path.length !== jobPath.length + 3 || step.key === null) {
        continue;
      }

      const container = step.path.slice(0, -1);
      const label =
        valueAt(entries, [...container, 'name'])?.value ||
        valueAt(entries, [...container, 'uses'])?.value ||
        truncate(valueAt(entries, [...container, 'run'])?.value ?? '', 60);

      if (step.key === 'name' || step.key === 'uses') {
        elements.add({
          kind: 'step',
          name: label === '' ? step.value : label,
          section: `jobs.${name}`,
          detail: step.key === 'uses' ? `uses ${step.value}` : 'a named step',
          line: step.line,
        });
      }

      if (step.key === 'run') {
        const stepName = label === '' ? truncate(step.value, 60) : label;

        elements.add({ kind: 'step', name: stepName, section: `jobs.${name}`, detail: step.value, line: step.line });
        elements.add({ kind: 'command', name: truncate(step.value, 80), section: `jobs.${name}`, detail: step.value, line: step.line });
        recordCommand(references, input, step, stepName);
      }

      if (step.key === 'working-directory' || step.key === 'workingDirectory') {
                references.add({
          kind: 'path',
          text: step.value,
          candidates: candidatesFor(step.value, input.path),
          element: label === '' ? name : label,
          line: step.line,
          evidence: `working directory of a step in job ${name}`,
          confidence: 'INFERRED',
        });
      }
    }
  }

  // A single-job pipeline states its steps at the top level. The same reading, with no job to attribute to.
  if (jobRoots.length === 0 && keys.has('steps')) {
    for (const step of under(entries, ['steps'])) {
      if (step.key === 'script' || step.key === 'run') {
        elements.add({ kind: 'command', name: truncate(step.value, 80), section: 'steps', detail: step.value, line: step.line });
        recordCommand(references, input, step, 'a top-level step');
      }
    }
  }

  // `script:` is how GitLab spells a job's commands, at whatever depth the job sits.
  for (const entry of entries) {
    if (entry.key === 'script' || entry.key === 'before_script' || entry.key === 'after_script') {
      const owner = entry.path.length >= 2 ? (entry.path.at(-2) as string) : 'the pipeline';

      if (entry.value !== '') {
        elements.add({ kind: 'command', name: truncate(entry.value, 80), section: owner, detail: entry.value, line: entry.line });
        recordCommand(references, input, entry, owner);
      }

      for (const command of childrenOf(entries, entry.path)) {
        const text = command.key === null ? command.value : `${command.key}: ${command.value}`;

        elements.add({ kind: 'command', name: truncate(text, 80), section: owner, detail: text, line: command.line });
        recordCommand(references, input, { value: text, line: command.line }, owner);
      }
    }
  }

  recordEnvironmentBlocks(entries, elements, references, input);

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read as indentation structure: jobs, their declared prerequisites, their steps and the commands those steps state. ' +
      'Reusable-workflow and template expansion, matrix expansion, anchors and aliases, and expression evaluation were not performed, ' +
      'so the jobs that actually run may differ from the jobs declared here.',
    summary: summarise('ci-workflow', elements, documentCount(entries) > 1 ? [`${documentCount(entries)} documents`] : []),
    dropped: elements.dropped + references.dropped,
  };
};

/** Environment and variable blocks, wherever a YAML artefact declares one. Names only, never values. */
function recordEnvironmentBlocks(
  entries: readonly YamlEntry[],
  elements: Elements,
  references: ReferenceCollector,
  input: ReadInput,
): void {
  for (const entry of entries) {
    if (entry.key !== 'env' && entry.key !== 'environment' && entry.key !== 'variables') {
      continue;
    }

    const owner = entry.path.length >= 2 ? (entry.path.at(-2) as string) : '';

    for (const variable of childrenOf(entries, entry.path)) {
      // Two spellings: a mapping (`KEY: value`) and a sequence (`- KEY=value`). Only the name is kept.
      const name = variable.key ?? (variable.value.split('=')[0] ?? '').trim();

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        continue;
      }

      elements.add({ kind: 'variable', name, section: owner === '' ? entry.key : `${owner}.${entry.key}`, detail: 'name only; the value is not read', line: variable.line });
      references.add({
        kind: 'environment',
        text: name,
        candidates: [],
        element: owner === '' ? null : owner,
        line: variable.line,
        evidence: `declared under ${entry.key}${owner === '' ? '' : ` of ${owner}`}`,
        confidence: 'CERTAIN',
      });
    }

    for (const name of environmentNames(entry.value)) {
      references.add({
        kind: 'environment',
        text: name,
        candidates: [],
        element: owner === '' ? null : owner,
        line: entry.line,
        evidence: `referenced under ${entry.key}`,
        confidence: 'CERTAIN',
      });
    }
  }

  // A `${{ secrets.X }}` or `$VAR` anywhere in the file is a variable the artefact needs.
  for (const name of environmentNames(input.contents)) {
    references.add({
      kind: 'environment',
      text: name,
      candidates: [],
      element: null,
      line: 0,
      evidence: 'referenced in the artefact text',
      confidence: 'CERTAIN',
    });
  }
}

/** A multi-container definition: what runs, from what, wired to what. */
const readCompose: Reader = (input) => {
  const entries = scanYaml(input.contents);
  const elements = new Elements();
  const references = new ReferenceCollector();

  for (const service of childrenOf(entries, ['services'])) {
    const name = service.key ?? '';

    if (name === '') {
      continue;
    }

    const servicePath = [...service.path];
    const image = valueAt(entries, [...servicePath, 'image'])?.value ?? '';
    const requires = [
      ...listAt(entries, [...servicePath, 'depends_on']),
      ...listAt(entries, [...servicePath, 'links']),
    ];

    elements.add({
      kind: 'service',
      name,
      section: 'services',
      detail: image === '' ? 'built from the repository' : `runs ${image}`,
      line: service.line,
      requires,
    });

    if (image !== '') {
      elements.add({ kind: 'image', name: image, section: `services.${name}`, detail: 'declared as image', line: service.line });
    }

    const context = valueAt(entries, [...servicePath, 'build'])?.value ?? valueAt(entries, [...servicePath, 'build', 'context'])?.value ?? '';

    if (context !== '') {
            references.add({
        kind: 'path',
        text: context,
        candidates: candidatesFor(context, input.path),
        element: name,
        line: service.line,
        evidence: `build context of service ${name}`,
        confidence: 'RESOLVED',
      });
    }

    const dockerfile = valueAt(entries, [...servicePath, 'build', 'dockerfile'])?.value ?? '';

    if (dockerfile !== '') {
      const base = context === '' ? input.path : `${context.replace(/^\.\//, '')}/x`;

            references.add({
        kind: 'path',
        text: dockerfile,
        candidates: candidatesFor(dockerfile, base),
        element: name,
        line: service.line,
        evidence: `image recipe of service ${name}`,
        confidence: 'INFERRED',
      });
    }

    for (const port of listAt(entries, [...servicePath, 'ports'])) {
      elements.add({ kind: 'port', name: port, section: `services.${name}`, detail: 'published by compose', line: service.line });
    }

    for (const volume of listAt(entries, [...servicePath, 'volumes'])) {
      elements.add({ kind: 'volume', name: volume, section: `services.${name}`, detail: 'mounted by compose', line: service.line });

      const host = volume.split(':')[0] ?? '';

      if (host.startsWith('.') || host.includes('/')) {
                references.add({
          kind: 'path',
          text: host,
          candidates: candidatesFor(host, input.path),
          element: name,
          line: service.line,
          evidence: `mounted into service ${name}`,
          confidence: 'INFERRED',
        });
      }
    }

    for (const network of listAt(entries, [...servicePath, 'networks'])) {
      elements.add({ kind: 'network', name: network, section: `services.${name}`, detail: 'joined by compose' });
    }

    const command = valueAt(entries, [...servicePath, 'command'])?.value ?? '';

    if (command !== '') {
      elements.add({ kind: 'command', name: truncate(command, 80), section: `services.${name}`, detail: command, line: service.line });
      recordCommand(references, input, { value: command, line: service.line }, name);
    }
  }

  for (const network of childrenOf(entries, ['networks'])) {
    if (network.key !== null) {
      elements.add({ kind: 'network', name: network.key, section: 'networks', detail: 'declared at the top level', line: network.line });
    }
  }

  for (const volume of childrenOf(entries, ['volumes'])) {
    if (volume.key !== null) {
      elements.add({ kind: 'volume', name: volume.key, section: 'volumes', detail: 'declared at the top level', line: volume.line });
    }
  }

  recordEnvironmentBlocks(entries, elements, references, input);

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read as indentation structure: services, the images and build contexts they name, their published ports, mounts, networks and declared prerequisites. ' +
      '`extends`, profiles, `env_file` contents, variable interpolation and override files were not resolved, so the composed configuration may differ from this one file.',
    summary: summarise('container-compose', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/** A Kubernetes-style resource stream: one resource per document, with its containers. */
const readOrchestration: Reader = (input) => {
  const entries = scanYaml(input.contents);
  const elements = new Elements();
  const references = new ReferenceCollector();
  const documents = documentCount(entries);

  for (let document = 0; document < documents; document += 1) {
    const scoped = entries.filter((entry) => entry.document === document);
    const kind = valueAt(scoped, ['kind'])?.value ?? '';
    const name = valueAt(scoped, ['metadata', 'name'])?.value ?? '';
    const version = valueAt(scoped, ['apiVersion'])?.value ?? '';

    if (kind === '') {
      continue;
    }

    elements.add({
      kind: 'resource',
      name: name === '' ? kind : `${kind} ${name}`,
      section: `document ${document + 1}`,
      detail: version === '' ? 'declared kind' : `apiVersion ${version}`,
      line: valueAt(scoped, ['kind'])?.line ?? 0,
    });

    for (const entry of scoped) {
      if (entry.key === 'image' && entry.value !== '') {
        elements.add({ kind: 'image', name: entry.value, section: name === '' ? kind : name, detail: 'container image', line: entry.line });
      }

      if ((entry.key === 'containerPort' || entry.key === 'port' || entry.key === 'targetPort') && entry.value !== '') {
        elements.add({ kind: 'port', name: entry.value, section: name === '' ? kind : name, detail: `declared as ${entry.key}`, line: entry.line });
      }

      if (entry.key === 'name' && entry.path.includes('env') && entry.value !== '') {
        elements.add({ kind: 'variable', name: entry.value, section: name === '' ? kind : name, detail: 'name only; the value is not read', line: entry.line });
        references.add({
          kind: 'environment',
          text: entry.value,
          candidates: [],
          element: name === '' ? null : name,
          line: entry.line,
          evidence: 'declared in a container env block',
          confidence: 'CERTAIN',
        });
      }
    }
  }

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read as indentation structure: each document’s kind, name, container images, ports and environment variable names. ' +
      'Templating (Helm, Kustomize, envsubst) was not expanded and no schema was validated, so a templated file is read as the template rather than as the resource it renders to.',
    summary: summarise('orchestration-resource', elements, documents > 1 ? [`across ${documents} documents`] : []),
    dropped: elements.dropped + references.dropped,
  };
};

// ---------------------------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------------------------

/** A container image recipe: its stages, what each builds from, and what it runs. */
const readDockerfile: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();
  const lines = input.contents.split('\n');

  let stage = '';
  let stageIndex = 0;
  /** Stage names declared so far, so a `COPY --from` can be told from an image reference. */
  const declaredStages = new Set<string>();

  // A Dockerfile instruction continues while the line ends in a backslash, and a `RUN` spanning ten
  // lines is one command rather than ten fragments.
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    let text = (lines[cursor] ?? '').trim();

    if (text === '' || text.startsWith('#')) {
      continue;
    }

    const line = cursor + 1;

    while (text.endsWith('\\') && cursor + 1 < lines.length) {
      cursor += 1;
      text = `${text.slice(0, -1).trim()} ${(lines[cursor] ?? '').trim()}`;
    }

    const match = /^([A-Za-z]+)\s+([\s\S]*)$/.exec(text);

    if (match === null) {
      continue;
    }

    const instruction = (match[1] ?? '').toUpperCase();
    const argument = (match[2] ?? '').trim();

    if (instruction === 'FROM') {
      stageIndex += 1;
      const named = /\s+as\s+([\w.-]+)\s*$/i.exec(argument);
      const image = argument.replace(/\s+as\s+[\w.-]+\s*$/i, '').trim();

      stage = named?.[1] ?? `stage ${stageIndex}`;
      declaredStages.add(stage);
      elements.add({ kind: 'stage', name: stage, detail: `builds from ${image}`, line });
      elements.add({ kind: 'image', name: image, section: stage, detail: 'declared by FROM', line });

      continue;
    }

    if (instruction === 'RUN' || instruction === 'CMD' || instruction === 'ENTRYPOINT') {
      elements.add({ kind: 'command', name: truncate(argument, 80), section: stage, detail: `${instruction} ${argument}`, line });
      recordCommand(references, input, { value: argument, line }, stage === '' ? basename(input.path) : stage);

      continue;
    }

    if (instruction === 'EXPOSE') {
      for (const port of argument.split(/\s+/)) {
        elements.add({ kind: 'port', name: port, section: stage, detail: 'declared by EXPOSE', line });
      }

      continue;
    }

    if (instruction === 'ENV' || instruction === 'ARG') {
      const name = (argument.split(/[=\s]/)[0] ?? '').trim();

      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        elements.add({ kind: 'variable', name, section: stage, detail: `declared by ${instruction}; the value is not read`, line });
        references.add({
          kind: 'environment',
          text: name,
          candidates: [],
          element: stage === '' ? null : stage,
          line,
          evidence: `declared by ${instruction}`,
          confidence: 'CERTAIN',
        });
      }

      continue;
    }

    if (instruction === 'COPY' || instruction === 'ADD') {
      const parts = argument.split(/\s+/).filter((part) => !part.startsWith('--'));
      const sources = parts.slice(0, -1);
      const from = /--from=(\S+)/.exec(argument)?.[1];

      if (from !== undefined) {
        /*
         * `--from` names **either** an earlier stage or an external image, and only the first is ordering.
         *
         * `COPY --from=builder` is this build declaring that one of its own stages must precede another.
         * `COPY --from=someorg/sometool` copies out of an image pulled from a registry, which is not a stage
         * and has no place in this artefact's order — recorded as a prerequisite, it produced one dangling
         * `DEPENDS_ON` per Dockerfile across a repository of container examples. The stages declared so far
         * are the discriminator, and this reader has them because it reads top to bottom.
         */
        const named = declaredStages.has(from);

        elements.add({
          kind: named ? 'step' : 'image',
          name: named ? `copy from ${from}` : from,
          section: stage,
          detail: argument,
          line,
          ...(named ? { requires: [from] } : {}),
        });
      }

      for (const source of sources) {
        if (source === '.' || from !== undefined) {
          continue;
        }

                references.add({
          kind: 'path',
          text: source,
          candidates: candidatesFor(source, input.path),
          element: stage === '' ? null : stage,
          line,
          evidence: `copied into the image by ${instruction}`,
          confidence: 'INFERRED',
        });
      }

      continue;
    }

    if (instruction === 'VOLUME') {
      elements.add({ kind: 'volume', name: argument, section: stage, detail: 'declared by VOLUME', line });
    }

    if (instruction === 'WORKDIR' || instruction === 'USER' || instruction === 'HEALTHCHECK') {
      elements.add({ kind: 'setting', name: `${instruction} ${truncate(argument, 60)}`, section: stage, detail: argument, line });
    }
  }

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read instruction by instruction: stages, base images, commands, exposed ports, declared variable names and copied paths. ' +
      'Build arguments were not substituted and no base image was inspected, so what the image finally contains is not established here.',
    summary: summarise('container-image', elements),
    dropped: elements.dropped + references.dropped,
  };
};

// ---------------------------------------------------------------------------------------------
// JSON, TOML, XML and plain configuration
// ---------------------------------------------------------------------------------------------

/**
 * A dependency or project manifest.
 *
 * Dependencies are deliberately **not** re-read here: the scanner already reads them, the graph already
 * holds a `Dependency` node per name, and a second reading would be a second answer to the same question.
 * What this adds is the part nothing read — the scripts a manifest exposes, the workspace members it
 * claims, and the files it points at.
 */
const readPackageManifest: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();
  const name = basename(input.path).toLowerCase();

  if (name === 'package.json' || name.endsWith('.json')) {
    const parsed = parseJson(input.contents);

    if (parsed === null) {
      return unreadable('package-manifest', 'the JSON could not be parsed, so nothing structural was read');
    }

    const scripts = record(parsed.scripts);

    for (const [script, command] of scripts) {
      elements.add({ kind: 'script-target', name: script, section: 'scripts', detail: command });
      recordCommand(references, input, { value: command, line: 0 }, script);
    }

    // `workspaces` is spelt either as an array or as `{ packages: [...] }`, and both are in wide use.
    const workspaces = Array.isArray(parsed.workspaces)
      ? stringList(parsed.workspaces)
      : stringList((parsed.workspaces as { readonly packages?: unknown } | undefined)?.packages);

    for (const member of workspaces) {
      elements.add({ kind: 'member', name: member, section: 'workspaces', detail: 'declared workspace member' });
    }

    for (const field of ['main', 'module', 'types', 'bin', 'exports'] as const) {
      const value = parsed[field];

      if (typeof value === 'string') {
        elements.add({ kind: 'setting', name: `${field}: ${value}`, section: 'entry points', detail: `declared as ${field}` });

                references.add({
          kind: 'path',
          text: value,
          candidates: candidatesFor(value, input.path),
          element: null,
          line: 0,
          evidence: `declared as the manifest's ${field}`,
          confidence: 'RESOLVED',
        });
      }
    }

    for (const key of ['name', 'version', 'private', 'type', 'license', 'packageManager'] as const) {
      const value = parsed[key];

      if (typeof value === 'string' || typeof value === 'boolean') {
        elements.add({ kind: 'setting', name: `${key}: ${String(value)}`, section: 'metadata', detail: 'declared by the manifest' });
      }
    }

    return {
      elements: elements.entries(),
      references: references.entries(),
      boundary:
        'Read as JSON: the scripts, workspace members, declared entry points and metadata. ' +
        'Declared dependencies are not re-read here — the scanner records them and the graph holds one node per dependency name.',
      summary: summarise('package-manifest', elements),
      dropped: elements.dropped + references.dropped,
    };
  }

  const sections = readIniLike(input, elements, references);

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary: `Read as ${sections} sections and keys. No manifest schema was applied, so a field's meaning is not established beyond its name.`,
    summary: summarise('package-manifest', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/**
 * A schema or migration: what it defines.
 *
 * Three syntaxes, each recognised by its own keyword — SQL's `CREATE`, Prisma's `model`, GraphQL's `type`
 * — because a schema file is one of those three in the great majority of repositories and none of them
 * needs a grammar to spot a definition line.
 */
const readSchema: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();
  const lines = input.contents.split('\n');

  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    const line = index + 1;

    const table = /^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)/i.exec(text);

    if (table !== null) {
      elements.add({ kind: 'entity', name: table[2] ?? '', detail: `created as a ${(table[1] ?? '').toLowerCase()}`, line });

      continue;
    }

    const index_ = /^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)[\]"`]?\s+on\s+["`[]?([\w.]+)/i.exec(text);

    if (index_ !== null) {
      elements.add({ kind: 'index', name: index_[1] ?? '', section: index_[2] ?? '', detail: `indexes ${index_[2] ?? ''}`, line });

      continue;
    }

    const altered = /^alter\s+table\s+(?:if\s+exists\s+)?["`[]?([\w.]+)/i.exec(text);

    if (altered !== null) {
      elements.add({ kind: 'entity', name: altered[1] ?? '', detail: 'altered by this migration', line });

      continue;
    }

    const model = /^(model|enum|type|interface|input)\s+([A-Za-z_]\w*)\s*\{?$/.exec(text);

    if (model !== null) {
      elements.add({ kind: 'entity', name: model[2] ?? '', detail: `declared as a ${model[1] ?? ''}`, line });
    }
  }

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read line by line for definition keywords: tables, views, indexes, altered tables and model or type declarations. ' +
      'Columns, constraints, foreign keys and dialect-specific syntax were not read, so relationships between entities are not established here.',
    summary: summarise('schema', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/** Prose: what it is about, and what it points at. */
const readDocumentation: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();
  const lines = input.contents.split('\n');

  let fenced = false;
  let section = '';

  for (const [index, raw] of lines.entries()) {
    const text = raw.trimEnd();
    const line = index + 1;

    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;

      continue;
    }

    if (fenced) {
      continue;
    }

    const atx = /^(#{1,6})\s+(.+?)\s*#*$/.exec(text);
    const setext = index > 0 && /^(=+|-{2,})\s*$/.test(text) ? (lines[index - 1] ?? '').trim() : '';

    if (atx !== null) {
      const level = (atx[1] ?? '').length;
      const heading = (atx[2] ?? '').replace(/[*_`]/g, '').trim();

      elements.add({ kind: 'heading', name: heading, section, detail: `level ${level} heading`, line });

      if (level <= 2) {
        section = heading;
      }

      continue;
    }

    if (setext !== '' && !setext.startsWith('#') && setext.length < 120) {
      elements.add({ kind: 'heading', name: setext.replace(/[*_`]/g, '').trim(), section, detail: 'underlined heading', line: line - 1 });
      section = setext;

      continue;
    }

    // Inline links, and the reference-definition form. Both name a target the repository may hold.
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\s*\[[^\]]+\]:\s*(\S+)/g)) {
      const target = match[1] ?? match[2] ?? '';

            references.add({
        kind: 'link',
        text: target,
        candidates: candidatesFor(target, input.path),
        element: section === '' ? null : section,
        line,
        evidence: section === '' ? 'linked from this document' : `linked under the "${section}" section`,
        confidence: 'RESOLVED',
      });
    }
  }

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read as headings and links. The prose itself is not interpreted: nothing here establishes what the document *says* about the files it names, ' +
      'and a reference-style or templated link whose target is not written literally is not resolved.',
    summary: summarise('documentation', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/** A shell script: what it defines and what it invokes. */
const readScript: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();
  const lines = input.contents.split('\n');

  const shebang = /^#!(.+)$/.exec(lines[0] ?? '');

  if (shebang !== null) {
    elements.add({ kind: 'setting', name: `interpreter: ${(shebang[1] ?? '').trim()}`, detail: 'declared by the shebang', line: 1 });
  }

  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    const line = index + 1;

    if (text === '' || text.startsWith('#')) {
      continue;
    }

    const declared = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/.exec(text);

    if (declared !== null) {
      elements.add({ kind: 'script-target', name: declared[1] ?? '', detail: 'a function this script defines', line });

      continue;
    }

    const assigned = /^(?:export\s+|readonly\s+|declare\s+-\w+\s+)?([A-Z_][A-Z0-9_]{1,})=/.exec(text);

    if (assigned !== null) {
      const name = assigned[1] ?? '';

      elements.add({ kind: 'variable', name, detail: 'assigned by this script; the value is not read', line });
    }

    for (const invoked of invokedPaths(text, input.path)) {
      references.add({
        kind: 'command',
        text: invoked.text,
        candidates: invoked.candidates,
        element: null,
        line,
        evidence: `invoked by this script: ${truncate(text, 120)}`,
        confidence: 'INFERRED',
      });
      elements.add({ kind: 'command', name: truncate(text, 80), detail: text, line });
    }

    for (const name of environmentNames(text)) {
      references.add({
        kind: 'environment',
        text: name,
        candidates: [],
        element: null,
        line,
        evidence: `read by this script: ${truncate(text, 120)}`,
        confidence: 'CERTAIN',
      });
    }
  }

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read line by line for function definitions, uppercase assignments, invoked paths and variable references. ' +
      'Control flow is not followed, so nothing here establishes what runs, in what order, or under what condition.',
    summary: summarise('script', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/**
 * A test file: the suites it declares, and a bounded sample of its cases.
 *
 * **The cap on cases is a deliberate prioritisation and it was measured.** A test file's *suites* say what
 * it covers, which is what a reader asking "what tests should I read first" wants; its individual case names
 * are bulk. Uncapped, test files contributed 3,084 of one repository's 3,471 artefact elements and 3,449 of
 * another's 4,433 — roughly doubling the graph to carry the least semantic thing artefact analysis extracts.
 * Every suite is kept; the cases stop at `TEST_CASE_LIMIT` and the boundary says so.
 */
const readTest: Reader = (input) => {
  const elements = new Elements();
  const lines = input.contents.split('\n');

  let suite = '';
  let cases = 0;
  let omitted = 0;

  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    const line = index + 1;

    const group = /^(?:describe|suite|context)(?:\.\w+)?\s*\(\s*['"`](.+?)['"`]/.exec(text);

    if (group !== null) {
      suite = group[1] ?? '';
      elements.add({ kind: 'section', name: suite, detail: 'a declared suite', line });

      continue;
    }

    const spec =
      /^(?:it|test|bench)(?:\.\w+)?\s*\(\s*['"`](.+?)['"`]/.exec(text) ??
      /^(?:def\s+(test_\w+)|func\s+(Test\w+)|(?:public\s+)?void\s+(test\w+))/.exec(text);

    if (spec !== null) {
      const name = spec[1] ?? spec[2] ?? spec[3] ?? '';

      if (cases >= TEST_CASE_LIMIT) {
        omitted += 1;

        continue;
      }

      cases += 1;
      elements.add({ kind: 'step', name, section: suite, detail: 'a declared test', line });
    }
  }

  return {
    elements: elements.entries(),
    references: [],
    boundary:
      'Read line by line for suite and test declarations written literally. A test whose name is computed, generated from a table, or declared by a helper is not listed, ' +
      `and what each test exercises is not established from its name.${
        omitted === 0 ? '' : ` ${omitted} further test names were not recorded: every suite is kept, and cases stop at ${TEST_CASE_LIMIT} per file.`
      }`,
    summary: summarise('test', elements, omitted === 0 ? [] : [`${omitted} further tests not listed`]),
    dropped: elements.dropped + omitted,
  };
};

/** How many individual test names one file contributes. Its suites are uncapped. */
const TEST_CASE_LIMIT = 8;

/**
 * An environment file: the variable **names** it supplies, and never their values.
 *
 * The one reader with a rule about what it must not read. A `.env` holds live credentials in a great many
 * repositories, and a value recorded here would reach the graph, then a projection, then a prompt, then an
 * answer. The name is the useful part and the value is the dangerous one.
 */
const readEnvironment: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();

  for (const [index, raw] of input.contents.split('\n').entries()) {
    const text = raw.trim();

    if (text === '' || text.startsWith('#')) {
      continue;
    }

    const name = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text)?.[1];

    if (name === undefined) {
      continue;
    }

    elements.add({ kind: 'variable', name, detail: 'name only; this reader never records a value', line: index + 1 });
    references.add({
      kind: 'environment',
      text: name,
      candidates: [],
      element: null,
      line: index + 1,
      evidence: `supplied by ${basename(input.path)}`,
      confidence: 'CERTAIN',
    });
  }

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Only variable names are read. Values are deliberately never recorded, because this file frequently holds credentials — ' +
      'so nothing here establishes what any variable is set to, in this or any environment.',
    summary: summarise('environment-configuration', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/** Infrastructure as code: Terraform's own block syntax, or a YAML definition read structurally. */
const readInfrastructure: Reader = (input) => {
  const elements = new Elements();
  const references = new ReferenceCollector();

  if (/\.(tf|tfvars|hcl)$/i.test(input.path)) {
    for (const [index, raw] of input.contents.split('\n').entries()) {
      const text = raw.trim();
      const line = index + 1;

      const block = /^(resource|data|module|variable|output|provider|locals|terraform)\s*(?:"([^"]+)")?\s*(?:"([^"]+)")?/.exec(text);

      if (block === null) {
        continue;
      }

      const keyword = block[1] ?? '';
      const kind: ArtifactElementKind =
        keyword === 'variable' ? 'input' : keyword === 'output' ? 'output' : keyword === 'module' ? 'member' : 'resource';
      const name = [block[2], block[3]].filter((part) => part !== undefined && part !== '').join('.');

      elements.add({
        kind,
        name: name === '' ? keyword : name,
        section: keyword,
        detail: `declared as a ${keyword} block`,
        line,
      });
    }

    for (const match of input.contents.matchAll(/source\s*=\s*"([^"]+)"/g)) {
      const target = match[1] ?? '';

            references.add({
        kind: 'path',
        text: target,
        candidates: candidatesFor(target, input.path),
        element: null,
        line: 0,
        evidence: 'declared as a module source',
        confidence: 'RESOLVED',
      });
    }

    return {
      elements: elements.entries(),
      references: references.entries(),
      boundary:
        'Read line by line for block headers: resources, data sources, modules, variables and outputs. ' +
        'Expressions, interpolations and remote modules were not evaluated, so what is actually provisioned is not established here.',
      summary: summarise('infrastructure-as-code', elements),
      dropped: elements.dropped + references.dropped,
    };
  }

  const entries = scanYaml(input.contents);

  for (const entry of childrenOf(entries, [])) {
    if (entry.key !== null) {
      elements.add({ kind: 'section', name: entry.key, detail: entry.value === '' ? 'a declared block' : entry.value, line: entry.line });
    }
  }

  for (const entry of entries) {
    if (entry.key === 'image' && entry.value !== '') {
      elements.add({ kind: 'image', name: entry.value, section: entry.path.slice(0, -1).join('.'), detail: 'declared image', line: entry.line });
    }
  }

  recordEnvironmentBlocks(entries, elements, references, input);

  return {
    elements: elements.entries(),
    references: references.entries(),
    boundary:
      'Read as indentation structure: the top-level blocks it declares and the images it names. ' +
      'Templating was not expanded and no schema was applied, so what this provisions is not established here.',
    summary: summarise('infrastructure-as-code', elements),
    dropped: elements.dropped + references.dropped,
  };
};

/**
 * Anything else structured: a tool configuration, a workspace file, a build script, a data file.
 *
 * One reader for four families because the useful reading is the same for all of them — the sections it
 * declares, the settings worth naming, and the paths it points at — and four copies of that would be four
 * places for it to drift.
 */
function generic(kind: ArtifactKind): Reader {
  return (input) => {
    const elements = new Elements();
    const references = new ReferenceCollector();
    const name = basename(input.path).toLowerCase();
    let how: string;

    if (/\.(json|jsonc|json5)$/.test(name)) {
      const parsed = parseJson(input.contents);

      if (parsed === null) {
        return unreadable(kind, 'the JSON could not be parsed, so nothing structural was read');
      }

      how = 'JSON keys, one level deep';

      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && typeof value === 'object') {
          const inner = Array.isArray(value) ? `${value.length} entries` : `${Object.keys(value).length} keys`;

          elements.add({ kind: 'section', name: key, detail: inner });

          for (const [childKey, childValue] of Array.isArray(value) ? [] : Object.entries(value)) {
            if (typeof childValue === 'string' || typeof childValue === 'number' || typeof childValue === 'boolean') {
              elements.add({ kind: 'setting', name: childKey, section: key, detail: String(childValue) });
            }
          }
        } else {
          elements.add({ kind: 'setting', name: key, detail: String(value) });
        }
      }

      for (const match of input.contents.matchAll(/"((?:\.{1,2}\/|[\w-]+\/)[\w./*-]+)"/g)) {
                references.add({
          kind: 'path',
          text: match[1] ?? '',
          candidates: candidatesFor((match[1] ?? '').replace(/\/?\*.*$/, ''), input.path),
          element: null,
          line: 0,
          evidence: 'named as a path in this configuration',
          confidence: 'INFERRED',
        });
      }
    } else if (/\.(ya?ml)$/.test(name)) {
      const entries = scanYaml(input.contents);

      how = 'indentation structure, one level deep';

      for (const entry of childrenOf(entries, [])) {
        if (entry.key !== null) {
          elements.add({
            kind: entry.value === '' ? 'section' : 'setting',
            name: entry.key,
            detail: entry.value === '' ? 'a declared block' : entry.value,
            line: entry.line,
          });
        }
      }

      recordEnvironmentBlocks(entries, elements, references, input);
    } else if (/\.(xml|csproj|fsproj|pom)$/.test(name) || name === 'pom.xml') {
      how = 'element names, one level deep';

      for (const match of input.contents.matchAll(/<(\w[\w.-]*)(?:\s[^>]*)?>\s*([^<\s][^<]*?)?\s*<\/\1>/g)) {
        const value = (match[2] ?? '').trim();

        elements.add({ kind: value === '' ? 'section' : 'setting', name: match[1] ?? '', detail: truncate(value, 80) });
      }
    } else {
      how = readIniLike(input, elements, references);
    }

    return {
      elements: elements.entries(),
      references: references.entries(),
      boundary: `Read as ${how}. No schema for this format was applied, so a key's meaning is not established beyond its name, and nested structure below the level read is not reported.`,
      summary: summarise(kind, elements),
      dropped: elements.dropped + references.dropped,
    };
  };
}

/**
 * INI, TOML and properties files, which share enough syntax that one reading serves all three.
 *
 * A section header in brackets and `key = value` lines. TOML's arrays of tables, inline tables and typed
 * values are read as text, which is the coarse-but-true reading this package prefers over a wrong one.
 */
function readIniLike(input: ReadInput, elements: Elements, references: ReferenceCollector): string {
  let section = '';

  for (const [index, raw] of input.contents.split('\n').entries()) {
    const text = raw.trim();
    const line = index + 1;

    if (text === '' || text.startsWith('#') || text.startsWith(';')) {
      continue;
    }

    const header = /^\[+([^\]]+)\]+$/.exec(text);

    if (header !== null) {
      section = (header[1] ?? '').trim();
      elements.add({ kind: 'section', name: section, detail: 'a declared section', line });

      continue;
    }

    const setting = /^([\w.$"'-]+)\s*[=:]\s*(.*)$/.exec(text);

    if (setting === null) {
      continue;
    }

    const key = (setting[1] ?? '').replace(/^["']|["']$/g, '');
    const value = (setting[2] ?? '').trim();

    elements.add({ kind: 'setting', name: key, section, detail: truncate(value, 80), line });

        references.add({
      kind: 'path',
      text: value,
      candidates: candidatesFor(value.replace(/^["']|["']$/g, ''), input.path),
      element: section === '' ? null : section,
      line,
      evidence: `named by ${key}${section === '' ? '' : ` in section ${section}`}`,
      confidence: 'INFERRED',
    });
  }

  return 'bracketed sections and key/value lines';
}

/** A file whose family is known and whose contents were deliberately not read. */
function presenceOnly(boundary: string, summary: string): ReadResult {
  return { elements: [], references: [], boundary, summary, dropped: 0 };
}

function unreadable(kind: ArtifactKind, reason: string): ReadResult {
  return {
    elements: [],
    references: [],
    boundary: `${reason}. Its presence is recorded; its contents are not.`,
    summary: `a ${kind} TraceIQ could not read`,
    dropped: 0,
  };
}

const readLockfile: Reader = (input) =>
  presenceOnly(
    'Deliberately not read. A lockfile is a machine-written resolution of the manifest beside it, often tens of thousands of lines, ' +
      'and its pinned versions answer no question about what the repository is — the manifest states the intent, and the graph already holds one node per declared dependency.',
    `a lockfile pinning the dependencies ${basename(input.path)} resolves`,
  );

const readGenerated: Reader = () =>
  presenceOnly(
    'Deliberately not read. This file was written by a tool or vendored from elsewhere, so its structure describes its generator rather than this repository.',
    'a generated or vendored artefact',
  );

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/**
 * Which reader reads which family.
 *
 * **A missing entry is not a failure.** A family with no reader is recorded with its family, its path and
 * a boundary sentence saying no reader exists for it — which is the graceful degradation the abstraction
 * exists to provide, and is strictly more than the nothing such a file carried before.
 */
export const READERS: Readonly<Partial<Record<ArtifactKind, Reader>>> = {
  'ci-workflow': readWorkflow,
  'container-compose': readCompose,
  'orchestration-resource': readOrchestration,
  'container-image': readDockerfile,
  'infrastructure-as-code': readInfrastructure,
  'package-manifest': readPackageManifest,
  lockfile: readLockfile,
  'build-configuration': generic('build-configuration'),
  'workspace-configuration': generic('workspace-configuration'),
  'environment-configuration': readEnvironment,
  'tool-configuration': generic('tool-configuration'),
  schema: readSchema,
  documentation: readDocumentation,
  script: readScript,
  test: readTest,
  generated: readGenerated,
  data: generic('data'),
};

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function parseJson(contents: string): Record<string, unknown> | null {
  try {
    // A trailing-comma or comment-bearing `jsonc` is common for tsconfig; both are stripped before the
    // parse, which is the one liberty taken with the format and the only way to read those files at all.
    const cleaned = contents
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    const parsed: unknown = JSON.parse(cleaned);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): readonly (readonly [string, string])[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : ''] as const);
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
