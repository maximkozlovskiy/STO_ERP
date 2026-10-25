// CSV операцій контрагента — усі записи, а не перші 50, які показує вкладка (рішення власника
// 2026-10-25). Mutation-verify (прогнано): повернути один запит першої сторінки → кейс «усі
// сторінки» падає.
import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import i18n from 'i18next';
import {
  TX_EXPORT_PAGE_SIZE,
  buildTransactionsCsv,
  fetchAllTransactions,
  type CsvTransaction,
} from '../transactions-csv';

const t = i18n.getFixedT('uk', 'settlements') as unknown as TFunction<'settlements'>;

const tx = (i: number): CsvTransaction => ({
  type: 'PAYMENT',
  amount: i,
  createdAt: '2026-10-20T10:00:00.000Z',
});

/** Фейковий API: `total` записів, сторінками по `limit`. */
function pager(total: number) {
  const all = Array.from({ length: total }, (_, i) => tx(i + 1));
  return vi.fn((page: number, limit: number) =>
    Promise.resolve({ items: all.slice((page - 1) * limit, page * limit), total }),
  );
}

describe('settlements › transactions-csv', () => {
  it('експорт збирає всі сторінки по 200 — 450 операцій → 3 запити, 450 рядків', async () => {
    const fetchPage = pager(450);
    const all = await fetchAllTransactions(fetchPage);
    expect(all).toHaveLength(450);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.map(c => c[1])).toEqual(Array(3).fill(TX_EXPORT_PAGE_SIZE));
  });

  it('рівно повна сторінка — зупинка за total, без зайвого запиту; порожньо — один запит', async () => {
    const full = pager(200);
    expect(await fetchAllTransactions(full)).toHaveLength(200);
    expect(full).toHaveBeenCalledTimes(1);
    const none = pager(0);
    expect(await fetchAllTransactions(none)).toEqual([]);
    expect(none).toHaveBeenCalledTimes(1);
  });

  it('CSV: заголовок + рядок на кожну операцію, базова сума — числом з комою', () => {
    const csv = buildTransactionsCsv(
      [{ ...tx(1), amount: 100, currencyCode: 'USD', amountBase: 4150.5 }],
      t,
      'UAH',
    );
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(';100;USD;4150,5;');
  });
});
