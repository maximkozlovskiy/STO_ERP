'use client';

import { type ReactNode } from 'react';
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

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {ReactQueryDevtools && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
