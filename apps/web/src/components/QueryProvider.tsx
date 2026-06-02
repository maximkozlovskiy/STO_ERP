'use client';

import { type ReactNode, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';

// React Query Devtools — лише у dev режимі.
// next/dynamic + умова process.env.NODE_ENV гарантує що бандл DevTools
// (~1.2 MB) НЕ потрапить у production build (Next.js tree-shake'не false-гілку
// dynamic() через DCE — DevTools chunk існує тільки у dev).
const ReactQueryDevtools =
  process.env.NODE_ENV === 'development'
    ? dynamic(() => import('@tanstack/react-query-devtools').then(m => m.ReactQueryDevtools), {
        ssr: false,
      })
    : null;

// Devtools FAB сидить bottom-left і може перекривати hover-only icon buttons
// у останній колонці таблиць коли Playwright скролить рядок у viewport.
// E2E тести виставляють localStorage('sto_e2e_disable_devtools') = '1'
// через addInitScript у beforeEach — це повністю прибирає DevTools з DOM.
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
