// Картка сторно безготівкової оплати клієнта (BR-PAY-024, POST /payments/:id/reverse).
//
// Що стереже:
//   - картка показує, що сторнується (дата, сума, спосіб, платник), і що станеться: борг і
//     «сплачено» назад, гроші на рахунку не рухаються; рядок виписки стане «Нерознесений»
//     (з рядка виписки — напевно, з «Пов'язаних документів» — «якщо»);
//   - причина обов'язкова (спільна `paymentReversalSchema`): порожня чи з пробілів — без запиту;
//   - «Сторнувати» спершу просить підтвердження; запит — лише з «Так, сторнувати»;
//   - тіло — рівно `{ reason }` (обрізана), ключ — у `Idempotency-Key`, один на відкриття картки
//     (і після відмови той самий), нове відкриття — новий ключ;
//   - успіх: `onReversed`, потім закриття; відмова — банер у картці, картка відкрита.
//
// Mutation-verify:
//   - прибрати гілку `if (confirming)` (одразу reverse) → «спершу підтвердження» падає;
//   - `idempotencyKeyRef.current = newIdempotencyKey()` перенести в `reverse` → «той самий ключ» падає;
//   - `p.fromBankStatement ? bankLine : bankLineMaybe` → завжди bankLineMaybe → «з рядка виписки» падає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { PaymentReversalModal, type PaymentReversalTarget } from '../PaymentReversalModal';
import { makeTestQueryClient } from '@/__tests__/query-utils';

const PAY = 'pay-1';
const REVERSE_PATH = `/payments/${PAY}/reverse`;

type Init = { method?: string; body?: string; headers?: Record<string, string> };

const target = (over: Partial<PaymentReversalTarget> = {}): PaymentReversalTarget => ({
  id: PAY,
  amountText: '1 000,00 ₴',
  dateText: '20.10.2026 12:00',
  methodLabel: 'Переказ',
  partyName: 'Коваль Олег',
  ...over,
});

const reverseCalls = () =>
  apiFetchMock.mock.calls.filter(c => c[0] === REVERSE_PATH) as [string, Init][];

function renderModal(payment: PaymentReversalTarget = target(), open = true) {
  const onClose = vi.fn();
  const onReversed = vi.fn();
  const client = makeTestQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <PaymentReversalModal
        open={open}
        onClose={onClose}
        onReversed={onReversed}
        payment={payment}
      />
    </QueryClientProvider>,
  );
  const rerender = (nextOpen: boolean) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <PaymentReversalModal
          open={nextOpen}
          onClose={onClose}
          onReversed={onReversed}
          payment={payment}
        />
      </QueryClientProvider>,
    );
  return { onClose, onReversed, rerender };
}

const reasonField = () => screen.getByLabelText(/^Причина сторно/);
const typeReason = (value: string) => fireEvent.change(reasonField(), { target: { value } });
const clickSubmit = () => fireEvent.click(screen.getByRole('button', { name: 'Сторнувати' }));
const confirmButton = () => screen.findByRole('button', { name: 'Так, сторнувати' });

describe('PaymentReversalModal (BR-PAY-024)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: PAY });
    toastMock.success.mockReset();
  });

  describe('що сторнується і що станеться', () => {
    // guards: BR-PAY-024
    it('показує дату, суму, спосіб і платника', () => {
      renderModal();
      const summary = screen.getByRole('region', { name: 'Що сторнується' });
      expect(within(summary).getByText('20.10.2026 12:00')).toBeInTheDocument();
      expect(within(summary).getByText('1 000,00 ₴')).toBeInTheDocument();
      expect(within(summary).getByText('Переказ')).toBeInTheDocument();
      expect(within(summary).getByText('Коваль Олег')).toBeInTheDocument();
    });

    // guards: BR-PAY-024
    it("з «Пов'язаних документів»: борг і «сплачено» назад, гроші не рухаються, виписка — «якщо»", () => {
      renderModal();
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent(
        'Оплата 1 000,00 ₴ лишиться в переліку з позначкою «Сторновано»',
      );
      expect(note).toHaveTextContent('оплачений наряд повернеться у «Виставлено»');
      expect(note).toHaveTextContent('Гроші на рахунку не рухаються');
      expect(note).toHaveTextContent('Якщо оплату рознесено з банківської виписки');
    });

    // guards: BR-PAY-024, BR-BANK-040
    it('з рядка виписки: рядок стане «Нерознесений» — без «якщо»', () => {
      renderModal(target({ fromBankStatement: true }));
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('Рядок банківської виписки стане «Нерознесений»');
      expect(note).not.toHaveTextContent('Якщо оплату');
    });
  });

  describe('причина', () => {
    // guards: BR-PAY-024
    it.each(['', '   '])('«%s» — помилка біля поля, запиту немає', async value => {
      renderModal();
      typeReason(value);
      clickSubmit();
      expect(await screen.findByText('Вкажіть причину сторно')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Так, сторнувати' })).toBeNull();
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
    // guards: BR-PAY-024
    it('«Сторнувати» спершу просить підтвердження; «Назад» повертає без запиту', async () => {
      renderModal();
      typeReason('не той клієнт');
      clickSubmit();
      await confirmButton();
      expect(screen.getByText('Сторно не можна скасувати. Сторнувати оплату?')).toBeVisible();
      expect(reverseCalls()).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
      expect(screen.getByRole('button', { name: 'Сторнувати' })).toBeInTheDocument();
      expect(reverseCalls()).toHaveLength(0);
    });

    // guards: BR-PAY-024
    it('POST /payments/:id/reverse з { reason } (обрізана) і Idempotency-Key; успіх → onReversed і закриття', async () => {
      const { onClose, onReversed } = renderModal();
      typeReason('  не той клієнт  ');
      clickSubmit();
      fireEvent.click(await confirmButton());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(onReversed).toHaveBeenCalledTimes(1);
      expect(onReversed.mock.invocationCallOrder[0]).toBeLessThan(
        onClose.mock.invocationCallOrder[0]!,
      );
      expect(reverseCalls()).toHaveLength(1);
      const [, init] = reverseCalls()[0]!;
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body!)).toEqual({ reason: 'не той клієнт' });
      expect(init.headers?.['Idempotency-Key']).toBeTruthy();
      expect(toastMock.success).toHaveBeenCalledWith('Оплату сторновано');
    });

    // guards: BR-PAY-024
    it('відмова сервера — у картці, картка відкрита; повтор — з тим самим ключем', async () => {
      let attempt = 0;
      apiFetchMock.mockImplementation((path: string) =>
        path === REVERSE_PATH
          ? ++attempt === 1
            ? Promise.reject(
                new Error(
                  'Оплата прийнята через касу — сторнуйте касову операцію на сторінці «Каса»',
                ),
              )
            : Promise.resolve({ id: PAY })
          : Promise.resolve([]),
      );
      const { onClose, onReversed } = renderModal();
      typeReason('повтор');
      clickSubmit();
      fireEvent.click(await confirmButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('сторнуйте касову операцію');
      expect(onClose).not.toHaveBeenCalled();
      expect(onReversed).not.toHaveBeenCalled();

      clickSubmit();
      fireEvent.click(await confirmButton());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      const keys = reverseCalls().map(c => c[1].headers?.['Idempotency-Key']);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });

    // guards: BR-PAY-024
    it('нове відкриття картки — новий ключ ідемпотентності', async () => {
      const { rerender } = renderModal();
      typeReason('перша');
      clickSubmit();
      fireEvent.click(await confirmButton());
      await waitFor(() => expect(reverseCalls()).toHaveLength(1));
      rerender(false);
      rerender(true);
      typeReason('друга');
      clickSubmit();
      fireEvent.click(await confirmButton());
      await waitFor(() => expect(reverseCalls()).toHaveLength(2));
      const keys = reverseCalls().map(c => c[1].headers?.['Idempotency-Key']);
      expect(keys[1]).not.toBe(keys[0]);
    });
  });
});
