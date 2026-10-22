// Вкладка «Гарантії» сторінки нарядів (BR-WAR-005, рішення власника 2026-10-22): список за
// стандартом списків — рядки з API, фільтр стану й пошук ідуть у запит, «Звернення» лише для
// чинних гарантій і ролей із правом, вікно звернення — наряди того самого клієнта без скасованих,
// після звернення список перечитується, `?open=` відкриває гарантію в панелі.

import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const push = vi.fn();
const replace = vi.fn();
const router = { push, replace };
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/work-orders',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));

import WarrantiesTab from '../WarrantiesTab';

const W_ID = '11111111-1111-4111-8111-111111111111';
const W2_ID = '22222222-2222-4222-8222-222222222222';
const W3_ID = '33333333-3333-4333-8333-333333333333';
const ROW = {
  id: W_ID,
  orgId: 'org-1',
  workOrderId: 'wo-1',
  counterpartyId: 'cp-1',
  expiresAt: '2026-11-20T00:00:00.000Z',
  description: 'Гарантія на виконані роботи',
  claimedAt: null,
  claimWoId: null,
  isActive: true,
  createdAt: '2026-10-21T08:00:00.000Z',
  workOrderNumber: 'НРД-2026-000101',
  counterpartyName: 'Петренко Іван',
  vehicleSummary: 'Toyota Corolla (AA1234BB)',
  state: 'EXPIRING' as const,
};
const ROWS = [
  ROW,
  {
    ...ROW,
    id: W2_ID,
    workOrderNumber: 'НРД-2026-000102',
    state: 'EXPIRED' as const,
    isActive: false,
  },
  {
    ...ROW,
    id: W3_ID,
    workOrderNumber: 'НРД-2026-000103',
    state: 'CLAIMED' as const,
    isActive: false,
    claimedAt: '2026-10-20T08:00:00.000Z',
  },
];
const CLIENT_WOS = [
  { id: 'wo-new', number: 'НРД-2026-000200', status: 'DRAFT', vehicleSummary: 'Toyota Corolla' },
  { id: 'wo-cancel', number: 'НРД-2026-000201', status: 'CANCELLED', vehicleSummary: null },
  // Наряд, що видав гарантію `ROW` (Bug #940): у переліку звернення його бути не має.
  { id: 'wo-1', number: 'НРД-2026-000101', status: 'COMPLETED', vehicleSummary: 'Toyota Corolla' },
];

const warrantyCalls = () =>
  apiFetchMock.mock.calls.map(c => String(c[0])).filter(p => p.startsWith('/warranties?'));

function renderTab(canClaim = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WarrantiesTab canClaim={canClaim} />
    </QueryClientProvider>,
  );
}

const rowOf = (number: string) => screen.getByText(number).closest('tr') as HTMLElement;
// Стан — кнопками в рядку над пошуком; кнопка стану «Звернення» має ту саму назву, що й дія
// «Звернення» в рядку й панелі, тож дію шукаємо поза групою станів.
const stateGroup = () => screen.getByRole('group', { name: 'Стан' });
const claimButtons = () =>
  screen.queryAllByRole('button', { name: 'Звернення' }).filter(b => !stateGroup().contains(b));

describe('Вкладка «Гарантії»', () => {
  beforeEach(() => {
    localStorage.clear();
    search = '';
    push.mockReset();
    replace.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path.startsWith('/warranties?')) {
        const id = new URLSearchParams(path.split('?')[1]).get('id');
        const items = id ? ROWS.filter(r => r.id === id) : ROWS;
        return Promise.resolve({ items, total: items.length, page: 1, limit: 20 });
      }
      if (path.startsWith('/work-orders?')) {
        return Promise.resolve({ items: CLIENT_WOS, total: 2, page: 1, limit: 100 });
      }
      if (init?.method === 'POST' && path.endsWith('/claim')) {
        return Promise.resolve({ ...ROW, claimWoId: 'wo-new' });
      }
      return Promise.resolve({});
    });
  });

  // guards: BR-WAR-005
  it('рядок: № наряду — посилання на наряд, клієнт / авто, опис, дати DD.MM.YYYY, мітка стану', async () => {
    renderTab();
    const link = await screen.findByRole('link', { name: 'НРД-2026-000101' });

    expect(link).toHaveAttribute('href', '/work-orders/wo-1');
    const row = rowOf('НРД-2026-000101');
    expect(within(row).getByText('Петренко Іван')).toBeInTheDocument();
    expect(within(row).getByText('Toyota Corolla (AA1234BB)')).toBeInTheDocument();
    expect(within(row).getByText('Гарантія на виконані роботи')).toBeInTheDocument();
    expect(within(row).getByText('21.10.2026')).toBeInTheDocument();
    expect(within(row).getByText('20.11.2026')).toBeInTheDocument();
    expect(within(row).getByText('Закінчується')).toBeInTheDocument();
    expect(within(rowOf('НРД-2026-000102')).getByText('Закінчилась')).toBeInTheDocument();
    expect(within(rowOf('НРД-2026-000103')).getByText('Звернення')).toBeInTheDocument();
  });

  // guards: BR-WAR-005
  it('перший запит — сторінка 1, порядок за «Дійсна до» за зростанням', async () => {
    renderTab();
    await screen.findByText('НРД-2026-000101');

    const params = new URLSearchParams(warrantyCalls()[0].split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({
      page: '1',
      limit: '20',
      sortBy: 'expiresAt',
      sortDir: 'asc',
    });
  });

  // guards: BR-WAR-005
  it('фільтр стану і пошук ідуть у запит (`state=`, `q=`)', async () => {
    renderTab();
    await screen.findByText('НРД-2026-000101');

    const expiring = within(stateGroup()).getByRole('button', { name: 'Закінчується' });
    fireEvent.click(expiring);
    expect(expiring).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(warrantyCalls().some(p => p.includes('state=EXPIRING'))).toBe(true));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'AA1234' } });
    await waitFor(
      () =>
        expect(
          warrantyCalls().some(p => p.includes('q=AA1234') && p.includes('state=EXPIRING')),
        ).toBe(true),
      { timeout: 2000 },
    );
    // Поле пошуку обмежене, як `@MaxLength(100)` запиту (Bug #816).
    expect(screen.getByRole('textbox')).toHaveAttribute('maxLength', '100');
  });

  // Стандарт списку (рішення власника 2026-10-22): стани — кнопками окремим рядком над пошуком.
  it('стан — кнопки окремим рядком над пошуком; «Всі» активна й знімає state', async () => {
    renderTab();
    await screen.findByText('НРД-2026-000101');

    const group = stateGroup();
    expect(
      within(group)
        .getAllByRole('button')
        .map(b => b.textContent),
    ).toEqual(['Всі', 'Діє', 'Закінчується', 'Закінчилась', 'Звернення']);
    expect(within(group).getByRole('button', { name: 'Всі' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const search = screen.getByRole('textbox');
    expect(group.contains(search)).toBe(false);
    expect(group.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(group).getByRole('button', { name: 'Закінчилась' }));
    await waitFor(() => expect(warrantyCalls().at(-1)).toContain('state=EXPIRED'));
    // Запит без стану вже в кеші — нового виклику немає; стан повертається до «Всі».
    fireEvent.click(within(group).getByRole('button', { name: 'Всі' }));
    expect(within(group).getByRole('button', { name: 'Всі' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Закінчилась' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(await screen.findByText('НРД-2026-000101')).toBeInTheDocument();
  });

  // guards: BR-WAR-005
  it('«Звернення» — лише для чинної гарантії (діє / закінчується)', async () => {
    renderTab();
    await screen.findByText('НРД-2026-000101');

    expect(
      within(rowOf('НРД-2026-000101')).getByRole('button', { name: 'Звернення' }),
    ).toBeVisible();
    expect(
      within(rowOf('НРД-2026-000102')).queryByRole('button', { name: 'Звернення' }),
    ).toBeNull();
    expect(
      within(rowOf('НРД-2026-000103')).queryByRole('button', { name: 'Звернення' }),
    ).toBeNull();
  });

  // guards: BR-WAR-005
  it('роль без права на звернення (бухгалтер) — кнопки «Звернення» немає ні в рядку, ні в панелі', async () => {
    renderTab(false);
    await screen.findByText('НРД-2026-000101');

    expect(claimButtons()).toHaveLength(0);
    fireEvent.click(rowOf('НРД-2026-000101'));
    await screen.findByRole('heading', { level: 2, name: 'НРД-2026-000101' });
    expect(claimButtons()).toHaveLength(0);
  });

  // guards: BR-WAR-005
  it('вікно звернення: наряди клієнта без скасованих → POST claim → список перечитано', async () => {
    renderTab();
    await screen.findByText('НРД-2026-000101');
    const before = warrantyCalls().length;

    fireEvent.click(within(rowOf('НРД-2026-000101')).getByRole('button', { name: 'Звернення' }));
    const dialog = await screen.findByRole('dialog', { name: 'Звернення за гарантією' });
    const select = await within(dialog).findByRole('combobox', { name: 'Наряд-звернення' });

    expect(
      apiFetchMock.mock.calls.some(
        c =>
          String(c[0]).startsWith('/work-orders?') && String(c[0]).includes('counterpartyId=cp-1'),
      ),
    ).toBe(true);
    const options = within(select)
      .getAllByRole('option')
      .map(o => o.textContent);
    expect(options.some(o => o?.includes('НРД-2026-000200'))).toBe(true);
    expect(options.some(o => o?.includes('НРД-2026-000201'))).toBe(false);
    // guards: BR-WAR-004 — наряд, що видав гарантію, звернення не оформлює (Bug #940)
    expect(options.some(o => o?.includes('НРД-2026-000101'))).toBe(false);

    fireEvent.change(select, { target: { value: 'wo-new' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Записати звернення' }));
    });

    const post = apiFetchMock.mock.calls.find(c => String(c[0]) === `/warranties/${W_ID}/claim`);
    expect(post?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ claimWoId: 'wo-new' }),
    });
    await waitFor(() => expect(warrantyCalls().length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Звернення за гарантією' })).toBeNull(),
    );
  });

  // guards: BR-WAR-005
  it('вікно для гарантії іншого клієнта не показує наряди попереднього, доки не прийшли свої', async () => {
    const other = { ...ROW, id: W2_ID, counterpartyId: 'cp-2', workOrderNumber: 'НРД-2026-000102' };
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/warranties?'))
        return Promise.resolve({ items: [ROW, other], total: 2, page: 1, limit: 20 });
      if (path.startsWith('/work-orders?') && path.includes('counterpartyId=cp-1'))
        return Promise.resolve({ items: CLIENT_WOS, total: 2 });
      return new Promise(() => {}); // наряди cp-2 ще в дорозі
    });
    renderTab();
    await screen.findByText('НРД-2026-000101');

    fireEvent.click(within(rowOf('НРД-2026-000101')).getByRole('button', { name: 'Звернення' }));
    let dialog = await screen.findByRole('dialog', { name: 'Звернення за гарантією' });
    await within(dialog).findByRole('combobox', { name: 'Наряд-звернення' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Звернення за гарантією' })).toBeNull(),
    );

    fireEvent.click(within(rowOf('НРД-2026-000102')).getByRole('button', { name: 'Звернення' }));
    dialog = await screen.findByRole('dialog', { name: 'Звернення за гарантією' });
    expect(within(dialog).queryByRole('combobox', { name: 'Наряд-звернення' })).toBeNull();
    expect(within(dialog).queryByText(/НРД-2026-000200/)).toBeNull();
  });

  // guards: BR-WAR-005
  it('відмова сервера (вже використано) — текст у вікні, вікно лишається', async () => {
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.reject(new Error('Гарантія вже використана'));
      if (path.startsWith('/work-orders?')) return Promise.resolve({ items: CLIENT_WOS, total: 2 });
      return Promise.resolve({ items: ROWS, total: 3, page: 1, limit: 20 });
    });
    renderTab();
    await screen.findByText('НРД-2026-000101');

    fireEvent.click(within(rowOf('НРД-2026-000101')).getByRole('button', { name: 'Звернення' }));
    const dialog = await screen.findByRole('dialog', { name: 'Звернення за гарантією' });
    fireEvent.change(await within(dialog).findByRole('combobox', { name: 'Наряд-звернення' }), {
      target: { value: 'wo-new' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Записати звернення' }));
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Гарантія вже використана');
    expect(screen.getByRole('dialog', { name: 'Звернення за гарантією' })).toBeInTheDocument();
  });

  // guards: BR-WAR-005
  it('`?open=<id>` відкриває гарантію в панелі й прибирає параметр з адреси', async () => {
    search = `tab=warranties&open=${W2_ID}`;
    renderTab();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'НРД-2026-000102' }),
    ).toBeInTheDocument();
    expect(warrantyCalls().some(p => p.includes(`id=${W2_ID}`))).toBe(true);
    expect(replace).toHaveBeenCalledWith('/work-orders?tab=warranties', { scroll: false });
  });

  // guards: BR-WAR-005
  it('гарантія, відкрита посиланням поза сторінкою списку, після звернення бере новий стан', async () => {
    let claimed = false;
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && path.endsWith('/claim')) {
        claimed = true;
        return Promise.resolve({ ...ROW, claimWoId: 'wo-new' });
      }
      if (path.startsWith('/warranties?')) {
        const id = new URLSearchParams(path.split('?')[1]).get('id');
        if (id) {
          const row = claimed
            ? { ...ROW, state: 'CLAIMED' as const, claimedAt: '2026-10-22T08:00:00.000Z' }
            : ROW;
          return Promise.resolve({ items: [row], total: 1, page: 1, limit: 1 });
        }
        // Гарантії з посилання на поточній сторінці списку немає.
        return Promise.resolve({ items: ROWS.slice(1), total: 2, page: 1, limit: 20 });
      }
      if (path.startsWith('/work-orders?')) return Promise.resolve({ items: CLIENT_WOS, total: 2 });
      return Promise.resolve({});
    });
    search = `tab=warranties&open=${W_ID}`;
    // Як справжній роутер: після `replace` параметра `open` в адресі вже немає.
    replace.mockImplementation(() => {
      search = 'tab=warranties';
    });
    renderTab();
    await screen.findByRole('heading', { level: 2, name: 'НРД-2026-000101' });

    await waitFor(() => expect(claimButtons()).toHaveLength(1));
    fireEvent.click(claimButtons()[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Звернення за гарантією' });
    fireEvent.change(await within(dialog).findByRole('combobox', { name: 'Наряд-звернення' }), {
      target: { value: 'wo-new' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Записати звернення' }));
    });

    await waitFor(() => expect(claimButtons()).toHaveLength(0));
    expect(screen.getByRole('heading', { level: 2, name: 'НРД-2026-000101' })).toBeInTheDocument();
  });

  it('клік по рядку з вимкненою панеллю веде на наряд', async () => {
    localStorage.setItem('sto_detail_panel_work-orders-warranties', 'false');
    renderTab();
    await screen.findByText('НРД-2026-000101');
    await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(rowOf('НРД-2026-000101'));

    expect(push).toHaveBeenCalledWith('/work-orders/wo-1');
  });
});
