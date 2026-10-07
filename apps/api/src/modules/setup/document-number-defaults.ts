import type { DocumentType, ResetPeriod } from '@prisma/client';

export interface DocumentNumberDefault {
  prefix: string;
  /** undefined → дефолт схеми (true). */
  includeDate?: boolean;
  resetPeriod: ResetPeriod;
}

/**
 * Нумерація документів для НОВОЇ організації (`/setup/init`).
 *
 * `Record<DocumentType, …>` навмисно вичерпний: нове значення enum не скомпілюється, доки
 * тут не з'явиться його рядок. До 2026-10-07 це був список із 8 типів із 13 (Bug #794) —
 * п'ять типів, доданих пізніше, отримали лише backfill-міграції для ВЖЕ наявних організацій,
 * а на чистій інсталяції міграції відпрацьовують на порожній `organisations`. Наслідок:
 * після встановлення `DocumentNumberService.next()` давав 404 для товарів, договорів,
 * повернень і оплат постачальнику та актів — тобто їх не можна було створити взагалі.
 *
 * Додав тип у enum → додай рядок тут, у `packages/database/prisma/seed.ts` і міграцію-backfill
 * для наявних організацій (взірець — `20261007120000_backfill_missing_document_number_configs`).
 *
 * Префікси перших восьми типів лишені як були (вони вже в документах встановлених систем).
 */
export const DOCUMENT_NUMBER_DEFAULTS: Record<DocumentType, DocumentNumberDefault> = {
  WORK_ORDER: { prefix: 'НЗ', resetPeriod: 'YEARLY' },
  INVOICE: { prefix: 'РФ', resetPeriod: 'YEARLY' },
  PURCHASE_ORDER: { prefix: 'ПО', resetPeriod: 'YEARLY' },
  SUPPLIER_RETURN: { prefix: 'ПВП', resetPeriod: 'YEARLY' },
  STOCK_RECEIPT: { prefix: 'ПТ', resetPeriod: 'YEARLY' },
  STOCK_WRITEOFF: { prefix: 'СП', resetPeriod: 'YEARLY' },
  STOCK_TRANSFER: { prefix: 'ПМ', resetPeriod: 'YEARLY' },
  STOCK_OPENING: { prefix: 'ВЗ', resetPeriod: 'YEARLY' },
  RECONCILIATION_ACT: { prefix: 'АС', resetPeriod: 'YEARLY' },
  // «АКТ»/«АС» зайняті актом звірки — акт виконаних робіт має власний префікс.
  COMPLETION_ACT: { prefix: 'АВР', resetPeriod: 'YEARLY' },
  COUNTERPARTY_AGREEMENT: { prefix: 'ДГ', resetPeriod: 'YEARLY' },
  // Внутрішній код товару — наскрізний лічильник без дати (як у міграції 20260619140001).
  GOOD_INTERNAL_CODE: { prefix: 'T', includeDate: false, resetPeriod: 'NEVER' },
  SUPPLIER_PAYMENT: { prefix: 'ОПП', resetPeriod: 'YEARLY' },
};
