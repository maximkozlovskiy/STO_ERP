// «Рентабельність» (BR-RPT-035, рішення власника 2026-10-29): підпис «Праця (оцінка N%)» — з
// частки праці у відповіді, а не зашиті 40%; «Налаштування звіту» (OWNER / ADMIN) — поле «Частка
// праці, %» 0–100, крок 1, збереження — `PATCH /settings/organisation` з `laborCostRatio` 0…1 і
// скидання кешу звіту «Рентабельність».
//
// Mutation-verify (2026-10-29): підпис без `pct` (зашиті 40%) → падає «підпис»; не ділити на 100
// → падає «збереження»; прибрати скидання `['reports','profitability']` → падає «збереження»;
// пропустити 101 → падає «межі»; показувати кнопку без canEditSettings → падає «ролі».
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ApiSchema } from '@sto/shared';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { ProfitabilityReport } from '../ProfitabilityReport';
import { ProfitabilitySettingsModal, parseLaborPercent } from '../ProfitabilitySettingsModal';

const data: ApiSchema<'ProfitabilityReportDto'> = {
  totalRevenue: 10000,
  totalVat: 2000,
  totalRevenueWithVat: 12000,
  totalCost: 3350,
  totalCostParts: 2000,
  totalCostLabor: 1350,
  grossProfit: 6650,
  margin: 66.5,
  ordersCount: 4,
  unknownCostPartsCount: 0,
  laborCostRatio: 0.35,
  from: '2026-10-01',
  to: '2026-10-31',
};

let client: QueryClient;
function renderWithClient(ui: ReactElement) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
});

describe('«Рентабельність» — частка праці з налаштувань (BR-RPT-035)', () => {
  // guards: BR-RPT-035
  it('підпис рядка праці — «Праця (оцінка N%)» з відповіді, без зашитих 40%', () => {
    renderWithClient(<ProfitabilityReport data={data} chart={null} />);
    expect(screen.getByTestId('profitability-row-labor')).toHaveTextContent('— Праця (оцінка 35%)');
    expect(screen.queryByText(/40%/)).toBeNull();
  });

  // guards: BR-RPT-035
  it('ролі: кнопка «Налаштування звіту» лише з canEditSettings', () => {
    const { unmount } = renderWithClient(<ProfitabilityReport data={data} chart={null} />);
    expect(screen.queryByRole('button', { name: 'Налаштування звіту' })).toBeNull();
    unmount();
    renderWithClient(<ProfitabilityReport data={data} chart={null} canEditSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Налаштування звіту' }));
    expect(screen.getByLabelText('Частка праці, %')).toHaveValue(35);
  });

  // guards: BR-RPT-035
  it('збереження: PATCH /settings/organisation з часткою 0…1; кеш «Рентабельності» скинуто', async () => {
    apiFetchMock.mockResolvedValue({});
    const onClose = vi.fn();
    renderWithClient(<ProfitabilitySettingsModal open onClose={onClose} laborCostRatio={0.4} />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const input = screen.getByLabelText('Частка праці, %');
    expect(input).toHaveValue(40);
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation', {
      method: 'PATCH',
      body: JSON.stringify({ laborCostRatio: 0.45 }),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reports', 'profitability'] });
    expect(toastMock.success).toHaveBeenCalled();
  });

  // guards: BR-RPT-035
  it('межі: не ціле число від 0 до 100 — помилка, запиту немає', () => {
    renderWithClient(<ProfitabilitySettingsModal open onClose={vi.fn()} laborCostRatio={0.4} />);
    const input = screen.getByLabelText('Частка праці, %');
    for (const bad of ['101', '-1', '12.5', '']) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
      expect(screen.getByText('Вкажіть ціле число від 0 до 100')).toBeInTheDocument();
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(parseLaborPercent('0')).toBe(0);
    expect(parseLaborPercent('100')).toBe(1);
  });
});
