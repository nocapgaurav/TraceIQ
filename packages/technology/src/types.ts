import type { ConfidenceLevel } from '@traceiq/types';

/**
 * What a technology claim rests on.
 *
 * **Every claim carries these, and a claim with none is not made.** A framework badge that a reader
 * cannot check is indistinguishable from a guess, and the whole product rests on never guessing.
 * One entry per file that proves something, with the proof stated in words a reader can go and
 * verify by opening that file.
 */
export interface TechnologyEvidence {
  /** Repository-relative path of the file the evidence is in. */
  readonly path: string;
  /** What was found there, shown to a reader verbatim. */
  readonly detail: string;
}

/**
 * What a technology is *for*, which is what makes a repository's shape readable.
 *
 * Coarse on purpose. The categories exist so that "this region is a frontend application and that
 * one is a backend service" is derivable, and a finer taxonomy — state management, ORM, bundler —
 * would multiply the rules without answering a question anyone is asking of an architecture view.
 */
export const TECHNOLOGY_CATEGORIES = [
  /** Renders a user interface: React, Vue, Svelte, Next.js. */
  'frontend',
  /** Serves requests: Express, NestJS, Fastify, Hono, Koa, Flask, Spring, Gin. */
  'backend',
  /** Describes how the software is deployed: Docker, Compose, Kubernetes, Terraform. */
  'infrastructure',
  /** Builds, orchestrates or packages the repository: npm, pnpm, Turborepo, Nx, Vite. */
  'build',
  /** Runs the tests: Vitest, Jest, pytest, JUnit. */
  'testing',
  /** Stores or moves data: Postgres, Redis, Prisma. */
  'data',
] as const;

export type TechnologyCategory = (typeof TECHNOLOGY_CATEGORIES)[number];

/**
 * One technology, found in one region, with everything that proves it.
 *
 * Scoped to a **region** rather than to the repository, and that is what makes it useful in a
 * monorepo. `apps/web` being Next.js and `apps/api` being NestJS are two different facts about two
 * different projects; collapsing them to "this repository uses Next.js and NestJS" loses the only
 * part an architecture view needs.
 */
export interface DetectedTechnology {
  /** Stable identifier, kebab-case: `react`, `nextjs`, `docker-compose`. */
  readonly id: string;
  /** How the technology spells its own name: `React`, `Next.js`, `Docker Compose`. */
  readonly name: string;
  readonly category: TechnologyCategory;
  /** The region this was detected in. `''` is the repository root. */
  readonly regionPath: string;
  /**
   * **`CERTAIN` for every rule currently in the table**, and that is a finding rather than an
   * oversight. Each rule is a direct reading of something the repository states: a `next` entry in
   * a manifest's dependencies, a `docker-compose.yml`, a `.tf` file. An earlier version rated an
   * extension match INFERRED on the theory that a file type is weaker evidence than a marker file;
   * the first test written against it disproved the theory, because `.tf` *is* Terraform and the
   * extension is owned exclusively. Inventing a distinction the rules do not support would make
   * the field noise.
   *
   * `INFERRED` is reserved, and reserved for something specific: a rule that *infers* rather than
   * reads — recognising a framework from an import of a package nothing declared, say, where the
   * source suggests it and no manifest confirms it. No such rule exists yet.
   *
   * Nothing here is ever `RESOLVED`: that level means a reference was followed to its target, and
   * no technology claim follows a reference.
   */
  readonly confidence: ConfidenceLevel;
  /** Never empty. Sorted by path, so two scans of one repository agree. */
  readonly evidence: readonly TechnologyEvidence[];
}

/**
 * What a region *is*, derived from the technologies found in it.
 *
 * This is the architecture, and it is derived rather than declared: no repository states that
 * `apps/web` is an application and `packages/ui` is a library. What a repository does state is a
 * Next.js dependency here and an `exports` field there, and the shape follows from those.
 *
 * `unknown` is a real answer and is used. A region holding only documentation is none of the
 * others, and calling it a library to avoid an empty field would be inventing a fact.
 */
export const REGION_KINDS = [
  /** Something a person opens: a frontend framework, or a static site. */
  'application',
  /** Something that serves requests: a backend framework, or registered routes. */
  'service',
  /** Code meant to be consumed by other code in this repository or published. */
  'library',
  /** Deployment and provisioning: Dockerfiles, Compose, Kubernetes manifests, Terraform. */
  'infrastructure',
  /** Configuration, scripts and build orchestration that ship with the repository. */
  'tooling',
  /** Nothing in the region says what it is. */
  'unknown',
] as const;

export type RegionKind = (typeof REGION_KINDS)[number];

/** One region, classified, with the reason a reader can check. */
export interface RegionArchitecture {
  readonly path: string;
  readonly kind: RegionKind;
  /** Why this kind, in words shown to a reader unchanged. */
  readonly reason: string;
  readonly confidence: ConfidenceLevel;
  /** The technologies found in this region, in detection order. */
  readonly technologies: readonly DetectedTechnology[];
}

/** Everything technology detection establishes about one repository. */
export interface TechnologyProfile {
  /** Every detection, across every region, sorted by region then id. */
  readonly technologies: readonly DetectedTechnology[];
  /** One entry per region the scanner found, in the same order. */
  readonly architecture: readonly RegionArchitecture[];
}
