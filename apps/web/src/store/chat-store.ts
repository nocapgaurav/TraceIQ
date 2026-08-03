'use client';

import { create } from 'zustand';

import type { ChatAnswer, ChatGrounding, ChatPhase, ChatSubject } from '@/types/api';

/**
 * Conversations, in memory for the session.
 *
 * **Deliberately not persisted.** Conversation storage is a deferred milestone and the AI layer ships only
 * the types; writing to `localStorage` here would invent a persistence format ahead of that decision, and
 * a stale conversation restored after a rescan would carry answers grounded in facts that no longer hold.
 *
 * Kept apart from `ui-store` because the two have different lifetimes: theme and panel sizes persist, a
 * conversation does not.
 */
export interface ChatTurn {
  readonly id: string;
  readonly question: string;
  readonly subject: ChatSubject;
  /** Grows while the answer streams. */
  readonly text: string;
  /** Present from the first `grounding` frame, so sources can be shown before any prose. */
  readonly grounding: ChatGrounding | null;
  /** Present once the answer completes. `null` while streaming or after a failure. */
  readonly answer: ChatAnswer | null;
  readonly status: 'streaming' | 'complete' | 'failed' | 'cancelled';
  /**
   * The stage the answer is at, while it is streaming.
   *
   * Held per turn rather than globally because a conversation may be scrolled while one turn works, and
   * a phase belongs to the answer it describes.
   */
  readonly phase: ChatPhase | null;
  /**
   * Why the prose on screen was replaced, where verification rejected it.
   *
   * Held on the turn rather than read off `answer` because it arrives *before* the answer does — on the
   * `restart` frame, at the moment the rejected prose is cleared — and a reader watching the text vanish is
   * owed the reason immediately rather than when the replacement finishes.
   */
  readonly corrections: readonly string[];
  readonly error: { readonly code: string; readonly detail: string; readonly hint: string } | null;
}

export interface Conversation {
  readonly id: string;
  /** Taken from the first question, so the sidebar reads as what was asked rather than "Conversation 3". */
  readonly title: string;
  readonly subject: ChatSubject;
  readonly turns: readonly ChatTurn[];
  readonly createdAt: number;
}

export interface ChatState {
  readonly conversations: readonly Conversation[];
  readonly activeId: string | null;
  /** The model the API reported in its `open` frame. Null until the first answer. */
  readonly model: string | null;
  readonly sidebarOpen: boolean;

  startConversation(subject: ChatSubject): string;
  selectConversation(id: string): void;
  removeConversation(id: string): void;
  /** Empties the active conversation's turns but keeps it and its subject. */
  clearActive(): void;
  setSubject(id: string, subject: ChatSubject): void;
  setModel(model: string | null): void;
  setSidebarOpen(open: boolean): void;

  addTurn(conversationId: string, turn: ChatTurn): void;
  updateTurn(conversationId: string, turnId: string, patch: Partial<ChatTurn>): void;
  appendDelta(conversationId: string, turnId: string, text: string): void;
  /** Drops a turn entirely. Used by retry, which re-asks rather than editing in place. */
  removeTurn(conversationId: string, turnId: string): void;
}

export const REPOSITORY_SUBJECT: ChatSubject = { kind: 'repository' };

/**
 * Identifiers.
 *
 * A counter rather than `crypto.randomUUID`, so a test sees the same ids on every run and a snapshot of
 * store state is comparable. Uniqueness within a session is all that is needed — nothing persists.
 */
let sequence = 0;

export function nextId(prefix: string): string {
  sequence += 1;

  return `${prefix}-${sequence}`;
}

/** Exposed so a test can start from a known counter. */
export function resetIds(): void {
  sequence = 0;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: [],
  activeId: null,
  model: null,
  sidebarOpen: false,

  startConversation: (subject) => {
    const id = nextId('conversation');

    set((state) => ({
      conversations: [
        { id, title: 'New conversation', subject, turns: [], createdAt: state.conversations.length },
        ...state.conversations,
      ],
      activeId: id,
    }));

    return id;
  },

  selectConversation: (id) => {
    set({ activeId: id });
  },

  removeConversation: (id) => {
    set((state) => {
      const conversations = state.conversations.filter((conversation) => conversation.id !== id);

      return {
        conversations,
        // Removing what was open selects the next one rather than leaving nothing selected.
        activeId: state.activeId === id ? (conversations[0]?.id ?? null) : state.activeId,
      };
    });
  },

  clearActive: () => {
    const { activeId } = get();

    if (activeId === null) {
      return;
    }

    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === activeId ? { ...conversation, turns: [], title: 'New conversation' } : conversation,
      ),
    }));
  },

  setSubject: (id, subject) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        // Changing the subject drops the turns: prior answers were about something else, and replaying them
        // as conversation would mislead both the reader and the model.
        conversation.id === id ? { ...conversation, subject, turns: [], title: 'New conversation' } : conversation,
      ),
    }));
  },

  setModel: (model) => {
    set({ model });
  },

  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
  },

  addTurn: (conversationId, turn) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              turns: [...conversation.turns, turn],
              title: conversation.turns.length === 0 ? titleOf(turn.question) : conversation.title,
            }
          : conversation,
      ),
    }));
  },

  updateTurn: (conversationId, turnId, patch) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              turns: conversation.turns.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn)),
            }
          : conversation,
      ),
    }));
  },

  appendDelta: (conversationId, turnId, text) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              turns: conversation.turns.map((turn) =>
                turn.id === turnId ? { ...turn, text: turn.text + text } : turn,
              ),
            }
          : conversation,
      ),
    }));
  },

  removeTurn: (conversationId, turnId) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, turns: conversation.turns.filter((turn) => turn.id !== turnId) }
          : conversation,
      ),
    }));
  },
}));

/** A sidebar title: the question, shortened on a word boundary where one is near enough. */
export function titleOf(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');

  if (trimmed.length <= 48) {
    return trimmed;
  }

  const cut = trimmed.slice(0, 48);
  const space = cut.lastIndexOf(' ');

  return `${space > 24 ? cut.slice(0, space) : cut}…`;
}

/** The active conversation, or `null`. A selector so a component re-renders on its turns alone. */
export function activeConversation(state: ChatState): Conversation | null {
  return state.conversations.find((conversation) => conversation.id === state.activeId) ?? null;
}

/**
 * Prior turns as the API's history shape.
 *
 * Only completed turns, and only their question and answer. A streaming, failed or cancelled turn has no
 * settled answer to replay, and **facts are never replayed** — each turn grounds itself on context acquired
 * for it, so a fact from turn one cannot still be grounding turn eight after a rescan.
 */
export function historyOf(conversation: Conversation): readonly { question: string; answer: string }[] {
  return conversation.turns
    .filter((turn) => turn.status === 'complete' && turn.text !== '')
    .map((turn) => ({ question: turn.question, answer: turn.text }));
}
