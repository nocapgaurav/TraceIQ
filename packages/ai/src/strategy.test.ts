import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { focusOf, intentOf, scopeOf } from './intent.js';
import { deriveProfile, subsystemsOf, type RepositoryProfile } from './profile.js';
import { assemble, reminderFor, systemMessage, stablePrefixOf, SYSTEM_PROMPT } from './prompt.js';
import { project } from './projection.js';
import { questionGuidance, repositoryGuidance, strategyFor } from './strategy.js';
import { node, repositoryContext, symbolContext } from './fixtures.test-helper.js';

/**
 * Two repositories that could not be less alike, asked the same questions.
 *
 * The milestone's success criterion is that the *same question* produces a differently shaped answer on
 * a service and on a framework while both stay grounded. That is a property of the rendered prompt, so
 * the prompt is what these assert — not the model's prose, which no test can adjudicate.
 */

function shaped(overrides: {
  technologies?: readonly Record<string, unknown>[];
  routes?: readonly Record<string, unknown>[];
  packages?: readonly { name: string; declarations: number }[];
  files?: number;
  declarations?: number;
  /** Regions, so a fixture can state that nothing was analysed and no manifest was found. */
  regions?: readonly Record<string, unknown>[];
  layers?: Record<string, readonly string[]>;
}): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;
  const layers = overrides.layers ?? {};
  const listing = (entries: readonly unknown[]): Record<string, unknown> => ({
    entries,
    total: entries.length,
    truncated: false,
  });
  const role = (key: string): Record<string, unknown> =>
    listing((layers[key] ?? []).map((name) => node(`sym:src/${name}.ts#${name}`, { name })));

  return {
    ...base,
    technologies: overrides.technologies ?? [],
    routes: (overrides.routes ?? []) as never,
    ...(overrides.regions === undefined
      ? {}
      : { capabilities: { ...base.capabilities, regions: overrides.regions } }),
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          repository: {
            files: overrides.files ?? 150,
            declarations: overrides.declarations ?? 900,
            routes: (overrides.routes ?? []).length,
          },
          packages: listing(
            (overrides.packages ?? []).map((entry) => ({
              name: entry.name,
              files: 5,
              declarations: entry.declarations,
              dependencies: 1,
              dependents: 1,
            })),
          ),
        },
        architecture: {
          controllers: role('Controller'),
          services: role('Service'),
          repositories: role('Repository'),
          middleware: role('Middleware'),
          models: listing([]),
          tests: listing([]),
          routes: listing(overrides.routes ?? []),
        },
      },
    },
  } as unknown as RepositoryContext;
}

const technology = (id: string, name: string, category: string, region = ''): Record<string, unknown> => ({
  id,
  name,
  category,
  regionPath: region,
  confidence: 'CERTAIN',
  evidence: `${region || '.'} declares ${name}`,
});

const route = (method: string, path: string): Record<string, unknown> => ({
  node: node(`route:${method}:${path}`),
  method,
  composition: { effectivePath: path, composed: true, note: '' },
});

/** A URL shortener: routes, layers, a cache and a database. */
const service = (): RepositoryContext =>
  shaped({
    technologies: [
      technology('express', 'Express', 'backend'),
      technology('prisma', 'Prisma', 'data'),
      technology('redis', 'Redis', 'data'),
    ],
    routes: [route('GET', '/:shortCode'), route('POST', '/login')],
    layers: {
      Controller: ['urlController', 'authController'],
      Service: ['urlService', 'authService'],
      Repository: ['PrismaUrlRepository'],
    },
  });

/** A large package-organised frontend framework with extension points and no routes. */
const framework = (): RepositoryContext =>
  shaped({
    technologies: [technology('react', 'React', 'frontend')],
    packages: [
      { name: 'packages/react-reconciler', declarations: 4200 },
      { name: 'packages/react-dom', declarations: 3900 },
      { name: 'packages/scheduler', declarations: 400 },
      { name: 'packages/react-refresh-plugin', declarations: 300 },
      { name: 'packages/eslint-plugin-react-hooks', declarations: 500 },
      { name: 'packages/babel-plugin-react-compiler', declarations: 700 },
      { name: 'packages/react-devtools-extension', declarations: 900 },
      { name: 'packages/shared', declarations: 600 },
    ],
    files: 3400,
  });

function strategyOf(context: RepositoryContext, question: string): ReturnType<typeof strategyFor> {
  const profile = deriveProfile(context);
  const input = { question, kind: context.kind, subsystems: subsystemsOf(profile) };

  return strategyFor({
    profile,
    scope: scopeOf(input),
    intent: intentOf(question),
    focus: focusOf(input),
  });
}

describe('the same question is answered differently by different repositories', () => {
  const question = 'Explain the architecture.';

  it('tells a service to trace a request and a framework not to', () => {
    const forService = repositoryGuidance(deriveProfile(service()));
    const forFramework = repositoryGuidance(deriveProfile(framework()));

    expect(forService).toContain('how a request moves from the route to persistence');
    expect(forFramework).toContain('extension points');
    // The instruction that used to be given to every repository, and is wrong for this one.
    expect(forFramework).toContain('Do not: describe a request flow');
    expect(forService).not.toContain('extension points');
  });

  it('gives them different depths, because one fits an answer and the other does not', () => {
    expect(strategyOf(service(), question).depth).toBe('complete');
    expect(strategyOf(framework(), question).depth).toBe('boundaries');
  });

  it('offers a drill-down only where the answer cannot be complete', () => {
    expect(strategyOf(service(), question).closing).toBeNull();
    expect(strategyOf(framework(), question).closing).toContain('most worth asking about next');
  });

  it('renders visibly different prompts for the identical question', () => {
    const both = [service(), framework()].map((context) =>
      systemMessage(project(context, { tier: 'standard' })),
    );

    expect(both[0]).not.toBe(both[1]);
    // And both still carry the whole of the fixed instruction, which nothing may compose away.
    for (const message of both) {
      expect(message?.startsWith(SYSTEM_PROMPT)).toBe(true);
    }
  });
});

describe('the question decides how far the answer reaches', () => {
  it('narrows to a technology the repository actually has', () => {
    const strategy = strategyOf(service(), 'Explain Redis.');

    expect(strategy.depth).toBe('focused');
    expect(strategy.focus).toBe('redis');
    expect(strategy.cover.join(' ')).toContain('what redis is responsible for');
  });

  it('stays repository-wide when the question names something the repository does not have', () => {
    // The same words against a repository with no Redis. Narrowing here would aim the whole answer at
    // a subsystem the facts cannot support.
    const strategy = strategyOf(framework(), 'Explain Redis.');

    expect(strategy.depth).toBe('boundaries');
    expect(strategy.focus).toBeNull();
  });

  it('narrows a large repository too, so scale never overrides an explicit subject', () => {
    // The conflict this precedence exists for: the boundaries instruction would have answered "explain
    // the reconciler" with an architecture overview that never reached the reconciler.
    const strategy = strategyOf(framework(), 'Explain the reconciler.');

    expect(strategy.depth).toBe('focused');
    expect(strategy.focus).toBe('reconciler');
  });

  it('prefers the more specific of two subsystems the question names', () => {
    const strategy = strategyOf(service(), 'Explain the Redis cache.');

    // Both `redis` and `caching` are present; the reader asked about the specific one.
    expect(strategy.focus).toBe('redis');
  });

  it('treats an already-resolved subject as its own scope, whatever the question says', () => {
    expect(scopeOf({ question: 'what is this', kind: 'symbol' })).toBe('entity');
    expect(scopeOf({ question: 'explain the whole architecture', kind: 'file' })).toBe('entity');
  });

  it('never narrows a question asked in the vocabulary of asking', () => {
    // The words a question is *shaped* with can never be what it is *about*. A real code directory
    // named `architecture` would otherwise hijack the most repository-wide question there is.
    for (const word of ['architecture', 'design', 'overview', 'modules', 'components']) {
      expect(
        focusOf({ question: `Explain the ${word}.`, kind: 'repository', subsystems: [word] }),
        word,
      ).toBeNull();
    }
  });

  it('does not match a subsystem inside a longer word', () => {
    expect(focusOf({ question: 'how does curl work', kind: 'repository', subsystems: ['url'] })).toBeNull();
    expect(focusOf({ question: 'explain the url service', kind: 'repository', subsystems: ['url'] })).toBe('url');
  });
});

describe('the guidance is placed where it does not cost prefix reuse', () => {
  const context = service();
  const projection = project(context, { tier: 'standard' });

  it('keeps the system message identical between two different questions', () => {
    // The system message is the front of the prompt prefix a provider caches. Anything question-shaped
    // here would re-evaluate thousands of tokens on every turn.
    const first = systemMessage(project(context, { tier: 'standard', intent: 'architecture' }));
    const second = systemMessage(project(context, { tier: 'standard', intent: 'caching' }));

    expect(first).toBe(second);
  });

  it('keeps the fact prefix identical too, so the profile did not break what it was built on', () => {
    const first = stablePrefixOf(project(context, { tier: 'standard', intent: 'architecture' }));
    const second = stablePrefixOf(project(context, { tier: 'standard', intent: 'caching' }));

    expect(first).toBe(second);
  });

  it('puts everything the question steered after the question', () => {
    const strategy = strategyOf(context, 'Explain Redis.');
    const messages = assemble({ question: 'Explain Redis.', projection, model: MODEL, strategy });
    const user = messages.at(-1)?.content ?? '';

    expect(user.indexOf('redis')).toBeGreaterThan(user.indexOf('Question:'));
    expect(systemMessage(projection)).not.toContain('This question is about one part');
  });

  it('says which instruction wins when the two disagree', () => {
    // A focused question inside a large repository has to defeat an instruction to start from the
    // subsystem boundaries. A model given both without a precedence rule averages them.
    const guidance = questionGuidance(strategyOf(framework(), 'Explain the reconciler.'));

    expect(guidance).toContain('overrides the repository-wide instruction above');
  });

  it('falls back to the fixed reminder where no strategy was derived', () => {
    expect(reminderFor(undefined)).not.toContain('overrides');
  });
});

describe('the guidance never asserts more than the profile proved', () => {
  it('refuses to name a type when the evidence settled none', () => {
    // No manifest, no declarations, no technologies, no routes: every rule's evidence is absent.
    const bare = shaped({
      declarations: 0,
      files: 6,
      regions: [
        {
          path: '',
          primaryLanguage: null,
          languages: [],
          ecosystems: [],
          fileCount: 6,
          sourceFileCount: 0,
          depth: 'universal',
          reason: 'no analyser ran',
        },
      ],
    });
    const profile: RepositoryProfile = deriveProfile(bare);

    expect(profile.type.value).toBe('unknown');
    expect(repositoryGuidance(profile)).toContain('could not be established');
    expect(repositoryGuidance(profile)).toContain('Do not assert one');
  });

  it('carries the evidence for the type it does name', () => {
    const guidance = repositoryGuidance(deriveProfile(service()));

    expect(guidance).toContain('It is a service');
    expect(guidance).toContain('2 routes');
    expect(guidance).toContain('Express');
  });

  it('names only technologies the detection carried', () => {
    const guidance = repositoryGuidance(deriveProfile(service()));

    expect(guidance).not.toContain('PostgreSQL');
    expect(guidance).not.toContain('Kafka');
  });

  it('shapes a symbol question without a repository overview to reason from', () => {
    // A symbol context carries no overview, so the profile degrades to what is always available. It
    // must still produce a usable strategy rather than throw or claim a type.
    const strategy = strategyOf(symbolContext(), 'what does this do');

    expect(strategy.depth).toBe('focused');
    expect(strategy.cover.length).toBeGreaterThan(0);
  });
});

const MODEL = {
  id: 'test',
  contextWindow: 16_384,
  maxOutputTokens: null,
  capabilities: new Set(['system-prompt'] as const),
};
