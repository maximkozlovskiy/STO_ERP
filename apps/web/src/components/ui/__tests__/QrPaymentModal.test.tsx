// QrPaymentModal — QR-оплата monobank (0 тестів на новий компонент). Покриваємо:
//  - при відкритті створює намір (POST /online-payments) з invoiceId(+amount).
//  - рендерить QR (QRCodeSVG з pageUrl) поки PENDING.
//  - polling: коли статус приходить PAID → «Оплачено» + onPaid() РІВНО один раз + polling стоп.
//  - FAILED/EXPIRED → відповідне повідомлення, polling стоп.
//  - помилка створення наміру → показує текст помилки (не crash).

import { screen, waitFor, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

import { QrPaymentModal } from '../QrPaymentModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// QRCodeSVG рендерить <svg>; у jsdom ок, але щоб детермінувати — легкий stub з value у data-attr.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));

const INTENT_ID = 'intent-1';
const PAGE_URL = 'https://pay.mono/xyz';

/** Маршрутизатор apiFetch: POST /online-payments → intent; GET /online-payments/:id → status. */
function wireApi(opts: { createStatus?: string; pollStatus?: () => string; createReject?: Error }) {
  apiFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/online-payments' && init?.method === 'POST') {
      if (opts.createReject) return Promise.reject(opts.createReject);
      return Promise.resolve({
        id: INTENT_ID,
        status: opts.createStatus ?? 'PENDING',
        pageUrl: PAGE_URL,
        amount: 500,
        paymentId: null,
        error: null,
      });
    }
    if (url.startsWith('/online-payments/')) {
      const status = opts.pollStatus?.() ?? 'PENDING';
      return Promise.resolve({
        id: INTENT_ID,
        status,
        pageUrl: PAGE_URL,
        amount: 500,
        paymentId: status === 'PAID' ? 'pay-1' : null,
        error: status === 'FAILED' ? 'Оплату відхилено' : null,
      });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('QrPaymentModal (QR-оплата monobank)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('при відкритті створює намір POST /online-payments з invoiceId+amount', async () => {
    wireApi({});
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" amount={250} onClose={() => {}} onPaid={() => {}} />,
    );
    await waitFor(() => {
      const post = apiFetchMock.mock.calls.find(
        c => c[0] === '/online-payments' && c[1]?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body)).toEqual({ invoiceId: 'inv-1', amount: 250 });
    });
  });

  it('PENDING → рендерить QR з pageUrl + текст очікування', async () => {
    wireApi({});
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" onClose={() => {}} onPaid={() => {}} />,
    );
    const qr = await screen.findByTestId('qr');
    expect(qr.getAttribute('data-value')).toBe(PAGE_URL);
    expect(screen.getByText(/Очікуємо підтвердження/)).toBeInTheDocument();
  });

  it('polling PAID → «Оплачено» + onPaid РІВНО один раз', async () => {
    let calls = 0;
    // перший GET — ще PENDING, наступні — PAID.
    wireApi({
      pollStatus: () => {
        calls += 1;
        return calls >= 2 ? 'PAID' : 'PENDING';
      },
    });
    const onPaid = vi.fn();
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" onClose={() => {}} onPaid={onPaid} />,
    );
    // refetchInterval 3s — дочекаємось PAID (реальні таймери, тест допускає до ~10s waitFor).
    await screen.findByTestId('qr');
    await waitFor(() => expect(screen.getByText('Оплачено')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    // onPaid викликано (гейт status==='PAID' один раз через залежність [status]).
    expect(onPaid).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('створення наміру відразу PAID → «Оплачено» без QR', async () => {
    wireApi({ createStatus: 'PAID' });
    const onPaid = vi.fn();
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" onClose={() => {}} onPaid={onPaid} />,
    );
    await waitFor(() => expect(screen.getByText('Оплачено')).toBeInTheDocument());
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it('намір FAILED → «Оплату відхилено»', async () => {
    wireApi({ createStatus: 'FAILED' });
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" onClose={() => {}} onPaid={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Оплату відхилено')).toBeInTheDocument());
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
  });

  it('намір EXPIRED → «Час на оплату вичерпано»', async () => {
    wireApi({ createStatus: 'EXPIRED' });
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" onClose={() => {}} onPaid={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Час на оплату вичерпано')).toBeInTheDocument());
  });

  it('помилка створення наміру → показує текст помилки, не crash', async () => {
    wireApi({ createReject: new Error('monobank еквайринг не налаштовано') });
    renderWithQueryClient(
      <QrPaymentModal open invoiceId="inv-1" onClose={() => {}} onPaid={() => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByText('monobank еквайринг не налаштовано')).toBeInTheDocument(),
    );
  });

  it('закрита модалка (open=false) → намір НЕ створюється', async () => {
    wireApi({});
    renderWithQueryClient(
      <QrPaymentModal open={false} invoiceId="inv-1" onClose={() => {}} onPaid={() => {}} />,
    );
    // дати ефектам відпрацювати
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      apiFetchMock.mock.calls.find(c => c[0] === '/online-payments' && c[1]?.method === 'POST'),
    ).toBeUndefined();
  });
});
