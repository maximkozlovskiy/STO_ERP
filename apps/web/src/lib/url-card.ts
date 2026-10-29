'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { activeDirtyGuard } from '@/lib/dirty-guards';

/**
 * Картка документа в адресі списку: `?open=<id>` (UX-огляд 2026-10-29, частина 3).
 *
 * Адреса — єдине джерело правди: картка відкрита, доки в адресі є `open`. Тому
 *   · посилання `/invoices?open=<id>` відкриває картку (поділитись, нова вкладка, закладка);
 *   · відкриття з рядка списку пише запис в історію (`push`) — «Назад» у браузері закриває картку;
 *   · закриття картки (×, Escape, «Скасувати») повертає на крок назад, якщо картку відкрили тут, і
 *     прибирає `open` без нового запису, якщо прийшли за посиланням (інакше «Назад» вивів би зі
 *     сторінки на ту, звідки прийшли, а картка лишилась би відкритою);
 *   · «Назад» при незбережених змінах (`useDirtyForm`, `lib/dirty-guards.ts`) картку не закриває:
 *     адреса повертається (`push`), і форма питає тим самим вікном «Є незбережені зміни», що й «×».
 *     «Скасувати» — картка лишається з `open` в адресі; «Покинути» — крок назад до списку.
 * Решта параметрів адреси (`tab`, фільтри) зберігається.
 */
export const URL_CARD_PARAM = 'open';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Адреса списку з `open=<id>` (або без нього, коли `id` — `null`); решта параметрів лишається. */
export function urlCardHref(
  pathname: string,
  search: string,
  id: string | null,
  param: string = URL_CARD_PARAM,
): string {
  const params = new URLSearchParams(search);
  if (id) params.set(param, id);
  else params.delete(param);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Валідний id картки з адреси; будь-що інше — `null` (картка не відкривається). */
export function parseUrlCardId(raw: string | null | undefined): string | null {
  return raw && UUID_RE.test(raw) ? raw : null;
}

export interface UrlCard {
  /** id картки, відкритої за адресою, або `null`. */
  id: string | null;
  /** Відкрити картку: новий запис в історії (поверх уже відкритої — заміна). */
  open: (id: string) => void;
  /** Закрити картку. Повторний виклик до оновлення адреси нічого не робить. */
  close: () => void;
  /** Адреса картки — для `<a href>` (середня кнопка миші, «Відкрити в новій вкладці»). */
  hrefFor: (id: string) => string;
}

export function useUrlCard(param: string = URL_CARD_PARAM): UrlCard {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const rawId = parseUrlCardId(searchParams?.get(param));

  // Запис в історії з карткою зробили ми — тоді закриття = крок назад.
  const pushedRef = useRef(false);
  // Закриття вже пішло (router.back асинхронний): другий виклик не має відступити ще на крок.
  const closingRef = useRef(false);
  // Картка, показана минулого рендеру, і запит «Є незбережені зміни», що вже чекає відповіді.
  const shownRef = useRef<string | null>(rawId);
  const askingRef = useRef(false);

  // `open` зник з адреси не нашим закриттям («Назад» у браузері), а форма брудна — картку тримаємо
  // вже в цьому рендері: кадр із закритою карткою скинув би введене.
  const hold =
    !rawId &&
    !!shownRef.current &&
    !closingRef.current &&
    (askingRef.current || activeDirtyGuard() !== null);
  const id = hold ? shownRef.current : rawId;
  useEffect(() => {
    shownRef.current = id;
  });

  useEffect(() => {
    if (!hold || !id) return;
    // Адресу картки повертаємо новим записом: тоді «Покинути» — один крок назад до списку.
    pushedRef.current = true;
    router.push(urlCardHref(pathname, search, id, param), { scroll: false });
    if (askingRef.current) return;
    askingRef.current = true;
    const guard = activeDirtyGuard();
    void (guard ? guard.confirm() : Promise.resolve(true)).then(leave => {
      askingRef.current = false;
      if (!leave) return;
      closingRef.current = true;
      pushedRef.current = false;
      router.back();
    });
  }, [hold, id, router, pathname, search, param]);

  useEffect(() => {
    closingRef.current = false;
    if (!id) pushedRef.current = false;
  }, [id]);

  const hrefFor = useCallback(
    (next: string) => urlCardHref(pathname, search, next, param),
    [pathname, search, param],
  );

  const open = useCallback(
    (next: string) => {
      const href = urlCardHref(pathname, search, next, param);
      if (id) {
        router.replace(href, { scroll: false });
        return;
      }
      pushedRef.current = true;
      router.push(href, { scroll: false });
    },
    [router, pathname, search, param, id],
  );

  const close = useCallback(() => {
    if (!id || closingRef.current) return;
    closingRef.current = true;
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
      return;
    }
    router.replace(urlCardHref(pathname, search, null, param), { scroll: false });
  }, [router, pathname, search, param, id]);

  return { id, open, close, hrefFor };
}
