'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { useTheme } from '@/hooks/use-theme';

/**
 * The client-side providers.
 *
 * The `QueryClient` is created in state rather than at module scope: a module-level client would be
 * shared between requests on the server, so one user's cache could answer another's request.
 */
export function Providers({ children }: { readonly children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A graph does not change until the next scan, so refetching on focus is pure noise.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  useTheme();

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
