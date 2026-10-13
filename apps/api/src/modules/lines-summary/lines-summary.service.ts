import { Injectable, NotFoundException } from '@nestjs/common';
import { formatPersonName, translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import type {
  LinesSummaryDto,
  LinesSummaryExecutorDto,
  LinesSummaryQuantityUnit,
  LinesSummaryTableDto,
  LinesSummaryTableKey,
} from './lines-summary.dto';

/** Рядок групування: одне найменування і скільки рядків / яка сума на ньому. */
interface Group {
  count: number;
  quantity: number;
}

/** Кількості — Float у базі: прибираємо хвіст двійкової арифметики (0.1 + 0.2). */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function table(
  key: LinesSummaryTableKey,
  groups: Group[],
  quantityUnit: LinesSummaryQuantityUnit,
  /** «Інше» не має найменувань: кожен рядок — сам по собі. */
  distinctIsPositions = false,
): LinesSummaryTableDto | null {
  const positions = groups.reduce((sum, g) => sum + g.count, 0);
  if (positions === 0) return null;
  return {
    key,
    positions,
    distinct: distinctIsPositions ? positions : groups.length,
    quantity: round3(groups.reduce((sum, g) => sum + g.quantity, 0)),
    quantityUnit,
  };
}

const present = <T>(items: (T | null)[]): T[] => items.filter((x): x is T => x !== null);

/**
 * BR-WO-009 — зведення по табличних частинах документа для бокової панелі списку.
 *
 * Рахує база (`groupBy`), а не клієнт із довантаженого документа: `findOne` документів
 * обрізає рядки (`take: 500`), а панель наряду документа не довантажує взагалі.
 *
 *  · рядків (positions) — скільки рядків у таблиці;
 *  · найменувань (distinct) — скільки РІЗНИХ товарів / робіт: два рядки одного товару — одне;
 *  · сума (quantity) — проста сума по рядках: кількість, а для робіт наряду — нормо-години
 *    (у рядка роботи наряду кількості немає).
 * Видалені (soft-deleted) рядки не рахуються. Порожня таблиця у відповідь не потрапляє.
 * Сам документ може бути позначений на видалення — список такі показує, панель теж має працювати.
 */
@Injectable()
export class LinesSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  private notFound(): NotFoundException {
    return new NotFoundException(translateError('err.linesSummary.documentNotFound', getLocale()));
  }

  /** Наряд: роботи (нормо-години), товари (кількість) і виконавці з рядків робіт (BR-WO-010). */
  async forWorkOrder(orgId: string, id: string): Promise<LinesSummaryDto> {
    const header = await this.prisma.workOrder.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!header) throw this.notFound();

    const lineWhere = { orgId, workOrderId: id, deletedAt: null };
    const [byWork, byEmployee, byGood] = await Promise.all([
      this.prisma.workOrderLine.groupBy({
        by: ['workId'],
        where: lineWhere,
        _count: { _all: true },
        _sum: { normoHours: true },
      }),
      this.prisma.workOrderLine.groupBy({
        by: ['employeeId'],
        where: lineWhere,
        _count: { _all: true },
        _sum: { normoHours: true },
      }),
      this.prisma.workOrderPart.groupBy({
        by: ['goodId'],
        where: lineWhere,
        _count: { _all: true },
        _sum: { quantity: true },
      }),
    ]);

    const employeeIds = byEmployee.map(g => g.employeeId);
    // Без фільтра deletedAt: звільнений працівник лишається виконавцем уже зроблених робіт.
    const employees = employeeIds.length
      ? await this.prisma.employee.findMany({
          where: { orgId, id: { in: employeeIds } },
          select: { id: true, firstName: true, lastName: true },
          take: employeeIds.length,
        })
      : [];
    const nameById = new Map(employees.map(e => [e.id, formatPersonName(e.lastName, e.firstName)]));

    const executors: LinesSummaryExecutorDto[] = byEmployee
      .map(g => ({
        employeeId: g.employeeId,
        name: nameById.get(g.employeeId) ?? '',
        works: g._count._all,
        normoHours: round3(g._sum.normoHours ?? 0),
      }))
      .sort(
        (a, b) =>
          b.normoHours - a.normoHours || b.works - a.works || a.name.localeCompare(b.name, 'uk'),
      );

    return {
      tables: present([
        table(
          'works',
          byWork.map(g => ({ count: g._count._all, quantity: g._sum.normoHours ?? 0 })),
          'hours',
        ),
        table(
          'goods',
          byGood.map(g => ({ count: g._count._all, quantity: g._sum.quantity ?? 0 })),
          'units',
        ),
      ]),
      executors,
    };
  }

  /** Рахунок: рядок із роботою — «роботи», із товаром — «товари», без обох — «інше». */
  async forInvoice(orgId: string, id: string): Promise<LinesSummaryDto> {
    const header = await this.prisma.invoice.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!header) throw this.notFound();

    // У InvoiceLine немає deletedAt: рядки рахунку заміщуються цілком.
    const groups = await this.prisma.invoiceLine.groupBy({
      by: ['workId', 'goodId'],
      where: { orgId, invoiceId: id },
      _count: { _all: true },
      _sum: { quantity: true },
    });
    const toGroup = (g: (typeof groups)[number]): Group => ({
      count: g._count._all,
      quantity: g._sum.quantity ?? 0,
    });
    // Найменування роботи — за workId, товару — за goodId: зводимо групи з однаковим ключем.
    const merge = (items: typeof groups, key: 'workId' | 'goodId'): Group[] => {
      const byKey = new Map<string, Group>();
      for (const g of items) {
        const k = g[key] as string;
        const acc = byKey.get(k) ?? { count: 0, quantity: 0 };
        acc.count += g._count._all;
        acc.quantity += g._sum.quantity ?? 0;
        byKey.set(k, acc);
      }
      return Array.from(byKey.values());
    };
    const works = groups.filter(g => g.workId !== null);
    const goods = groups.filter(g => g.workId === null && g.goodId !== null);
    const other = groups.filter(g => g.workId === null && g.goodId === null);

    return {
      tables: present([
        table('works', merge(works, 'workId'), 'units'),
        table('goods', merge(goods, 'goodId'), 'units'),
        table('other', other.map(toGroup), 'units', true),
      ]),
      executors: [],
    };
  }

  async forPurchaseOrder(orgId: string, id: string): Promise<LinesSummaryDto> {
    const header = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!header) throw this.notFound();
    const groups = await this.prisma.purchaseOrderLine.groupBy({
      by: ['goodId'],
      where: { orgId, purchaseOrderId: id, deletedAt: null },
      _count: { _all: true },
      _sum: { quantity: true },
    });
    return this.goodsOnly(groups);
  }

  async forStockDocument(orgId: string, id: string): Promise<LinesSummaryDto> {
    const header = await this.prisma.stockDocument.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!header) throw this.notFound();
    const groups = await this.prisma.stockDocumentLine.groupBy({
      by: ['goodId'],
      where: { orgId, stockDocumentId: id, deletedAt: null },
      _count: { _all: true },
      _sum: { quantity: true },
    });
    return this.goodsOnly(groups);
  }

  async forSupplierReturn(orgId: string, id: string): Promise<LinesSummaryDto> {
    const header = await this.prisma.supplierReturn.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!header) throw this.notFound();
    const groups = await this.prisma.supplierReturnLine.groupBy({
      by: ['goodId'],
      where: { orgId, supplierReturnId: id, deletedAt: null },
      _count: { _all: true },
      _sum: { quantity: true },
    });
    return this.goodsOnly(groups);
  }

  private goodsOnly(
    groups: { _count: { _all: number }; _sum: { quantity: number | null } }[],
  ): LinesSummaryDto {
    return {
      tables: present([
        table(
          'goods',
          groups.map(g => ({ count: g._count._all, quantity: g._sum.quantity ?? 0 })),
          'units',
        ),
      ]),
      executors: [],
    };
  }
}
