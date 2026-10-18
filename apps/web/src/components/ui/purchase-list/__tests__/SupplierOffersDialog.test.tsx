// «Пропозиції» позиції (docs/objects/supplier-offer.md): чипи стану кожного підключення, зокрема
// «Немає зв'язку — повтор о HH:MM» (BR-SOFR-002); останні відомі пропозиції, поки підключення не
// відповіло (BR-SOFR-003); ручний вибір (BR-SOFR-006); ролі без цін бачать «—» (BR-SOFR-010).

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { fmtTime } from '@/lib/format';
import type {
  SupplierOffer,
  SupplierOfferItem,
  SupplierOfferRequest,
} from '@/hooks/api/useSupplierOffers';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }) }));

import { SupplierOffersDialog, mergeRequests, requestChip } from '../SupplierOffersDialog';

const offer = (over: Partial<SupplierOffer> = {}): SupplierOffer => ({
  id: 'of-1',
  connectionId: 'c-utr',
  supplierItemId: 'si-1',
  article: 'OC 90',
  brand: 'MAHLE',
  name: 'Фільтр оливи',
  price: 2,
  currencyCode: 'EUR',
  priceUah: 90,
  qty: 10,
  qtyIsLowerBound: true,
  warehouseCode: 'w1',
  warehouseName: 'Київ Правий',
  deliveryDays: 1,
  deliveryDate: null,
  multiplicity: null,
  isAnalog: false,
  offerKey: 'k-1',
  matchedGoodId: 'g-1',
  matchStatus: 'matched',
  fetchedAt: '2026-10-18T10:00:00.000Z',
  stale: false,
  selectable: true,
  notSelectableReason: null,
  replacesGood: false,
  chosen: false,
  ...over,
});

const request = (over: Partial<SupplierOfferRequest> = {}): SupplierOfferRequest => ({
  id: 'r-1',
  connectionId: 'c-utr',
  connectionName: 'UTR',
  provider: 'UTR',
  supplierId: 's-utr',
  supplierName: 'UTR Постачальник',
  status: 'DONE',
  fromCache: false,
  fetchedAt: '2026-10-18T10:00:00.000Z',
  stale: false,
  mirrorStale: false,
  nextRetryAt: null,
  error: null,
  offers: [offer()],
  ...over,
});

const itemDto = (requests: SupplierOfferRequest[]): SupplierOfferItem => ({
  itemId: 'it-1',
  goodId: 'g-1',
  goodName: 'Фільтр',
  article: 'OC 90',
  brand: 'MAHLE',
  quantity: 4,
  status: 'OPEN',
  source: 'MANUAL',
  chosenOfferKey: null,
  chosenConnectionId: null,
  chosenBy: null,
  requests,
});

const ITEM = {
  id: 'it-1',
  goodName: 'Фільтр',
  goodUnit: 'шт',
  quantity: 4,
  status: 'OPEN',
  offerKey: null,
} as unknown as PurchaseListItem;

const t = (key: string, opts?: Record<string, unknown>) =>
  `${key}${opts ? JSON.stringify(opts) : ''}`;

function routes(batchItem: SupplierOfferItem, lastKnown: SupplierOfferItem) {
  apiFetch.mockImplementation((path: string) => {
    if (path === '/supplier-offers/search')
      return Promise.resolve({
        id: 'b-1',
        purpose: 'MANUAL',
        strategy: null,
        done: true,
        completedAt: null,
        createdAt: '2026-10-18T10:00:00.000Z',
        items: [batchItem],
        queueUnavailable: false,
        noConnections: false,
        skippedItemIds: [],
      });
    if (path === '/supplier-offers/batches/b-1')
      return Promise.resolve({ id: 'b-1', done: true, items: [batchItem] });
    if (path === '/purchase-list-items/it-1/offers') return Promise.resolve(lastKnown);
    if (path === '/purchase-list-items/it-1/choose-offer') return Promise.resolve({ id: 'it-1' });
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SupplierOffersDialog item={ITEM} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe('requestChip — стан підключення в пошуку (BR-SOFR-002)', () => {
  // guards: BR-SOFR-002
  it('немає зв’язку чи ліміт — «повтор о HH:MM» за київським часом', () => {
    const at = '2026-10-18T10:29:00.000Z';
    const chip = requestChip(request({ status: 'RETRYING', nextRetryAt: at, offers: [] }), t);
    expect(chip.label).toBe(`offers.chip.retry${JSON.stringify({ time: fmtTime(at) })}`);
    expect(fmtTime(at)).toBe('13:29');
    expect(chip.variant).toBe('warning');
  });

  // guards: BR-SOFR-002
  it('черга / виконується — «Завантаження…»; кеш — «З кешу від …»; помилка — з текстом', () => {
    expect(requestChip(request({ status: 'QUEUED' }), t).label).toBe('offers.chip.loading');
    expect(requestChip(request({ status: 'RUNNING' }), t).label).toBe('offers.chip.loading');
    expect(requestChip(request({ fromCache: true }), t).label).toMatch(/^offers\.chip\.cache/);
    const failed = requestChip(request({ status: 'FAILED', error: 'UTR 401: Bad credentials' }), t);
    expect(failed).toMatchObject({
      label: 'offers.chip.failed',
      title: 'UTR 401: Bad credentials',
    });
    expect(requestChip(request({ stale: true }), t).label).toContain('offers.chip.stale');
  });
});

describe('mergeRequests — останні відомі пропозиції (BR-SOFR-003)', () => {
  // guards: BR-SOFR-003
  it('підключення ще не відповіло — показуються його останні відомі пропозиції', () => {
    const current = itemDto([
      request({ status: 'RETRYING', offers: [] }),
      request({
        connectionId: 'c-avd',
        supplierName: 'AVD',
        offers: [offer({ id: 'of-a', priceUah: 80, connectionId: 'c-avd' })],
      }),
    ]);
    const previous = itemDto([request()]);
    const { rows } = mergeRequests(current, previous);
    expect(rows.map(r => [r.offer.id, r.fromLastKnown])).toEqual([
      ['of-a', false],
      ['of-1', true],
    ]);
  });

  it('виконаний поточний запит — без підміни, рядки за ціною в гривні', () => {
    const current = itemDto([
      request({ offers: [offer({ id: 'x', priceUah: 200 }), offer({ id: 'y', priceUah: 100 })] }),
    ]);
    const { rows } = mergeRequests(current, itemDto([request()]));
    expect(rows.map(r => r.offer.id)).toEqual(['y', 'x']);
    expect(rows.every(r => !r.fromLastKnown)).toBe(true);
  });
});

describe('SupplierOffersDialog', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  // guards: BR-SOFR-002
  it('відкриття запускає пошук; чипи кожного підключення; «Оновити» — з refresh', async () => {
    routes(
      itemDto([
        request({ status: 'RETRYING', nextRetryAt: '2026-10-18T10:29:00.000Z', offers: [] }),
      ]),
      itemDto([request()]),
    );
    renderDialog();
    expect(await screen.findByText(/повтор о 13:29/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/supplier-offers/search', {
      method: 'POST',
      body: JSON.stringify({ itemIds: ['it-1'], refresh: false }),
    });
    // Підключення не відповіло — рядок останньої відомої пропозиції на місці.
    expect(await screen.findAllByTestId('supplier-offer-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/supplier-offers/search', {
        method: 'POST',
        body: JSON.stringify({ itemIds: ['it-1'], refresh: true }),
      }),
    );
  });

  it('«Обрати» — choose-offer з id пропозиції і закриття; кількість «≥10», ціна + у гривні', async () => {
    routes(itemDto([request()]), itemDto([]));
    const { onClose } = renderDialog();
    const row = await screen.findByTestId('supplier-offer-row');
    expect(within(row).getByText('≥10')).toBeInTheDocument();
    expect(within(row).getByText(/2,00\s+EUR/)).toBeInTheDocument();
    expect(within(row).getByText(/≈ 90,00/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /^Обрати/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith('/purchase-list-items/it-1/choose-offer', {
      method: 'POST',
      body: JSON.stringify({ offerId: 'of-1' }),
    });
  });

  it('пропозицію, яку не можна обрати, позначено причиною — кнопки «Обрати» немає', async () => {
    routes(
      itemDto([
        request({
          offers: [
            offer({
              isAnalog: true,
              selectable: false,
              notSelectableReason: 'analogFromWorkOrder',
            }),
          ],
        }),
      ]),
      itemDto([]),
    );
    renderDialog();
    const row = await screen.findByTestId('supplier-offer-row');
    expect(within(row).getByText(/спершу змініть товар у наряді/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Обрати/ })).toBeNull();
  });

  // guards: BR-SOFR-010
  it('ціна null (роль без закупівельних цін) — «—», без валюти й гривневого еквівалента', async () => {
    routes(itemDto([request({ offers: [offer({ price: null, priceUah: null })] })]), itemDto([]));
    renderDialog();
    const row = await screen.findByTestId('supplier-offer-row');
    expect(within(row).queryByText(/EUR|₴/)).toBeNull();
    expect(within(row).getByText('—')).toBeInTheDocument();
  });
});
