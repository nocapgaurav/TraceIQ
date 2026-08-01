import type { TechnologyRegion } from '@traceiq/scanner';

import type { DetectedTechnology, RegionArchitecture, RegionKind } from './types.js';

/**
 * What a region *is*, from the technologies found in it and the files it holds.
 *
 * **This is the architecture layer, and it is derived rather than declared.** No repository states
 * that `apps/web` is an application and `packages/ui` is a library; what it states is a Next.js
 * dependency in one manifest and an `exports` field in another. The shape follows from those, and
 * every classification names the evidence it followed so a reader can disagree with it.
 *
 * The order below is the priority, and it is not arbitrary. A region can be several things at once
 * — a Next.js application with a Dockerfile and a test runner is all three — and the question an
 * architecture view answers is "what is this *for*", which the most specific answer settles. A
 * frontend framework beats a backend one because a Next.js app that also serves API routes is
 * still the thing a user opens; infrastructure and tooling come last because almost every region
 * has some.
 *
 * `unknown` is a real answer and is returned. A region holding only documentation is none of the
 * others, and calling it a library to avoid an empty field would invent a fact.
 */
export function classifyRegion(input: {
  readonly region: TechnologyRegion;
  readonly technologies: readonly DetectedTechnology[];
}): RegionArchitecture {
  const { region, technologies } = input;
  const named = (category: DetectedTechnology['category']): readonly DetectedTechnology[] =>
    technologies.filter((entry) => entry.category === category);

  const frontend = named('frontend');
  const backend = named('backend');
  const infrastructure = named('infrastructure');
  const build = named('build');

  const decided = ((): { readonly kind: RegionKind; readonly reason: string } => {
    if (frontend.length > 0) {
      return {
        kind: 'application',
        reason: `${list(frontend)} ${frontend.length === 1 ? 'is' : 'are'} used here, which renders a user interface`,
      };
    }

    if (backend.length > 0) {
      return {
        kind: 'service',
        reason: `${list(backend)} ${backend.length === 1 ? 'is' : 'are'} used here, which serves requests`,
      };
    }

    // No framework, but the region publishes code for something else to consume. A workspace
    // package is the common case, and a manifest naming the package is what makes it consumable.
    if (region.manifests.length > 0 && region.sourceFileCount > 0) {
      return {
        kind: 'library',
        reason:
          'this region declares a manifest and holds source, but no framework — so it is code meant to be consumed by other code',
      };
    }

    // Infrastructure is checked only once code has been ruled out, because almost every
    // application region also carries a Dockerfile.
    if (infrastructure.length > 0) {
      return {
        kind: 'infrastructure',
        reason: `${list(infrastructure)} ${infrastructure.length === 1 ? 'describes' : 'describe'} how this is deployed, and the region holds no application code`,
      };
    }

    if (build.length > 0) {
      return {
        kind: 'tooling',
        reason: `${list(build)} ${build.length === 1 ? 'orchestrates' : 'orchestrate'} the build, and the region holds no application code`,
      };
    }

    if (region.sourceFileCount > 0) {
      return {
        kind: 'library',
        reason: 'this region holds source and declares no framework, so it is read as shared code',
      };
    }

    return {
      kind: 'unknown',
      reason: 'nothing in this region says what it is: no framework, no manifest and no source',
    };
  })();

  return {
    path: region.path,
    kind: decided.kind,
    reason: decided.reason,
    // `CERTAIN` only when a technology proved it and that technology was itself certain. A region
    // read as a library because it has a manifest and some source is a reasonable reading of a
    // convention, which is what INFERRED means everywhere else in this project.
    confidence: certaintyOf(decided.kind, technologies),
    technologies,
  };
}

function certaintyOf(
  kind: RegionKind,
  technologies: readonly DetectedTechnology[],
): RegionArchitecture['confidence'] {
  const deciding: Readonly<Partial<Record<RegionKind, DetectedTechnology['category']>>> = {
    application: 'frontend',
    service: 'backend',
    infrastructure: 'infrastructure',
    tooling: 'build',
  };

  const category = deciding[kind];

  if (category === undefined) {
    // `library` and `unknown` rest on the absence of a framework plus a convention about layout.
    // Neither is proven by anything the repository wrote down.
    return 'INFERRED';
  }

  return technologies.some((entry) => entry.category === category && entry.confidence === 'CERTAIN')
    ? 'CERTAIN'
    : 'INFERRED';
}

/** `React`, or `React and Next.js`, or `React, Next.js and Vite`. */
function list(technologies: readonly DetectedTechnology[]): string {
  const names = technologies.map((entry) => entry.name);

  if (names.length <= 1) {
    return names[0] ?? '';
  }

  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}
