import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '@/test/harness';
import { resetIds, useChatStore } from '@/store/chat-store';

import ChatPage from './chat/page';

/**
 * Repository Chat, end to end from `fetch` upwards.
 *
 * Only `fetch` is stubbed: the SSE client, the store, the hook and every component are the production code
 * path, so this proves the page reads the frames the API actually sends. What is not tested is whether a
 * model writes a good answer — that is model evaluation.
 */
/**
 * Search params are mutable so the hand-off case can set `?q=`. Every other test leaves them empty, which
 * is the state the page was written against before the Repository Overview started handing questions over.
 */
const search = { current: new URLSearchParams() };
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => search.current,
}));

const GROUNDING = {
  kind: 'repository',
  subject: null,
  factCount: 64,
  coreCount: 0,
  intent: 'overview',
  tier: 'standard',
  tokens: 1920,
  promptTokens: null,
  digest: 'c0a8bdfbb1fe2e3f',
  omissions: [{ part: 'cycles', kept: 15, total: 18 }],
};

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: 'How many files?',
    subject: { kind: 'repository' },
    text: 'It has **228** files [f2].',
    verdict: 'grounded',
    citations: [
      {
        factId: 'f2',
        subject: 'repository',
        predicate: 'contains',
        object: '228 files',
        confidence: 'CERTAIN',
        provenance: '@traceiq/explorer',
      },
    ],
    fabricatedIdentifiers: [],
    unsupportedTerms: [],
    diagnostics: [],
    unknownCitations: [],
    grounding: GROUNDING,
    attempts: 1,
    corrections: [],
    model: 'test:1b',
    stopReason: 'complete',
    usage: { promptTokens: 2002, outputTokens: 13 },
    ...overrides,
  };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A stubbed `fetch` that answers `/version` as JSON and `/chat/stream` as an event stream. */
function stub(chunks: readonly string[]): { readonly bodies: unknown[] } {
  const bodies: unknown[] = [];
  const encoder = new TextEncoder();

  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/chat/stream')) {
      bodies.push(JSON.parse(String(init?.body)));

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }

            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }

    const data = url.includes('/version')
      ? { version: '1.0.0', scanned: true, databasePath: '/x.db' }
      : { query: {}, match: 'prefix', declarations: { entries: [], total: 0, truncated: false }, files: { entries: [], total: 0, truncated: false }, routes: { entries: [], total: 0, truncated: false }, environmentVariables: { entries: [], total: 0, truncated: false }, externalPackages: { entries: [], total: 0, truncated: false }, total: 0 };

    return new Response(JSON.stringify({ success: true, data, meta: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);

  return { bodies };
}

const SUCCESS = [frame('open', { model: 'test:1b' }), frame('grounding', GROUNDING), frame('delta', { text: 'It has ' }), frame('delta', { text: '**228** files [f2].' }), frame('complete', answer())];

async function ask(question = 'How many files?'): Promise<void> {
  await userEvent.type(screen.getByLabelText('Ask about the repository'), question);
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

beforeEach(() => {
  resetIds();
  search.current = new URLSearchParams();
  replace.mockClear();
  useChatStore.setState({ conversations: [], activeId: null, model: null, sidebarOpen: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the empty page', () => {
  it('opens with a conversation ready and says what it can answer', async () => {
    stub([]);
    renderWithQuery(<ChatPage />);

    expect(await screen.findByText(/Ask about the whole repository/)).toBeInTheDocument();
    // The disclaimer appears twice on an empty page — in the empty state and under the composer — and both
    // are deliberate: whichever a reader looks at, it says the same thing.
    expect(screen.getAllByText(/No source code is available to the model/)).toHaveLength(2);
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('disables Ask until something is typed', async () => {
    stub([]);
    renderWithQuery(<ChatPage />);

    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Ask about the repository'), 'x');

    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });
});

describe('asking', () => {
  it('sends the question and the resolved subject', async () => {
    const { bodies } = stub(SUCCESS);

    renderWithQuery(<ChatPage />);
    await ask();

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    expect(bodies[0]).toEqual({ question: 'How many files?', subject: { kind: 'repository' } });
  });

  it('shows the question immediately', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();

    // Scoped to the transcript: the sidebar titles the conversation with the same question.
    const transcript = await screen.findByRole('article');

    expect(within(transcript).getByText('How many files?')).toBeInTheDocument();
  });

  it('shows the projection summary and its omissions before any prose', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByText('64')).toBeInTheDocument();
    expect(screen.getByText(/These lists were incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/showing 15 of 18/)).toBeInTheDocument();
  });

  it('renders the answer as markdown, so bold is bold rather than asterisks', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();

    const bold = await screen.findByText('228');

    expect(bold.tagName).toBe('STRONG');
    // The asterisks themselves must not be on screen.
    expect(screen.queryByText(/\*\*228\*\*/)).not.toBeInTheDocument();
  });

  it('shows the grounding badge, the model and the token usage', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByText('grounded')).toBeInTheDocument();
    expect(screen.getByText('test:1b')).toBeInTheDocument();
    expect(screen.getByText('2002 prompt / 13 output tokens')).toBeInTheDocument();
  });

  it('lists the citations, each with the capability that established it', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();

    await userEvent.click(await screen.findByText('1 fact cited'));

    expect(screen.getByText('[f2]')).toBeInTheDocument();
    expect(screen.getByText('contains')).toBeInTheDocument();
    expect(screen.getByText('@traceiq/explorer')).toBeInTheDocument();
  });

  it('links an identifier in a citation to its page', async () => {
    stub([
      frame('grounding', GROUNDING),
      frame('complete', {
        ...answer(),
        citations: [
          {
            factId: 'f1',
            subject: 'sym:a.ts#B',
            predicate: 'calls',
            object: 'sym:c.ts#D at depth 2',
            confidence: 'INFERRED',
            provenance: '@traceiq/call-graph',
          },
        ],
      }),
    ]);

    renderWithQuery(<ChatPage />);
    await ask();
    await userEvent.click(await screen.findByText('1 fact cited'));

    expect(screen.getByRole('link', { name: 'sym:a.ts#B' })).toHaveAttribute(
      'href',
      '/symbol?id=sym%3Aa.ts%23B',
    );
    // The depth suffix is a fact about the edge, not part of the name, so the link uses the bare identifier.
    expect(screen.getByRole('link', { name: 'sym:c.ts#D' })).toBeInTheDocument();
  });

  it('clears the textarea after asking', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();

    await waitFor(() => {
      expect(screen.getByLabelText('Ask about the repository')).toHaveValue('');
    });
  });

  it('replays the prior turn as history on the next question', async () => {
    const { bodies } = stub(SUCCESS);

    renderWithQuery(<ChatPage />);
    await ask('first?');
    await waitFor(() => {
      expect(screen.getByText('grounded')).toBeInTheDocument();
    });

    await ask('second?');
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });

    // Questions and answers only — never the facts that grounded them.
    expect(bodies[1]).toMatchObject({
      question: 'second?',
      history: [{ question: 'first?', answer: 'It has **228** files [f2].' }],
    });
    // The answer *text* legitimately contains the marker the model wrote; what must never be replayed is
    // the evidence — the citations, their provenance and the grounding.
    expect(bodies[1]).not.toHaveProperty('citations');
    expect(JSON.stringify(bodies[1])).not.toContain('provenance');
    expect(JSON.stringify(bodies[1])).not.toContain('grounding');
    expect(JSON.stringify(bodies[1])).not.toContain('@traceiq/');
  });
});

describe('a corrected answer', () => {
  it('discards the rejected prose when told to, and says the answer was rewritten', async () => {
    /*
     * The rejected answer was already on screen. Leaving it there until `complete` arrives would let a
     * reader finish something the pipeline had thrown away; appending the rewrite would splice two answers
     * together. So the text is cleared, and the badge says the first attempt did not verify.
     */
    stub([
      frame('grounding', GROUNDING),
      frame('delta', { text: 'The repository is well documented.' }),
      frame('restart', { reasons: ['presence-as-quality: nothing measures documentation'] }),
      frame('status', { phase: 'correcting' }),
      frame('delta', { text: 'It has **228** files [f2].' }),
      frame('complete', {
        ...answer(),
        attempts: 2,
        corrections: ['presence-as-quality: nothing measures documentation'],
      }),
    ]);

    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByText('rewritten once')).toBeInTheDocument();
    expect(screen.queryByText(/well documented/)).not.toBeInTheDocument();
    // The rewritten answer, which the fixture renders with a bold count. Several nodes carry the number —
    // the prose and the grounding summary — so the assertion is that at least one does.
    expect(screen.getAllByText(/228/).length).toBeGreaterThan(0);
  });
});

describe('an ungrounded answer', () => {
  it('is shown, with the verdict and the fabrication named', async () => {
    // Withholding it would hide the evidence of the failure.
    stub([
      frame('grounding', GROUNDING),
      frame('delta', { text: 'It calls sym:invented.ts#Nope.' }),
      frame('complete', {
        ...answer(),
        text: 'It calls sym:invented.ts#Nope.',
        verdict: 'ungrounded',
        fabricatedIdentifiers: ['sym:invented.ts#Nope'],
        diagnostics: [
          {
            kind: 'fabricated-identifier',
            subject: 'sym:invented.ts#Nope',
            detail: 'no fact carried this identifier; 12 were available',
            nearest: [],
          },
        ],
        citations: [],
      }),
    ]);

    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByText('ungrounded')).toBeInTheDocument();
    // The reason, not only the rejected string: a reader has to be able to tell an invention from a
    // verifier that was too strict about how a real name was written.
    expect(screen.getByText(/could not be checked against the facts/)).toBeInTheDocument();
    expect(screen.getByText('sym:invented.ts#Nope')).toBeInTheDocument();
    expect(screen.getByText(/no fact carried this identifier/)).toBeInTheDocument();
  });

  it('names the closest fact when a rejection looks like a granularity mismatch', async () => {
    stub([
      frame('grounding', GROUNDING),
      frame('delta', { text: 'The dialog is in ModalDialog.js.' }),
      frame('complete', {
        ...answer(),
        text: 'The dialog is in ModalDialog.js.',
        verdict: 'ungrounded',
        unsupportedTerms: ['ModalDialog.js'],
        diagnostics: [
          {
            kind: 'unsupported-term',
            subject: 'ModalDialog.js',
            detail: 'no fact named this package, framework, file or dependency; 88 names were available',
            nearest: ['packages/react-devtools-shared/src/devtools/views/ModalDialog.js'],
          },
        ],
        citations: [],
      }),
    ]);

    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByText(/Closest the facts did carry/)).toBeInTheDocument();
  });

  it('marks an uncited answer unverifiable rather than passing it off', async () => {
    stub([
      frame('grounding', GROUNDING),
      frame('complete', { ...answer(), verdict: 'unverifiable', citations: [] }),
    ]);

    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByText('unverifiable')).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('shows a terminal error frame with its code, keeping what had arrived', async () => {
    stub([
      frame('grounding', GROUNDING),
      frame('delta', { text: 'half ' }),
      frame('error', { code: 'stream-interrupted', detail: 'the provider closed the stream', hint: 'try again', partial: 'half ' }),
    ]);

    renderWithQuery(<ChatPage />);
    await ask();

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText('stream-interrupted')).toBeInTheDocument();
    expect(within(alert).getByText('the provider closed the stream')).toBeInTheDocument();
    expect(screen.getByText('half')).toBeInTheDocument();
  });

  /**
   * A missing model is a setup step, not a failed question, so the page shows how to switch chat on
   * instead of an error row. The API's own detail is still shown, so the cause is not hidden.
   */
  it('shows setup guidance when the API has no model configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string) => {
      if (String(input).includes('/chat/stream')) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: 'ai-not-configured', detail: 'no model', hint: 'start the API with a model' },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ success: true, data: { version: '1.0.0', scanned: true, databasePath: '/x' }, meta: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);

    renderWithQuery(<ChatPage />);
    await ask();

    // Setup guidance, not an error box: the heading, the commands, and reassurance about the rest.
    expect(await screen.findByRole('heading', { name: 'Ask TraceIQ needs a language model' })).toBeInTheDocument();
    expect(screen.getByText('ollama pull qwen2.5:7b-instruct')).toBeInTheDocument();
    expect(screen.getByText(/Overview, Explorer, Architecture, Impact and Search all work/)).toBeInTheDocument();
    // The API's own detail is still shown rather than swallowed.
    expect(screen.getByText(/no model/)).toBeInTheDocument();
  });
});

describe('stop, retry and clear', () => {
  it('shows Stop while streaming and Ask when it is not', async () => {
    // A stream that never closes, so the streaming state is observable.
    const encoder = new TextEncoder();

    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string) => {
      if (String(input).includes('/chat/stream')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(frame('grounding', GROUNDING)));
              // Never closed: the answer is still arriving.
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }

      return new Response(JSON.stringify({ success: true, data: { version: '1.0.0', scanned: true, databasePath: '/x' }, meta: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);

    renderWithQuery(<ChatPage />);
    await ask();

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByRole('button', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.getByText(/Stopped\./)).toBeInTheDocument();
  });

  it('retries by asking the same question again and dropping the previous answer', async () => {
    const { bodies } = stub(SUCCESS);

    renderWithQuery(<ChatPage />);
    await ask('why?');
    await waitFor(() => {
      expect(screen.getByText('grounded')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));

    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });

    expect(bodies[1]).toMatchObject({ question: 'why?' });
    // The retry replaced the turn rather than adding one, so the transcript holds it once. The sidebar
    // title also reads 'why?', hence the scope.
    const transcript = screen.getByRole('article');

    expect(within(transcript).getAllByText('why?')).toHaveLength(1);
    // And it does not replay itself as history.
    expect(bodies[1]).not.toHaveProperty('history');
  });

  it('clears the conversation but keeps it selected', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask();
    await waitFor(() => {
      expect(screen.getByText('grounded')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Clear/ }));

    expect(await screen.findByText(/Ask about the whole repository/)).toBeInTheDocument();
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('disables retry and clear when there is nothing to act on', async () => {
    stub([]);
    renderWithQuery(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry/ })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: /Clear/ })).toBeDisabled();
  });
});

describe('the sidebar', () => {
  it('lists conversations and starts a new one', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask('first question');
    await waitFor(() => {
      expect(screen.getByText('grounded')).toBeInTheDocument();
    });

    const list = await screen.findByLabelText('Conversations');

    expect(within(list).getByText('first question')).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: /New conversation/ })[0] as HTMLElement);

    expect(useChatStore.getState().conversations).toHaveLength(2);
    expect(await screen.findByText(/Ask about the whole repository/)).toBeInTheDocument();
  });

  it('deletes a conversation', async () => {
    stub(SUCCESS);
    renderWithQuery(<ChatPage />);
    await ask('doomed question');
    await waitFor(() => {
      expect(screen.getByText('grounded')).toBeInTheDocument();
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Delete doomed question' }));

    // The page keeps exactly one conversation available, so deleting the last opens a fresh one rather than
    // leaving nothing to type into. What must be gone is the deleted one.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete doomed question' })).not.toBeInTheDocument();
    });
    expect(useChatStore.getState().conversations.some((entry) => entry.title === 'doomed question')).toBe(false);
  });
});

/**
 * The Repository Overview's "Ask TraceIQ" box navigates here with the question in the URL. This is the
 * whole integration — the overview owns no chat pipeline, so if the hand-off breaks the feature is gone.
 */
describe('a question handed over from another page', () => {
  it('asks it on arrival, through the same pipeline as a typed question', async () => {
    search.current = new URLSearchParams('q=Explain the architecture');
    stub(SUCCESS);

    renderWithQuery(<ChatPage />);

    // Scoped to the transcript: the sidebar titles the conversation with the same question.
    const transcript = await screen.findByRole('article');

    expect(within(transcript).getByText('Explain the architecture')).toBeInTheDocument();

    // The answer streamed and rendered, so the whole pipeline ran — not just the request.
    expect(await screen.findByText('228')).toBeInTheDocument();
    expect(within(transcript).getByText('grounded')).toBeInTheDocument();
  });

  /**
   * The parameter is dropped with `history.replaceState`, not `router.replace`. A router navigation
   * re-runs the route and left a stray empty conversation behind — visible only in a browser, which is
   * why this asserts the location rather than a spy on the router.
   */
  it('drops the parameter, so a refresh does not silently re-run the model', async () => {
    search.current = new URLSearchParams('q=Explain the architecture');
    stub(SUCCESS);

    renderWithQuery(<ChatPage />);

    await screen.findByRole('article');

    expect(window.location.search).toBe('');
    expect(replace).not.toHaveBeenCalled();
  });

  it('asks it once, not once per render', async () => {
    search.current = new URLSearchParams('q=Explain the architecture');
    const sent = stub(SUCCESS);

    renderWithQuery(<ChatPage />);

    await screen.findByText(/228/);

    // One request, and it carries the handed-over question against the repository subject.
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0]).toMatchObject({
      question: 'Explain the architecture',
      subject: { kind: 'repository' },
    });

    // And one conversation — arriving with a question must not also leave an empty one behind.
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  /**
   * A regression guard for a latent bug this milestone surfaced.
   *
   * The effect that guarantees a conversation exists decided from the `conversations` captured by the
   * render. Strict Mode invokes an effect twice on mount sharing one closure, so both runs saw "none" and
   * created two — an empty conversation sitting beside the real one. Only visible in a browser: jsdom
   * does not apply Strict Mode's double-invoke here, so this asserts the invariant directly instead.
   */
  it('leaves exactly one conversation under Strict Mode, not an empty one beside it', async () => {
    search.current = new URLSearchParams('q=Explain the architecture');
    stub(SUCCESS);

    // Strict Mode is what the application runs with, and is the condition that produced the bug: it
    // invokes each effect twice on mount, both times against the same captured render.
    renderWithQuery(
      <StrictMode>
        <ChatPage />
      </StrictMode>,
    );

    await screen.findByRole('article');

    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('ignores a blank parameter', async () => {
    search.current = new URLSearchParams('q=   ');
    const sent = stub([]);

    renderWithQuery(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Ask about the repository')).toBeInTheDocument();
    });

    expect(sent.bodies).toHaveLength(0);
  });
});

describe('nothing invites source code or a chat about anything else', () => {
  it('states that no source is available to the model', async () => {
    stub([]);
    renderWithQuery(<ChatPage />);

    expect((await screen.findAllByText(/No source code is available to the model/)).length).toBeGreaterThan(0);
  });

  it('offers no way to send anything but a question about a resolved subject', async () => {
    stub([]);
    renderWithQuery(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Ask about the repository')).toBeInTheDocument();
    });

    // One textarea, and it is the question box. No prompt editor, no system-message field, no model picker.
    expect(document.querySelectorAll('textarea')).toHaveLength(1);
  });
});
