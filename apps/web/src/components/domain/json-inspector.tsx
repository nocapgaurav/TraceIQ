'use client';

import { AlertTriangle } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { bytes } from '@/lib/format';
import { resolveDark } from '@/lib/theme';
import { useUiStore } from '@/store/ui-store';

/**
 * Monaco, as a read-only inspector for the exact payload a page was rendered from.
 *
 * **Why not a source viewer.** Monaco is in the approved stack, but the REST API exposes no file
 * contents: no endpoint returns source text, and the backend deliberately never serves it. Rather than
 * add a backend endpoint — the backend is frozen for this milestone — Monaco is put to the use the API
 * does support: showing the raw JSON behind the view, with folding, search and structural navigation.
 * That makes every page auditable against the API response that produced it. Raised as an approval item
 * in the milestone report.
 *
 * Loaded through `next/dynamic` with `ssr: false`: Monaco touches `window` on import, so rendering it on
 * the server would throw, and it is far too large to belong in the initial bundle of every page.
 */
const MonacoEditor = dynamic(async () => (await import('@monaco-editor/react')).default, {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/**
 * How long to wait for the editor before falling back to plain text.
 *
 * `@monaco-editor/react` fetches Monaco's assets at runtime, so an offline or blocked environment leaves
 * the editor spinning forever. A payload is the point of this panel, and it should never be unreachable
 * because a large asset did not arrive.
 */
const LOAD_TIMEOUT_MS = 8000;

export function JsonInspector({
  value,
  height = 420,
  label = 'Raw API payload',
}: {
  readonly value: unknown;
  readonly height?: number;
  readonly label?: string;
}) {
  const theme = useUiStore((state) => state.theme);
  const [dark, setDark] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const mounted = useRef(false);

  // Resolved on the client only: `resolveDark` consults `matchMedia`, which does not exist on the server,
  // so reading it during render would make the server markup differ from the client's.
  useEffect(() => {
    setDark(resolveDark(theme));
  }, [theme]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!mounted.current) {
        setState('unavailable');
      }
    }, LOAD_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  const text = JSON.stringify(value, null, 2);
  const size = new TextEncoder().encode(text).length;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{bytes(size)}</span>
      </div>

      {state === 'unavailable' ? (
        <>
          <p className="flex items-center gap-2 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            the editor could not be loaded — showing plain text instead
          </p>
          <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px]">
            {text}
          </pre>
        </>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border" style={{ height }}>
          <MonacoEditor
            height={height}
            language="json"
            value={text}
            theme={dark ? 'vs-dark' : 'light'}
            loading={<Skeleton className="h-full w-full" />}
            onMount={() => {
              mounted.current = true;
              setState('ready');
            }}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              folding: true,
              scrollBeyondLastLine: false,
              renderLineHighlight: 'none',
              wordWrap: 'on',
              automaticLayout: true,
              // Read-only: no suggestions and no formatting, so nothing implies the text can be edited.
              quickSuggestions: false,
              occurrencesHighlight: 'off',
            }}
          />
        </div>
      )}
    </div>
  );
}
