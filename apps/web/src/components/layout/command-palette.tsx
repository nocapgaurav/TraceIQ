'use client';

import { CornerDownLeft, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { InlineLoading } from '@/components/domain/states';
import { KindLabel } from '@/components/domain/node-pill';
import { NAV_ITEMS } from '@/components/layout/nav';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useDebounced } from '@/hooks/use-debounced';
import { useSearch } from '@/hooks/queries';
import { filePathOf, symbolName } from '@/lib/format';
import { linkForNode, routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/store/ui-store';

interface Choice {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly detail: string;
  readonly href: string;
}

/**
 * Keyboard-first navigation.
 *
 * Opened with `⌘K` / `Ctrl+K` from anywhere, driven entirely by arrows and `Enter`, and closed with
 * `Escape`. It is the reason the whole application is reachable without a pointer: sections are always
 * listed, and typing searches the repository through the same `/search` endpoint the Search page uses.
 *
 * Radix's `Dialog` supplies focus trapping and restoration, so no focus is managed by hand here.
 */
export function CommandPalette() {
  const open = useUiStore((state) => state.commandOpen);
  const setOpen = useUiStore((state) => state.setCommandOpen);
  const router = useRouter();
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const debounced = useDebounced(text, 200);
  const search = useSearch({ text: debounced });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [setOpen]);

  const choices = useMemo<readonly Choice[]>(() => {
    const query = text.trim().toLowerCase();

    const sections: Choice[] = NAV_ITEMS.filter((item) => query === '' || item.label.toLowerCase().includes(query)).map(
      (item) => ({ id: `nav:${item.href}`, label: item.label, kind: 'section', detail: item.href, href: item.href }),
    );

    if (search.data === undefined) {
      return sections;
    }

    const groups: readonly [string, readonly { readonly id: string; readonly kind: string }[]][] = [
      ['declaration', search.data.declarations.entries],
      ['file', search.data.files.entries],
      ['route', search.data.routes.entries],
      ['env', search.data.environmentVariables.entries],
      ['external', search.data.externalPackages.entries],
    ];

    const found: Choice[] = groups.flatMap(([, entries]) =>
      entries.slice(0, 6).map((node) => ({
        id: node.id,
        label: node.kind === 'File' ? filePathOf(node.id) : symbolName(node.id),
        kind: node.kind,
        detail: node.id,
        href: linkForNode(node.id),
      })),
    );

    return [...sections, ...found];
  }, [text, search.data]);

  // A shrinking result list must not leave the cursor pointing past the end.
  useEffect(() => {
    setCursor((current) => (current >= choices.length ? 0 : current));
  }, [choices.length]);

  const go = (choice: Choice | undefined): void => {
    if (choice === undefined) {
      return;
    }

    setOpen(false);
    setText('');
    router.push(choice.href);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          setText('');
          setCursor(0);
        }
      }}
    >
      <DialogContent showClose={false} className="p-0" aria-describedby="palette-help">
        <DialogTitle className="sr-only">Search and navigate</DialogTitle>
        <DialogDescription id="palette-help" className="sr-only">
          Type to search the repository. Use the arrow keys to choose a result and Enter to open it.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((current) => (choices.length === 0 ? 0 : (current + 1) % choices.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((current) => (choices.length === 0 ? 0 : (current - 1 + choices.length) % choices.length));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                go(choices[cursor]);
              }
            }}
            placeholder="Search declarations, files, routes…"
            aria-label="Search declarations, files, routes"
            aria-controls="palette-results"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <ul id="palette-results" role="listbox" aria-label="Results" className="max-h-[46vh] overflow-y-auto p-1">
          {search.isFetching && debounced !== '' ? (
            <li className="px-2">
              <InlineLoading label="Searching" />
            </li>
          ) : null}

          {choices.length === 0 && !search.isFetching ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {debounced === '' ? 'Type to search' : `Nothing matches “${debounced}”`}
            </li>
          ) : null}

          {choices.map((choice, index) => (
            <li key={`${choice.kind}:${choice.id}`} role="option" aria-selected={index === cursor}>
              <button
                type="button"
                tabIndex={-1}
                onMouseEnter={() => {
                  setCursor(index);
                }}
                onClick={() => {
                  go(choice);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left',
                  index === cursor ? 'bg-accent text-accent-foreground' : 'text-foreground',
                )}
              >
                <KindLabel kind={choice.kind} className="w-24 shrink-0 text-right" />
                <span className="truncate font-mono text-xs">{choice.label}</span>
                <span className="ml-auto hidden truncate pl-3 text-[11px] text-muted-foreground sm:block">
                  {choice.detail}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" aria-hidden /> open · ↑↓ move · esc close
          </span>
          {search.data === undefined ? null : (
            <a href={routes.search(debounced)} className="underline hover:text-foreground">
              {search.data.total} total results
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
