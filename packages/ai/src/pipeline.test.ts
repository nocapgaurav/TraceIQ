import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RepositoryContextBuilder } from '@traceiq/context';
import { SymbolExplainer } from '@traceiq/explain';
import { CachingGraph, RepositoryExplorer } from '@traceiq/explorer';
import { RepositoryHealthAnalyzer } from '@traceiq/health';
import { ImpactAnalyzer } from '@traceiq/impact';
import { RepositoryPipeline, type RepositorySession } from '@traceiq/pipeline';
import { QueryEngine } from '@traceiq/query';
import type { NodeId } from '@traceiq/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RepositoryAnswerer } from './answer.js';
import { TIER_TOKENS } from './budget.js';
import { project } from './projection.js';
import { collect } from './stream.js';
import { ScriptedModel } from './testing.js';

/**
 * The answerer over a real repository, composed from real capabilities.
 *
 * The unit suites run against fabricated contexts and prove the package reaches nothing. This one scans a
 * real project, wires the five real capabilities behind a real `RepositoryContextBuilder`, and answers —
 * so a passing unit test cannot be an artefact of the fakes.
 *
 * The **model** is still scripted. What is being tested is the pipeline: that a real context projects, fits
 * a budget, renders a reproducible prompt and grounds a citation. Whether a given model writes a good
 * answer is model evaluation, needs labelled data, and is not something a test suite can assert.
 *
 * `@traceiq/pipeline` and everything under it are **dev** dependencies: they appear here to build a fixture,
 * and nothing in `src/` outside a test imports them.
 */
const FILES = {
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { UserService } from '../../core/src/service';
const router = Router();
const service = new UserService();
router.get('/users/:id', requireAuth, getUser);
export function requireAuth(): void {}
export function getUser(): string | undefined { return service.find('1'); }
export default router;
`,
  'packages/core/src/service.ts': `import { helper } from './cycle.a';
export class UserService {
  find(id: string): string | undefined {
    helper();
    return process.env.JWT_SECRET;
  }
}
export function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }
`,
  'packages/core/src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'packages/core/src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
};

const FIND = 'sym:packages/core/src/service.ts#UserService.find' as NodeId;
const HELPER = 'sym:packages/core/src/cycle.a.ts#helper' as NodeId;

let root: string;
let session: RepositorySession;
let builder: RepositoryContextBuilder;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-ai-'));

  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: false,
        skipLibCheck: true,
      },
    }),
    ...FILES,
  };

  for (const [relativePath, contents] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents, 'utf8');
  }

  const pipeline = new RepositoryPipeline();
  const databasePath = path.join(root, 'graph.db');

  await pipeline.scan({ repositoryPath: root, databasePath, createdAt: '1970-01-01T00:00:00.000Z' });

  session = pipeline.open(databasePath);

  const graph = new CachingGraph(session.api);
  const queries = new QueryEngine(graph);

  builder = new RepositoryContextBuilder({
    explorer: new RepositoryExplorer(graph),
    explain: new SymbolExplainer(queries),
    impact: new ImpactAnalyzer(queries),
    health: new RepositoryHealthAnalyzer(graph),
    queries,
  });
}, 60_000);

afterAll(async () => {
  session.close();
  await rm(root, { recursive: true, force: true });
});

describe('projecting a real context', () => {
  it('reduces a real symbol context to a budget', () => {
    const context = builder.build({ kind: 'symbol', id: FIND });
    const projection = project(context, { tier: 'standard' });

    const contextBytes = JSON.stringify(context).length;

    expect(projection.tokens).toBeLessThanOrEqual(TIER_TOKENS.standard);
    // The reduction is the whole point: a real context is orders of magnitude larger than a prompt.
    expect(projection.tokens * 3.6).toBeLessThan(contextBytes);
    expect(projection.facts.length).toBeGreaterThan(5);
  });

  it('names the real declaration and its real file', () => {
    const projection = project(builder.build({ kind: 'symbol', id: FIND }), { tier: 'full' });

    expect(projection.subject).toBe(FIND);
    expect(projection.facts.some((fact) => fact.object === 'packages/core/src/service.ts')).toBe(true);
    expect(projection.facts.some((fact) => fact.predicate === 'is-a' && fact.object === 'Method')).toBe(true);
  });

  it('carries the environment variable the declaration really reads', () => {
    const projection = project(builder.build({ kind: 'symbol', id: FIND }), { tier: 'full' });

    expect(projection.facts.some((fact) => fact.predicate === 'reads-env' && fact.object === 'JWT_SECRET')).toBe(true);
  });

  it('reports a real cycle as a condition of the subject', () => {
    const projection = project(builder.build({ kind: 'symbol', id: HELPER }), { tier: 'full' });

    expect(projection.facts.some((fact) => fact.predicate === 'in-cycle')).toBe(true);
  });

  it('names every limitation code the capabilities reported, in one fact', () => {
    /*
     * The invariant is that no caveat is silently dropped — not that each gets a line of its own.
     *
     * Seventeen limitation facts cost 1,081 tokens on React, a fifth of the whole prompt, and the
     * prose in them was being restated back as though it described the repository. The codes are kept
     * because they are what qualifies an answer; the fixed sentences around them are not.
     */
    const context = builder.build({ kind: 'symbol', id: FIND });
    const projection = project(context, { tier: 'full' });
    const limitations = projection.facts.filter((fact) => fact.predicate === 'limitation');

    expect(limitations).toHaveLength(1);

    for (const code of new Set(context.limitations.map((limitation) => limitation.code))) {
      expect(limitations[0]?.object, code).toContain(code);
    }
  });

  it('projects every context kind the builder supports', () => {
    for (const request of [
      { kind: 'symbol', id: FIND },
      { kind: 'impact', id: HELPER },
      { kind: 'file', path: 'packages/core/src/service.ts' },
      { kind: 'package', name: 'packages/core' },
      { kind: 'route', method: 'GET', path: '/users/:id' },
      { kind: 'repository' },
      { kind: 'search', query: { text: 'helper' } },
    ] as const) {
      const projection = project(builder.build(request), { tier: 'standard' });

      expect(projection.facts.length, request.kind).toBeGreaterThan(0);
      expect(projection.tokens, request.kind).toBeLessThanOrEqual(TIER_TOKENS.standard);
    }
  }, 60_000);

  it('reduces the largest real context — impact — by orders of magnitude', () => {
    const context = builder.build({ kind: 'impact', id: HELPER });
    const projection = project(context, { tier: 'standard' });

    expect(JSON.stringify(context).length).toBeGreaterThan(projection.tokens * 3.6 * 10);
  });

  it('is deterministic over a real graph', () => {
    const context = builder.build({ kind: 'symbol', id: FIND });

    expect(project(context, { tier: 'standard' })).toEqual(project(context, { tier: 'standard' }));
    expect(project(context, { tier: 'standard' }).digest).toBe(project(context, { tier: 'standard' }).digest);
  });

  it('never invents an identifier a real context did not hold', () => {
    const context = builder.build({ kind: 'impact', id: HELPER });
    const projection = project(context, { tier: 'full' });
    const serialised = JSON.stringify(context);

    for (const identifier of projection.identifiers) {
      expect(serialised, identifier).toContain(identifier);
    }
  });

  it('leaks no database path, connection or storage word into a projection', () => {
    const projection = project(builder.build({ kind: 'repository' }), { tier: 'full' });
    const serialised = JSON.stringify({ ...projection, identifiers: [...projection.identifiers] });

    expect(serialised).not.toContain('.db');
    expect(serialised).not.toContain(root);
    expect(serialised.toLowerCase()).not.toContain('sqlite');
  });
});

describe('answering over a real repository', () => {
  it('grounds a citation in a real fact', async () => {
    const answerer = new RepositoryAnswerer(
      builder,
      new ScriptedModel({ text: 'It reads JWT_SECRET [f1] and takes part in a cycle.' }),
    );

    const answer = await collect(answerer.answer({ question: 'What does it read?', subject: { kind: 'symbol', id: FIND } }));

    expect(answer.verdict).toBe('grounded');
    expect(answer.citations[0]?.fact.subject).toBe(FIND);
    expect(answer.citations[0]?.fact.provenance).toMatch(/^@traceiq\//);
  });

  it('rejects an answer that invents an identifier a real graph does not hold', async () => {
    const answerer = new RepositoryAnswerer(
      builder,
      new ScriptedModel({ text: 'It calls sym:packages/core/src/nowhere.ts#absent [f1].' }),
    );

    const answer = await collect(answerer.answer({ question: 'q', subject: { kind: 'symbol', id: FIND } }));

    // The invention is diagnosed and the sentence that carried it is not returned. See `finalise`.
    expect(answer.status).toBe('limited-evidence');
    expect(answer.text).not.toContain('sym:packages/core/src/nowhere.ts#absent');
    expect(
      answer.diagnostics.some((entry) => entry.subject === 'sym:packages/core/src/nowhere.ts#absent'),
    ).toBe(true);
  });

  it('raises subject-not-found for a declaration the real graph does not hold', async () => {
    const answerer = new RepositoryAnswerer(builder, new ScriptedModel());

    const failing = async (): Promise<void> => {
      for await (const _ of answerer.answer({
        question: 'q',
        subject: { kind: 'symbol', id: 'sym:nowhere.ts#Absent' as NodeId },
      })) {
        // No event should arrive.
      }
    };

    await expect(failing()).rejects.toMatchObject({ code: 'subject-not-found' });
  });

  it('builds the identical prompt from the identical real context', async () => {
    const prompt = async (): Promise<string> => {
      const model = new ScriptedModel({ text: 'ok' });

      await collect(
        new RepositoryAnswerer(builder, model).answer({
          question: 'What calls this?',
          subject: { kind: 'symbol', id: FIND },
        }),
      );

      return model.lastPrompt();
    };

    expect(await prompt()).toBe(await prompt());
  });

  it('shows the model no source code, because the API serves none', async () => {
    const model = new ScriptedModel({ text: 'ok' });

    await collect(
      new RepositoryAnswerer(builder, model).answer({
        question: 'q',
        subject: { kind: 'symbol', id: FIND },
      }),
    );

    // Facts are identifiers, predicates and counts. No file contents exist anywhere below this layer.
    expect(model.lastPrompt()).not.toContain('return process.env.JWT_SECRET');
    expect(model.lastPrompt()).not.toContain('export class UserService');
  });

  it('asks the context builder exactly once per answer', async () => {
    const calls: string[] = [];
    const counting = {
      build: (request: Parameters<typeof builder.build>[0]) => {
        calls.push(request.kind);

        return builder.build(request);
      },
    };

    await collect(
      new RepositoryAnswerer(counting, new ScriptedModel({ text: 'ok' })).answer({
        question: 'q',
        subject: { kind: 'symbol', id: FIND },
      }),
    );

    expect(calls).toEqual(['symbol']);
  });
});
