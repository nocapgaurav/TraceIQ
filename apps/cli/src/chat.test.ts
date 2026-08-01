import type { ContextRequest, RepositoryContext } from '@traceiq/context';
import { FakeContextSource, ScriptedModel } from '@traceiq/ai/testing';
import { AiError } from '@traceiq/ai';
import { describe, expect, it } from 'vitest';

import {
  CHAT_BANNER,
  describeSubject,
  paint,
  parseSubjectArgument,
  renderChatError,
  renderCitations,
  renderGrounding,
  renderVerdict,
  runChat,
} from './chat.js';
import { DEFAULT_DATABASE, parseCommandLine } from './cli.js';
import { CliError, EXIT_STATUS } from './errors.js';
import { PROVIDER_NAMES, isProviderName, providerFor } from './providers.js';
import type { Io } from './types.js';

/**
 * `traceiq chat`, driven as a function.
 *
 * No terminal, no signals, no provider and no model weights: lines are injected, the model is scripted and
 * the context is fabricated. That is the point — the REPL is a function of its inputs, and what is tested is
 * the loop, the commands, the rendering and the cancellation, not whether a model writes good prose.
 */
const defaults = { databasePath: DEFAULT_DATABASE, profile: false, model: null, provider: 'ollama', subject: null };

function recorder(): Io & { readonly out: string[]; readonly errors: string[]; text(): string } {
  const out: string[] = [];
  const errors: string[] = [];

  return {
    out,
    errors,
    write: (text) => {
      out.push(text);
    },
    writeError: (text) => {
      errors.push(text);
    },
    cwd: '/tmp',
    text: () => out.join(''),
  };
}

async function* linesOf(...lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

/** A context shaped like the builder's, small enough that each test states its own case. */
function context(): RepositoryContext {
  return {
    kind: 'repository',
    primary: {
      type: 'repository',
      value: {
        overview: {
          repository: { files: 12, declarations: 40, routes: 1 },
          graph: { nodes: 60, edges: 200, unresolvedReferences: 3 },
          packages: {
            entries: [{ name: 'src', files: 12, declarations: 40, dependencies: 0, dependents: 0 }],
            total: 1,
            truncated: false,
          },
        },
        architecture: {
          controllers: { entries: [], total: 0, truncated: false },
          services: { entries: [], total: 0, truncated: false },
          repositories: { entries: [], total: 0, truncated: false },
          middleware: { entries: [], total: 0, truncated: false },
          models: { entries: [], total: 0, truncated: false },
          tests: { entries: [], total: 0, truncated: false },
        },
        hotspots: {
          mostReferenced: { entries: [], total: 0, truncated: false },
          mostConnectedFiles: { entries: [], total: 0, truncated: false },
        },
      },
    },
    // Present on every context, and projected for every kind — including this one. Until the technology
    // extractor was split out, the repository kind returned from `identity` before reaching them, so
    // "what technologies are used" was unanswerable about a repository and answerable about a symbol.
    technologies: [
      {
        id: 'tech:typescript',
        name: 'TypeScript',
        category: 'build',
        regionPath: '',
        confidence: 'CERTAIN',
        evidence: 'tsconfig.json is present',
      },
    ],
    related: [],
    references: { incomingCalls: [], outgoingCalls: [], references: [], typeReferences: [] },
    dependencies: { view: null, externalPackages: [], environmentVariables: [], cycles: null },
    impact: { analysis: null, summary: null },
    routes: [],
    health: { report: null, subject: null },
    limitations: [{ code: 'capped-lists', detail: 'lists are capped', affected: 7 }],
    provenance: { producer: 'context', parts: [], subject: null },
    // Carried on every context now, so the model can be told what the repository is made of and how
    // deeply each part was read.
    capabilities: {
      depth: 'semantic',
      isPolyglot: false,
      languages: [{ language: 'typescript', files: 12 }],
      regions: [
        {
          path: '',
          primaryLanguage: 'typescript',
          languages: [{ language: 'typescript', files: 12 }],
          ecosystems: ['npm'],
          fileCount: 12,
          sourceFileCount: 12,
          depth: 'semantic',
          reason: 'the TypeScript compiler read these sources',
        },
      ],
    },
    statistics: { capabilityCalls: {}, totalCapabilityCalls: 0, relatedNodes: 0, explainedNodes: 0, referenceEdges: 0 },
  } as unknown as RepositoryContext;
}

const REPOSITORY: ContextRequest = { kind: 'repository' };

describe('command line', () => {
  it('reads --model in both forms', () => {
    expect(parseCommandLine(['chat', '--model', 'a:1b'], defaults).options.model).toBe('a:1b');
    expect(parseCommandLine(['chat', '--model=b:1b'], defaults).options.model).toBe('b:1b');
  });

  it('reads --provider and --subject', () => {
    const parsed = parseCommandLine(['chat', '--provider', 'ollama', '--subject', 'sym:a.ts#B'], defaults);

    expect(parsed.options.provider).toBe('ollama');
    expect(parsed.options.subject).toBe('sym:a.ts#B');
  });

  it('defaults the provider and leaves the model unset, since no default model is assumed', () => {
    const parsed = parseCommandLine(['chat'], defaults);

    expect(parsed.options.provider).toBe('ollama');
    expect(parsed.options.model).toBeNull();
  });

  it('still rejects an unknown option', () => {
    expect(() => parseCommandLine(['chat', '--temperature', '1'], defaults)).toThrow(CliError);
  });
});

describe('parseSubjectArgument', () => {
  it('defaults to the repository', () => {
    expect(parseSubjectArgument('')).toEqual({ kind: 'repository' });
    expect(parseSubjectArgument('repository')).toEqual({ kind: 'repository' });
  });

  it('reads each prefixed form', () => {
    expect(parseSubjectArgument('sym:a.ts#B')).toEqual({ kind: 'symbol', id: 'sym:a.ts#B' });
    expect(parseSubjectArgument('impact:sym:a.ts#B')).toEqual({ kind: 'impact', id: 'sym:a.ts#B' });
    expect(parseSubjectArgument('file:src/a.ts')).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(parseSubjectArgument('pkg:packages/core')).toEqual({ kind: 'package', name: 'packages/core' });
    expect(parseSubjectArgument('route:GET:/users/:id')).toEqual({ kind: 'route', method: 'GET', path: '/users/:id' });
  });

  it('refuses a bare word rather than guessing, because guessing would be repository search', () => {
    // Resolving free text to a subject is the Explorer's job. Doing it here would put repository
    // intelligence in the AI path, which the architecture forbids.
    expect(() => parseSubjectArgument('UserService')).toThrow(CliError);
    expect(() => parseSubjectArgument('UserService')).toThrow(/not a subject/);
  });

  it('points at search when it refuses', () => {
    try {
      parseSubjectArgument('UserService');
      expect.unreachable();
    } catch (error) {
      expect((error as CliError).hint).toContain('traceiq search');
    }
  });
});

describe('describeSubject', () => {
  it('names every kind in one line', () => {
    expect(describeSubject({ kind: 'repository' })).toBe('the repository as a whole');
    expect(describeSubject({ kind: 'symbol', id: 'sym:a.ts#B' as never })).toContain('sym:a.ts#B');
    expect(describeSubject({ kind: 'route', method: 'GET', path: '/x' })).toBe('route GET /x');
    expect(describeSubject({ kind: 'search', query: { text: 'q' } })).toBe('search q');
  });
});

describe('rendering', () => {
  it('colours only when asked, so a pipe stays plain and diffable', () => {
    expect(paint('x', 'red', false)).toBe('x');
    expect(paint('x', 'red', true)).not.toBe('x');
    expect(paint('x', 'red', true)).toContain('x');
  });

  it('colours a verdict by its meaning and never hides it', () => {
    expect(renderVerdict('grounded', false)).toBe('grounded');
    expect(renderVerdict('ungrounded', false)).toBe('ungrounded');
    expect(renderVerdict('unverifiable', false)).toBe('unverifiable');
    expect(renderVerdict('grounded', true)).not.toBe(renderVerdict('ungrounded', true));
  });

  it('reports every omission, so a cap is never silent in the terminal either', () => {
    const rendered = renderGrounding(
      {
        kind: 'symbol',
        factCount: 12,
        tier: 'standard',
        tokens: 900,
        digest: 'abc',
        omissions: [{ part: 'incomingCalls', kept: 40, total: 927 }],
      },
      false,
    );

    expect(rendered).toContain('12 facts');
    expect(rendered).toContain('incomingCalls: showing 40 of 927');
  });

  it('shows each citation with the fact and the capability that established it', () => {
    const rendered = renderCitations(
      [
        {
          factId: 'f1',
          fact: { subject: 'sym:a.ts#B', predicate: 'calls', object: 'sym:c.ts#D', provenance: '@traceiq/call-graph' },
        },
      ],
      false,
    );

    expect(rendered).toContain('[f1]');
    expect(rendered).toContain('sym:a.ts#B calls sym:c.ts#D');
    expect(rendered).toContain('@traceiq/call-graph');
  });

  it('renders an AI error with its own code, unreworded', () => {
    const rendered = renderChatError(new AiError('provider-unavailable', 'nothing is listening at :11434'), false);

    expect(rendered).toContain('provider-unavailable');
    expect(rendered).toContain('nothing is listening at :11434');
    expect(rendered).toContain('start the model provider');
  });
});

describe('the REPL', () => {
  it('greets, names the model and the subject, then says bye', async () => {
    const io = recorder();
    const status = await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'ok [f1]', id: 'test:1b' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('/exit'),
    });

    expect(status).toBe(0);
    expect(io.text()).toContain(CHAT_BANNER);
    expect(io.text()).toContain('model test:1b');
    expect(io.text()).toContain('the repository as a whole');
    expect(io.text()).toContain('bye');
  });

  it('answers, streaming the deltas as they arrive', async () => {
    const io = recorder();

    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ chunks: ['It has ', '12 files ', '[f2].'] }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('How many files?', '/exit'),
    });

    // Each delta is written on its own, not buffered into one string at the end.
    expect(io.out).toContain('It has ');
    expect(io.out).toContain('12 files ');
    expect(io.text()).toContain('It has 12 files [f2].');
  });

  it('prints the grounding before the answer', async () => {
    const io = recorder();

    // A distinctive marker: the banner itself contains the word "answers", so a looser needle would match
    // the greeting and the assertion would pass for the wrong reason.
    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'ZZMARKER [f1]' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('q', '/exit'),
    });

    const text = io.text();

    // Evidence precedes claim: a reader sees what the answer may be based on before reading it.
    expect(text.indexOf('facts ·')).toBeLessThan(text.indexOf('ZZMARKER'));
  });

  it('prints the verdict, the model, the stop reason and the usage', async () => {
    const io = recorder();

    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'It has 12 files [f2].', id: 'test:1b', stopReason: 'complete' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('q', '/exit'),
    });

    expect(io.text()).toContain('verdict grounded');
    expect(io.text()).toContain('test:1b');
    expect(io.text()).toContain('complete');
    expect(io.text()).toMatch(/\d+ prompt \/ \d+ output tokens/);
  });

  it('names a fabricated identifier rather than presenting the answer as sound', async () => {
    const io = recorder();

    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'It calls sym:invented.ts#Nope [f1].' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('q', '/exit'),
    });

    expect(io.text()).toContain('verdict ungrounded');
    expect(io.text()).toContain('sym:invented.ts#Nope');
    expect(io.text()).toContain('invented, and not in the graph');
  });

  it('says so when an answer cited nothing', async () => {
    const io = recorder();

    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'It is quite large.' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('q', '/exit'),
    });

    expect(io.text()).toContain('verdict unverifiable');
    expect(io.text()).toContain('no facts were cited');
  });

  it('answers several questions in one session, and does not hang after the first', async () => {
    // The regression this guards: the interrupt watcher used to await an iterable that never ended, so the
    // loop produced one answer, printed its footer and then blocked forever without reading the next line.
    const io = recorder();
    const model = new ScriptedModel({ text: 'ok [f1]' });

    const status = await runChat(new FakeContextSource(context()), io, {
      model,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('first?', 'second?', 'third?', '/exit'),
      onInterrupt: () => () => undefined,
    });

    expect(status).toBe(0);
    expect(model.requests).toHaveLength(3);
    expect(io.text()).toContain('bye');
  });

  it('replays prior turns as conversation, and never the facts that grounded them', async () => {
    const io = recorder();
    const model = new ScriptedModel({ text: 'ok [f1]' });

    await runChat(new FakeContextSource(context()), io, {
      model,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('first question', 'second question', '/exit'),
    });

    const second = model.requests[1];
    const text = (second?.messages ?? []).map((message) => message.content).join('\n');

    expect(text).toContain('first question');
    expect(text).toContain('ok [f1]');
    // A prior turn contributes its words, not its evidence: a fact from turn one must not still be
    // grounding turn two after the repository has changed underneath it.
    expect((second?.messages ?? []).filter((message) => message.role === 'user')).toHaveLength(2);
  });

  it('forgets the conversation on /clear', async () => {
    const io = recorder();
    const model = new ScriptedModel({ text: 'ok [f1]' });

    await runChat(new FakeContextSource(context()), io, {
      model,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('first', '/clear', 'second', '/exit'),
    });

    expect(io.text()).toContain('conversation cleared');
    expect(model.requests[1]?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('reports the subject on /subject and changes it on /subject <what>', async () => {
    const io = recorder();

    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'ok' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('/subject', '/subject file:src/a.ts', '/subject', '/exit'),
    });

    expect(io.text()).toContain('the repository as a whole');
    expect(io.text()).toContain('subject is now file src/a.ts');
  });

  it('refuses a bad /subject without ending the session', async () => {
    const io = recorder();

    const status = await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'ok [f1]' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('/subject nonsense', 'q', '/exit'),
    });

    expect(status).toBe(0);
    expect(io.errors.join('')).toContain('not a subject');
    expect(io.text()).toContain('bye');
  });

  it('drops the conversation when the subject changes, since prior answers were about something else', async () => {
    const io = recorder();
    const model = new ScriptedModel({ text: 'ok [f1]' });

    await runChat(new FakeContextSource(context()), io, {
      model,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('first', '/subject file:src/a.ts', 'second', '/exit'),
    });

    expect(model.requests[1]?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('ignores a blank line', async () => {
    const io = recorder();
    const model = new ScriptedModel({ text: 'ok' });

    await runChat(new FakeContextSource(context()), io, {
      model,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('', '   ', '/exit'),
    });

    expect(model.requests).toEqual([]);
  });

  it('leaves on /quit as well as /exit', async () => {
    const io = recorder();

    expect(
      await runChat(new FakeContextSource(context()), io, {
        model: new ScriptedModel({ text: 'ok' }),
        subject: REPOSITORY,
        colour: false,
        lines: linesOf('/quit'),
      }),
    ).toBe(0);
  });

  it('leaves cleanly when the input simply ends, as Ctrl+D does', async () => {
    const io = recorder();

    expect(
      await runChat(new FakeContextSource(context()), io, {
        model: new ScriptedModel({ text: 'ok' }),
        subject: REPOSITORY,
        colour: false,
        lines: linesOf(),
      }),
    ).toBe(0);
    expect(io.text()).toContain('bye');
  });
});

describe('cancellation', () => {
  it('cancels the answer in flight and keeps the session alive', async () => {
    const io = recorder();
    let fire: (() => void) | null = null;

    const model = new ScriptedModel({ chunks: ['a', 'b', 'c', 'd'] });

    const status = await runChat(new FakeContextSource(context()), io, {
      model,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('long question', 'short question', '/exit'),
      onInterrupt: (handler) => {
        fire = handler;
        // Cancel as soon as this answer subscribes, which is before its first delta.
        queueMicrotask(() => {
          handler();
        });

        return () => {
          fire = null;
        };
      },
    });

    expect(status).toBe(0);
    expect(io.text()).toContain('cancelled');
    // Cancelling one answer must not end the session: the second question was still asked.
    expect(model.requests).toHaveLength(2);
    expect(io.text()).toContain('bye');
    expect(fire).toBeNull();
  });

  it('unsubscribes after each answer, so a listener cannot accumulate', async () => {
    const io = recorder();
    let subscriptions = 0;
    let releases = 0;

    await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ text: 'ok [f1]' }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('one', 'two', 'three', '/exit'),
      onInterrupt: () => {
        subscriptions += 1;

        return () => {
          releases += 1;
        };
      },
    });

    expect(subscriptions).toBe(3);
    expect(releases).toBe(3);
  });

  it('does not treat a cancelled answer as a failure', async () => {
    const io = recorder();

    const status = await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ chunks: ['a', 'b'] }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('q'),
      onInterrupt: (handler) => {
        queueMicrotask(() => {
          handler();
        });

        return () => undefined;
      },
    });

    expect(status).toBe(0);
  });
});

describe('failures', () => {
  it('reports a generation failure with its code and stays in the session', async () => {
    const io = recorder();
    let attempt = 0;

    // Fails once, then succeeds — so the assertion is that one failure does not end the session, rather
    // than that a wholly failed session is somehow clean.
    const model = {
      describe: () => ({
        id: 'flaky',
        contextWindow: 32_768,
        maxOutputTokens: null,
        capabilities: new Set(['system-prompt'] as const),
      }),
      tokens: { count: (text: string) => Math.ceil(text.length / 3.6) },
      // eslint-disable-next-line @typescript-eslint/require-await
      async *generate() {
        attempt += 1;

        if (attempt === 1) {
          throw new AiError('provider-unavailable', 'nothing is listening');
        }

        yield { type: 'start', model: 'flaky' } as const;
        yield { type: 'delta', text: 'recovered [f1]' } as const;
        yield { type: 'end', stopReason: 'complete', usage: { promptTokens: 1, outputTokens: 1 } } as const;
      },
    };

    const status = await runChat(new FakeContextSource(context()), io, {
      model: model as never,
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('first', 'second', '/exit'),
    });

    expect(io.errors.join('')).toContain('provider-unavailable');
    expect(io.text()).toContain('recovered [f1]');
    // One failure does not doom the session, and something was answered, so the status is clean.
    expect(status).toBe(0);
  });

  it('exits non-zero when nothing in the session could be answered', async () => {
    const io = recorder();

    const status = await runChat(new FakeContextSource(context()), io, {
      model: new ScriptedModel({ failAfter: 0, failWith: new AiError('model-load-failed', 'out of memory') }),
      subject: REPOSITORY,
      colour: false,
      lines: linesOf('q', '/exit'),
    });

    expect(status).toBe(5);
    expect(io.errors.join('')).toContain('model-load-failed');
  });
});

describe('providers', () => {
  it('knows exactly one provider, and it is the one implemented', () => {
    expect(PROVIDER_NAMES).toEqual(['ollama']);
    expect(isProviderName('ollama')).toBe(true);
    expect(isProviderName('anthropic')).toBe(false);
  });

  it('refuses an unknown provider by name, listing what there is', () => {
    expect(() => providerFor('anthropic')).toThrow(CliError);

    try {
      providerFor('anthropic');
      expect.unreachable();
    } catch (error) {
      expect((error as CliError).code).toBe('unknown-provider');
      expect((error as CliError).hint).toContain('ollama');
    }
  });

  it('builds the provider it does know', () => {
    expect(providerFor('ollama').name).toBe('ollama');
  });
});

describe('exit statuses for chat', () => {
  it('separates a wrong flag from a provider that is not running from a model that is not there', () => {
    // A script needs to tell these apart: `--provider typo` is the user's mistake, "nothing is listening"
    // is an environment that is not ready, and "no such model" is a thing that does not exist.
    expect(EXIT_STATUS['unknown-provider']).toBe(2);
    expect(EXIT_STATUS['provider-unavailable']).toBe(3);
    expect(EXIT_STATUS['model-not-found']).toBe(4);
    expect(EXIT_STATUS['chat-failed']).toBe(5);
  });

  it('gives every chat code a non-zero status', () => {
    for (const code of ['unknown-provider', 'provider-unavailable', 'model-not-found', 'chat-failed'] as const) {
      expect(EXIT_STATUS[code], code).toBeGreaterThan(0);
    }
  });
});
