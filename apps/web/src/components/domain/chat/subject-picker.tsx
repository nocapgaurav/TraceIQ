'use client';

import { Search as SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { InlineLoading } from '@/components/domain/states';
import { KindLabel } from '@/components/domain/node-pill';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/hooks/use-debounced';
import { useSearch } from '@/hooks/queries';
import { describeSubject } from '@/hooks/use-chat';
import { filePathOf, symbolName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ChatSubject } from '@/types/api';

/**
 * Chooses what a conversation is about.
 *
 * **Resolution happens here, through `GET /search` — never in the AI layer.** The chat endpoints refuse a
 * free-text subject on purpose: turning a name into an identifier is repository search, it belongs to the
 * Explorer, and doing it inside the AI path would put repository intelligence there. So this searches, the
 * user picks, and a resolved `ChatSubject` is what reaches the API.
 *
 * Ambiguity is the user's to settle. Nothing here guesses which `Listing` was meant.
 */
const FIXED: readonly { readonly label: string; readonly subject: ChatSubject; readonly detail: string }[] = [
  {
    label: 'The whole repository',
    subject: { kind: 'repository' },
    detail: 'scale, architecture, health and what limits the analysis',
  },
];

export function SubjectPicker({
  subject,
  onChange,
}: {
  readonly subject: ChatSubject;
  readonly onChange: (subject: ChatSubject) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
        className="max-w-full gap-2"
      >
        <SearchIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-mono text-xs">{describeSubject(subject)}</span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
      >
        <DialogContent className="p-0">
          <DialogTitle className="border-b border-border px-4 py-3 text-sm font-semibold">
            What should this conversation be about?
          </DialogTitle>
          <DialogDescription className="px-4 pt-3 text-xs text-muted-foreground">
            Search the repository and choose a declaration, file or package. An answer is grounded only in
            the context assembled for what you pick.
          </DialogDescription>
          <Picker
            onPick={(picked) => {
              onChange(picked);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function Picker({ onPick }: { readonly onPick: (subject: ChatSubject) => void }) {
  const [text, setText] = useState('');
  const debounced = useDebounced(text, 250);
  const search = useSearch({ text: debounced });

  return (
    <div className="flex flex-col">
      <div className="p-4">
        <Input
          autoFocus
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          placeholder="Declaration, file or package…"
          aria-label="Search for a subject"
        />
      </div>

      <div className="max-h-[46vh] overflow-y-auto border-t border-border p-1">
        {debounced === ''
          ? FIXED.map((entry) => (
              <Row
                key={entry.label}
                label={entry.label}
                detail={entry.detail}
                onPick={() => {
                  onPick(entry.subject);
                }}
              />
            ))
          : null}

        {search.isFetching && debounced !== '' ? <InlineLoading label="Searching" /> : null}

        {search.data === undefined || debounced === '' ? null : (
          <>
            {search.data.total === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches “{debounced}”. Matching is exact or by prefix.
              </p>
            ) : null}

            {search.data.declarations.entries.map((node) => (
              <Row
                key={node.id}
                kind={node.kind}
                label={symbolName(node.id)}
                detail={node.id}
                onPick={() => {
                  onPick({ kind: 'symbol', id: node.id });
                }}
                secondary={{
                  label: 'impact',
                  onPick: () => {
                    onPick({ kind: 'impact', id: node.id });
                  },
                }}
              />
            ))}

            {search.data.files.entries.map((node) => (
              <Row
                key={node.id}
                kind="File"
                label={filePathOf(node.id)}
                detail={node.id}
                onPick={() => {
                  onPick({ kind: 'file', path: filePathOf(node.id) });
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  kind,
  label,
  detail,
  onPick,
  secondary,
}: {
  readonly kind?: string;
  readonly label: string;
  readonly detail: string;
  readonly onPick: () => void;
  readonly secondary?: { readonly label: string; readonly onPick: () => void };
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onPick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {kind === undefined ? null : <KindLabel kind={kind} className="w-20 shrink-0 text-right" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
        </span>
      </button>

      {secondary === undefined ? null : (
        <button
          type="button"
          onClick={secondary.onPick}
          title="Ask about what a change here would reach"
          className="shrink-0 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant="outline">{secondary.label}</Badge>
        </button>
      )}
    </div>
  );
}
