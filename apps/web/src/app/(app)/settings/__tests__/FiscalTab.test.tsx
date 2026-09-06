// Registry-провайдери ПРРО/еквайрингу: ProviderRegistryPanel + FiscalTab (дві панелі).
// Покриває поведінку, яку API-тести не бачать:
//   1. FiscalTab монтує обидві панелі (ПРРО + еквайринг).
//   2. картки провайдерів рендеряться з бекенд-конфігів (hasCredentials → «Креди збережено»).
//   3. клік по назві → модалка кредів; поля секретів write-only (не prefill).
//   4. save → PATCH /:endpoint/branch/:id з provider + непорожні credentials; порожні ОМІТ.
//   5. verify → POST /:endpoint/:code/verify; happy/error.
//   6. активація без кредів → блокується (не POST activate).

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import FiscalTab from '../FiscalTab';
import ProviderRegistryPanel, { type PanelProviderMeta } from '../ProviderRegistryPanel';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: () => undefined }));

const BRANCHES = [{ id: 'br-1', name: 'Філія 1' }];

const CHECKBOX: PanelProviderMeta = {
  code: 'checkbox',
  name: 'Checkbox',
  hasShiftMode: true,
  fields: [
    { key: 'licenseKey', label: 'Ліцензійний ключ каси', secret: true },
    { key: 'pinCode', label: 'PIN касира', secret: true },
  ],
};
const VCHASNO: PanelProviderMeta = {
  code: 'vchasno',
  name: 'Вчасно.Каса',
  fields: [{ key: 'token', label: 'API-токен', secret: true }],
};

// configs — масив ProviderConfigView, який GET /:endpoint/branch/:id повертає.
function mock(
  configs: Array<Record<string, unknown>> = [],
  verify: { valid: boolean; cashRegisterName?: string; error?: string } = { valid: true },
) {
  apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (typeof path !== 'string') return Promise.resolve({});
    if (path === '/branches') return Promise.resolve(BRANCHES);
    if (path.endsWith('/verify')) return Promise.resolve(verify);
    if (path.includes('/branch/br-1')) {
      if (opts?.method === 'PATCH' || opts?.method === 'POST') return Promise.resolve({});
      return Promise.resolve(configs);
    }
    return Promise.resolve({});
  });
}

function findCall(match: (path: string, opts?: { method?: string }) => boolean) {
  return apiFetchMock.mock.calls.find(c => match(c[0] as string, c[1]));
}

describe('ProviderRegistryPanel', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('рендерить картки провайдерів; hasCredentials → «Креди збережено»', async () => {
    mock([{ provider: 'checkbox', enabled: true, apiUrl: null, hasCredentials: true }]);
    render(
      <ProviderRegistryPanel
        title="ПРРО"
        endpoint="fiscal-providers"
        providers={[CHECKBOX, VCHASNO]}
      />,
    );
    expect(await screen.findByText('Checkbox')).toBeInTheDocument();
    expect(screen.getByText('Вчасно.Каса')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Креди збережено')).toBeInTheDocument());
  });

  it('клік по назві → модалка кредів; секрет-поля write-only (порожні)', async () => {
    mock([{ provider: 'checkbox', enabled: false, apiUrl: null, hasCredentials: true }]);
    const user = userEvent.setup();
    render(
      <ProviderRegistryPanel title="ПРРО" endpoint="fiscal-providers" providers={[CHECKBOX]} />,
    );
    await user.click(await screen.findByRole('button', { name: /Налаштувати креди Checkbox/ }));
    const license = (await screen.findByLabelText('Ліцензійний ключ каси')) as HTMLInputElement;
    // write-only: не prefill; placeholder «Збережено» бо hasCredentials.
    expect(license.value).toBe('');
    expect(license.placeholder).toMatch(/Збережено/);
  });

  it('save → PATCH з provider + непорожні credentials; порожні ОМІТ', async () => {
    mock([{ provider: 'checkbox', enabled: false, apiUrl: null, hasCredentials: false }]);
    const user = userEvent.setup();
    render(
      <ProviderRegistryPanel title="ПРРО" endpoint="fiscal-providers" providers={[CHECKBOX]} />,
    );
    await user.click(await screen.findByRole('button', { name: /Налаштувати креди Checkbox/ }));

    await user.type(await screen.findByLabelText('Ліцензійний ключ каси'), 'LIC-1');
    // pinCode лишаємо порожнім → не в payload.
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => {
      const patch = findCall((p, o) => p.includes('/branch/br-1') && o?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as { body: string }).body);
      expect(body.provider).toBe('checkbox');
      expect(body.credentials).toEqual({ licenseKey: 'LIC-1' });
      expect(body.credentials).not.toHaveProperty('pinCode');
      expect(body.shiftMode).toBe('MANUAL'); // hasShiftMode → включено
    });
  });

  it('verify happy → POST /:endpoint/:code/verify → «Дійсні креди»', async () => {
    mock([{ provider: 'checkbox', enabled: false, apiUrl: null, hasCredentials: true }], {
      valid: true,
      cashRegisterName: 'Каса №7',
    });
    const user = userEvent.setup();
    render(
      <ProviderRegistryPanel title="ПРРО" endpoint="fiscal-providers" providers={[CHECKBOX]} />,
    );
    await user.click(await screen.findByRole('button', { name: /Налаштувати креди Checkbox/ }));
    await user.click(await screen.findByRole('button', { name: 'Перевірити' }));

    await waitFor(() => expect(screen.getByText(/Дійсні креди/)).toBeInTheDocument());
    expect(screen.getByText(/Каса №7/)).toBeInTheDocument();
    const verifyCall = findCall(p => p === '/fiscal-providers/checkbox/verify');
    expect(verifyCall).toBeTruthy();
  });

  it('verify error (valid:false) → показує помилку, не «дійсні»', async () => {
    mock([{ provider: 'checkbox', enabled: false, apiUrl: null, hasCredentials: true }], {
      valid: false,
      error: 'Невірний ключ',
    });
    const user = userEvent.setup();
    render(
      <ProviderRegistryPanel title="ПРРО" endpoint="fiscal-providers" providers={[CHECKBOX]} />,
    );
    await user.click(await screen.findByRole('button', { name: /Налаштувати креди Checkbox/ }));
    await user.click(await screen.findByRole('button', { name: 'Перевірити' }));
    await waitFor(() => expect(screen.getByText('Невірний ключ')).toBeInTheDocument());
    expect(screen.queryByText(/Дійсні креди/)).not.toBeInTheDocument();
  });

  it('активація без кредів → блокується (НЕ POST activate)', async () => {
    mock([{ provider: 'vchasno', enabled: false, apiUrl: null, hasCredentials: false }]);
    const user = userEvent.setup();
    render(
      <ProviderRegistryPanel title="ПРРО" endpoint="fiscal-providers" providers={[VCHASNO]} />,
    );
    // Switch активації для vchasno (без кредів).
    const sw = await screen.findByRole('switch', { name: /Активувати провайдера Вчасно/ });
    await user.click(sw);
    // activate НЕ викликано (empty-state guard).
    const activateCall = findCall((p, o) => p.endsWith('/activate') && o?.method === 'POST');
    expect(activateCall).toBeUndefined();
  });

  it('активація з кредами → POST /:endpoint/branch/:id/activate {provider}', async () => {
    mock([{ provider: 'vchasno', enabled: false, apiUrl: null, hasCredentials: true }]);
    const user = userEvent.setup();
    render(
      <ProviderRegistryPanel title="ПРРО" endpoint="fiscal-providers" providers={[VCHASNO]} />,
    );
    await user.click(await screen.findByRole('switch', { name: /Активувати провайдера Вчасно/ }));
    await waitFor(() => {
      const activateCall = findCall(
        (p, o) => p === '/fiscal-providers/branch/br-1/activate' && o?.method === 'POST',
      );
      expect(activateCall).toBeTruthy();
      const body = JSON.parse((activateCall![1] as { body: string }).body);
      expect(body.provider).toBe('vchasno');
    });
  });
});

describe('FiscalTab (дві панелі)', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('монтує панель ПРРО і панель еквайрингу', async () => {
    mock([]);
    render(<FiscalTab />);
    expect(await screen.findByText('Фіскалізація (ПРРО)')).toBeInTheDocument();
    expect(screen.getByText('Онлайн-оплата (еквайринг)')).toBeInTheDocument();
    // Провайдери обох реєстрів присутні.
    expect(screen.getByText('Checkbox')).toBeInTheDocument();
    expect(screen.getByText('Вчасно.Каса')).toBeInTheDocument();
    expect(screen.getByText('monobank Еквайринг')).toBeInTheDocument();
    expect(screen.getByText('LiqPay (ПриватБанк)')).toBeInTheDocument();
  });
});
