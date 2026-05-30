import { QueryClient } from '@tanstack/react-query';

// Singleton — не recreate при кожному render
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30s — дані свіжі без refetch
      retry: 1, // один retry на network error
      refetchOnWindowFocus: false, // не refetch при переключенні вкладок (offline-first)
    },
    mutations: {
      retry: 0,
    },
  },
});
