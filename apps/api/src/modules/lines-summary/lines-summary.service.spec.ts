/**
 * BR-WO-009 — зведення по табличних частинах документа; BR-WO-010 — виконавці наряду з рядків
 * робіт (запит власника 2026-10-13: розділ у боковій панелі списків).
 *
 * Mutation-verify:
 *  · прибрати `deletedAt: null` з умов рядків → кейси про видалені рядки падають;
 *  · прибрати `orgId` з умов рядків або шапки → кейси про чужу організацію падають;
 *  · `distinct: positions` замість `groups.length` → кейс «два рядки одного товару» падає;
 *  · прибрати перевірку `positions === 0` → кейс «порожня таблиця не показується» падає;
 *  · роботи наряду рахувати з `quantityUnit: 'units'` → кейс про нормо-години падає;
 *  · прибрати `merge` у рахунку → кейс «робота з тим самим workId у двох групах» падає;
 *  · сортувати виконавців за іменем → кейс про порядок падає;
 *  · прибрати `round3` → кейс про 0.1 + 0.2 падає.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { LinesSummaryService } from './lines-summary.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const DOC = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;
interface GroupByArgs {
  by: string[];
  where: Row;
  _sum?: Record<string, true>;
}

/** Рядок підходить умові: рівність по кожному полю; `null` у where означає «поле порожнє». */
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as Row))
      return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
    return (row[k] ?? null) === v;
  });

/** Мінімальний двійник Prisma: `findFirst`, `findMany` і `groupBy` поверх масиву рядків. */
function model(rows: Row[]) {
  return {
    findFirst: ({ where }: { where: Row }) =>
      Promise.resolve(rows.find(r => matches(r, where)) ?? null),
    findMany: ({ where }: { where: Row }) => Promise.resolve(rows.filter(r => matches(r, where))),
    groupBy: ({ by, where, _sum }: GroupByArgs) => {
      // Сервіс зобов'язаний обмежити рядки організацією.
      expect(where.orgId).toBe(ORG);
      const groups = new Map<string, Row>();
      for (const r of rows.filter(x => matches(x, where))) {
        const key = by.map(f => String(r[f] ?? 'null')).join('|');
        const g =
          groups.get(key) ??
          ({
            ...Object.fromEntries(by.map(f => [f, r[f] ?? null])),
            _count: { _all: 0 },
            _sum: Object.fromEntries(Object.keys(_sum ?? {}).map(f => [f, null])),
          } as Row);
        (g._count as { _all: number })._all += 1;
        for (const f of Object.keys(_sum ?? {})) {
          const sums = g._sum as Record<string, number | null>;
          sums[f] = (sums[f] ?? 0) + Number(r[f] ?? 0);
        }
        groups.set(key, g);
      }
      return Promise.resolve(Array.from(groups.values()));
    },
  };
}

describe('LinesSummaryService — зведення по табличних частинах (BR-WO-009)', () => {
  let db: Record<string, Row[]>;
  let service: LinesSummaryService;

  const header = (table: string, patch: Row = {}) =>
    db[table]!.push({ id: DOC, orgId: ORG, deletedAt: null, ...patch });

  beforeEach(() => {
    db = {
      workOrder: [],
      workOrderLine: [],
      workOrderPart: [],
      employee: [],
      invoice: [],
      invoiceLine: [],
      purchaseOrder: [],
      purchaseOrderLine: [],
      stockDocument: [],
      stockDocumentLine: [],
      supplierReturn: [],
      supplierReturnLine: [],
    };
    const prisma = Object.fromEntries(Object.keys(db).map(k => [k, model(db[k]!)]));
    service = new LinesSummaryService(prisma as unknown as PrismaService);
  });

  describe('наряд', () => {
    const line = (patch: Row) =>
      db.workOrderLine!.push({
        orgId: ORG,
        workOrderId: DOC,
        workId: 'w1',
        employeeId: 'e1',
        normoHours: 1,
        deletedAt: null,
        ...patch,
      });
    const part = (patch: Row) =>
      db.workOrderPart!.push({
        orgId: ORG,
        workOrderId: DOC,
        goodId: 'g1',
        quantity: 1,
        deletedAt: null,
        ...patch,
      });

    // guards: BR-WO-009
    it('роботи рахуються в нормо-годинах, товари — в кількості', async () => {
      header('workOrder');
      line({ workId: 'w1', normoHours: 1.5 });
      line({ workId: 'w2', normoHours: 2 });
      part({ goodId: 'g1', quantity: 4 });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.tables).toEqual([
        { key: 'works', positions: 2, distinct: 2, quantity: 3.5, quantityUnit: 'hours' },
        { key: 'goods', positions: 1, distinct: 1, quantity: 4, quantityUnit: 'units' },
      ]);
    });

    // guards: BR-WO-009
    it('два рядки одного товару — одне найменування, два рядки, кількість сумується', async () => {
      header('workOrder');
      part({ goodId: 'g1', quantity: 2 });
      part({ goodId: 'g1', quantity: 3 });
      part({ goodId: 'g2', quantity: 1 });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.tables).toEqual([
        { key: 'goods', positions: 3, distinct: 2, quantity: 6, quantityUnit: 'units' },
      ]);
    });

    // guards: BR-WO-009
    it('видалені рядки і рядки іншого наряду не рахуються', async () => {
      header('workOrder');
      line({ normoHours: 1 });
      line({ normoHours: 5, deletedAt: new Date() });
      line({ normoHours: 7, workOrderId: 'other-doc' });
      part({ quantity: 1 });
      part({ quantity: 9, deletedAt: new Date() });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.tables.map(t => [t.key, t.positions, t.quantity])).toEqual([
        ['works', 1, 1],
        ['goods', 1, 1],
      ]);
      expect(res.executors).toEqual([expect.objectContaining({ works: 1, normoHours: 1 })]);
    });

    // guards: BR-WO-009
    it('порожня таблиця не показується; наряд без рядків — порожнє зведення', async () => {
      header('workOrder');
      expect(await service.forWorkOrder(ORG, DOC)).toEqual({ tables: [], executors: [] });
      line({});
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.tables.map(t => t.key)).toEqual(['works']);
    });

    // guards: BR-WO-009
    it('дробові суми без хвоста двійкової арифметики (0.1 + 0.2 = 0.3)', async () => {
      header('workOrder');
      line({ normoHours: 0.1 });
      line({ normoHours: 0.2, workId: 'w2' });
      part({ quantity: 0.1 });
      part({ quantity: 0.2 });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.tables.map(t => t.quantity)).toEqual([0.3, 0.3]);
      expect(res.executors[0]!.normoHours).toBe(0.3);
    });

    // guards: BR-WO-010
    it('виконавці: групуються за працівником — роботи й нормо-години, «Прізвище Ім’я»', async () => {
      header('workOrder');
      db.employee!.push(
        { id: 'e1', orgId: ORG, firstName: 'Іван', lastName: 'Петренко' },
        { id: 'e2', orgId: ORG, firstName: 'Олег', lastName: 'Сидоренко' },
      );
      line({ employeeId: 'e1', workId: 'w1', normoHours: 1.5 });
      line({ employeeId: 'e1', workId: 'w2', normoHours: 3 });
      line({ employeeId: 'e2', workId: 'w3', normoHours: 2 });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.executors).toEqual([
        { employeeId: 'e1', name: 'Петренко Іван', works: 2, normoHours: 4.5 },
        { employeeId: 'e2', name: 'Сидоренко Олег', works: 1, normoHours: 2 },
      ]);
    });

    // guards: BR-WO-010
    it('виконавці впорядковані за нормо-годинами, далі за числом робіт, далі за іменем', async () => {
      header('workOrder');
      db.employee!.push(
        { id: 'a', orgId: ORG, firstName: 'А', lastName: 'Яковенко' },
        { id: 'b', orgId: ORG, firstName: 'Б', lastName: 'Андрієнко' },
        { id: 'c', orgId: ORG, firstName: 'В', lastName: 'Бойко' },
      );
      line({ employeeId: 'b', normoHours: 1 });
      line({ employeeId: 'c', normoHours: 1 });
      line({ employeeId: 'a', normoHours: 5 });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.executors.map(e => e.name)).toEqual(['Яковенко А', 'Андрієнко Б', 'Бойко В']);
    });

    // guards: BR-WO-010
    it('звільнений (видалений) працівник лишається виконавцем; працівник чужої організації — без імені', async () => {
      header('workOrder');
      db.employee!.push(
        { id: 'e1', orgId: ORG, firstName: 'Іван', lastName: 'Петренко', deletedAt: new Date() },
        { id: 'e2', orgId: OTHER, firstName: 'Чужий', lastName: 'Працівник' },
      );
      line({ employeeId: 'e1', normoHours: 2 });
      line({ employeeId: 'e2', normoHours: 1 });
      const res = await service.forWorkOrder(ORG, DOC);
      expect(res.executors.map(e => [e.employeeId, e.name])).toEqual([
        ['e1', 'Петренко Іван'],
        ['e2', ''],
      ]);
    });

    // guards: BR-WO-009
    it('наряд чужої організації або неіснуючий → 404, рядки не читаються', async () => {
      header('workOrder', { orgId: OTHER });
      db.workOrderLine!.push({ orgId: OTHER, workOrderId: DOC, workId: 'w', employeeId: 'e' });
      await expect(service.forWorkOrder(ORG, DOC)).rejects.toThrow(NotFoundException);
      await expect(service.forWorkOrder(ORG, 'missing')).rejects.toThrow(/Документ не знайдено/);
    });

    // guards: BR-WO-009
    it('наряд, позначений на видалення, усе одно має зведення (список такі показує)', async () => {
      header('workOrder', { deletedAt: new Date() });
      line({});
      expect((await service.forWorkOrder(ORG, DOC)).tables).toHaveLength(1);
    });
  });

  describe('рахунок', () => {
    const line = (patch: Row) =>
      db.invoiceLine!.push({
        orgId: ORG,
        invoiceId: DOC,
        workId: null,
        goodId: null,
        quantity: 1,
        ...patch,
      });

    // guards: BR-WO-009
    it('рядок із роботою — «роботи», із товаром — «товари», без обох — «інше»', async () => {
      header('invoice');
      line({ workId: 'w1', quantity: 2 });
      line({ goodId: 'g1', quantity: 3 });
      line({ goodId: 'g1', quantity: 1 });
      line({ quantity: 5 });
      line({ quantity: 1 });
      const res = await service.forInvoice(ORG, DOC);
      expect(res).toEqual({
        tables: [
          { key: 'works', positions: 1, distinct: 1, quantity: 2, quantityUnit: 'units' },
          { key: 'goods', positions: 2, distinct: 1, quantity: 4, quantityUnit: 'units' },
          // «Інше» найменувань не має: кожен рядок рахується окремо.
          { key: 'other', positions: 2, distinct: 2, quantity: 6, quantityUnit: 'units' },
        ],
        executors: [],
      });
    });

    // guards: BR-WO-009
    it('робота з товаром-супутником: одна робота в двох групах — одне найменування', async () => {
      header('invoice');
      // Той самий workId з різними goodId дає дві групи groupBy — найменування все одно одне.
      line({ workId: 'w1', goodId: 'g1', quantity: 1 });
      line({ workId: 'w1', goodId: 'g2', quantity: 2 });
      const res = await service.forInvoice(ORG, DOC);
      expect(res.tables).toEqual([
        { key: 'works', positions: 2, distinct: 1, quantity: 3, quantityUnit: 'units' },
      ]);
    });

    // guards: BR-WO-009
    it('рядки іншого рахунку не рахуються; чужий рахунок → 404', async () => {
      header('invoice');
      line({ goodId: 'g1' });
      line({ goodId: 'g2', invoiceId: 'other' });
      expect((await service.forInvoice(ORG, DOC)).tables[0]).toMatchObject({ positions: 1 });
      await expect(service.forInvoice(OTHER, DOC)).rejects.toThrow(NotFoundException);
    });
  });

  describe.each([
    ['закупівля', 'purchaseOrder', 'purchaseOrderLine', 'purchaseOrderId', 'forPurchaseOrder'],
    [
      'складський документ',
      'stockDocument',
      'stockDocumentLine',
      'stockDocumentId',
      'forStockDocument',
    ],
    [
      'повернення постачальнику',
      'supplierReturn',
      'supplierReturnLine',
      'supplierReturnId',
      'forSupplierReturn',
    ],
  ] as const)('%s', (_title, headerTable, lineTable, fk, method) => {
    const line = (patch: Row) =>
      db[lineTable]!.push({
        orgId: ORG,
        [fk]: DOC,
        goodId: 'g1',
        quantity: 1,
        deletedAt: null,
        ...patch,
      });

    // guards: BR-WO-009
    it('товари: найменування, рядки, сума кількості; видалені й чужі рядки не рахуються', async () => {
      header(headerTable);
      line({ goodId: 'g1', quantity: 2.5 });
      line({ goodId: 'g1', quantity: 1.5 });
      line({ goodId: 'g2', quantity: 10 });
      line({ goodId: 'g3', quantity: 99, deletedAt: new Date() });
      line({ goodId: 'g4', quantity: 99, [fk]: 'other-doc' });
      expect(await service[method](ORG, DOC)).toEqual({
        tables: [{ key: 'goods', positions: 3, distinct: 2, quantity: 14, quantityUnit: 'units' }],
        executors: [],
      });
    });

    // guards: BR-WO-009
    it('без рядків — порожнє зведення; документ чужої організації → 404', async () => {
      header(headerTable);
      expect(await service[method](ORG, DOC)).toEqual({ tables: [], executors: [] });
      await expect(service[method](OTHER, DOC)).rejects.toThrow(NotFoundException);
    });
  });
});
