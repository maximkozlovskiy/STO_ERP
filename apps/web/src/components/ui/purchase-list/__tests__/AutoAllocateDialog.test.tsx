// «Підібрати автоматично» (BR-SOFR-007…009): стратегія за замовчуванням — з налаштувань закупівлі;
// попередній перегляд — dryRun; позиції з ручним вибором лишаються, доки не позначено «Перезаписати
// ручний вибір» (overrideManual); «Застосувати» — той самий розподіл без dryRun.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'STOREKEEPER' } }) }));

import { AutoAllocateDialog } from '../AutoAllocateDialog';

const BATCH = {
  id: 'b-1',
  purpose: 'MANUAL',
  strategy: null,
  done: true,
  completedAt: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  items: [
    {
      itemId: 'it-1',
      goodId: 'g',
      goodName: 'Фільтр',
      article: 'OC 90',
      brand: null,
      quantity: 4,
      status: 'OPEN',
      source: 'MANUAL',
      chosenOfferKey: 'k',
      chosenConnectionId: 'c',
      chosenBy: 'MANUAL',
      requests: [{ connectionId: 'c', status: 'DONE', offers: [] }],
    },
  ],
};

const allocateBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  apiFetch.mockReset();
  allocateBodies.length = 0;
  apiFetch.mockImplementation((path: string, init?: { body?: string }) => {
    if (path === '/supplier-offers/settings')
      return Promise.resolve({
        defaultStrategy: 'FAST',
        offerTtlMinutes: 60,
        allowSplit: true,
        allowAnalogsInAuto: false,
        analogPolicy: 'CATALOG_ONLY',
      });
    if (path === '/supplier-offers/search')
      return Promise.resolve({
        ...BATCH,
        queueUnavailable: false,
        noConnections: false,
        skippedItemIds: [],
      });
    if (path === '/supplier-offers/batches/b-1') return Promise.resolve(BATCH);
    if (path === '/supplier-offers/allocate') {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      allocateBodies.push(body);
      const manualKept = !body.overrideManual;
      return Promise.resolve({
        strategy: body.strategy,
        applied: !body.dryRun,
        previewToken: `tok-${String(body.strategy)}-${String(body.overrideManual)}`,
        totalUah: manualKept ? 0 : 320,
        items: [
          {
            itemId: 'it-1',
            goodName: 'Фільтр',
            need: 4,
            uncovered: 0,
            skippedReason: manualKept ? 'manualChoice' : null,
            parts: manualKept
              ? []
              : [
                  {
                    offerId: 'o',
                    connectionId: 'c',
                    supplierId: 's',
                    supplierName: 'AVD',
                    warehouseName: 'КИЇВ',
                    offerKey: 'k2',
                    qty: 4,
                    priceUah: 80,
                    days: 2,
                    isAnalog: false,
                  },
                ],
          },
        ],
      });
    }
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
});

function renderDialog() {
  const onApplied = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AutoAllocateDialog ids={['it-1']} onClose={vi.fn()} onApplied={onApplied} />
    </QueryClientProvider>,
  );
  return { onApplied };
}

describe('AutoAllocateDialog', () => {
  // guards: BR-SOFR-009
  it('перегляд — dryRun зі стратегією з налаштувань; ручний вибір лишається без прапорця', async () => {
    renderDialog();
    expect(await screen.findByText('обрано вручну — лишається')).toBeInTheDocument();
    expect(allocateBodies[0]).toEqual({
      batchId: 'b-1',
      strategy: 'FAST',
      dryRun: true,
      overrideManual: false,
    });
    expect(screen.getByRole('button', { name: 'Застосувати' })).toBeDisabled();
  });

  // guards: BR-SOFR-009
  it('«Перезаписати ручний вибір» → перегляд з overrideManual; «Застосувати» — без dryRun', async () => {
    const { onApplied } = renderDialog();
    await screen.findByText('обрано вручну — лишається');
    fireEvent.click(screen.getByLabelText(/Перезаписати ручний вибір/));
    expect(await screen.findByText(/AVD · КИЇВ: 4 × 80,00/)).toBeInTheDocument();
    expect(allocateBodies.at(-1)).toMatchObject({ overrideManual: true, dryRun: true });

    fireEvent.change(screen.getByLabelText('Стратегія'), { target: { value: 'CHEAP' } });
    await waitFor(() => expect(allocateBodies.at(-1)).toMatchObject({ strategy: 'CHEAP' }));
    const apply = screen.getByRole('button', { name: 'Застосувати' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    // Застосування несе відбиток показаного перегляду (BR-SOFR-009).
    expect(allocateBodies.at(-1)).toEqual({
      batchId: 'b-1',
      strategy: 'CHEAP',
      overrideManual: true,
      previewToken: 'tok-CHEAP-true',
    });
  });

  // guards: BR-SOFR-009
  it('Ctrl+Enter не застосовує в обхід кнопки, коли застосовувати нічого', async () => {
    renderDialog();
    await screen.findByText('обрано вручну — лишається');
    fireEvent.keyDown(screen.getByTestId('auto-allocate-dialog'), { key: 'Enter', ctrlKey: true });
    await new Promise(r => setTimeout(r, 0));
    expect(allocateBodies.every(b => b.dryRun === true)).toBe(true);
  });
});
