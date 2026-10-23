// НДІ → «Реквізити»: телефон, e-mail, ІПН і основний банківський рахунок організації —
// друкуються в шапці рахунків, нарядів і актів (план друку 2026-10-15). До цього основний
// рахунок був у стані форми, але вибрати його було ніде.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
const multipartMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: (...args: unknown[]) => multipartMock(...args),
}));

let bankAccounts: Array<{ id: string; name: string; ibanUA: string }> = [];
vi.mock('@/hooks/api/useBankStatements', () => ({
  useBankAccountOptions: () => ({ data: bankAccounts }),
}));

import OrgInfoTab from '../OrgInfoTab';

const ACC_1 = '33333333-3333-4333-8333-333333333333';
const ACC_2 = '44444444-4444-4444-8444-444444444444';
const GONE = '55555555-5555-4555-8555-555555555555';

const orgInfo = (over: Record<string, unknown> = {}) => ({
  id: 'org-1',
  orgId: 'org-1',
  name: 'СТО Альфа',
  edrpou: '12345678',
  logoUrl: null,
  legalAddress: null,
  actualAddress: null,
  phone: '+380501112233',
  email: 'info@alfa.ua',
  ipn: '123456789012',
  bankAccountId: ACC_1,
  updatedAt: '2026-10-15T00:00:00.000Z',
  ...over,
});

function mockApi(info: ReturnType<typeof orgInfo>, patch?: () => Promise<unknown>) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/settings/org-info' && init?.method === 'PATCH') {
      return patch ? patch() : Promise.resolve({ ...info, ...JSON.parse(String(init.body)) });
    }
    if (path === '/settings/org-info') return Promise.resolve(info);
    return Promise.resolve({ items: [] });
  });
}

const patchBody = () => {
  const call = apiFetchMock.mock.calls.find(
    ([p, init]) =>
      p === '/settings/org-info' && (init as RequestInit | undefined)?.method === 'PATCH',
  );
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
};

const bankSelect = () => screen.getByLabelText('Основний банківський рахунок') as HTMLSelectElement;

describe('OrgInfoTab — реквізити для друку', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    bankAccounts = [
      { id: ACC_1, name: 'Основний', ibanUA: 'UA213223130000026007233566001' },
      { id: ACC_2, name: 'Резервний', ibanUA: 'UA903052992990004149123456789' },
    ];
  });

  it('показує телефон, e-mail, ІПН і вибраний основний рахунок з організації', async () => {
    mockApi(orgInfo());
    render(<OrgInfoTab />);

    expect(await screen.findByDisplayValue('+380501112233')).toBeInTheDocument();
    expect(screen.getByLabelText('Телефон')).toHaveValue('+380501112233');
    expect(screen.getByLabelText('E-mail')).toHaveValue('info@alfa.ua');
    expect(screen.getByLabelText('ІПН платника ПДВ')).toHaveValue('123456789012');
    await waitFor(() => expect(bankSelect().value).toBe(ACC_1));
    expect(
      screen.getByText('Друкується в рахунках і нарядах разом із реквізитами й логотипом'),
    ).toBeInTheDocument();
  });

  it('у виборі — «не вибрано» і всі рахунки організації з IBAN', async () => {
    mockApi(orgInfo({ bankAccountId: null }));
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    const options = Array.from(bankSelect().options).map(o => o.textContent);
    expect(options).toEqual([
      '— не вибрано —',
      'Основний · UA213223130000026007233566001',
      'Резервний · UA903052992990004149123456789',
    ]);
    expect(bankSelect().value).toBe('');
  });

  it('збереження шле нові поля і вибраний рахунок', async () => {
    mockApi(orgInfo());
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: ' +380671112233 ' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'office@alfa.ua' } });
    fireEvent.change(screen.getByLabelText('ІПН платника ПДВ'), {
      target: { value: '1234567890' },
    });
    fireEvent.change(bankSelect(), { target: { value: ACC_2 } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody()).toMatchObject({
      phone: '+380671112233',
      email: 'office@alfa.ua',
      ipn: '1234567890',
      bankAccountId: ACC_2,
    });
  });

  it('очищені поля і «не вибрано» йдуть як null', async () => {
    mockApi(orgInfo());
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('ІПН платника ПДВ'), { target: { value: '' } });
    fireEvent.change(bankSelect(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody()).toMatchObject({ phone: null, email: null, ipn: null, bankAccountId: null });
  });

  it('помилка валідації сервера показується текстом', async () => {
    mockApi(orgInfo(), () => Promise.reject(new Error('ІПН має містити 10 або 12 цифр')));
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    expect(await screen.findByText('ІПН має містити 10 або 12 цифр')).toBeInTheDocument();
  });

  it('основний рахунок видалено (його немає у списку) → видно «недоступний», а не порожньо', async () => {
    mockApi(orgInfo({ bankAccountId: GONE }));
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    await waitFor(() => expect(bankSelect().value).toBe(GONE));
    expect(bankSelect().selectedOptions[0]?.textContent).toBe('Рахунок недоступний (видалений)');
  });

  // Сервер на видалений bankAccountId відповідає 404: якби незмінений рахунок ішов у кожному
  // PATCH, жодне інше поле реквізитів не збереглося б.
  it('рахунок не змінювали → bankAccountId не шлеться (видалений рахунок не блокує збереження)', async () => {
    mockApi(orgInfo({ bankAccountId: GONE }));
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '+380671112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody()).toMatchObject({ phone: '+380671112233' });
    expect(patchBody()).not.toHaveProperty('bankAccountId');
  });
});

// Bug #952: onError ховав <img> і показував заглушку правкою DOM-стилів. Після «Замінити» React
// міняв лише src — картинка лишалась display:none, а поверх неї «Немає логотипу». Bug #953 / CodeQL:
// небезпечна схема logoUrl не потрапляє в src і не відкриває лайтбокс, а «Видалити» лишається.
describe('OrgInfoTab — логотип', () => {
  const BROKEN = 'http://minio.local/sto-files/org/1/old.png';
  const NEW_URL = 'http://minio.local/sto-files/org/1/public/new.png';

  beforeEach(() => {
    apiFetchMock.mockReset();
    multipartMock.mockReset();
    bankAccounts = [];
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/preview-1');
    URL.revokeObjectURL = vi.fn();
  });

  const logoImg = () => screen.queryByAltText('Логотип організації');
  const fallback = () => screen.getByText('Немає логотипу').parentElement as HTMLElement;

  it('логотип не завантажився → заглушка; після заміни нова картинка видима, заглушка схована', async () => {
    mockApi(orgInfo({ logoUrl: BROKEN }));
    multipartMock.mockResolvedValue({ url: NEW_URL });
    const { container } = render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    fireEvent.error(logoImg()!);
    await waitFor(() => expect(logoImg()).toBeNull());
    expect(fallback().style.display).toBe('flex');

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(logoImg()?.getAttribute('src')).toBe(NEW_URL));
    expect(logoImg()!.style.display).not.toBe('none');
    expect(fallback().style.display).toBe('none');
  });

  it('logoUrl із javascript: → без <img> і без лайтбокса, «Видалити» шле null', async () => {
    mockApi(orgInfo({ logoUrl: 'javascript:alert(1)' }));
    render(<OrgInfoTab />);
    await screen.findByDisplayValue('+380501112233');

    expect(logoImg()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Збільшити логотип' })).toBeNull();
    expect(fallback().style.display).toBe('flex');

    fireEvent.click(screen.getByRole('button', { name: /Видалити/ }));
    await waitFor(() => expect(patchBody()).toEqual({ logoUrl: null }));
  });
});
