import { beforeEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_SUBJECT,
  activeConversation,
  historyOf,
  resetIds,
  titleOf,
  useChatStore,
  type ChatTurn,
} from './chat-store';

/**
 * The conversation store.
 *
 * Two properties matter beyond the bookkeeping: changing the subject drops the turns, and history carries
 * only settled question-and-answer pairs — never the facts that grounded them.
 */
beforeEach(() => {
  resetIds();
  useChatStore.setState({ conversations: [], activeId: null, model: null, sidebarOpen: false });
});

function turn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: 'turn-x',
    question: 'q',
    subject: REPOSITORY_SUBJECT,
    text: 'a',
    grounding: null,
    corrections: [],
    phase: null,
    answer: null,
    status: 'complete',
    error: null,
    ...overrides,
  };
}

describe('conversations', () => {
  it('starts one and makes it active', () => {
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    expect(useChatStore.getState().activeId).toBe(id);
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('puts the newest first, since that is what a sidebar should show at the top', () => {
    useChatStore.getState().startConversation(REPOSITORY_SUBJECT);
    const second = useChatStore.getState().startConversation({ kind: 'file', path: 'a.ts' });

    expect(useChatStore.getState().conversations[0]?.id).toBe(second);
  });

  it('titles a conversation from its first question and does not retitle it', () => {
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().addTurn(id, turn({ id: 'a', question: 'How many files?' }));
    useChatStore.getState().addTurn(id, turn({ id: 'b', question: 'And declarations?' }));

    expect(activeConversation(useChatStore.getState())?.title).toBe('How many files?');
  });

  it('selects the next conversation when the open one is removed', () => {
    const first = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);
    const second = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().removeConversation(second);

    expect(useChatStore.getState().activeId).toBe(first);
  });

  it('leaves nothing selected when the last is removed', () => {
    const only = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().removeConversation(only);

    expect(useChatStore.getState().activeId).toBeNull();
    expect(useChatStore.getState().conversations).toEqual([]);
  });

  it('clears the active conversation without removing it', () => {
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().addTurn(id, turn());
    useChatStore.getState().clearActive();

    expect(activeConversation(useChatStore.getState())?.turns).toEqual([]);
    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(activeConversation(useChatStore.getState())?.title).toBe('New conversation');
  });

  it('drops the turns when the subject changes', () => {
    // Prior answers were about something else; replaying them would mislead the reader and the model.
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().addTurn(id, turn());
    useChatStore.getState().setSubject(id, { kind: 'file', path: 'a.ts' });

    const conversation = activeConversation(useChatStore.getState());

    expect(conversation?.turns).toEqual([]);
    expect(conversation?.subject).toEqual({ kind: 'file', path: 'a.ts' });
  });
});

describe('turns', () => {
  it('appends deltas to the text as they arrive', () => {
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().addTurn(id, turn({ id: 't', text: '', status: 'streaming' }));
    useChatStore.getState().appendDelta(id, 't', 'one ');
    useChatStore.getState().appendDelta(id, 't', 'two');

    expect(activeConversation(useChatStore.getState())?.turns[0]?.text).toBe('one two');
  });

  it('patches a turn without touching the others', () => {
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().addTurn(id, turn({ id: 'a' }));
    useChatStore.getState().addTurn(id, turn({ id: 'b', status: 'streaming' }));
    useChatStore.getState().updateTurn(id, 'b', { status: 'complete' });

    const turns = activeConversation(useChatStore.getState())?.turns ?? [];

    expect(turns[0]?.status).toBe('complete');
    expect(turns[1]?.status).toBe('complete');
  });

  it('removes a turn, which is how retry re-asks', () => {
    const id = useChatStore.getState().startConversation(REPOSITORY_SUBJECT);

    useChatStore.getState().addTurn(id, turn({ id: 'a' }));
    useChatStore.getState().removeTurn(id, 'a');

    expect(activeConversation(useChatStore.getState())?.turns).toEqual([]);
  });
});

describe('historyOf', () => {
  it('carries only questions and answers, never the facts that grounded them', () => {
    // A fact from turn one must not still be grounding turn eight after a rescan.
    const conversation = {
      id: 'c',
      title: 't',
      subject: REPOSITORY_SUBJECT,
      createdAt: 0,
      turns: [
        turn({
          id: 'a',
          question: 'q1',
          text: 'a1',
          answer: {
            question: 'q1',
            subject: REPOSITORY_SUBJECT,
            text: 'a1',
            verdict: 'grounded',
            citations: [
              { factId: 'f1', subject: 'sym:stale.ts#Gone', predicate: 'is-a', object: 'Method', confidence: 'CERTAIN', provenance: '@traceiq/explain' },
            ],
            fabricatedIdentifiers: [],
            unsupportedTerms: [],
            attempts: 1,
            corrections: [],
            diagnostics: [],
            unknownCitations: [],
            grounding: { kind: 'repository', subject: null, factCount: 1, coreCount: 1, intent: 'overview', tier: 'standard', tokens: 10, promptTokens: null, digest: 'd', omissions: [] },
            model: 'm',
            stopReason: 'complete',
            usage: { promptTokens: 1, outputTokens: 1 },
          },
        }),
      ],
    };

    const history = historyOf(conversation);

    expect(history).toEqual([{ question: 'q1', answer: 'a1' }]);
    expect(JSON.stringify(history)).not.toContain('sym:stale.ts#Gone');
    expect(JSON.stringify(history)).not.toContain('f1');
  });

  it('excludes a streaming, failed or cancelled turn, which has no settled answer', () => {
    const conversation = {
      id: 'c',
      title: 't',
      subject: REPOSITORY_SUBJECT,
      createdAt: 0,
      turns: [
        turn({ id: 'a', status: 'streaming' }),
        turn({ id: 'b', status: 'failed' }),
        turn({ id: 'c', status: 'cancelled' }),
        turn({ id: 'd', question: 'kept', text: 'yes' }),
      ],
    };

    expect(historyOf(conversation)).toEqual([{ question: 'kept', answer: 'yes' }]);
  });

  it('excludes a completed turn that produced no text', () => {
    const conversation = {
      id: 'c',
      title: 't',
      subject: REPOSITORY_SUBJECT,
      createdAt: 0,
      turns: [turn({ id: 'a', text: '' })],
    };

    expect(historyOf(conversation)).toEqual([]);
  });
});

describe('titleOf', () => {
  it('keeps a short question whole', () => {
    expect(titleOf('How many files?')).toBe('How many files?');
  });

  it('collapses whitespace', () => {
    expect(titleOf('  a   b  ')).toBe('a b');
  });

  it('shortens a long question on a word boundary', () => {
    const title = titleOf('What would break if I changed the Listing interface in the explorer package today?');

    expect(title.length).toBeLessThanOrEqual(49);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('  ');
  });
});

describe('the store holds no repository data', () => {
  it('carries conversations, selection, model and sidebar state, and nothing else', () => {
    const keys = Object.entries(useChatStore.getState())
      .filter(([, value]) => typeof value !== 'function')
      .map(([key]) => key)
      .sort();

    expect(keys).toEqual(['activeId', 'conversations', 'model', 'sidebarOpen']);
  });
});
