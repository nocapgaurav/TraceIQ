'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, NetworkError } from '@/services/api-client';
import { streamChat } from '@/services/chat-service';
import {
  activeConversation,
  historyOf,
  nextId,
  useChatStore,
  type ChatTurn,
  type Conversation,
} from '@/store/chat-store';
import type { ChatSubject } from '@/types/api';

/**
 * Everything the chat page can do, as one hook.
 *
 * The page renders; this owns the request in flight. No component holds an `AbortController`, and no
 * component knows the URL — the same division every other page in this app follows.
 */
export interface UseChat {
  readonly conversation: Conversation | null;
  readonly streaming: boolean;
  readonly model: string | null;
  ask(question: string): Promise<void>;
  stop(): void;
  /** Re-asks the last question, dropping the answer it produced. */
  retry(): Promise<void>;
  clear(): void;
  readonly canRetry: boolean;
}

export function useChat(): UseChat {
  const conversation = useChatStore(activeConversation);
  const addTurn = useChatStore((state) => state.addTurn);
  const updateTurn = useChatStore((state) => state.updateTurn);
  const appendDelta = useChatStore((state) => state.appendDelta);
  const removeTurn = useChatStore((state) => state.removeTurn);
  const clearActive = useChatStore((state) => state.clearActive);
  const setModel = useChatStore((state) => state.setModel);
  const model = useChatStore((state) => state.model);

  const [streaming, setStreaming] = useState(false);
  const controller = useRef<AbortController | null>(null);

  // Leaving the page mid-answer must stop the model, not just stop the component listening. A local model
  // keeps generating for as long as the connection is open.
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const send = useCallback(
    async (question: string, target: Conversation, history: readonly { question: string; answer: string }[]) => {
      const turnId = nextId('turn');
      const turn: ChatTurn = {
        id: turnId,
        question,
        subject: target.subject,
        text: '',
        grounding: null,
        answer: null,
        status: 'streaming',
        phase: 'acquiring-context',
        error: null,
      };

      addTurn(target.id, turn);
      setStreaming(true);

      const abort = new AbortController();

      controller.current = abort;

      try {
        for await (const event of streamChat(
          {
            question,
            subject: target.subject,
            ...(history.length === 0 ? {} : { history }),
          },
          abort.signal,
        )) {
          if (event.type === 'open') {
            setModel(event.model);
          } else if (event.type === 'status') {
            updateTurn(target.id, turnId, { phase: event.phase });
          } else if (event.type === 'grounding') {
            // Arrives before any prose, so the sources are on screen before the answer is.
            updateTurn(target.id, turnId, { grounding: event.grounding });
          } else if (event.type === 'delta') {
            appendDelta(target.id, turnId, event.text);
          } else if (event.type === 'complete') {
            updateTurn(target.id, turnId, {
              answer: event.answer,
              text: event.answer.text,
              grounding: event.answer.grounding,
              status: 'complete',
              phase: null,
            });
          } else {
            // A terminal error frame. Whatever had already arrived stays on screen.
            updateTurn(target.id, turnId, {
              status: 'failed',
              phase: null,
              error: { code: event.code, detail: event.detail, hint: event.hint },
              ...(event.partial === null ? {} : { text: event.partial }),
            });
          }
        }

        // The stream ended without completing: either the user stopped it, or it was cut short.
        const settled = useChatStore
          .getState()
          .conversations.find((entry) => entry.id === target.id)
          ?.turns.find((entry) => entry.id === turnId);

        if (settled?.status === 'streaming') {
          // A stream that ended without a terminal frame. The server now always sends one, so reaching
          // here means the connection itself was lost — which is a failure to report rather than a
          // completion to imply. Only a deliberate cancellation is not a failure.
          updateTurn(
            target.id,
            turnId,
            abort.signal.aborted
              ? { status: 'cancelled', phase: null }
              : {
                  status: 'failed',
                  phase: null,
                  error: {
                    code: 'connection-lost',
                    detail: 'the connection closed before the answer finished',
                    hint: 'this is usually a proxy or network timeout rather than anything you did — ask again',
                  },
                },
          );
        }
      } catch (cause) {
        updateTurn(target.id, turnId, {
          status: 'failed',
          phase: null,
          error:
            cause instanceof ApiError
              ? { code: cause.code, detail: cause.detail, hint: cause.hint }
              : {
                  code: cause instanceof NetworkError ? 'network' : 'unexpected',
                  detail: cause instanceof Error ? cause.message : String(cause),
                  hint: 'check that the TraceIQ API is running with a model configured',
                },
        });
      } finally {
        controller.current = null;
        setStreaming(false);
      }
    },
    [addTurn, appendDelta, setModel, updateTurn],
  );

  const ask = useCallback(
    async (question: string) => {
      const target = activeConversation(useChatStore.getState());

      if (target === null || question.trim() === '' || streaming) {
        return;
      }

      await send(question.trim(), target, historyOf(target));
    },
    [send, streaming],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);

  const retry = useCallback(async () => {
    const target = activeConversation(useChatStore.getState());
    const last = target?.turns.at(-1);

    if (target === null || target === undefined || last === undefined || streaming) {
      return;
    }

    // The failed turn is dropped and the question asked again, rather than edited in place: an answer and
    // its grounding belong together, and a retry produces a new pair.
    removeTurn(target.id, last.id);

    const history = historyOf({ ...target, turns: target.turns.filter((turn) => turn.id !== last.id) });

    await send(last.question, target, history);
  }, [removeTurn, send, streaming]);

  const clear = useCallback(() => {
    controller.current?.abort();
    clearActive();
  }, [clearActive]);

  return {
    conversation,
    streaming,
    model,
    ask,
    stop,
    retry,
    clear,
    canRetry: !streaming && (conversation?.turns.length ?? 0) > 0,
  };
}

/** Turns a subject into one line, for the header and the sidebar. */
export function describeSubject(subject: ChatSubject): string {
  switch (subject.kind) {
    case 'symbol':
      return subject.id;
    case 'impact':
      return `impact of ${subject.id}`;
    case 'file':
      return subject.path;
    case 'package':
      return subject.name;
    case 'route':
      return `${subject.method} ${subject.path}`;
    case 'repository':
      return 'the whole repository';
    case 'search':
      return `search: ${subject.query.text}`;
  }
}
