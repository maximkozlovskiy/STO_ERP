// Спільні test-утиліти для компонентів/хуків, що використовують React Query.
// Раніше `renderWithQueryClient` дублювався по кількох тест-файлах (Bug review
// simplify/reuse): будь-який компонент з useQuery/useMutation падає з
// "No QueryClient set" без провайдера. retry:false — швидкий fail замість
// повторних спроб, які роздувають час тесту.

import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

/** Свіжий QueryClient без retry — ізоляція між тестами. */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** render() обгорнутий у свіжий QueryClientProvider. */
export function renderWithQueryClient(ui: ReactElement) {
  return render(<QueryClientProvider client={makeTestQueryClient()}>{ui}</QueryClientProvider>);
}

/** Wrapper-компонент для renderHook({ wrapper }). */
export function createQueryWrapper() {
  const qc = makeTestQueryClient();
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}
