'use client';

import { Terminal } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';

/**
 * What to show when the API has no language model.
 *
 * `ai-not-configured` is not a fault — it is the documented default. A model is several gigabytes, so a
 * first `docker compose up` deliberately does not download one, and the API starts with chat disabled and
 * everything else working. That makes a red error box the wrong response: nothing is broken, something is
 * simply not switched on yet.
 *
 * So this is a setup page rather than an error. It says what is missing, gives the exact commands, and
 * says plainly which parts of TraceIQ are unaffected — the questions a reader has at that moment.
 */
export function ChatSetup({ detail }: { readonly detail?: string }) {
  return (
    <Card className="mx-auto my-6 max-w-2xl">
      <CardContent className="p-6">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold tracking-tight">Ask TraceIQ needs a language model</h2>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This server started without one, so questions cannot be answered yet. Nothing else is affected —
          the Overview, Explorer, Architecture, Impact and Search all work, because they read the
          repository graph rather than a model.
        </p>

        <p className="mt-4 text-xs font-medium">To switch it on:</p>

        <ol className="mt-2 flex flex-col gap-3">
          <Step
            index={1}
            title="Pull a model"
            detail="Verified with qwen2.5:7b-instruct, about 4.7 GB with a 32k context window."
            command="ollama pull qwen2.5:7b-instruct"
          />
          <Step
            index={2}
            title="Tell the API to use it"
            detail="Set TRACEIQ_MODEL and restart. With Docker, put it in .env and run docker compose up again — the model is pulled once into a persistent volume."
            command="TRACEIQ_MODEL=qwen2.5:7b-instruct"
          />
        </ol>

        <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground">
          The model is never given your source code. It answers from facts the analysis already produced,
          cites them, and carries a verdict saying whether it stayed inside them.
        </p>

        {detail === undefined ? null : (
          <p className="mt-3 border-t border-border pt-3 font-mono text-[11px] text-muted-foreground">
            {detail}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Step({
  index,
  title,
  detail,
  command,
}: {
  readonly index: number;
  readonly title: string;
  readonly detail: string;
  readonly command: string;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold"
      >
        {index}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{detail}</span>
        <code className="mt-1.5 block overflow-x-auto rounded-md border border-border bg-secondary/60 px-3 py-1.5 font-mono text-[11px]">
          {command}
        </code>
      </span>
    </li>
  );
}
