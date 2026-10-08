import { render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * BR-WO-007 — попередній перегляд підсумку в модалці наряду знає режим ПДВ організації й
 * показує ті самі три величини, що збереже бекенд (`WorkOrderTotalsService.recalc`):
 *   «ПДВ зверху»  → без ПДВ = сума рядків, разом = сума рядків + ПДВ
 *   «ПДВ у ціні»  → разом = сума рядків, без ПДВ = сума рядків − ПДВ
 *   без ПДВ       → один підсумок
 * База — фактичні роботи (actualHours ?? normoHours) плюс запчастини.
 *
 * Mutation-verify: (1) передавати в splitVatTotals режим 'EXCLUSIVE' замість vatMode →
 * кейси «ПДВ у ціні» і «без ПДВ» падають; (2) рахувати базу від linesTotals (план) замість
 * actualTotals → кейс «фактичні години» падає; (3) ігнорувати defaultVatRateId → кейс
 * «ставка за замовчуванням з налаштувань» падає.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

type TaxRate = { id: string; rate: number; isDefault: boolean; isActive: boolean };

function mockApi(opts: {
  vatMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';
  taxRates?: TaxRate[];
  defaultVatRateId?: string | null;
  actualHours?: number | null;
}) {
  const taxRates = opts.taxRates ?? [{ id: 'r20', rate: 20, isDefault: true, isActive: true }];
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path.startsWith('/employees')) {
      return Promise.resolve({ items: [{ id: 'e1', firstName: 'Іван', lastName: 'Петров' }] });
    }
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') {
      return Promise.resolve({
        vatMode: opts.vatMode,
        defaultVatRateId: opts.defaultVatRateId ?? null,
      });
    }
    if (path === '/settings/tax-rates') return Promise.resolve(taxRates);
    if (path === '/work-orders/wo-1/linked-documents') {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === '/work-orders/wo-1') {
      return Promise.resolve({
        id: 'wo-1',
        number: 'WO-001',
        status: 'IN_PROGRESS',
        branchId: 'b1',
        vehicleId: 'v1',
        counterpartyId: 'cp1',
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-08',
        plannedAt: null,
        dueDate: null,
        plannedHours: 2,
        actualHours: null,
        lines: [
          {
            id: 'l1',
            workId: 'work-1',
            workName: 'Заміна колодок',
            employeeId: 'e1',
            normoHours: 2,
            actualHours: opts.actualHours ?? null,
            price: 500,
          },
        ],
        parts: [
          {
            id: 'p1',
            goodId: 'g1',
            goodName: 'Колодки',
            warehouseId: 'w1',
            quantity: 1,
            price: 200,
          },
        ],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function openModal() {
  render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
  await screen.findByText('Заміна колодок');
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
}

const row = (testId: string) => norm(screen.getByTestId(testId).textContent);

// guards: BR-WO-007
describe('CreateWorkOrderModal — підсумок з ПДВ за режимом організації', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // Рядки: робота 2 × 500 = 1000, запчастина 1 × 200 = 200 → сума рядків 1200.

  it('«ПДВ зверху» 20%: без ПДВ 1200, ПДВ 240, разом 1440', async () => {
    mockApi({ vatMode: 'EXCLUSIVE' });
    await openModal();

    await waitFor(() => expect(row('vat-totals-gross')).toBe('Разом1 440,00'));
    expect(row('vat-totals-net')).toBe('Сума без ПДВ1 200,00');
    expect(row('vat-totals-vat')).toBe('ПДВ240,00');
  });

  it('«ПДВ у ціні» 20%: разом 1200, ПДВ 200, без ПДВ 1000', async () => {
    mockApi({ vatMode: 'INCLUSIVE' });
    await openModal();

    await waitFor(() => expect(row('vat-totals-vat')).toBe('ПДВ200,00'));
    expect(row('vat-totals-net')).toBe('Сума без ПДВ1 000,00');
    expect(row('vat-totals-gross')).toBe('Разом1 200,00');
  });

  it('без ПДВ: один підсумок 1200, рядків розкладки немає — навіть коли ставка в довіднику є', async () => {
    mockApi({ vatMode: 'NONE' });
    await openModal();

    await waitFor(() => expect(row('vat-totals-gross')).toBe('Разом1 200,00'));
    expect(screen.queryByTestId('vat-totals-net')).toBeNull();
    expect(screen.queryByTestId('vat-totals-vat')).toBeNull();
  });

  it('база — фактичні години: 3 год факту замість 2 планових → 1700 без ПДВ, 2040 разом', async () => {
    mockApi({ vatMode: 'EXCLUSIVE', actualHours: 3 });
    await openModal();

    // 3 × 500 + 200 = 1700; ПДВ 340
    await waitFor(() => expect(row('vat-totals-gross')).toBe('Разом2 040,00'));
    expect(row('vat-totals-net')).toBe('Сума без ПДВ1 700,00');
    expect(row('vat-totals-vat')).toBe('ПДВ340,00');
  });

  it('ставка за замовчуванням береться з налаштувань організації, а не з прапорця isDefault', async () => {
    mockApi({
      vatMode: 'EXCLUSIVE',
      defaultVatRateId: 'r7',
      taxRates: [
        { id: 'r20', rate: 20, isDefault: true, isActive: true },
        { id: 'r7', rate: 7, isDefault: false, isActive: true },
      ],
    });
    await openModal();

    // 1200 × 7% = 84
    await waitFor(() => expect(row('vat-totals-vat')).toBe('ПДВ84,00'));
    expect(row('vat-totals-gross')).toBe('Разом1 284,00');
  });
});
