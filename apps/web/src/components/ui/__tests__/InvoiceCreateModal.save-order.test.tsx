// BR-INV-024 (як BR-WO-035 наряду): «Зберегти зміни» чернетки рахунку — PATCH шапки → POST нових
// рядків → PATCH змінених (`_dirty`) → DELETE прибраних останнім, усе послідовно. Кількість і ціну
// наявного рядка правлять на місці (PATCH, той самий id), а не видаленням і новим рядком.
//
// Mutation-verify:
//   - DELETE перед POST (старий порядок)              → «порядок» і «збій POST» падають;
//   - PATCH усіх збережених (без `_dirty`)            → «PATCH лише зміненого» падає;
//   - DELETE зупиняється на першій відмові (без try)  → «відмова одного DELETE» падає;
//   - невдалий DELETE не лишається в черзі            → «повтор — лише невидалений» падає.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { InvoiceCreateModal } from '../InvoiceCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const CP = '11111111-1111-4111-8111-111111111111';
const line = (id: string, description: string, quantity: number, unitPrice: number) => ({
  id,
  workId: null,
  goodId: null,
  description,
  quantity,
  unitPrice,
  vatRate: 20,
  priceWithVat: quantity * unitPrice * 1.2,
});
const DOC = {
  id: 'inv-1',
  number: 'РАХ-0042',
  status: 'DRAFT',
  invoiceType: 'STANDARD',
  counterpartyId: CP,
  counterpartyName: 'Клієнт',
  amount: 0,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-28T00:00:00.000Z',
  notes: null,
  deletedAt: null,
  workOrderId: null,
  workOrderNumber: null,
  lines: [
    line('l-a', 'Діагностика', 1, 100),
    line('l-b', 'Мийка', 1, 50),
    line('l-c', 'Огляд', 1, 30),
  ],
};

/** Запити рядків рахунку в порядку відправки: «POST lines», «PATCH l-a», «DELETE l-b». */
const lineCalls = () =>
  apiFetchMock.mock.calls
    .map(([path, init]) => [String(path), (init as { method?: string } | undefined)?.method])
    .filter(([path]) => path!.startsWith('/invoices/inv-1/lines'))
    .map(([path, method]) => `${method} ${path!.replace('/invoices/inv-1/lines', 'lines')}`);

let fail: (path: string, method?: string) => Error | null;

beforeEach(() => {
  fail = () => null;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/invoices/inv-1?withDeleted=true') return Promise.resolve(DOC);
    const err = fail(path, init?.method);
    if (err) return Promise.reject(err);
    return Promise.resolve(path === '/currencies' ? { items: [] } : {});
  });
});

async function openCard() {
  const onClose = vi.fn();
  render(<InvoiceCreateModal open invoiceId="inv-1" onClose={onClose} />);
  await screen.findByLabelText('Кількість: Діагностика');
  return onClose;
}

/** Кількість «Діагностики» 1 → 3, «Мийку» прибрати, нова позиція «Шиномонтаж». */
async function editAndSave() {
  fireEvent.change(screen.getByLabelText('Кількість: Діагностика'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Видалити позицію: Мийка' }));
  fireEvent.click(screen.getByRole('button', { name: 'Додати' }));
  fireEvent.change(screen.getByPlaceholderText('Опис позиції…'), {
    target: { value: 'Шиномонтаж' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
}

describe('Картка рахунку — збереження рядків (BR-INV-024)', () => {
  // guards: BR-INV-024
  it('порядок: POST нового → PATCH зміненого (той самий id) → DELETE прибраного останнім', async () => {
    const onClose = await openCard();
    await editAndSave();
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(lineCalls()).toEqual(['POST lines', 'PATCH lines/l-a', 'DELETE lines/l-b']);
    const patch = apiFetchMock.mock.calls.find(c => c[0] === '/invoices/inv-1/lines/l-a')!;
    expect(JSON.parse(String((patch[1] as { body: string }).body))).toEqual({
      quantity: 3,
      unitPrice: 100,
    });
  });

  // guards: BR-INV-024
  it('PATCH лише зміненого рядка; незмінені («Огляд») не чіпаються', async () => {
    const onClose = await openCard();
    fireEvent.change(screen.getByLabelText('Ціна: Мийка'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(lineCalls()).toEqual(['PATCH lines/l-b']);
  });

  // guards: BR-INV-024
  it('збій POST нового рядка — нічого не змінено й не видалено, картка відкрита з помилкою', async () => {
    fail = (path, method) =>
      method === 'POST' && path === '/invoices/inv-1/lines' ? new Error('Збій мережі') : null;
    const onClose = await openCard();
    await editAndSave();

    expect(await screen.findByText('Збій мережі')).toBeInTheDocument();
    expect(lineCalls()).toEqual(['POST lines']);
    expect(onClose).not.toHaveBeenCalled();
  });

  // guards: BR-INV-024
  it('відмова одного DELETE не зупиняє інших; повтор — лише невидалений рядок', async () => {
    let refuseB = true;
    fail = (path, method) =>
      method === 'DELETE' && path.endsWith('/l-b') && refuseB ? new Error('Рядок зайнятий') : null;
    const onClose = await openCard();
    fireEvent.click(screen.getByRole('button', { name: 'Видалити позицію: Мийка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Видалити позицію: Огляд' }));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    expect(await screen.findByText('Рядок зайнятий')).toBeInTheDocument();
    expect(lineCalls()).toEqual(['DELETE lines/l-b', 'DELETE lines/l-c']);
    expect(onClose).not.toHaveBeenCalled();

    refuseB = false;
    apiFetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(lineCalls()).toEqual(['DELETE lines/l-b']);
  });

  it('змінена кількість — сума рядка з ПДВ пропорційно (120 → 360), «Разом» теж (216 → 456)', async () => {
    await openCard();
    fireEvent.change(screen.getByLabelText('Кількість: Діагностика'), { target: { value: '3' } });
    const sums = screen.getAllByTestId('invoice-line-sum').map(el => el.textContent);
    expect(sums).toEqual(['360,00', '60,00', '36,00']);
    // «Разом» — теж перераховано (watch('lines') віддає той самий масив — мемо за ним лишало 216).
    const totalRow = screen.getByText('Разом:').closest('tr') as HTMLElement;
    expect(totalRow.textContent?.replace(/\s/g, '')).toContain('456,00');
  });
});
