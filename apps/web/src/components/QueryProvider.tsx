'use client';

import { type ReactNode, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';

const ReactQueryDevtools =
  process.env.NODE_ENV === 'development'
    ? dynamic(() => import('@tanstack/react-query-devtools').then(m => m.ReactQueryDevtools), {
        ssr: false,
      })
    : null;

function useDevtoolsEnabled(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return localStorage.getItem('sto_e2e_disable_devtools') !== '1';
      } catch {
        return true;
      }
    },
    () => true,
  );
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const devtoolsEnabled = useDevtoolsEnabled();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {ReactQueryDevtools && devtoolsEnabled && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
