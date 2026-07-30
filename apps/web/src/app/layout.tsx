import type { Metadata, Viewport } from 'next';

import './globals.css';

import { AppShell } from '@/components/layout/app-shell';
import { ErrorBoundary } from '@/components/layout/error-boundary';
import { Providers } from '@/app/providers';

export const metadata: Metadata = {
  title: { default: 'TraceIQ', template: '%s · TraceIQ' },
  description: 'Repository intelligence for TypeScript codebases, derived from static analysis.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1117' },
  ],
};

/**
 * Applies the stored theme before the first paint.
 *
 * Without this the page renders light, then flips once React hydrates and reads the store — a visible
 * flash on every load for a dark-mode user. Inline and synchronous is the only way to run before paint;
 * it reads the same `localStorage` key Zustand's `persist` writes.
 */
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('traceiq-ui');var t=s?JSON.parse(s).state.theme:'system';var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <AppShell>
            {/* One boundary around the page, so a thrown render error costs the page and not the chrome. */}
            <ErrorBoundary label="This page failed to render">{children}</ErrorBoundary>
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
