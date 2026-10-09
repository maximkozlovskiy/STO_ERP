// Імпорт виписки з обома напрямками (BR-BANK-017, 018, 037):
//   - `directionMode` (типово SIGN) і `debitCol` ідуть у multipart-запит прев'ю;
//     `debitCol` — лише в режимі «за знаком суми»;
//   - `direction` кожного рядка йде в apply (сума в прев'ю завжди додатна);
//   - прев'ю: напрям, сума зі знаком у ВАЛЮТІ РАХУНКУ, позначка можливого дубля ручного платежу
//     і підсумок зверху.
//
// Mutation-verify:
//   - хук: прибрати `fd.append('directionMode', …)`            → кейси режиму падають;
//   - хук: `directionMode === 'SIGN' && mapping.debitCol` → `mapping.debitCol` → «debitCol не йде в режимі OUT» падає;
//   - модалка: прибрати `direction: r.direction` з рядків apply → «direction іде в apply» падає;
//   - модалка: `r.possibleManualDuplicate &&` → `false &&`       → кейси позначки дубля падають;
//   - модалка: `{currencySuffix}` → `₴`                          → «валюта рахунку» падає.

import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => `d:${v}`,
  fmtBankCurrencySuffix: (c: string | null | undefined) => (!c || c === 'UAH' ? '₴' : c),
}));

const apiFetchMock = vi.fn();
const multipartMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: (...args: unknown[]) => multipartMock(...args),
}));

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BankStatementImportModal } from '../BankStatementImportModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const ACC_UAH = '11111111-1111-4111-8111-111111111111';
const ACC_USD = '22222222-2222-4222-8222-222222222222';

const previewRow = (over: Record<string, unknown> = {}) => ({
  rowIndex: 2,
  operationDate: '2026-10-01',
  direction: 'IN',
  amount: 500,
  payerName: 'ТОВ Клієнт',
  payerIban: null,
  payerEdrpou: null,
  purpose: 'Оплата',
  externalId: 'ext-1',
  matchStatus: 'notFound',
  candidates: [],
  possibleManualDuplicate: false,
  ...over,
});

let previewRows: ReturnType<typeof previewRow>[] = [];

type Init = { method?: string; body?: string };

beforeEach(() => {
  apiFetchMock.mockReset();
  multipartMock.mockReset();
  previewRows = [previewRow()];
  apiFetchMock.mockImplementation((path: string, init?: Init) => {
    if (path === '/bank-accounts')
      return Promise.resolve({
        items: [
          { id: ACC_UAH, name: 'Основний', currencyCode: 'UAH' },
          { id: ACC_USD, name: 'Валютний', currencyCode: 'USD' },
        ],
      });
    if (path === '/bank-statements/import/apply' && init?.method === 'POST')
      return Promise.resolve({ created: 2, skipped: 0 });
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
  multipartMock.mockImplementation((path: string) => {
    if (path.endsWith('/raw-preview'))
      return Promise.resolve({ rows: [['Дата', 'Сума', 'ID']], columnCount: 3 });
    if (path.endsWith('/preview')) return Promise.resolve({ rows: previewRows });
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
});

/** Пройти крок 1 (рахунок + файл) і опинитись на розмітці колонок. */
async function toMappingStep(accountId = ACC_UAH) {
  renderWithQueryClient(<BankStatementImportModal open onClose={() => {}} />);
  await screen.findByRole('option', { name: 'Валютний' });
  fireEvent.change(screen.getByLabelText(/Банківський рахунок/), { target: { value: accountId } });
  const file = new File(['a;b;c'], 'statement.csv', { type: 'text/csv' });
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
  await screen.findByText('Напрям платежів у файлі');
}

async function toPreviewStep(accountId = ACC_UAH) {
  await toMappingStep(accountId);
  fireEvent.click(screen.getByRole('button', { name: 'Передперегляд' }));
  await screen.findByRole('button', { name: /Імпортувати/ });
}

const previewForm = (): FormData => {
  const call = multipartMock.mock.calls.find(c => String(c[0]).endsWith('/import/preview'));
  expect(call).toBeTruthy();
  return call![1] as FormData;
};
const applyBody = () => {
  const call = apiFetchMock.mock.calls.find(c => c[0] === '/bank-statements/import/apply');
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as Init).body!) as {
    bankAccountId: string;
    rows: Record<string, unknown>[];
  };
};
const mode = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
const debitCol = () => screen.getByLabelText(/Колонка суми списання/) as HTMLInputElement;

describe('BankStatementImportModal — напрям платежів у файлі (крок колонок)', () => {
  it('типово «За знаком суми»; три режими; колонка списання доступна', async () => {
    await toMappingStep();
    expect(mode('За знаком суми').checked).toBe(true);
    expect(mode('Усі вхідні').checked).toBe(false);
    expect(mode('Усі вихідні').checked).toBe(false);
    expect(debitCol().disabled).toBe(false);
  });

  it('підписи колонок — «контрагент», а не «платник»', async () => {
    await toMappingStep();
    expect(screen.getByLabelText(/^Колонка контрагента/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Колонка IBAN контрагента/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Колонка ЄДРПОУ контрагента/)).toBeInTheDocument();
    expect(screen.queryByText(/платник/i)).not.toBeInTheDocument();
  });

  it("типовий режим іде в запит прев'ю як directionMode=SIGN, без debitCol", async () => {
    await toPreviewStep();
    const fd = previewForm();
    expect(fd.get('directionMode')).toBe('SIGN');
    expect(fd.has('debitCol')).toBe(false);
    expect(fd.get('bankAccountId')).toBe(ACC_UAH);
  });

  it("«За знаком суми» + колонка списання → debitCol у запиті прев'ю", async () => {
    await toMappingStep();
    fireEvent.change(debitCol(), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Передперегляд' }));
    await screen.findByRole('button', { name: /Імпортувати/ });
    const fd = previewForm();
    expect(fd.get('directionMode')).toBe('SIGN');
    expect(fd.get('debitCol')).toBe('5');
  });

  it.each([
    ['Усі вхідні', 'IN'],
    ['Усі вихідні', 'OUT'],
  ] as const)(
    '«%s» → directionMode=%s; колонка списання вимкнена й не йде в запит',
    async (label, value) => {
      await toMappingStep();
      // Колонку вказали ще в режимі «за знаком» — після зміни режиму вона не має поїхати в запит.
      fireEvent.change(debitCol(), { target: { value: '5' } });
      fireEvent.click(mode(label));
      expect(debitCol().disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Передперегляд' }));
      await screen.findByRole('button', { name: /Імпортувати/ });
      const fd = previewForm();
      expect(fd.get('directionMode')).toBe(value);
      expect(fd.has('debitCol')).toBe(false);
    },
  );
});

describe("BankStatementImportModal — прев'ю і apply", () => {
  it('колонка напряму й сума зі знаком: вхідний «+», вихідний «−»', async () => {
    previewRows = [
      previewRow({ rowIndex: 2, externalId: 'in-1', direction: 'IN', amount: 500 }),
      previewRow({
        rowIndex: 3,
        externalId: 'out-1',
        direction: 'OUT',
        amount: 1200,
        payerName: 'ТОВ Постачальник',
      }),
    ];
    await toPreviewStep();
    expect(screen.getByRole('columnheader', { name: 'Напрям' })).toBeInTheDocument();
    const [, inRow, outRow] = screen.getAllByRole('row');
    expect(within(inRow!).getByText('Вхідний')).toBeInTheDocument();
    expect(within(inRow!).getByText('+500 ₴')).toHaveClass(
      'text-success',
      'text-right',
      'tabular-nums',
    );
    expect(within(outRow!).getByText('Вихідний')).toBeInTheDocument();
    expect(within(outRow!).getByText('−1200 ₴')).toHaveClass(
      'text-destructive',
      'text-right',
      'tabular-nums',
    );
  });

  it('сума — у валюті обраного рахунку, а не захардкоджена гривня', async () => {
    previewRows = [previewRow({ direction: 'OUT', amount: 150 })];
    await toPreviewStep(ACC_USD);
    expect(screen.getByText('−150 USD')).toBeInTheDocument();
    expect(screen.queryByText(/₴/)).not.toBeInTheDocument();
  });

  it('direction кожного рядка йде в apply; сума лишається додатною', async () => {
    previewRows = [
      previewRow({ rowIndex: 2, externalId: 'in-1', direction: 'IN', amount: 500 }),
      previewRow({ rowIndex: 3, externalId: 'out-1', direction: 'OUT', amount: 1200 }),
    ];
    await toPreviewStep();
    fireEvent.click(screen.getByRole('button', { name: 'Імпортувати (2)' }));
    await waitFor(() => expect(screen.getByText('Створено: 2')).toBeInTheDocument());
    const body = applyBody();
    expect(body.bankAccountId).toBe(ACC_UAH);
    expect(body.rows.map(r => [r.externalId, r.direction, r.amount])).toEqual([
      ['in-1', 'IN', 500],
      ['out-1', 'OUT', 1200],
    ]);
  });

  it('дублікат за externalId в apply не йде — як і раніше', async () => {
    previewRows = [
      previewRow({ externalId: 'new', direction: 'OUT' }),
      previewRow({ rowIndex: 3, externalId: 'dup', matchStatus: 'duplicate' }),
    ];
    await toPreviewStep();
    fireEvent.click(screen.getByRole('button', { name: 'Імпортувати (1)' }));
    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some(c => c[0] === '/bank-statements/import/apply')).toBe(
        true,
      ),
    );
    expect(applyBody().rows.map(r => r.externalId)).toEqual(['new']);
  });

  it('possibleManualDuplicate: позначка біля рядка і підсумок зверху; імпорт не блокується', async () => {
    previewRows = [
      previewRow({ rowIndex: 2, externalId: 'a', possibleManualDuplicate: true }),
      previewRow({ rowIndex: 3, externalId: 'b', possibleManualDuplicate: false }),
      previewRow({ rowIndex: 4, externalId: 'c', possibleManualDuplicate: true, direction: 'OUT' }),
    ];
    await toPreviewStep();
    const [, rowA, rowB, rowC] = screen.getAllByRole('row');
    const MARK = 'Схоже на платіж, внесений вручну';
    expect(within(rowA!).getByText(MARK)).toBeInTheDocument();
    expect(within(rowB!).queryByText(MARK)).not.toBeInTheDocument();
    expect(within(rowC!).getByText(MARK)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Рядків, схожих на платежі, внесені вручну: 2.',
    );
    // Попередження, а не блок: усі три рядки імпортуються.
    expect(screen.getByRole('button', { name: 'Імпортувати (3)' })).toBeEnabled();
  });

  it('без можливих дублів підсумку й позначок немає', async () => {
    await toPreviewStep();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Схоже на платіж, внесений вручну')).not.toBeInTheDocument();
  });
});
