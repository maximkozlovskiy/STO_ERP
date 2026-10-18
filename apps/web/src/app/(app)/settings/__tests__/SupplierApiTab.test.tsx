// «Налаштування → Постачальники API» (BR-SCON-001…004, BR-SOFR-005, 007, 008): картка підключення —
// поля з опису провайдера, креди лише на запис (збережене не показується, порожнє не надсилається),
// мапа складів — неповний склад не пропускається; розділ «Закупівля через API» шле лише змінене.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
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
import SupplierApiTab from '../SupplierApiTab';

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
  credentialFields: [
    { key: 'apiKey', label: 'API-ключ', secret: true, required: true, type: 'string' },
  ],
  optionFields: [],
  warehouseFields: [
    { key: 'locationUuid', label: 'Точка', secret: false, required: true, type: 'string' },
    { key: 'forwarderUuid', label: 'Перевізник', secret: false, required: true, type: 'string' },
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

describe('SupplierConnectionModal', () => {
  // guards: BR-SCON-002
  it('креди лише на запис: збережене — плейсхолдер «збережено», порожнє не надсилається', async () => {
    const { onSave } = renderModal(CONN);
    const key = screen.getByLabelText('API-ключ');
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Заповніть поле «API-ключ»');

    fireEvent.change(screen.getByLabelText('API-ключ'), { target: { value: 'k-123' } });
    const wh = screen.getByRole('group', { name: 'Основний' });
    fireEvent.change(within(wh).getByLabelText('Точка'), { target: { value: 'loc-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти і перевірити' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Склад «Основний»: заповніть «Перевізник»',
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(within(wh).getByLabelText('Перевізник'), { target: { value: 'fw-1' } });
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
});
