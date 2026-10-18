// Передача замовлення в API постачальника в картці замовлення (BR-SCON-009…014, BR-PO-011, 012):
// скасування / видалення відправленого — підтвердження «скасуйте в кабінеті постачальника» і повтор
// із force; без зовнішнього замовлення — звичайна помилка без підтвердження. Блок: стан, рядки
// «запитано / підтверджено», «Відправити в API» з Idempotency-Key, прихований без підключення.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PurchaseOrderSupplierApi } from '@/hooks/api/useSupplierApiOrder';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let role = 'STOREKEEPER';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SupplierApiOrderBlock, useSentOrderForce } from '../SupplierApiOrderBlock';

const state = (over: Partial<PurchaseOrderSupplierApi> = {}): PurchaseOrderSupplierApi => ({
  purchaseOrderId: 'po-1',
  supplierApiStatus: 'SENT',
  supplierApiSentAt: '2026-10-18T10:00:00.000Z',
  supplierApiError: null,
  sendMode: 'MANUAL',
  hasConnection: true,
  canSend: false,
  canRelease: false,
  warnings: [],
  orders: [
    {
      id: 'so-1',
      connectionId: 'c',
      connectionName: 'AVD основний',
      provider: 'AVD_TRADE',
      supplierWarehouseCode: null,
      status: 'PLACED',
      step: null,
      externalOrderId: 'ext-1',
      externalNumber: 'AGS0001',
      externalStatusRaw: 'Відправлено на зборку',
      reference: 'ref',
      sentAt: '2026-10-18T10:00:00.000Z',
      confirmedAt: null,
      lastPolledAt: null,
      nextPollAt: null,
      error: null,
      lines: [
        {
          id: 'l-1',
          goodId: 'g',
          goodName: 'Фільтр оливи',
          offerKey: 'k',
          warehouseCode: null,
          qtyRequested: 4,
          qtyConfirmed: 2,
          priceRequested: 100,
          priceConfirmed: null,
          currencyCode: 'UAH',
          statusRaw: null,
        },
      ],
    },
  ],
  ...over,
});

function Harness({ attempt }: { attempt: (force: boolean) => Promise<string> }) {
  const { run, dialogProps } = useSentOrderForce();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void run('po-1', 'cancel', attempt).then(
            r => (document.body.dataset.result = r.done ? r.result : 'declined'),
            (e: Error) => (document.body.dataset.result = `error:${e.message}`),
          )
        }
      >
        Скасувати замовлення
      </button>
      <ConfirmDialog {...dialogProps} />
    </>
  );
}

const withClient = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  apiFetch.mockReset();
  role = 'STOREKEEPER';
  delete document.body.dataset.result;
});

describe('useSentOrderForce — скасування відправленого (BR-SCON-014)', () => {
  // guards: BR-SCON-014
  it('сервер відмовив, замовлення в постачальника → підтвердження → повтор із force', async () => {
    apiFetch.mockResolvedValue(state());
    const attempt = vi
      .fn<(force: boolean) => Promise<string>>()
      .mockRejectedValueOnce(new Error('cancelSentOrder'))
      .mockResolvedValueOnce('скасовано');
    render(<Harness attempt={attempt} />);
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати замовлення' }));
    expect(
      await screen.findByText(/скасуйте його в кабінеті постачальника\. Продовжити скасування/),
    ).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/purchase-orders/po-1/supplier-api');
    fireEvent.click(screen.getByRole('button', { name: 'Так, скасовано в кабінеті' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('скасовано'));
    expect(attempt.mock.calls).toEqual([[false], [true]]);
  });

  // guards: BR-SCON-014
  it('відмова в підтвердженні — без повтору; не відправлене — звичайна помилка без діалогу', async () => {
    apiFetch.mockResolvedValueOnce(state());
    const attempt = vi
      .fn<(force: boolean) => Promise<string>>()
      .mockRejectedValue(new Error('cancelSentOrder'));
    render(<Harness attempt={attempt} />);
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати замовлення' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Скасувати' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('declined'));
    expect(attempt).toHaveBeenCalledTimes(1);

    apiFetch.mockResolvedValueOnce(
      state({ orders: [{ ...state().orders[0]!, status: 'FAILED' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати замовлення' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('error:cancelSentOrder'));
    // Повтору з force не було: обидві спроби — без нього.
    expect(attempt.mock.calls).toEqual([[false], [false]]);
  });

  // guards: BR-SCON-014
  it('масове видалення: відправлені — одне спільне підтвердження і повтор із force, решта відмов лишається', async () => {
    // po-1 видалено одразу; po-2 — у постачальника; po-3 — відмова з іншої причини (не в API).
    apiFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/purchase-orders/po-2/supplier-api'
          ? state({ purchaseOrderId: 'po-2' })
          : state({ purchaseOrderId: 'po-3', orders: [] }),
      ),
    );
    const attempt = vi.fn((id: string, force: boolean) =>
      id === 'po-1' || (id === 'po-2' && force)
        ? Promise.resolve('ok')
        : Promise.reject(new Error(`deny ${id}`)),
    );
    function BulkHarness() {
      const { runMany, dialogProps } = useSentOrderForce();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              void runMany(['po-1', 'po-2', 'po-3'], attempt).then(
                r => (document.body.dataset.result = `${r.succeeded}/${r.failed}`),
              )
            }
          >
            Видалити вибрані
          </button>
          <ConfirmDialog {...dialogProps} />
        </>
      );
    }
    render(<BulkHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Видалити вибрані' }));
    expect(await screen.findByText(/скасуйте його в кабінеті постачальника/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Так, скасовано в кабінеті' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('2/1'));
    expect(attempt.mock.calls).toEqual([
      ['po-1', false],
      ['po-2', false],
      ['po-3', false],
      ['po-2', true],
    ]);
  });
});

describe('SupplierApiOrderBlock', () => {
  // guards: BR-SCON-013
  it('стан передачі: зовнішній номер і статус, рядки «запитано / підтверджено»', async () => {
    apiFetch.mockResolvedValue(state({ supplierApiStatus: 'PARTIAL', canRelease: true }));
    withClient(
      <SupplierApiOrderBlock purchaseOrderId="po-1" poStatus="ORDERED" onChanged={vi.fn()} />,
    );
    expect(await screen.findByTestId('supplier-api-status')).toHaveTextContent(
      'Підтверджено частково',
    );
    expect(screen.getByText('№ у постачальника: AGS0001')).toBeInTheDocument();
    expect(screen.getByText('запитано 4')).toBeInTheDocument();
    expect(screen.getByText('підтверджено 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повернути непідтверджене в список' })).toBeEnabled();
  });

  // guards: BR-SCON-009
  it('«Відправити в API» — підтвердження, POST з Idempotency-Key, картка перечитується', async () => {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/send')
          ? state({ supplierApiStatus: 'QUEUED', orders: [] })
          : state({ supplierApiStatus: 'NOT_SENT', canSend: true, orders: [] }),
      ),
    );
    const onChanged = vi.fn();
    withClient(
      <SupplierApiOrderBlock purchaseOrderId="po-1" poStatus="DRAFT" onChanged={onChanged} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Відправити в API' }));
    expect(
      await screen.findByText('Замовлення перейде в «Замовлено» і буде відправлене постачальнику.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Так' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const send = apiFetch.mock.calls.find(c => String(c[0]).endsWith('/send'))!;
    expect(send[1]).toMatchObject({
      method: 'POST',
      headers: { 'Idempotency-Key': expect.any(String) },
    });
  });

  it('без підключення і передач — блок не показано; бухгалтер бачить стан без кнопок', async () => {
    apiFetch.mockResolvedValue(
      state({ hasConnection: false, orders: [], supplierApiStatus: 'NOT_SENT' }),
    );
    const { container, unmount } = withClient(
      <SupplierApiOrderBlock purchaseOrderId="po-1" poStatus="DRAFT" onChanged={vi.fn()} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="supplier-api-order-block"]')).toBeNull();
    unmount();

    role = 'ACCOUNTANT';
    apiFetch.mockResolvedValue(state({ canSend: true }));
    withClient(
      <SupplierApiOrderBlock purchaseOrderId="po-1" poStatus="ORDERED" onChanged={vi.fn()} />,
    );
    expect(await screen.findByTestId('supplier-api-status')).toHaveTextContent('Відправлено');
    expect(screen.queryByRole('button', { name: 'Відправити в API' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Оновити статус' })).toBeNull();
  });
});
