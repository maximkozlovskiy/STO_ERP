// Картка сторно касової операції (BR-CASH-023…025).
//
// Що стереже:
//   - картка показує, що саме сторнується (дата, операція, сума, контрагент, підстава), і що
//     станеться — за приводом оригіналу (оплата контрагента / постачальнику / решта);
//   - причина обов'язкова (спільна `cashReversalSchema`): порожня чи з пробілів — без запиту;
//   - «Сторнувати» спершу просить підтвердження; запит іде лише з «Так, сторнувати»;
//   - тіло POST …/operations/:operationId/reverse — рівно `{ reason }` (обрізана), ключ — у
//     заголовку `Idempotency-Key`, один на відкриття картки (і після збою той самий);
//   - подвійний клік по підтвердженню — один запит;
//   - відмова сервера лишається в картці (`role="alert"`), картка не закривається;
//   - Escape з уведеною причиною — запит «Є незбережені зміни»; без причини — закриття одразу.
//
// Mutation-verify:
//   - `if (!operation || savingRef.current) return` → прибрати `savingRef.current` → «подвійний клік» падає;
//   - `idempotencyKeyRef.current = newIdempotencyKey()` перенести в `reverse` → «той самий ключ» падає;
//   - прибрати гілку `if (confirming)` (одразу reverse) → «спершу підтвердження» падає;
//   - прибрати `dirty.markDirty()` у close → «Escape з причиною» падає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => `дата ${v.slice(0, 10)}`,
}));

import { CashReversalModal } from '../CashReversalModal';
import { makeTestQueryClient } from '@/__tests__/query-utils';
import type { CashOperation } from '@/hooks/api/useCash';

const REG = 'reg-1';
const OP = 'op-1';
const REVERSE_PATH = `/cash-registers/${REG}/operations/${OP}/reverse`;

type Init = { method?: string; body?: string; headers?: Record<string, string> };

const operation = (over: Partial<CashOperation> = {}): CashOperation => ({
  id: OP,
  cashRegisterId: REG,
  direction: 'IN',
  amount: 1250,
  reason: 'SALE_PAYMENT',
  counterpartyName: 'Коваль Олег',
  baseDocumentType: 'WorkOrder',
  baseDocumentId: 'wo-1',
  baseDocumentNumber: 'НЗ-000012',
  documentType: 'Payment',
  documentId: 'pay-1',
  createdAt: '2026-10-14T09:00:00.000Z',
  ...over,
});

const reverseCalls = () =>
  apiFetchMock.mock.calls.filter(c => c[0] === REVERSE_PATH) as [string, Init][];

function renderModal(op: CashOperation = operation()) {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <CashReversalModal open onClose={onClose} operation={op} currencySymbol="₴" />
    </QueryClientProvider>,
  );
  return { onClose };
}

const reasonField = () => screen.getByLabelText(/^Причина сторно/);
const typeReason = (value: string) => fireEvent.change(reasonField(), { target: { value } });
const clickSubmit = () => fireEvent.click(screen.getByRole('button', { name: 'Сторнувати' }));
const confirmButton = () => screen.findByRole('button', { name: 'Так, сторнувати' });
const escape = () => fireEvent.keyDown(document, { key: 'Escape' });
const UNSAVED = 'Є незбережені зміни';

describe('CashReversalModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: 'op-rev' });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  describe('що сторнується і що станеться', () => {
    it('показує дату, операцію, суму, контрагента й підставу оригіналу', () => {
      renderModal();
      const summary = screen.getByRole('region', { name: 'Що сторнується' });
      expect(within(summary).getByText('дата 2026-10-14')).toBeInTheDocument();
      expect(within(summary).getByText('Внесення · Оплата контрагента')).toBeInTheDocument();
      expect(within(summary).getByText('1250 ₴')).toBeInTheDocument();
      expect(within(summary).getByText('Коваль Олег')).toBeInTheDocument();
      expect(within(summary).getByText('НЗ-000012')).toBeInTheDocument();
    });

    it('оплата контрагента: видача тієї самої суми, борг і «сплачено» повернуться, бонуси спишуться', () => {
      renderModal();
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('З каси буде видано 1250 ₴');
      expect(note).toHaveTextContent(
        'Борг контрагента і «сплачено» наряду та рахунку повернуться, нараховані за оплату бонуси буде списано.',
      );
    });

    it('оплата постачальнику: внесення назад, «сплачено» замовлення зменшиться', () => {
      renderModal(
        operation({
          direction: 'OUT',
          reason: 'SUPPLIER_PAYMENT',
          documentType: 'SupplierPayment',
          baseDocumentType: 'PurchaseOrder',
          baseDocumentNumber: 'ЗП-000003',
        }),
      );
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('До каси буде внесено 1250 ₴');
      expect(note).toHaveTextContent(
        'Оплату постачальнику буде сторновано, «сплачено» замовлення зменшиться',
      );
    });

    it('ручна операція: лише рядок каси, без обіцянок про борг чи бонуси', () => {
      renderModal(
        operation({
          reason: 'MANUAL_IN',
          counterpartyName: null,
          baseDocumentId: null,
          baseDocumentNumber: null,
          documentType: null,
          documentId: null,
        }),
      );
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('З каси буде видано 1250 ₴');
      expect(note).not.toHaveTextContent(/бонус|борг|сплачено/);
      expect(screen.queryByText('Контрагент / працівник')).toBeNull();
      expect(screen.queryByText('Підстава')).toBeNull();
    });
  });

  describe('причина', () => {
    it('порожня — помилка біля поля, запиту немає', async () => {
      renderModal();
      clickSubmit();
      expect(await screen.findByText('Вкажіть причину сторно')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Так, сторнувати' })).toBeNull();
      expect(reverseCalls()).toHaveLength(0);
    });

    it('лише пробіли — не причина', async () => {
      renderModal();
      typeReason('   ');
      clickSubmit();
      expect(await screen.findByText('Вкажіть причину сторно')).toBeInTheDocument();
      expect(reverseCalls()).toHaveLength(0);
    });

    it('лічильник показує межу зі спільної схеми', () => {
      renderModal();
      typeReason('помилка');
      expect(screen.getByText('7 / 500')).toBeInTheDocument();
      expect(reasonField()).toHaveAttribute('maxLength', '500');
    });
  });

  describe('надсилання', () => {
    it('«Сторнувати» спершу просить підтвердження; «Назад» повертає без запиту', async () => {
      renderModal();
      typeReason('помилкова сума');
      clickSubmit();
      await confirmButton();
      expect(screen.getByText('Сторно не можна скасувати. Сторнувати операцію?')).toBeVisible();
      expect(reverseCalls()).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
      expect(screen.getByRole('button', { name: 'Сторнувати' })).toBeInTheDocument();
      expect(reverseCalls()).toHaveLength(0);
    });

    it('тіло — рівно { reason } (обрізана), ключ — у заголовку; успіх закриває картку', async () => {
      const { onClose } = renderModal();
      typeReason('  не та каса  ');
      clickSubmit();
      fireEvent.click(await confirmButton());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(reverseCalls()).toHaveLength(1);
      const [, init] = reverseCalls()[0]!;
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body!)).toEqual({ reason: 'не та каса' });
      expect(init.headers?.['Idempotency-Key']).toBeTruthy();
      expect(toastMock.success).toHaveBeenCalledWith('Операцію сторновано');
      expect(screen.queryByText(UNSAVED)).toBeNull();
    });

    it('подвійний клік по підтвердженню — один запит', async () => {
      let release: (v: unknown) => void = () => {};
      apiFetchMock.mockImplementation((path: string) =>
        path === REVERSE_PATH ? new Promise(r => (release = r)) : Promise.resolve([]),
      );
      const { onClose } = renderModal();
      typeReason('дубль');
      clickSubmit();
      const button = await confirmButton();
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(reverseCalls()).toHaveLength(1));
      release({ id: 'op-rev' });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(reverseCalls()).toHaveLength(1);
    });

    it('відмова сервера — у картці, картка відкрита; повтор іде з тим самим ключем', async () => {
      let attempt = 0;
      apiFetchMock.mockImplementation((path: string) =>
        path === REVERSE_PATH
          ? ++attempt === 1
            ? Promise.reject(new Error('Операцію вже сторновано'))
            : Promise.resolve({ id: 'op-rev' })
          : Promise.resolve([]),
      );
      const { onClose } = renderModal();
      typeReason('повтор');
      clickSubmit();
      fireEvent.click(await confirmButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('Операцію вже сторновано');
      expect(onClose).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();

      clickSubmit();
      fireEvent.click(await confirmButton());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      const keys = reverseCalls().map(c => c[1].headers?.['Idempotency-Key']);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });
  });

  describe('закриття з уведеним', () => {
    it('без причини — Escape закриває одразу', async () => {
      const { onClose } = renderModal();
      escape();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(UNSAVED)).toBeNull();
    });

    it('з причиною — запит; «Скасувати» лишає картку й текст, «Покинути» закриває', async () => {
      const { onClose } = renderModal();
      typeReason('чернетка причини');
      escape();
      expect(await screen.findByText(UNSAVED)).toBeVisible();
      expect(onClose).not.toHaveBeenCalled();
      const dialog = screen.getByText(UNSAVED).closest('[role="dialog"]') as HTMLElement;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
      await waitFor(() => expect(screen.queryByText(UNSAVED)).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      expect(reasonField()).toHaveValue('чернетка причини');

      escape();
      expect(await screen.findByText(UNSAVED)).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Покинути' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  });
});
