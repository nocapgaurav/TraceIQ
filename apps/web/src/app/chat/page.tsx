'use client';

import { Eraser, PanelLeft, RotateCcw, Send, Square } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { ConversationSidebar, SidebarOverlay } from '@/components/domain/chat/sidebar';
import { SubjectPicker } from '@/components/domain/chat/subject-picker';
import { ChatSetup } from '@/components/domain/chat/setup';
import { EmptyConversation, Turn } from '@/components/domain/chat/turn';
import { ErrorBoundary } from '@/components/layout/error-boundary';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { describeSubject, useChat } from '@/hooks/use-chat';
import { parseChatSubject } from '@/lib/chat-subject';
import { useVersion } from '@/hooks/queries';
import { activeConversation, REPOSITORY_SUBJECT, useChatStore } from '@/store/chat-store';

/**
 * Repository Chat.
 *
 * The only page in this app that renders markdown, because it is the only one showing model prose —
 * repository pages render plain data, as they always have.
 *
 * Everything the page does goes through `useChat`: it holds no `AbortController`, builds no URL and knows no
 * endpoint. The one thing it owns is the draft in the textarea.
 */
export default function ChatPage() {
  const { conversation, streaming, ask, stop, retry, clear, canRetry } = useChat();
  const conversations = useChatStore((state) => state.conversations);
  const startConversation = useChatStore((state) => state.startConversation);
  const setSubject = useChatStore((state) => state.setSubject);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const version = useVersion();
  const searchParams = useSearchParams();
  const handedOff = searchParams.get('q');
  const handedOffSubject = searchParams.get('subject');

  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement | null>(null);
  const asked = useRef(false);

  /**
   * One conversation always exists, so the page is never an empty shell with nothing to type into.
   *
   * The guard reads `getState()` rather than the `conversations` captured by this render. React invokes
   * an effect twice on mount under Strict Mode, and both invocations share one closure — so the closure
   * form saw "no conversations" both times and created two, the second an empty one sitting beside the
   * real conversation. Reading current state makes the effect idempotent, which is what it always meant
   * to be. `conversations.length` stays in the dependencies so a cleared store still gets a conversation.
   */
  useEffect(() => {
    if (useChatStore.getState().conversations.length === 0) {
      startConversation(REPOSITORY_SUBJECT);
    }
  }, [conversations.length, startConversation]);

  /**
   * A question handed over from another page — the Repository Overview's "Ask TraceIQ" box arrives as
   * `?q=…`. It is asked once and the parameter is dropped, so a refresh or a back-navigation does not
   * silently re-run the model. `asked` guards the double-invocation React performs under Strict Mode.
   *
   * Two details are load-bearing, both found by watching this run in a browser rather than in jsdom:
   *
   * `history.replaceState`, **not** `router.replace`. A router navigation re-runs the route, and the
   * effect above — which creates a conversation whenever none exists — fired a second time against a
   * stale count, leaving an empty "New conversation" beside the real one. Rewriting the URL in place
   * drops the parameter without a navigation, so nothing re-runs.
   *
   * The conversation is created here if the effect above has not got to it yet, read through `getState`
   * rather than the render closure. That removes the ordering dependency between the two effects
   * entirely, instead of relying on which commit each happens to land in.
   */
  useEffect(() => {
    if (handedOff === null || handedOff.trim() === '' || asked.current) {
      return;
    }

    asked.current = true;
    window.history.replaceState(null, '', '/chat');

    /*
     * A hand-off carries its own subject — the Explorer asks about the package, file or declaration the
     * reader was looking at, not about the repository. It always opens a **new** conversation rather than
     * reusing the current one, because `setSubject` clears the turns of the conversation it changes, and
     * silently discarding someone's open conversation to answer a question from another page would be a
     * poor trade. Without a subject parameter this behaves exactly as before.
     */
    const subject = parseChatSubject(handedOffSubject);

    if (handedOffSubject === null) {
      if (activeConversation(useChatStore.getState()) === null) {
        startConversation(REPOSITORY_SUBJECT);
      }
    } else {
      startConversation(subject);
    }

    void ask(handedOff);
  }, [ask, handedOff, handedOffSubject, startConversation]);

  // Follow the answer as it streams. `block: 'end'` rather than `scrollIntoView()` on the last turn, so a
  // long answer keeps its tail visible instead of jumping to its top.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [conversation?.turns]);

  /*
   * Whether this API has a model at all.
   *
   * Read from the turns rather than asked for: no endpoint reports whether chat is configured, and the
   * one authority on it is the answer the API gives when asked a question. The last turn is enough —
   * once a model is configured a later turn will not carry this code.
   */
  const notConfigured =
    conversation?.turns.at(-1)?.error?.code === 'ai-not-configured'
      ? (conversation.turns.at(-1)?.error?.detail ?? null)
      : null;

  const submit = (): void => {
    const question = draft.trim();

    if (question === '' || streaming) {
      return;
    }

    setDraft('');
    void ask(question);
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] gap-4">
      <SidebarOverlay />

      {/* A permanent column above lg; the overlay above covers narrower screens. */}
      <aside className="hidden w-64 shrink-0 rounded-lg border border-border lg:block">
        <ConversationSidebar />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-border">
        <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
          <Button
            size="icon"
            variant="ghost"
            className="lg:hidden"
            aria-label="Open conversations"
            onClick={() => {
              setSidebarOpen(true);
            }}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>

          <h1 className="sr-only">Ask TraceIQ</h1>

          {conversation === null ? null : (
            <SubjectPicker
              subject={conversation.subject}
              onChange={(subject) => {
                setSubject(conversation.id, subject);
              }}
            />
          )}

          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canRetry}
              onClick={() => {
                void retry();
              }}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Retry</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={(conversation?.turns.length ?? 0) === 0}
              onClick={clear}
              className="gap-1.5"
            >
              <Eraser className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </Button>
          </div>
        </header>

        <ErrorBoundary label="This conversation failed to render">
          <ScrollArea className="flex min-h-0 flex-1 flex-col p-3">
            {notConfigured !== null ? (
              /*
               * A missing model is a setup step, not a failed question. The transcript would otherwise
               * show a red `ai-not-configured` box for every attempt, which reads as a broken product
               * rather than one waiting to be switched on.
               */
              <ChatSetup detail={notConfigured} />
            ) : conversation === null || conversation.turns.length === 0 ? (
              <EmptyConversation subject={conversation === null ? 'the repository' : describeSubject(conversation.subject)} />
            ) : (
              <div className="flex flex-col gap-6">
                {conversation.turns.map((turn) => (
                  <Turn key={turn.id} turn={turn} />
                ))}
              </div>
            )}
            <div ref={bottom} />
          </ScrollArea>
        </ErrorBoundary>

        <footer className="border-t border-border p-2">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line — the convention every chat uses, and the reason
                // this is a textarea rather than an input.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={2}
              aria-label="Ask about the repository"
              placeholder={
                conversation === null
                  ? 'Ask about the repository…'
                  : `Ask about ${describeSubject(conversation.subject)}…`
              }
              className="min-h-[3.25rem] flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />

            {streaming ? (
              <Button type="button" variant="destructive" onClick={stop} className="gap-1.5">
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button type="submit" disabled={draft.trim() === ''} className="gap-1.5">
                <Send className="h-3.5 w-3.5" />
                Ask
              </Button>
            )}
          </form>

          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Grounded in the repository graph. No source code is available to the model.
            {version.data === undefined ? null : version.data.scanned ? null : ' No graph is loaded — scan first.'}
          </p>
        </footer>
      </section>
    </div>
  );
}
