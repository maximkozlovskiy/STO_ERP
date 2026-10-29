// Картка документа в адресі списку `?open=<id>` (UX-огляд 2026-10-29, частина 3): посилання
// відкриває картку, відкриття з рядка пише запис в історію, «Назад» закриває картку, а закриття
// картки, відкритої за посиланням, не виводить зі сторінки.
//
// Mutation-verify (2026-10-29): `open` через `replace` замість `push` → падає «відкриття — новий
// запис»; `close` завжди `back()` → падає «прийшли за посиланням»; без `closingRef` → падає
// «подвійне закриття».
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUrlCardId, urlCardHref, useUrlCard } from '../url-card';
import { registerDirtyGuard } from '../dirty-guards';

let search = '';
const history: string[] = [];
const push = vi.fn((href: string) => {
  history.push(href);
  search = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
});
const replace = vi.fn((href: string) => {
  history[history.length - 1] = href;
  search = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
});
const back = vi.fn(() => {
  history.pop();
  const href = history.at(-1) ?? '/invoices';
  search = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/invoices',
}));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function start(initial: string) {
  search = initial;
  history.length = 0;
  history.push(initial ? `/invoices?${initial}` : '/invoices');
  return renderHook(() => useUrlCard());
}

describe('urlCardHref / parseUrlCardId', () => {
  it('ставить і знімає open, решта параметрів лишається', () => {
    expect(urlCardHref('/invoices', 'tab=x&page=2', A)).toBe(`/invoices?tab=x&page=2&open=${A}`);
    expect(urlCardHref('/invoices', `tab=x&open=${A}`, null)).toBe('/invoices?tab=x');
    expect(urlCardHref('/invoices', `open=${A}`, null)).toBe('/invoices');
    expect(urlCardHref('/purchase-orders', '', B, 'openReturn')).toBe(
      `/purchase-orders?openReturn=${B}`,
    );
  });

  it('id — лише UUID', () => {
    expect(parseUrlCardId(A)).toBe(A);
    expect(parseUrlCardId('abc')).toBeNull();
    expect(parseUrlCardId(null)).toBeNull();
  });
});

describe('useUrlCard', () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    back.mockClear();
  });

  it('посилання з open відкриває картку; невалідний id — ні', () => {
    expect(start(`open=${A}`).result.current.id).toBe(A);
    expect(start('open=garbage').result.current.id).toBeNull();
  });

  it('відкриття з рядка — новий запис в історії; закриття — крок назад', () => {
    const { result, rerender } = start('tab=list');
    act(() => result.current.open(A));
    expect(push).toHaveBeenCalledWith(`/invoices?tab=list&open=${A}`, { scroll: false });
    rerender();
    expect(result.current.id).toBe(A);

    act(() => result.current.close());
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    rerender();
    expect(result.current.id).toBeNull();
    expect(history).toEqual(['/invoices?tab=list']);
  });

  it('«Назад» у браузері (адреса без open) закриває картку', () => {
    const { result, rerender } = start('');
    act(() => result.current.open(A));
    rerender();
    expect(result.current.id).toBe(A);
    back();
    rerender();
    expect(result.current.id).toBeNull();
  });

  it('прийшли за посиланням — закриття прибирає open без кроку назад (не вивести зі сторінки)', () => {
    const { result, rerender } = start(`tab=list&open=${A}`);
    act(() => result.current.close());
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/invoices?tab=list', { scroll: false });
    rerender();
    expect(result.current.id).toBeNull();
  });

  it('подвійне закриття до оновлення адреси — лише один крок назад', () => {
    const { result, rerender } = start('');
    act(() => result.current.open(A));
    rerender();
    const { close } = result.current;
    act(() => {
      close();
      close();
    });
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('відкриття іншої картки поверх відкритої — заміна, не новий запис', () => {
    const { result, rerender } = start('');
    act(() => result.current.open(A));
    rerender();
    act(() => result.current.open(B));
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/invoices?open=${B}`, { scroll: false });
    rerender();
    act(() => result.current.close());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('hrefFor — адреса картки з поточними параметрами (для нової вкладки)', () => {
    const { result } = start('page=3');
    expect(result.current.hrefFor(B)).toBe(`/invoices?page=3&open=${B}`);
  });
});

// «Назад» при незбережених змінах (рішення власника 2026-10-29): картка лишається, адреса з `open`
// повертається, форма питає своїм вікном; «Скасувати» — лишитись, «Покинути» — один крок назад.
// Mutation-verify (2026-10-29): без `hold` у рендері → падають обидва кейси «брудна форма»; без
// `router.push` у відновленні → падає «адреса повертається».
describe('useUrlCard — «Назад» при незбережених змінах', () => {
  let dirty = false;
  let answer: (leave: boolean) => void = () => {};
  const confirm = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        answer = resolve;
      }),
  );
  let unregister: () => void = () => {};

  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    back.mockClear();
    confirm.mockClear();
    dirty = true;
    unregister = registerDirtyGuard({ isDirty: () => dirty, confirm });
  });
  afterEach(() => unregister());

  const openThenBack = () => {
    const hook = start('tab=list');
    act(() => hook.result.current.open(A));
    hook.rerender();
    back(); // «Назад» у браузері
    hook.rerender();
    return hook;
  };

  it('брудна форма: картка лишається, адреса з open повертається, питає форма; «Скасувати» — лишитись', async () => {
    const { result, rerender } = openThenBack();
    expect(result.current.id).toBe(A);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenLastCalledWith(`/invoices?tab=list&open=${A}`, { scroll: false });
    await act(async () => answer(false));
    rerender();
    expect(result.current.id).toBe(A);
    expect(search).toBe(`tab=list&open=${A}`);
    expect(back).toHaveBeenCalledTimes(1); // лише браузерний «Назад»
  });

  it('брудна форма, «Покинути» — один крок назад до списку, картка закрита', async () => {
    const { result, rerender } = openThenBack();
    await act(async () => answer(true));
    rerender();
    expect(back).toHaveBeenCalledTimes(2); // браузерний + наш один
    expect(search).toBe('tab=list');
    expect(result.current.id).toBeNull();
    expect(history).toEqual(['/invoices?tab=list']);
  });

  it('чиста форма — «Назад» закриває картку без запиту', () => {
    dirty = false;
    const { result } = openThenBack();
    expect(result.current.id).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});

// Один хелпер для всіх списків: кожен список з карткою документа тримає її в адресі через
// `useUrlCard` (а не одноразове читання `open` при монтуванні, що чистило адресу).
describe('списки з карткою в адресі', () => {
  const APP = resolve(__dirname, '../../app/(app)');
  it.each([
    'work-orders/page.tsx',
    'invoices/page.tsx',
    'purchase-orders/page.tsx',
    'stock-documents/page.tsx',
    'tasks/page.tsx',
    'counterparties/page.tsx',
  ])('%s — useUrlCard', file => {
    const text = readFileSync(resolve(APP, file), 'utf8');
    expect(text).toMatch(/useUrlCard\(\)/);
    expect(text).not.toMatch(/params\.delete\('open'\)/);
  });
});
