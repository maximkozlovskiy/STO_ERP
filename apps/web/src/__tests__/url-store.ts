// Реактивна адреса для тестів сторінок-списків: `next/navigation` з `push` / `replace` / `back`, що
// справді змінюють параметри адреси й перемальовують сторінку. Потрібна, відколи картка документа
// живе в адресі (`?open=<id>`, `lib/url-card.ts`): клік по рядку пише адресу, а картку відкриває вже
// нова адреса — статичний `useSearchParams` такого не показав би.
//
// Підключення (фабрика `vi.mock` піднімається вгору файла, тож — через динамічний імпорт):
//   vi.mock('next/navigation', async () =>
//     (await import('@/__tests__/url-store')).navigationMock('/invoices'));
//   beforeEach(() => urlStore.reset());
import { useMemo, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

let search = '';
const history: string[] = [''];
const listeners = new Set<() => void>();

const searchOf = (href: string) => (href.includes('?') ? href.slice(href.indexOf('?') + 1) : '');
const set = (next: string) => {
  search = next;
  listeners.forEach(l => l());
};

export const urlStore = {
  /** Поточні параметри адреси (без `?`). */
  get search(): string {
    return search;
  },
  /** Почати з чистої історії (і, за потреби, з параметрами `initial`). */
  reset(initial = ''): void {
    history.length = 0;
    history.push(initial);
    search = initial;
    router.push.mockClear();
    router.replace.mockClear();
    router.back.mockClear();
  },
};

const router = {
  push: vi.fn((href: string) => {
    history.push(searchOf(href));
    set(searchOf(href));
  }),
  replace: vi.fn((href: string) => {
    history[history.length - 1] = searchOf(href);
    set(searchOf(href));
  }),
  back: vi.fn(() => {
    if (history.length > 1) history.pop();
    set(history.at(-1) ?? '');
  }),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function navigationMock(pathname: string) {
  return {
    useRouter: () => router,
    usePathname: () => pathname,
    useSearchParams: () => {
      const s = useSyncExternalStore(
        subscribe,
        () => search,
        () => search,
      );
      return useMemo(() => new URLSearchParams(s), [s]);
    },
  };
}
