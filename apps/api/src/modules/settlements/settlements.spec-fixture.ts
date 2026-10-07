import { vi } from 'vitest';
import { SettlementsAccountService } from './settlements-account.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PdfService } from '../pdf/pdf.service';

/**
 * Фікстура для спеків SettlementsAccountService (читання балансу/журналу, акт звірки).
 * Factory, не const: api-спеки йдуть з `isolate: false` без `clearMocks`, тож кожен
 * `beforeEach` мусить отримати свіжі моки.
 */
export function makeAccountFixture() {
  const prisma = {
    settlementAccount: { findFirst: vi.fn().mockResolvedValue(null) },
    settlementTransaction: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    counterparty: { findFirst: vi.fn().mockResolvedValue({ id: 'cp-1' }) },
    reconciliationAct: {
      // Повертає те, що записали, — як це зробила б БД.
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'act-1',
          createdAt: new Date('2026-08-01T10:00:00.000Z'),
          ...data,
        }),
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    organisation: { findFirst: vi.fn().mockResolvedValue({ name: 'СТО Тест' }) },
  };
  const pdf = { generateReconciliationActPdf: vi.fn().mockResolvedValue(Buffer.from('pdf')) };
  const service = new SettlementsAccountService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
  );
  return { prisma, pdf, service };
}

/** Рядок журналу, яким його повертає Prisma (суми — рядки, як Decimal після серіалізації). */
export function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    type: 'CHARGE',
    amount: '100.00',
    currencyId: null,
    amountBase: '100.00',
    rateUsed: '1',
    documentType: null,
    documentId: null,
    notes: null,
    createdAt: new Date('2026-07-10T09:00:00.000Z'),
    currency: null,
    ...overrides,
  };
}
