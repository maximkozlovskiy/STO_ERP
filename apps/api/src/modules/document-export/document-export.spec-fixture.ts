import type { PrismaService } from '../../prisma/prisma.service';
import type { OrgPrintInfo } from '../pdf/org-print-info.types';

/**
 * Prisma-двійник для спеків друку документів. Не повертає заготовку, а ВИКОНУЄ запит: `where`
 * (рівність полів, `deletedAt: null` — «не видалені»), `select` (лише вибрані поля, вкладені
 * зв'язки), а для списку рядків — `where`, `orderBy` і `take`. Тож тест на порядок рядків падає,
 * якщо мапер забув `orderBy` (рядки лежать у сховищі навмисно перемішаними), а тест на чужу
 * організацію — якщо зник фільтр `orgId`.
 */

type Row = Record<string, unknown>;
type Spec = Record<string, unknown>;

function matches(row: Row, where: Spec | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, 'asc' | 'desc'>[];
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const [field, dir] = Object.entries(k)[0];
      const c = cmp(a[field], b[field]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

function project(row: Row, select: Spec): Row {
  const out: Row = {};
  for (const [k, spec] of Object.entries(select)) {
    if (spec === true) {
      out[k] = row[k];
      continue;
    }
    const s = spec as Spec;
    const v = row[k];
    if (Array.isArray(v)) {
      let items = (v as Row[]).filter(r => matches(r, s.where as Spec | undefined));
      if (s.orderBy) items = sortRows(items, s.orderBy);
      if (typeof s.take === 'number') items = items.slice(0, s.take);
      out[k] = items.map(i => (s.select ? project(i, s.select as Spec) : i));
    } else {
      out[k] = v == null ? null : s.select ? project(v as Row, s.select as Spec) : v;
    }
  }
  return out;
}

export interface PrintWorld {
  prisma: PrismaService;
  /** `where` кожного читання документа — щоб перевірити фільтр буквально. */
  reads: Spec[];
}

/** Сховище документів за назвою делегата Prisma (`invoice`, `purchaseOrder`, …). */
export function printWorld(store: Record<string, Row[]>): PrintWorld {
  const reads: Spec[] = [];
  const delegates: Record<string, { findFirst: (args: Spec) => Promise<Row | null> }> = {};
  for (const [model, rows] of Object.entries(store)) {
    delegates[model] = {
      findFirst: (args: Spec) => {
        reads.push(args.where as Spec);
        const row = rows.find(r => matches(r, args.where as Spec));
        return Promise.resolve(row ? project(row, args.select as Spec) : null);
      },
    };
  }
  return { prisma: delegates as unknown as PrismaService, reads };
}

export const ORG = 'org-a';
export const OTHER_ORG = 'org-b';
export const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
export const PO_ID = '22222222-2222-4222-8222-222222222222';
export const SD_ID = '33333333-3333-4333-8333-333333333333';
export const SR_ID = '44444444-4444-4444-8444-444444444444';

const t = (ms: number) => new Date(Date.UTC(2026, 10, 5, 8, 0, 0, ms));
const good = (name: string, unit = 'шт', base: string | null = null) => ({
  name,
  unit,
  unitOfMeasure: base ? { shortName: base } : null,
});
const supplier = {
  firstName: null,
  lastName: null,
  companyName: 'ТОВ Постачальник',
  phone: '+380501112233',
  edrpou: '12345678',
};

export const ORG_INFO: OrgPrintInfo = {
  name: 'СТО Альфа',
  edrpou: '87654321',
  address: 'м. Київ, вул. Сервісна, 1',
  phone: '+380441234567',
};

/**
 * Документи в сховищі. Рядки лежать НЕ в порядку картки: порядок визначає лише `orderBy` мапера.
 */
export function sampleStore(over: { deletedAt?: Date | null } = {}): Record<string, Row[]> {
  const deletedAt = over.deletedAt ?? null;
  return {
    invoice: [
      {
        id: INVOICE_ID,
        orgId: ORG,
        deletedAt,
        number: 'INV/2026/0001',
        documentDate: new Date('2026-11-05T00:00:00Z'),
        dueDate: new Date('2026-11-19T00:00:00Z'),
        notes: 'Оплата протягом 14 днів',
        totalWithoutVat: 1000,
        totalVat: 200,
        totalWithVat: 1200,
        currency: { code: 'UAH' },
        counterparty: {
          firstName: 'Іван',
          lastName: 'Петренко',
          companyName: null,
          phone: '+380671234567',
          edrpou: null,
        },
        lines: [
          {
            sortOrder: 2,
            createdAt: t(0),
            id: 'l-c',
            description: 'Ручний рядок',
            quantity: 1,
            unitPrice: 100,
            vatRate: 20,
            priceWithVat: 120,
            workId: null,
            unitOfMeasure: null,
            good: null,
          },
          {
            sortOrder: 0,
            createdAt: t(5),
            id: 'l-b',
            description: 'Заміна масла',
            quantity: 1.5,
            unitPrice: 400,
            vatRate: 20,
            priceWithVat: 720,
            workId: 'w-1',
            unitOfMeasure: null,
            good: null,
          },
          {
            sortOrder: 0,
            createdAt: t(1),
            id: 'l-a',
            description: 'Масло 5W-30',
            quantity: 2,
            unitPrice: 150,
            vatRate: 20,
            priceWithVat: 360,
            workId: null,
            unitOfMeasure: { shortName: 'л' },
            good: good('Масло 5W-30', 'шт', 'кан'),
          },
        ],
      },
    ],
    purchaseOrder: [
      {
        id: PO_ID,
        orgId: ORG,
        deletedAt,
        number: 'PO-0007',
        documentDate: new Date('2026-11-04T00:00:00Z'),
        paymentDate: new Date('2026-11-20T00:00:00Z'),
        notes: null,
        totalAmount: 650,
        totalVat: 108.33,
        currency: { code: 'UAH' },
        supplier,
        warehouse: { name: 'Основний склад' },
        contract: { number: 'Д-15' },
        lines: [
          {
            id: 'p-2',
            createdAt: t(2),
            deletedAt: null,
            quantity: 3,
            price: 50,
            vatAmount: 25,
            unitOfMeasure: null,
            good: good('Фільтр повітряний', 'шт', 'шт'),
          },
          {
            id: 'p-x',
            createdAt: t(0),
            deletedAt: new Date('2026-11-04T10:00:00Z'),
            quantity: 9,
            price: 9,
            vatAmount: 0,
            unitOfMeasure: null,
            good: good('Видалений рядок'),
          },
          {
            id: 'p-1',
            createdAt: t(1),
            deletedAt: null,
            quantity: 1,
            price: 500,
            vatAmount: 83.33,
            unitOfMeasure: { shortName: 'компл' },
            good: good('Комплект ГРМ', 'шт', 'шт'),
          },
        ],
      },
    ],
    stockDocument: [
      {
        id: SD_ID,
        orgId: ORG,
        deletedAt,
        number: 'SD-0003',
        type: 'TRANSFER',
        documentDate: new Date('2026-11-03T00:00:00Z'),
        confirmedAt: new Date('2026-11-03T21:30:00Z'),
        notes: 'Переміщення на філію',
        warehouse: { name: 'Основний склад' },
        targetWarehouse: { name: 'Склад філії' },
        purchaseOrder: null,
        lines: [
          {
            id: 's-2',
            createdAt: t(2),
            deletedAt: null,
            quantity: 4,
            price: null,
            unitOfMeasure: null,
            good: good('Хомут', 'шт', null),
          },
          {
            id: 's-1',
            createdAt: t(1),
            deletedAt: null,
            quantity: 0.3,
            price: 100.05,
            unitOfMeasure: null,
            good: good('Мастило', 'кг', 'кг'),
          },
        ],
      },
    ],
    supplierReturn: [
      {
        id: SR_ID,
        orgId: ORG,
        deletedAt,
        number: 'SR-0002',
        documentDate: new Date('2026-11-02T00:00:00Z'),
        notes: null,
        totalAmount: 230,
        supplier,
        warehouse: { name: 'Основний склад' },
        purchaseOrder: { number: 'PO-0007' },
        lines: [
          {
            id: 'r-2',
            createdAt: t(2),
            deletedAt: null,
            quantity: 1,
            price: 80,
            unitOfMeasure: null,
            good: good('Свічка', 'шт', 'шт'),
          },
          {
            id: 'r-1',
            createdAt: t(1),
            deletedAt: null,
            quantity: 3,
            price: 50,
            unitOfMeasure: null,
            good: good('Фільтр', 'шт', 'шт'),
          },
        ],
      },
    ],
  };
}
