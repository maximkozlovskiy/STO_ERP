// «Налаштування → Постачальники API» (BR-SCON-001…004, BR-SOFR-005, 007, 008): картка підключення —
// поля з опису провайдера, креди лише на запис (збережене не показується, порожнє не надсилається),
// мапа складів — неповний склад не пропускається; розділ «Закупівля через API» шле лише змінене.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import i18n from '@/i18n/config';
import type { SupplierConnection, SupplierProviderInfo } from '@/hooks/api/useSupplierConnections';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }) }));
vi.mock('@/hooks/api/useInfrastructure', () => ({
  useWarehouses: () => ({
    data: [{ id: 'w0000000-0000-4000-8000-000000000001', name: 'Основний' }],
  }),
}));

import { SupplierConnectionModal } from '../SupplierConnectionModal';
import SupplierApiTab, { SUPPLIER_SETTINGS_DEFAULTS } from '../SupplierApiTab';

// Підписи — з каталогу supplierApi:fieldLabels.AVD_TRADE (uk — як у реєстрі адаптерів).
const KEY = 'API-ключ (x-api-key)';
const POINT = 'Торгова точка AVD (GET /locations)';
const CARRIER = 'Перевізник AVD (GET /forwarders)';

const AVD: SupplierProviderInfo = {
  provider: 'AVD_TRADE',
  name: 'AVD Trade',
  capabilities: {
    search: 'mirror',
    analogs: false,
    order: 'cart',
    sandbox: true,
    orderPerWarehouse: false,
    requiresWarehouseMapping: true,
  },
  credentialFields: [{ key: 'apiKey', label: KEY, secret: true, required: true, type: 'string' }],
  optionFields: [],
  warehouseFields: [
    { key: 'locationUuid', label: POINT, secret: false, required: true, type: 'string' },
    { key: 'forwarderUuid', label: CARRIER, secret: false, required: true, type: 'string' },
  ],
};

const CONN: SupplierConnection = {
  id: 'c-1',
  counterpartyId: 'cp-1',
  counterpartyName: 'AVD ТОВ',
  provider: 'AVD_TRADE',
  providerName: 'AVD Trade',
  name: 'AVD основний',
  enabled: true,
  apiUrl: null,
  testMode: false,
  priority: 100,
  defaultDeliveryDays: null,
  hasCredentials: true,
  credentialKeys: ['apiKey'],
  options: {},
  verifyStatus: 'OK',
  verifyRequestedAt: null,
  lastVerifiedAt: '2026-10-18T10:00:00.000Z',
  lastError: null,
  catalogSyncedAt: null,
  catalogSyncStatus: null,
  catalogSyncError: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

function renderModal(connection: SupplierConnection | null) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SupplierConnectionModal
        open
        connection={connection}
        providers={[AVD]}
        live={connection}
        verifying={false}
        onClose={vi.fn()}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return { onSave };
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith('/counterparties'))
      return Promise.resolve({ items: [{ id: 'cp-1', companyName: 'AVD ТОВ' }] });
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
});

afterEach(async () => {
  await i18n.changeLanguage('uk');
});

describe('SupplierConnectionModal', () => {
  // guards: BR-SCON-002
  it('креди лише на запис: збережене — плейсхолдер «збережено», порожнє не надсилається', async () => {
    const { onSave } = renderModal(CONN);
    const key = screen.getByLabelText(KEY);
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', 'збережено');
    expect(key).toHaveAttribute('type', 'password');
    await screen.findByRole('option', { name: 'AVD ТОВ' });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [body, verify] = onSave.mock.calls[0]!;
    expect(verify).toBe(false);
    expect(body).not.toHaveProperty('credentials');
    expect(body).toMatchObject({
      counterpartyId: 'cp-1',
      apiUrl: null,
      options: { warehouses: {} },
    });
  });

  // guards: BR-SCON-003
  it('Bug #892: у локалі en підписи полів — англійською; поле поза каталогом — підпис сервера', async () => {
    await i18n.changeLanguage('en');
    const provider: SupplierProviderInfo = {
      ...AVD,
      credentialFields: [
        ...AVD.credentialFields,
        { key: 'newField', label: 'Нове поле', secret: false, required: false, type: 'string' },
      ],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SupplierConnectionModal
          open
          connection={CONN}
          providers={[provider]}
          live={CONN}
          verifying={false}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('API key (x-api-key)')).toBeInTheDocument();
    const wh = screen.getByRole('group', { name: 'Основний' });
    expect(within(wh).getByLabelText('AVD sales point (GET /locations)')).toBeInTheDocument();
    expect(screen.getByLabelText('Нове поле')).toBeInTheDocument();
    expect(screen.queryByLabelText(KEY)).toBeNull();
  });

  // guards: BR-SCON-001
  it('Bug #894: контрагент підключення поза першими 200 — у списку; більше 200 — пошук на сервері', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/counterparties'))
        return Promise.resolve(
          path.includes('&q=')
            ? { items: [{ id: 'cp-9', companyName: 'Знайдений ТОВ' }], total: 1 }
            : { items: [{ id: 'cp-2', companyName: 'Інший ТОВ' }], total: 250 },
        );
      return Promise.reject(new Error(`unexpected ${String(path)}`));
    });
    const { onSave } = renderModal(CONN);
    expect(await screen.findByRole('option', { name: 'Інший ТОВ' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Контрагент-постачальник/)).toHaveValue('cp-1');
    expect(screen.getByRole('option', { name: 'AVD ТОВ' })).toBeInTheDocument();
    // Поле — спільний SupplierOptionsSelect; id картки лишились (на них спираються селектори).
    expect(screen.getByLabelText(/Контрагент-постачальник/)).toHaveAttribute(
      'id',
      'scon-counterparty',
    );
    expect(screen.getByLabelText('Пошук постачальника')).toHaveAttribute(
      'id',
      'scon-counterparty-search',
    );

    fireEvent.change(screen.getByLabelText('Пошук постачальника'), { target: { value: 'Знай' } });
    expect(await screen.findByRole('option', { name: 'Знайдений ТОВ' })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/counterparties?types=SUPPLIER&types=BOTH&limit=200&q=%D0%97'),
      expect.anything(),
    );
    fireEvent.change(screen.getByLabelText(/Контрагент-постачальник/), {
      target: { value: 'cp-9' },
    });
    fireEvent.change(screen.getByLabelText('Пошук постачальника'), { target: { value: '' } });
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Знайдений ТОВ' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ counterpartyId: 'cp-9' });
  });

  // guards: BR-SCON-002
  it('Bug #891: стерта назва підключення надсилається як null — очищається', async () => {
    const { onSave } = renderModal(CONN);
    await screen.findByRole('option', { name: 'AVD ТОВ' });
    fireEvent.change(screen.getByLabelText(/Назва/), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: null });
  });

  // guards: BR-SCON-003
  it('нове: обов’язковий ключ і повна мапа складу; «Зберегти і перевірити» — verify', async () => {
    const { onSave } = renderModal(null);
    fireEvent.change(screen.getByLabelText(/Постачальник API/), { target: { value: 'AVD_TRADE' } });
    await screen.findByRole('option', { name: 'AVD ТОВ' });
    fireEvent.change(screen.getByLabelText(/Контрагент-постачальник/), {
      target: { value: 'cp-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти і перевірити' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Заповніть поле «${KEY}»`);

    fireEvent.change(screen.getByLabelText(KEY), { target: { value: 'k-123' } });
    const wh = screen.getByRole('group', { name: 'Основний' });
    fireEvent.change(within(wh).getByLabelText(POINT), { target: { value: 'loc-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти і перевірити' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Склад «Основний»: заповніть «${CARRIER}»`,
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(within(wh).getByLabelText(CARRIER), { target: { value: 'fw-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти і перевірити' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]).toEqual([
      expect.objectContaining({
        provider: 'AVD_TRADE',
        counterpartyId: 'cp-1',
        credentials: { apiKey: 'k-123' },
        options: {
          warehouses: {
            'w0000000-0000-4000-8000-000000000001': {
              locationUuid: 'loc-1',
              forwarderUuid: 'fw-1',
            },
          },
        },
      }),
      true,
    ]);
  });
});

describe('SupplierApiTab — «Закупівля через API»', () => {
  it('PATCH лише змінених полів; вага ціни у відсотках → частка', async () => {
    const settings = {
      supplierOrderSendMode: 'MANUAL',
      supplierAnalogPolicy: 'CATALOG_ONLY',
      supplierDefaultStrategy: 'OPTIMAL',
      supplierOptimalPriceWeight: 0.7,
      supplierAllowSplit: true,
      supplierAllowAnalogsInAuto: false,
      supplierOfferTtlMinutes: 60,
      supplierOfferRetentionDays: 7,
      supplierOrderPollIntervalMinutes: 30,
      supplierCatalogSyncIntervalMinutes: 360,
      supplierUnknownDeliveryDays: 7,
    };
    apiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/settings/organisation' && init?.method === 'PATCH')
        return Promise.resolve({ ...settings, ...(JSON.parse(init.body ?? '{}') as object) });
      if (path === '/settings/organisation') return Promise.resolve(settings);
      if (path === '/supplier-providers') return Promise.resolve([AVD]);
      if (path === '/supplier-connections') return Promise.resolve({ items: [], total: 0 });
      return Promise.reject(new Error(`unexpected ${String(path)}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SupplierApiTab />
      </QueryClientProvider>,
    );
    const mode = await screen.findByLabelText('Передача замовлення в API');
    fireEvent.change(mode, { target: { value: 'ON_ORDERED' } });
    fireEvent.change(screen.getByLabelText('«Оптимально»: вага ціни, %'), {
      target: { value: '40' },
    });
    fireEvent.click(
      screen.getByRole('switch', { name: 'Ділити позицію між різними постачальниками' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          supplierOrderSendMode: 'ON_ORDERED',
          supplierOptimalPriceWeight: 0.4,
          supplierAllowSplit: false,
        }),
      }),
    );
  });

  it('значення поза межами — помилка без запиту', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/settings/organisation')
        return Promise.resolve({
          supplierOrderSendMode: 'MANUAL',
          supplierAnalogPolicy: 'CATALOG_ONLY',
          supplierDefaultStrategy: 'OPTIMAL',
          supplierOptimalPriceWeight: 0.7,
          supplierAllowSplit: true,
          supplierAllowAnalogsInAuto: false,
          supplierOfferTtlMinutes: 60,
          supplierOfferRetentionDays: 7,
          supplierOrderPollIntervalMinutes: 30,
          supplierCatalogSyncIntervalMinutes: 360,
          supplierUnknownDeliveryDays: 7,
        });
      if (path === '/supplier-providers') return Promise.resolve([]);
      if (path === '/supplier-connections') return Promise.resolve({ items: [], total: 0 });
      return Promise.reject(new Error(`unexpected ${String(path)}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SupplierApiTab />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Синхронізувати каталог AVD кожні, хв'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('від 60 до 1440');
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/settings/organisation',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  // Старіша збірка API (dev :3000 від 2026-10-15) не віддає полів `supplier*` — розділ показував
  // `strategyHint.undefined` і порожні числа. Тепер — значення за замовчуванням зі схеми.
  // guards: BR-SCON-009, BR-SOFR-007
  it('відповідь без полів supplier* → значення за замовчуванням, підказка обраної стратегії, без запиту', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/settings/organisation') return Promise.resolve({ invoiceDueDays: 14 });
      if (path === '/supplier-providers') return Promise.resolve([]);
      if (path === '/supplier-connections') return Promise.resolve({ items: [], total: 0 });
      return Promise.reject(new Error(`unexpected ${String(path)}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SupplierApiTab />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText('Передача замовлення в API')).toHaveValue('MANUAL');
    expect(screen.getByLabelText(/Стратегія автопідбору/)).toHaveValue('OPTIMAL');
    expect(screen.getByText('Баланс ціни й терміну за вагою з налаштувань')).toBeInTheDocument();
    expect(screen.queryByText(/strategyHint\./)).toBeNull();
    expect(screen.getByLabelText('«Оптимально»: вага ціни, %')).toHaveValue(70);
    expect(screen.getByLabelText('Пропозиція застаріла через, хв')).toHaveValue(60);
    expect(screen.getByLabelText('Синхронізувати каталог AVD кожні, хв')).toHaveValue(360);
    expect(
      screen.getByRole('switch', { name: 'Ділити позицію між різними постачальниками' }),
    ).toHaveAttribute('aria-checked', 'true');

    // Нічого не змінено — збереження без запиту (значення за замовчуванням не «зміна»).
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled());
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/settings/organisation',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  // guards: BR-SOFR-007
  it('невідома стратегія й вага рядком (Decimal) → стратегія за замовчуванням, вага з відповіді', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/settings/organisation')
        return Promise.resolve({
          supplierDefaultStrategy: 'NEW_FROM_FUTURE',
          supplierOptimalPriceWeight: '0.400',
        });
      if (path === '/supplier-providers') return Promise.resolve([]);
      if (path === '/supplier-connections') return Promise.resolve({ items: [], total: 0 });
      return Promise.reject(new Error(`unexpected ${String(path)}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SupplierApiTab />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText(/Стратегія автопідбору/)).toHaveValue('OPTIMAL');
    expect(screen.getByLabelText('«Оптимально»: вага ціни, %')).toHaveValue(40);
  });
});

// Значення за замовчуванням вкладки — копія `@default` схеми: поле, змінене лише в схемі, мовчки
// розійшлося б із тим, що вкладка показує старішому API.
describe('SupplierApiTab — значення за замовчуванням збігаються зі схемою', () => {
  // guards: BR-SCON-009, BR-SOFR-007
  it('кожне поле SUPPLIER_SETTINGS_DEFAULTS = @default у 09_settings.prisma', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../../../../../../packages/database/prisma/schema/09_settings.prisma'),
      'utf8',
    );
    const entries = Object.entries(SUPPLIER_SETTINGS_DEFAULTS);
    expect(entries).toHaveLength(11);
    for (const [field, value] of entries) {
      const m = new RegExp(`^\\s*${field}\\s+\\w+\\s+@default\\(([^)]+)\\)`, 'm').exec(schema);
      expect(m, field).not.toBeNull();
      expect(m![1], field).toBe(String(value));
    }
  });
});
