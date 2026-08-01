import { regionOf, type ManifestFile, type RepositoryFile, type TechnologyRegion } from '@traceiq/scanner';
import type { ConfidenceLevel } from '@traceiq/types';

import { classifyRegion } from './classify.js';
import {
  DEPENDENCY_RULES,
  DIRECTORY_CONSTRAINED,
  FILE_RULES,
  LOCKFILE_RULES,
  type DependencyRule,
} from './rules.js';
import type { DetectedTechnology, TechnologyEvidence, TechnologyProfile } from './types.js';

/** What the detector needs, which is exactly what the scanner already produced. */
export interface TechnologyInput {
  readonly files: readonly RepositoryFile[];
  readonly manifests: readonly ManifestFile[];
  readonly regions: readonly TechnologyRegion[];
  /**
   * Reads a repository file, or returns `null`.
   *
   * Supplied by the caller rather than taken from `node:fs` so this package stays a pure function
   * of its inputs and can be tested without a directory. It is called for a **bounded** set of
   * candidates — YAML files that might be Kubernetes manifests — and never for source.
   */
  readonly readFile?: (path: string) => Promise<string | null>;
}

/** How much of a candidate file is read before deciding. Enough for a YAML document header. */
const CONTENT_PROBE_BYTES = 2048;

/** A Kubernetes manifest states both of these, at the top level, and nothing else does. */
const KUBERNETES_MARKERS = [/^apiVersion:\s*\S/m, /^kind:\s*\S/m];

/**
 * Detects the technologies a repository is built from, with the evidence for each.
 *
 * **Nothing here guesses.** Every detection names the files that prove it, and a technology with no
 * proof is not reported. That is the difference between an architecture view a reader can act on
 * and a badge wall they have to verify by hand.
 *
 * Detection is **per region**, because a monorepo is several projects and "this repository uses
 * Next.js and NestJS" throws away the only part that matters — which project is which. A region's
 * technologies come from its own manifests and its own files; the root region does not inherit
 * what a nested package declares, and a nested package does not inherit the root's.
 *
 * Three sources, in descending directness:
 *
 * 1. **A declared dependency.** `"next": "^14"` in a manifest. A direct reading of what the
 *    repository's authors wrote, so `CERTAIN`.
 * 2. **A marker file.** `docker-compose.yml`, `next.config.js`, a `.tf` file. The file's existence
 *    *is* the technology, so `CERTAIN` as well.
 * 3. **A file the technology owns, with nothing declaring it.** `.vue` files in a region whose
 *    manifest never mentions Vue. Real, and indirect: `INFERRED`.
 *
 * A technology found by more than one source keeps the strongest confidence and accumulates every
 * piece of evidence, because a reader asking "why do you say this is a Next.js app" is better
 * served by three reasons than by one.
 */
export async function detectTechnologies(input: TechnologyInput): Promise<TechnologyProfile> {
  const kubernetes = await findKubernetesManifests(input);
  const byRegion = new Map<string, Map<string, Mutable>>();

  const record = (
    regionPath: string,
    key: { readonly id: string; readonly name: string; readonly category: DetectedTechnology['category'] },
    confidence: ConfidenceLevel,
    evidence: TechnologyEvidence,
  ): void => {
    const bucket = byRegion.get(regionPath) ?? new Map<string, Mutable>();
    const existing = bucket.get(key.id);

    if (existing === undefined) {
      bucket.set(key.id, { ...key, regionPath, confidence, evidence: [evidence] });
    } else {
      existing.evidence.push(evidence);
      existing.confidence = strongest(existing.confidence, confidence);
    }

    byRegion.set(regionPath, bucket);
  };

  // Files and manifests attributed to regions by the scanner's own rule, so a file counted in one
  // region can never have its technologies recorded against another.
  const anchors = input.regions.map((region) => region.path).sort();
  const filesByRegion = new Map<string, RepositoryFile[]>(anchors.map((path) => [path, []]));
  const manifestsByRegion = new Map<string, ManifestFile[]>(anchors.map((path) => [path, []]));

  for (const file of input.files) {
    filesByRegion.get(regionOf(anchors, file.path))?.push(file);
  }

  for (const manifest of input.manifests) {
    manifestsByRegion.get(regionOf(anchors, manifest.path))?.push(manifest);
  }

  for (const region of input.regions) {
    // ---- declared dependencies ----------------------------------------------------------------
    for (const manifest of manifestsByRegion.get(region.path) ?? []) {
      for (const rule of DEPENDENCY_RULES) {
        const declared = manifest.declaredDependencies.filter((entry) => satisfies(rule, entry));

        if (declared.length > 0) {
          record(region.path, rule, 'CERTAIN', {
            path: manifest.path,
            detail: `declares ${declared.map((name) => `'${artifactOf(name)}'`).join(', ')}`,
          });
        }

        // **A framework's own repository never depends on itself.** `packages/core/package.json`
        // in nestjs/nest is *named* `@nestjs/core`. Without this, scanning nestjs/nest, fastify or
        // hono reported every framework those repositories use and not the one they are — which is
        // the single thing a reader opening a framework repository wants to know.
        if (manifest.declaredName !== null && satisfies(rule, manifest.declaredName)) {
          record(region.path, rule, 'CERTAIN', {
            path: manifest.path,
            detail: `is the package '${manifest.declaredName}'`,
          });
        }
      }

      const lockfile = LOCKFILE_RULES[baseName(manifest.path).toLowerCase()];

      if (lockfile !== undefined) {
        record(region.path, { ...lockfile, category: 'build' }, 'CERTAIN', {
          path: manifest.path,
          detail: 'the lockfile this package manager writes',
        });
      }
    }

    // ---- marker files -------------------------------------------------------------------------
    for (const file of filesByRegion.get(region.path) ?? []) {
      const base = baseName(file.path);
      const lockfile = LOCKFILE_RULES[base.toLowerCase()];

      if (lockfile !== undefined) {
        record(region.path, { ...lockfile, category: 'build' }, 'CERTAIN', {
          path: file.path,
          detail: 'the lockfile this package manager writes',
        });
      }

      if (kubernetes.has(file.path)) {
        record(
          region.path,
          { id: 'kubernetes', name: 'Kubernetes', category: 'infrastructure' },
          'CERTAIN',
          { path: file.path, detail: 'a YAML document declaring apiVersion and kind' },
        );
      }

      for (const rule of FILE_RULES) {
        if (!matchesFileRule(rule, base)) {
          continue;
        }

        // A rule that only holds inside one directory — a GitHub workflow is an ordinary YAML file
        // everywhere else, and claiming it outside `.github/workflows` would be the guess this
        // layer exists to avoid.
        const required = DIRECTORY_CONSTRAINED[rule.id];

        if (required !== undefined && !file.path.startsWith(required)) {
          continue;
        }

        // Every rule in the table is a direct reading, so every match is CERTAIN. An earlier
        // version rated an extension match INFERRED, on the theory that a marker file is more
        // direct than a file type — and the first test written against it showed the theory was
        // wrong: `.tf` *is* Terraform, `.vue` *is* a Vue component, and the extensions are owned
        // exclusively. There was no inference to be weaker about. See `DetectedTechnology.confidence`
        // for what INFERRED is reserved for.
        record(region.path, rule, 'CERTAIN', { path: file.path, detail: rule.detail });
      }
    }
  }

  const technologies = [...byRegion.entries()]
    .flatMap(([, bucket]) => [...bucket.values()])
    .map(
      (entry): DetectedTechnology => ({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        regionPath: entry.regionPath,
        confidence: entry.confidence,
        // Sorted so two scans of one repository produce byte-identical evidence, and capped so a
        // repository with four hundred Vue components does not carry four hundred proofs of Vue.
        evidence: [...entry.evidence].sort(byPath).slice(0, EVIDENCE_LIMIT),
      }),
    )
    .sort((a, b) => a.regionPath.localeCompare(b.regionPath) || a.id.localeCompare(b.id));

  return {
    technologies,
    architecture: input.regions.map((region) =>
      classifyRegion({
        region,
        technologies: technologies.filter((entry) => entry.regionPath === region.path),
      }),
    ),
  };
}

/**
 * How many evidence entries one technology keeps.
 *
 * Capped because a Vue application proves Vue with every component it has, and four hundred
 * identical proofs are not four hundred times as convincing. The cap is generous enough that a
 * reader sees the spread of a technology across a region rather than a single file.
 */
const EVIDENCE_LIMIT = 12;

interface Mutable {
  readonly id: string;
  readonly name: string;
  readonly category: DetectedTechnology['category'];
  readonly regionPath: string;
  confidence: ConfidenceLevel;
  readonly evidence: TechnologyEvidence[];
}

/**
 * Which YAML files are Kubernetes manifests.
 *
 * **The only detection that reads a file's contents**, and it does so because nothing else can
 * tell one apart. `.yaml` is the extension of CI configuration, application config, Compose files,
 * OpenAPI documents and Kubernetes manifests alike; claiming Kubernetes from the extension would
 * be wrong far more often than right. A Kubernetes document states `apiVersion` and `kind` at the
 * top level, always, and nothing else in common use states both.
 *
 * Bounded twice over: only YAML files are candidates, and only the first two kilobytes of each are
 * read — a document header is at the top or the document is not one.
 */
async function findKubernetesManifests(input: TechnologyInput): Promise<ReadonlySet<string>> {
  const found = new Set<string>();

  if (input.readFile === undefined) {
    return found;
  }

  const candidates = input.files.filter((file) => {
    const base = baseName(file.path).toLowerCase();

    return (
      /\.ya?ml$/.test(base) &&
      // A Compose file states neither key, and a workflow is not a Kubernetes manifest however
      // much YAML it shares. Excluding them keeps one file from proving two contradictory things.
      !/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(base) &&
      !file.path.startsWith('.github/')
    );
  });

  for (const file of candidates) {
    const contents = await input.readFile(file.path);

    if (contents === null) {
      continue;
    }

    const head = contents.slice(0, CONTENT_PROBE_BYTES);

    if (KUBERNETES_MARKERS.every((marker) => marker.test(head))) {
      found.add(file.path);
    }
  }

  return found;
}

function matchesFileRule(rule: (typeof FILE_RULES)[number], base: string): boolean {
  if (rule.fileNames?.some((name) => name.toLowerCase() === base.toLowerCase()) === true) {
    return true;
  }

  if (rule.filePattern?.test(base) === true) {
    return true;
  }

  const extension = base.includes('.') ? (base.split('.').pop() ?? '') : '';

  return rule.extensions?.includes(extension.toLowerCase()) === true;
}

const ORDER: readonly ConfidenceLevel[] = ['AMBIGUOUS', 'INFERRED', 'RESOLVED', 'CERTAIN'];

/** The same maximum the Graph Builder takes over the edges that introduce a node. */
function strongest(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

function byPath(a: TechnologyEvidence, b: TechnologyEvidence): number {
  return a.path.localeCompare(b.path);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether one declared dependency satisfies a rule.
 *
 * **Two ecosystems name the same dependency differently, and a rule may only be written one way.**
 * npm declares `"next"`; Maven and Gradle declare `org.springframework.boot:spring-boot-starter-web`.
 * A rule listing the bare artifact therefore matched nothing at all, and spring-petclinic — whose
 * `pom.xml` declares six Spring Boot starters — was reported as having no framework while the Java
 * analyser had already recognised its Spring annotations. The evidence was present and parsed; only
 * the two spellings never met.
 *
 * Comparing the artifact rather than the whole coordinate is what a Maven rule means. Only the
 * artifact half is compared, never the group, so one vendor's namespace cannot stand in for any of
 * its products.
 */
function satisfies(rule: DependencyRule, declared: string): boolean {
  const artifact = artifactOf(declared);

  return (
    rule.packages.includes(declared) ||
    rule.packages.includes(artifact) ||
    (rule.prefixes ?? []).some((prefix) => artifact.startsWith(prefix))
  );
}

/** The artifact half of a `group:artifact` coordinate, or the name itself. An npm scope is not one. */
function artifactOf(declared: string): string {
  const colon = declared.lastIndexOf(':');

  return colon === -1 ? declared : declared.slice(colon + 1);
}
