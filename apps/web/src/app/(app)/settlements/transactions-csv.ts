// CSV операцій контрагента (вкладка «Взаєморозрахунки») — винесено з SettlementsTabContent, щоб
// повноту вибірки й формат файла можна було тестувати (тест — __tests__/transactions-csv.test.ts).

import type { TFunction } from 'i18next';
import { escapeCsvCell } from '@/lib/utils';
import { fmtDate } from '@/lib/format';
import { settlementTxTypeLabel } from '@/i18n/enumLabel';

/** Рядок операції, як його віддає `GET /counterparties/:id/transactions`. */
export interface CsvTransaction {
  type: string;
  amount: number;
  currencyCode?: string | null;
  amountBase?: number | null;
  documentType?: string | null;
  notes?: string | null;
  createdAt: string;
}

/** Найбільша сторінка, яку віддає API (`calculatePagination` — cap 200). */
export const TX_EXPORT_PAGE_SIZE = 200;

/**
 * Усі операції контрагента сторінками по 200 — експорт до 2026-10-25 брав лише перші 50, які
 * показує вкладка, хоча в заголовку стояла загальна кількість (рішення власника: «усі записи»).
 * Зупиняється, коли зібрано `total` або сторінка прийшла неповною.
 */
export async function fetchAllTransactions<T>(
  fetchPage: (page: number, limit: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const { items, total } = await fetchPage(page, TX_EXPORT_PAGE_SIZE);
    all.push(...items);
    if (items.length < TX_EXPORT_PAGE_SIZE || all.length >= total) return all;
  }
}

/**
 * Мультивалюта: окремі колонки «Валюта» + «Сума (базова)», щоб експорт не змішував суми різних
 * валют у одній колонці (100 USD і 4150 UAH виглядали б однаково → нескладна сума). Base-колонка
 * (amountBase ?? amount — історичні = base UAH) — єдина, яку коректно підсумовувати.
 */
export function buildTransactionsCsv(
  transactions: CsvTransaction[],
  t: TFunction<'settlements'>,
  baseCode: string,
): string {
  const rows = [
    [
      t('csv.date'),
      t('csv.type'),
      t('csv.amount'),
      t('csv.currency'),
      t('csv.amountBase', { code: baseCode }),
      t('csv.document'),
      t('csv.notes'),
    ],
    ...transactions.map(tx => [
      fmtDate(tx.createdAt),
      settlementTxTypeLabel(tx.type),
      tx.amount,
      tx.currencyCode ?? baseCode,
      tx.amountBase ?? tx.amount,
      tx.documentType ?? '',
      tx.notes ?? '',
    ]),
  ];
  return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
}
