'use client';

import { CornerDownLeft, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { routes } from '@/lib/routes';
import { Button } from '@/components/ui/button';

/**
 * Section 4 — Ask TraceIQ.
 *
 * **No AI is implemented here.** The box takes a question and opens Repository Chat with it; the chat
 * page owns the conversation, the streaming, the citations and the grounding verdict, exactly as it did
 * before. Running a second copy of that pipeline inline would duplicate the one part of this application
 * with the most moving parts, and the two copies would drift.
 *
 * The suggested prompts are questions about *this* repository in general, so they are answerable with the
 * repository subject the chat page already defaults to. None of them is answered here.
 */
const SUGGESTIONS: readonly string[] = [
  'Explain the architecture',
  'Where should I start?',
  'Explain authentication',
  'How does request flow work?',
  'What is the most important package?',
];

export function AskTraceIq() {
  const router = useRouter();
  const [question, setQuestion] = useState('');

  const open = (text: string): void => {
    const trimmed = text.trim();

    if (trimmed === '') {
      return;
    }

    router.push(routes.chat(trimmed));
  };

  return (
    <section aria-labelledby="ask-traceiq" className="relative overflow-hidden rounded-xl border border-border bg-card">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.06] via-transparent to-transparent"
      />

      <div className="relative p-6 sm:p-8">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <h2 id="ask-traceiq" className="text-base font-semibold tracking-tight">
            Ask TraceIQ
          </h2>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Ask anything about this repository. Every answer is grounded in the repository graph and cites
          the facts behind it.
        </p>

        <form
          className="mt-5 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            open(question);
          }}
        >
          <div className="relative flex-1">
            <input
              value={question}
              onChange={(event) => {
                setQuestion(event.target.value);
              }}
              aria-label="Ask about this repository"
              placeholder="What does this repository do?"
              className="h-12 w-full rounded-lg border border-input bg-background px-4 pr-10 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <CornerDownLeft
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
          <Button type="submit" size="lg" disabled={question.trim() === ''} className="h-12 px-6">
            Ask
          </Button>
        </form>

        <ul className="mt-4 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => {
                  open(suggestion);
                }}
                className="rounded-full border border-border bg-secondary/40 px-3 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>

        {/*
          No "is a graph loaded?" check here, deliberately. This section only renders once `/overview`
          has succeeded, and `/overview` cannot succeed without a graph — the check would be unreachable
          and would cost the page a third request to answer a question already settled.
        */}
        <p className="mt-4 text-[11px] text-muted-foreground">
          No source code is available to the model — answers come from graph facts alone.
        </p>
      </div>
    </section>
  );
}
