import type { TechnologyCategory } from './types.js';

/**
 * A technology recognised from a dependency a manifest declares.
 *
 * **A declared dependency is the strongest signal available without parsing**, and it is a direct
 * reading rather than an inference: `"next": "^14"` in a package.json says this project depends on
 * Next.js, in the words of whoever built it. That is why these are `CERTAIN`.
 *
 * `packages` lists every distribution name that means the same technology. NestJS ships as a dozen
 * `@nestjs/*` packages and any of them proves it; matching on a prefix instead would also match
 * somebody's `@nestjs-contrib/thing`, which proves a community package rather than the framework.
 */
export interface DependencyRule {
  readonly id: string;
  readonly name: string;
  readonly category: TechnologyCategory;
  /** Exact distribution names, in the manifest's own ecosystem spelling. */
  readonly packages: readonly string[];
  /**
   * Name prefixes, for a technology distributed as a family of packages rather than as one.
   *
   * **Used where a prefix is the technology's own definition of itself, not as a fuzzy match.** A
   * Maven artifact beginning `spring-boot-starter-` *is* a Spring Boot starter — that is what the
   * name means, and Spring publishes dozens of them. spring-petclinic declares six, of which the
   * exact-name rule listed none, so a Spring repository was reported as having no framework while
   * the analysis had already recognised its Spring annotations. Two surfaces disagreeing about one
   * repository is worse than either answer alone.
   *
   * A prefix must still be specific enough that nothing else can begin with it. `spring-boot-` is;
   * `spring-` would not be, and `react-` certainly would not.
   */
  readonly prefixes?: readonly string[];
}

/**
 * A technology recognised from a file whose existence *is* the technology.
 *
 * `docker-compose.yml` is Docker Compose; a `.tf` file is Terraform; `nx.json` is Nx. There is
 * nothing to infer, which is why these are `CERTAIN` too — and why the match must be on the whole
 * file name or a whole extension rather than on a substring. A file called `my-terraform-notes.md`
 * is not Terraform.
 */
export interface FileRule {
  readonly id: string;
  readonly name: string;
  readonly category: TechnologyCategory;
  /** Matched against the file's base name, case-insensitively. */
  readonly fileNames?: readonly string[];
  /** Matched against the base name as a regular expression, anchored by the author. */
  readonly filePattern?: RegExp;
  /** Matched against the file's extension, without the dot. */
  readonly extensions?: readonly string[];
  /** What to say about a matching file. */
  readonly detail: string;
}

/**
 * Dependency-declared technologies.
 *
 * Ordered by category then name so the rule table reads as a catalogue. Adding a technology is
 * adding a row: no code changes, and the evidence and confidence rules apply to it automatically.
 */
export const DEPENDENCY_RULES: readonly DependencyRule[] = [
  // ---- frontend -------------------------------------------------------------------------------
  { id: 'react', name: 'React', category: 'frontend', packages: ['react', 'react-dom'] },
  { id: 'nextjs', name: 'Next.js', category: 'frontend', packages: ['next'] },
  { id: 'vue', name: 'Vue', category: 'frontend', packages: ['vue', '@vue/runtime-core'] },
  { id: 'nuxt', name: 'Nuxt', category: 'frontend', packages: ['nuxt'] },
  { id: 'svelte', name: 'Svelte', category: 'frontend', packages: ['svelte'] },
  { id: 'sveltekit', name: 'SvelteKit', category: 'frontend', packages: ['@sveltejs/kit'] },
  { id: 'angular', name: 'Angular', category: 'frontend', packages: ['@angular/core'] },
  { id: 'solid', name: 'SolidJS', category: 'frontend', packages: ['solid-js'] },
  { id: 'astro', name: 'Astro', category: 'frontend', packages: ['astro'] },

  // ---- backend --------------------------------------------------------------------------------
  { id: 'express', name: 'Express', category: 'backend', packages: ['express'] },
  {
    id: 'nestjs',
    name: 'NestJS',
    category: 'backend',
    packages: ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/platform-fastify'],
  },
  { id: 'fastify', name: 'Fastify', category: 'backend', packages: ['fastify'] },
  { id: 'hono', name: 'Hono', category: 'backend', packages: ['hono'] },
  { id: 'koa', name: 'Koa', category: 'backend', packages: ['koa'] },
  { id: 'hapi', name: 'hapi', category: 'backend', packages: ['@hapi/hapi'] },
  { id: 'trpc', name: 'tRPC', category: 'backend', packages: ['@trpc/server'] },
  { id: 'apollo-server', name: 'Apollo Server', category: 'backend', packages: ['@apollo/server'] },
  // Python, Java and Go backends, in their own ecosystems' spellings. The rule table is not
  // JavaScript-only — a Python region declaring `flask` is exactly as detectable.
  { id: 'flask', name: 'Flask', category: 'backend', packages: ['flask', 'Flask'] },
  { id: 'fastapi', name: 'FastAPI', category: 'backend', packages: ['fastapi'] },
  { id: 'django', name: 'Django', category: 'backend', packages: ['django', 'Django'] },
  {
    id: 'spring-boot',
    name: 'Spring Boot',
    category: 'backend',
    packages: ['spring-boot-starter-web', 'spring-boot-starter'],
    // Every starter, because a repository picks the ones it needs and none of them is guaranteed.
    prefixes: ['spring-boot-starter'],
  },
  { id: 'gin', name: 'Gin', category: 'backend', packages: ['github.com/gin-gonic/gin'] },
  { id: 'echo', name: 'Echo', category: 'backend', packages: ['github.com/labstack/echo/v4'] },
  { id: 'fiber', name: 'Fiber', category: 'backend', packages: ['github.com/gofiber/fiber/v2'] },

  // ---- build ----------------------------------------------------------------------------------
  { id: 'turborepo', name: 'Turborepo', category: 'build', packages: ['turbo'] },
  { id: 'nx', name: 'Nx', category: 'build', packages: ['nx', '@nx/workspace'] },
  { id: 'vite', name: 'Vite', category: 'build', packages: ['vite'] },
  { id: 'webpack', name: 'webpack', category: 'build', packages: ['webpack'] },
  { id: 'esbuild', name: 'esbuild', category: 'build', packages: ['esbuild'] },
  { id: 'rollup', name: 'Rollup', category: 'build', packages: ['rollup'] },

  // ---- testing --------------------------------------------------------------------------------
  { id: 'vitest', name: 'Vitest', category: 'testing', packages: ['vitest'] },
  { id: 'jest', name: 'Jest', category: 'testing', packages: ['jest'] },
  { id: 'playwright', name: 'Playwright', category: 'testing', packages: ['@playwright/test', 'playwright'] },
  { id: 'cypress', name: 'Cypress', category: 'testing', packages: ['cypress'] },
  { id: 'pytest', name: 'pytest', category: 'testing', packages: ['pytest'] },
  { id: 'junit', name: 'JUnit', category: 'testing', packages: ['junit-jupiter', 'junit-jupiter-api', 'junit'] },

  // ---- data -----------------------------------------------------------------------------------
  { id: 'prisma', name: 'Prisma', category: 'data', packages: ['prisma', '@prisma/client'] },
  { id: 'typeorm', name: 'TypeORM', category: 'data', packages: ['typeorm'] },
  { id: 'drizzle', name: 'Drizzle ORM', category: 'data', packages: ['drizzle-orm'] },
  { id: 'mongoose', name: 'Mongoose', category: 'data', packages: ['mongoose'] },
  { id: 'sqlalchemy', name: 'SQLAlchemy', category: 'data', packages: ['sqlalchemy', 'SQLAlchemy'] },
  { id: 'postgres', name: 'PostgreSQL', category: 'data', packages: ['pg', 'psycopg2', 'psycopg2-binary', 'postgres'] },
  { id: 'redis', name: 'Redis', category: 'data', packages: ['redis', 'ioredis'] },
  { id: 'sqlite', name: 'SQLite', category: 'data', packages: ['better-sqlite3', 'sqlite3'] },
];

/**
 * File-declared technologies.
 *
 * A Kubernetes manifest is deliberately **absent** from this table: `.yaml` is the extension of
 * every configuration file ever written, and claiming Kubernetes from it would be the guess this
 * whole layer exists to avoid. It needs the file's contents, and is handled separately.
 */
export const FILE_RULES: readonly FileRule[] = [
  {
    id: 'docker',
    name: 'Docker',
    category: 'infrastructure',
    fileNames: ['dockerfile', '.dockerignore'],
    // `Dockerfile.prod`, `api.Dockerfile` — both are Dockerfiles and both are common.
    filePattern: /^(?:.+\.dockerfile|dockerfile\..+)$/i,
    detail: 'a Dockerfile',
  },
  {
    id: 'docker-compose',
    name: 'Docker Compose',
    category: 'infrastructure',
    filePattern: /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i,
    detail: 'a Compose file',
  },
  {
    id: 'terraform',
    name: 'Terraform',
    category: 'infrastructure',
    extensions: ['tf', 'tfvars'],
    detail: 'a Terraform configuration',
  },
  {
    id: 'helm',
    name: 'Helm',
    category: 'infrastructure',
    fileNames: ['chart.yaml', 'chart.yml'],
    detail: 'a Helm chart',
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions',
    category: 'infrastructure',
    filePattern: /^[\w.-]+\.ya?ml$/i,
    detail: 'a workflow definition',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    category: 'frontend',
    filePattern: /^next\.config\.(?:m?[jt]s|mjs|cjs)$/i,
    detail: 'a Next.js configuration file',
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    category: 'frontend',
    filePattern: /^nuxt\.config\.(?:m?[jt]s|mjs|cjs)$/i,
    detail: 'a Nuxt configuration file',
  },
  {
    id: 'svelte',
    name: 'Svelte',
    category: 'frontend',
    extensions: ['svelte'],
    detail: 'a Svelte component',
  },
  {
    id: 'vue',
    name: 'Vue',
    category: 'frontend',
    extensions: ['vue'],
    detail: 'a Vue single-file component',
  },
  {
    id: 'angular',
    name: 'Angular',
    category: 'frontend',
    fileNames: ['angular.json'],
    detail: 'an Angular workspace file',
  },
  {
    id: 'astro',
    name: 'Astro',
    category: 'frontend',
    extensions: ['astro'],
    detail: 'an Astro component',
  },
  {
    id: 'turborepo',
    name: 'Turborepo',
    category: 'build',
    fileNames: ['turbo.json'],
    detail: 'a Turborepo pipeline file',
  },
  { id: 'nx', name: 'Nx', category: 'build', fileNames: ['nx.json'], detail: 'an Nx workspace file' },
  {
    id: 'vite',
    name: 'Vite',
    category: 'build',
    filePattern: /^vite\.config\.(?:m?[jt]s|mjs|cjs)$/i,
    detail: 'a Vite configuration file',
  },
  {
    id: 'prisma',
    name: 'Prisma',
    category: 'data',
    extensions: ['prisma'],
    detail: 'a Prisma schema',
  },
];

/**
 * A file rule that only applies inside a particular directory.
 *
 * `GitHub Actions` is the case that forces this: a workflow is an ordinary YAML file, and the only
 * thing distinguishing it from every other YAML file is that it lives in `.github/workflows`. The
 * constraint is part of the evidence rather than a heuristic layered over it.
 */
export const DIRECTORY_CONSTRAINED: Readonly<Record<string, string>> = {
  'github-actions': '.github/workflows/',
};

/** Package managers, recognised from the lockfile each one writes. */
export const LOCKFILE_RULES: Readonly<Record<string, { readonly id: string; readonly name: string }>> = {
  'package-lock.json': { id: 'npm', name: 'npm' },
  'pnpm-lock.yaml': { id: 'pnpm', name: 'pnpm' },
  'yarn.lock': { id: 'yarn', name: 'Yarn' },
  'bun.lockb': { id: 'bun', name: 'Bun' },
  'bun.lock': { id: 'bun', name: 'Bun' },
  'poetry.lock': { id: 'poetry', name: 'Poetry' },
  'uv.lock': { id: 'uv', name: 'uv' },
  'pipfile.lock': { id: 'pipenv', name: 'Pipenv' },
  'cargo.lock': { id: 'cargo', name: 'Cargo' },
  'gemfile.lock': { id: 'bundler', name: 'Bundler' },
  'composer.lock': { id: 'composer', name: 'Composer' },
  'go.sum': { id: 'go-modules', name: 'Go modules' },
};
