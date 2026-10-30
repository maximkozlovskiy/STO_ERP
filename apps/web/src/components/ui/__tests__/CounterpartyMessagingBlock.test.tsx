// Повідомлення клієнту в картці контрагента (docs/objects/automation.md, BR-AUT-011, 041, 042;
// US-AUT-6): кожен перемикач шле PATCH лише свого поля; коли й хто змінив згоду — лише показ;
// бажаний канал з поясненням; Telegram-бот — посилання й QR, відписка.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let role = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'rec', role } }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { CounterpartyMessagingBlock } from '../CounterpartyMessagingBlock';

const CP = '44444444-4444-4444-8444-000000000001';
const LINK = 'https://t.me/sto_bot?start=AbCdEfGhIjKlMnOpQrStUv';
let cp: Record<string, unknown>;

const patches = () =>
  apiFetchMock.mock.calls
    .filter(
      ([p, init]) =>
        p === `/counterparties/${CP}` && (init as { method?: string })?.method === 'PATCH',
    )
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);

beforeEach(() => {
  role = 'RECEPTIONIST';
  cp = {
    id: CP,
    type: 'CLIENT',
    vatPayer: false,
    noServiceMessages: false,
    marketingConsent: true,
    marketingConsentAt: '2026-10-29T10:15:00.000Z',
    marketingConsentById: 'emp-1',
    preferredChannel: null,
    telegramSubscription: { active: true, subscribedAt: '2026-10-28T09:00:00.000Z' },
  };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (path.startsWith('/employees'))
      return Promise.resolve({
        items: [{ id: 'emp-1', firstName: 'Олена', lastName: 'Приймальна', status: 'ACTIVE' }],
        total: 1,
      });
    if (path === `/counterparties/${CP}` && method === 'PATCH') {
      // Відповідь PATCH — без підписки (як у сервера): блок лишає її з картки.
      const { telegramSubscription: _sub, ...rest } = cp;
      cp = { ...cp, ...JSON.parse(init!.body!) };
      return Promise.resolve({ ...rest, ...JSON.parse(init!.body!) });
    }
    if (path === `/counterparties/${CP}`) return Promise.resolve(cp);
    if (path === `/counterparties/${CP}/telegram-link` && method === 'POST')
      return Promise.resolve({ code: 'x', url: LINK, expiresAt: '2026-11-06T10:00:00.000Z' });
    if (path === `/counterparties/${CP}/telegram-subscription` && method === 'DELETE') {
      cp = { ...cp, telegramSubscription: { active: false, subscribedAt: null } };
      return Promise.resolve(undefined);
    }
    return Promise.resolve({});
  });
});

function renderBlock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CounterpartyMessagingBlock counterpartyId={CP} />
    </QueryClientProvider>,
  );
}

describe('Повідомлення клієнту в картці контрагента', () => {
  // guards: BR-AUT-042
  it('кожен перемикач — PATCH лише свого поля (решта картки не перезаписується)', async () => {
    renderBlock();
    const svc = await screen.findByRole('switch', { name: 'Не надсилати службові' });
    fireEvent.click(svc);
    await waitFor(() => expect(patches()).toEqual([{ noServiceMessages: true }]));
    fireEvent.click(screen.getByRole('switch', { name: 'Згода на маркетинг' }));
    await waitFor(() => expect(patches()[1]).toEqual({ marketingConsent: false }));
  });

  // guards: BR-AUT-042
  it('згода: коли й хто змінив — показ з картки, не поле форми', async () => {
    renderBlock();
    expect(await screen.findByTestId('consent-changed')).toHaveTextContent(
      /Змінено 29\.10\.2026.*Приймальна Олена/,
    );
  });

  // guards: BR-AUT-011
  it('бажаний канал — PATCH preferredChannel; «Не вказано» — null; пояснення про «як у філії»', async () => {
    renderBlock();
    const select = await screen.findByLabelText('Бажаний канал');
    fireEvent.change(select, { target: { value: 'VIBER' } });
    await waitFor(() => expect(patches()).toEqual([{ preferredChannel: 'VIBER' }]));
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(patches()[1]).toEqual({ preferredChannel: null }));
    expect(screen.getByText(/як у налаштуваннях філії.*першим/)).toBeInTheDocument();
    expect(
      screen.getByText(/власним переліком каналів бажаний канал не враховує/),
    ).toBeInTheDocument();
  });

  // guards: BR-AUT-041
  it('Telegram: статус підписки, «Отримати посилання» → посилання і QR, «Відписати» → DELETE', async () => {
    renderBlock();
    const block = within(await screen.findByTestId('telegram-subscription'));
    expect(block.getByTestId('telegram-status')).toHaveTextContent('Підписаний з 28.10.2026');
    fireEvent.click(block.getByRole('button', { name: /Отримати посилання/ }));
    expect(await screen.findByTestId('telegram-link-url')).toHaveTextContent(LINK);
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', LINK);
    const linkDialog = screen.getByRole('dialog', { name: 'Підписка на Telegram-бот' });
    fireEvent.click(within(linkDialog).getAllByRole('button', { name: 'Закрити' }).at(-1)!);

    fireEvent.click(block.getByRole('button', { name: /Відписати/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Відписати' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Відписати' }));
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([p, init]) =>
            p === `/counterparties/${CP}/telegram-subscription` &&
            (init as { method?: string })?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(block.getByTestId('telegram-status')).toHaveTextContent('Не підписаний'),
    );
  });

  it('бухгалтер бачить стан, але перемикачі й посилання недоступні', async () => {
    role = 'ACCOUNTANT';
    renderBlock();
    expect(await screen.findByRole('switch', { name: 'Не надсилати службові' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Отримати посилання/ })).toBeNull();
  });
});
