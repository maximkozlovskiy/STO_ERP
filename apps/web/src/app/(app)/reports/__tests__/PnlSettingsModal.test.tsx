// «Налаштування звіту» P&L (BR-RPT-030, рішення власника 2026-10-29): прапорці за групами (інші
// доходи / витрати з каси / зарплата), «Витрата» завжди увімкнена й не знімається, попередження про
// подвійний облік оплати контрагента, збереження — `PATCH /settings/organisation` і скидання кешу
// звіту P&L і KPI дашборду; Escape закриває вікно; кнопку бачать лише OWNER / ADMIN.
//
// Mutation-verify (2026-10-29): прибрати скидання `['dashboard-data','pnl']` → падає «збереження»;
// не додавати EXPENSE у тіло → падає «збереження»; прибрати попередження → падає «подвійний облік»;
// показувати кнопку без canEditSettings → падає «ролі».
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

import { PnlSettingsModal } from '../PnlSettingsModal';
import { PnlReport } from '../PnlReport';

const settings: ApiSchema<'PnlSettingsDto'> = {
  incomeCashReasons: ['MANUAL_IN'],
  expenseCashReasons: ['EXPENSE'],
  warnFuturePayroll: false,
};

let client: QueryClient;
function renderWithClient(ui: ReactElement) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) });

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
});

describe('PnlSettingsModal — BR-RPT-030', () => {
  // guards: BR-RPT-030
  it('прапорці з налаштувань звіту; «Витрата» увімкнена й заблокована; недоступних приводів немає', () => {
    renderWithClient(<PnlSettingsModal open onClose={vi.fn()} settings={settings} />);
    expect(box('Внесення')).toBeChecked();
    expect(box('Оплата контрагента')).not.toBeChecked();
    expect(box('Витрата')).toBeChecked();
    expect(box('Витрата')).toBeDisabled();
    expect(box('Під звіт')).not.toBeChecked();
    expect(box('Попереджати')).not.toBeChecked();
    // Зарплата, оплата постачальнику, повернення клієнту — вже в P&L, у вікні їх немає.
    expect(screen.queryByRole('checkbox', { name: /Виплата ЗП/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Оплата постачальнику/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Повернення клієнту/ })).toBeNull();
  });

  // guards: BR-RPT-030
  it('оплата контрагента як інший дохід — попередження про подвійний облік', () => {
    renderWithClient(<PnlSettingsModal open onClose={vi.fn()} settings={settings} />);
    expect(screen.queryByTestId('pnl-settings-double-count')).toBeNull();
    fireEvent.click(box('Оплата контрагента'));
    expect(screen.getByTestId('pnl-settings-double-count')).toHaveTextContent('двічі');
    fireEvent.click(box('Оплата контрагента'));
    expect(screen.queryByTestId('pnl-settings-double-count')).toBeNull();
  });

  // guards: BR-RPT-030
  it('збереження: PATCH /settings/organisation з усіма трьома полями; кеш P&L і дашборду скинуто', async () => {
    apiFetchMock.mockResolvedValue({});
    const onClose = vi.fn();
    renderWithClient(<PnlSettingsModal open onClose={onClose} settings={settings} />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    fireEvent.click(box('Під звіт'));
    fireEvent.click(box('Внесок власника'));
    fireEvent.click(box('Попереджати'));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/settings/organisation');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      pnlIncomeCashReasons: ['MANUAL_IN', 'OWNER_IN'],
      pnlExpenseCashReasons: ['EXPENSE', 'ADVANCE_ISSUE'],
      pnlWarnFuturePayroll: true,
    });
    const keys = invalidate.mock.calls.map(c => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['reports', 'pnl']));
    expect(keys).toContain(JSON.stringify(['dashboard-data', 'pnl']));
    expect(toastMock.success).toHaveBeenCalledWith('Налаштування звіту збережено');
  });

  // guards: BR-RPT-030
  it('помилка сервера — текст у вікні, вікно не закривається, кеш не скидається', async () => {
    apiFetchMock.mockRejectedValue(
      new Error('Звіт P&L: привід «Витрата» має завжди входити у витрати'),
    );
    const onClose = vi.fn();
    renderWithClient(<PnlSettingsModal open onClose={onClose} settings={settings} />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('«Витрата»');
    expect(onClose).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('Escape закриває вікно без збереження', () => {
    const onClose = vi.fn();
    renderWithClient(<PnlSettingsModal open onClose={onClose} settings={settings} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('PnlReport — рядок «Пораховано» і кнопка налаштувань', () => {
  const data: ApiSchema<'PnlReportDto'> = {
    months: ['2026-10'],
    rows: [
      { key: 'revenue', amounts: [100], total: 100 },
      { key: 'netProfit', amounts: [100], total: 100 },
    ],
    unknownCostPartsCount: 0,
    payrollMissingMonths: [],
    settings: {
      incomeCashReasons: ['MANUAL_IN', 'SALE_PAYMENT'],
      expenseCashReasons: ['EXPENSE', 'ADVANCE_ISSUE'],
      warnFuturePayroll: false,
    },
    from: '2026-10-01',
    to: '2026-10-31',
  };

  // guards: BR-RPT-030
  it('«Пораховано: …» — назви приводів, за якими зібрано звіт', () => {
    renderWithClient(<PnlReport data={data} />);
    expect(screen.getByTestId('pnl-settings-summary')).toHaveTextContent(
      'Пораховано: інші доходи — Внесення, Оплата контрагента; витрати з каси — Витрата, Під звіт',
    );
  });

  // guards: BR-RPT-030
  it('кнопку «Налаштування звіту» бачать лише ролі з правом змінювати (canEditSettings)', () => {
    const { unmount } = renderWithClient(<PnlReport data={data} />);
    expect(screen.queryByRole('button', { name: 'Налаштування звіту' })).toBeNull();
    unmount();

    renderWithClient(<PnlReport data={data} canEditSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Налаштування звіту' }));
    expect(screen.getByTestId('pnl-settings-modal')).toBeInTheDocument();
    expect(box('Оплата контрагента')).toBeChecked();
  });

  it('колонки «Показник» і «Разом» закріплені (sticky) з непрозорим фоном', () => {
    renderWithClient(<PnlReport data={data} />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers[0]?.className).toMatch(/sticky left-0/);
    expect(headers[0]?.className).toMatch(/bg-secondary/);
    expect(headers.at(-1)?.className).toMatch(/sticky right-0/);
    const net = screen.getByTestId('pnl-row-netProfit');
    const cells = net.querySelectorAll('td');
    expect(cells[0]?.className).toMatch(/sticky left-0.*bg-secondary|bg-secondary.*sticky left-0/);
    expect(cells[cells.length - 1]?.className).toMatch(/sticky right-0/);
  });
});
