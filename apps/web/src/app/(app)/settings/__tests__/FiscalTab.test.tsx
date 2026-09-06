// Bug #667 — component-guard для FiscalTab (Checkbox ПРРО Крок 1).
// Покриває поведінку, яку API-тести не бачать:
//   1. Switch «Увімкнути фіскалізацію» → toggle стану.
//   2. save → PATCH /settings/branch/:id з fiscalEnabled/apiUrl/cashRegisterId.
//   3. write-only секрети: порожні license/pin ОМИТ з PATCH; непорожні — включені.
//   4. verify happy-path → POST /verify, показує «Ключ дійсний · каса: …».
//   5. verify error-path → показує повідомлення про помилку, не crash.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import FiscalTab from '../FiscalTab';

// ─── Module mocks ────────────────────────────────────────────────────────────
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: () => undefined,
}));

const BRANCHES = [{ id: 'br-1', name: 'Філія 1' }];

// Базовий happy-mock: /branches + GET settings + PATCH/POST успішні.
function baseMock(
  settings: Record<string, unknown> = {
    fiscalEnabled: false,
    checkboxApiUrl: null,
    checkboxCashRegisterId: null,
  },
  verify: Record<string, unknown> = { valid: true, cashRegisterName: 'Каса №1' },
) {
  apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/branches') return Promise.resolve(BRANCHES);
    if (path === '/settings/br-1/fiscal/verify' || path === '/settings/branch/br-1/fiscal/verify')
      return Promise.resolve(verify);
    if (path.startsWith('/settings/branch/br-1')) {
      if (opts?.method === 'PATCH') return Promise.resolve({});
      return Promise.resolve(settings);
    }
    return Promise.resolve({});
  });
}

function findPatch() {
  return apiFetchMock.mock.calls.find(
    c => c[0] === '/settings/branch/br-1' && c[1]?.method === 'PATCH',
  );
}

describe('FiscalTab', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('завантажує налаштування філії й рендерить форму', async () => {
    baseMock({
      fiscalEnabled: true,
      checkboxApiUrl: 'https://api.checkbox.ua',
      checkboxCashRegisterId: 'cr-1',
    });
    render(<FiscalTab />);
    // Switch відображає завантажений enabled=true
    const sw = await screen.findByRole('switch', { name: /Вимкнути фіскалізацію/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('Switch перемикає стан фіскалізації', async () => {
    baseMock({ fiscalEnabled: false, checkboxApiUrl: null, checkboxCashRegisterId: null });
    const user = userEvent.setup();
    render(<FiscalTab />);
    const sw = await screen.findByRole('switch', { name: /Увімкнути фіскалізацію/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    // Після кліку aria-label міняється на «Вимкнути…» + aria-checked=true
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('save → PATCH з fiscalEnabled/apiUrl/cashRegisterId', async () => {
    baseMock({ fiscalEnabled: false, checkboxApiUrl: null, checkboxCashRegisterId: null });
    const user = userEvent.setup();
    render(<FiscalTab />);

    await screen.findByRole('switch');
    // Заповнюємо cashRegisterId
    const crInput = screen.getByLabelText('ID каси (cash register)');
    await user.type(crInput, 'cr-99');

    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch![1].body as string);
      expect(body.fiscalEnabled).toBe(false);
      expect(body.checkboxCashRegisterId).toBe('cr-99');
      expect(body).toHaveProperty('checkboxApiUrl');
    });
  });

  it('write-only: порожні license/pin ОМИТ з PATCH', async () => {
    baseMock({ fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch![1].body as string);
      // Секрети не введені → НЕ у payload (не затираємо збережені).
      expect(body).not.toHaveProperty('checkboxLicenseKey');
      expect(body).not.toHaveProperty('checkboxPinCode');
    });
  });

  it('write-only: непорожні license/pin включені у PATCH', async () => {
    baseMock({ fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    await user.type(screen.getByLabelText('Ліцензійний ключ каси'), 'my-license');
    await user.type(screen.getByLabelText('PIN касира'), '1234');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch![1].body as string);
      expect(body.checkboxLicenseKey).toBe('my-license');
      expect(body.checkboxPinCode).toBe('1234');
    });
  });

  it('verify happy-path → POST /verify → «Ключ дійсний · каса»', async () => {
    baseMock(
      { fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null },
      { valid: true, cashRegisterName: 'Каса №7' },
    );
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    await user.click(screen.getByRole('button', { name: 'Перевірити' }));

    await waitFor(() => expect(screen.getByText(/Ключ дійсний/)).toBeInTheDocument());
    expect(screen.getByText(/Каса №7/)).toBeInTheDocument();

    // POST на verify-endpoint зроблено
    const verifyCall = apiFetchMock.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].endsWith('/fiscal/verify'),
    );
    expect(verifyCall).toBeTruthy();
    expect(verifyCall![1]?.method).toBe('POST');
  });

  it('verify error-path (valid:false) → показує помилку, не «дійсний»', async () => {
    baseMock(
      { fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null },
      { valid: false, error: 'Невірний ключ' },
    );
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    await user.click(screen.getByRole('button', { name: 'Перевірити' }));

    await waitFor(() => expect(screen.getByText('Невірний ключ')).toBeInTheDocument());
    expect(screen.queryByText(/Ключ дійсний/)).not.toBeInTheDocument();
  });

  it('verify reject (мережа) → показує помилку, не crash', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve(BRANCHES);
      if (typeof path === 'string' && path.endsWith('/fiscal/verify'))
        return Promise.reject(new Error('Немає звʼязку'));
      if (path.startsWith('/settings/branch/br-1'))
        return Promise.resolve({
          fiscalEnabled: true,
          checkboxApiUrl: null,
          checkboxCashRegisterId: null,
        });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    await user.click(screen.getByRole('button', { name: 'Перевірити' }));

    await waitFor(() => expect(screen.getByText('Немає звʼязку')).toBeInTheDocument());
  });

  it('shiftMode: завантажене значення відображається у Select', async () => {
    baseMock({
      fiscalEnabled: true,
      checkboxApiUrl: null,
      checkboxCashRegisterId: null,
      shiftMode: 'AUTO_OPEN',
    });
    render(<FiscalTab />);
    await screen.findByRole('switch');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('AUTO_OPEN'));
  });

  it('shiftMode: round-trip — зміна значення → у PATCH', async () => {
    baseMock({
      fiscalEnabled: true,
      checkboxApiUrl: null,
      checkboxCashRegisterId: null,
      shiftMode: 'MANUAL',
    });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('MANUAL'));

    await user.selectOptions(select, 'AUTO_OPEN');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch![1].body as string);
      expect(body.shiftMode).toBe('AUTO_OPEN');
    });
  });

  it('shiftMode: дефолт MANUAL коли GET не повернув поле', async () => {
    baseMock({ fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null });
    render(<FiscalTab />);
    await screen.findByRole('switch');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('MANUAL');
  });

  it('після успішного save секрет-поля очищуються', async () => {
    baseMock({ fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    const licenseInput = screen.getByLabelText('Ліцензійний ключ каси') as HTMLInputElement;
    await user.type(licenseInput, 'sekret');
    expect(licenseInput.value).toBe('sekret');

    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(licenseInput.value).toBe(''));
  });

  // ─── monobank еквайринг (QR-оплата) — write-only токен ─────────────────────────
  it('monobank: hasMonobankToken=true → placeholder «Збережено»; поле НЕ prefill', async () => {
    baseMock({
      fiscalEnabled: true,
      checkboxApiUrl: null,
      checkboxCashRegisterId: null,
      monobankApiUrl: 'https://api.monobank.ua',
      hasMonobankToken: true,
    });
    render(<FiscalTab />);
    await screen.findByRole('switch');
    const tokenInput = screen.getByLabelText('X-Token merchant') as HTMLInputElement;
    await waitFor(() => expect(tokenInput.placeholder).toMatch(/Збережено/));
    // write-only: значення НЕ підтягується з GET (лишається порожнім).
    expect(tokenInput.value).toBe('');
  });

  it('monobank: порожній токен ОМІТ з PATCH (не затираємо збережений)', async () => {
    baseMock({
      fiscalEnabled: true,
      checkboxApiUrl: null,
      checkboxCashRegisterId: null,
      hasMonobankToken: true,
    });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch![1].body as string);
      expect(body).not.toHaveProperty('monobankToken');
    });
  });

  it('monobank: round-trip — введений токен + apiUrl → у PATCH; поле очищується', async () => {
    baseMock({ fiscalEnabled: true, checkboxApiUrl: null, checkboxCashRegisterId: null });
    const user = userEvent.setup();
    render(<FiscalTab />);
    await screen.findByRole('switch');

    const tokenInput = screen.getByLabelText('X-Token merchant') as HTMLInputElement;
    await user.type(tokenInput, 'MERCH-XYZ');
    await user.type(screen.getByLabelText('API URL (необовʼязково)'), 'https://api.monobank.ua');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch![1].body as string);
      expect(body.monobankToken).toBe('MERCH-XYZ');
      expect(body.monobankApiUrl).toBe('https://api.monobank.ua');
    });
    // секрет-поле очищене після save.
    await waitFor(() => expect(tokenInput.value).toBe(''));
  });
});
