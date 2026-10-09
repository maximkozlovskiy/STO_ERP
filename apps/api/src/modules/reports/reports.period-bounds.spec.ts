/**
 * ReportsService — межі періоду, що йдуть у запит.
 *
 * Період звіту — календарні дні КИЄВА, обидва включно: від 00:00:00.000 дня «з» до 23:59:59.999
 * дня «по» за київським часом. Зсув кожної межі береться окремо, тож у дні переведення годинника
 * (29.03.2026 — доба з 23 годин, 25.10.2026 — з 25) межі лишаються справжньою північчю й кінцем
 * доби. Власна копія зсуву в сервісі прибрана: межі дає спільний `normalizeKyivDateRange`.
 *
 * Mutation-verify: підмінити `normalizeKyivDateRange(from, to)` на UTC-межі
 * (`new Date(from + 'T00:00:00.000Z')` / `new Date(to + 'T23:59:59.999Z')`) → падають усі кейси
 * таблиці меж; підмінити `kyivDayRangeFilter` у `stock` на `dateOnlyRangeFilter` → падають кейси
 * звіту по складу; прибрати перевірку порядку → падають кейси «початок пізніше кінця».
 *
 * `vatReport` відбирає за `documentDate` (дата БЕЗ часу), тому його межі — календарні дати без
 * зсуву на пояс: київська північ (21:00Z попереднього дня) затягувала в період день перед `from`.
 * Mutation-verify: повернути `documentDate: { gte: fromDate, lte: toDate }` → кейси ПДВ падають.
 */
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

const ORG = 'org-1';

/** [назва, день, початок київської доби (UTC), кінець київської доби (UTC)] */
const DAYS = [
  ['зима (UTC+2)', '2026-01-15', '2026-01-14T22:00:00.000Z', '2026-01-15T21:59:59.999Z'],
  ['літо (UTC+3)', '2026-07-09', '2026-07-08T21:00:00.000Z', '2026-07-09T20:59:59.999Z'],
  [
    'перехід на літній час 29.03.2026',
    '2026-03-29',
    '2026-03-28T22:00:00.000Z',
    '2026-03-29T20:59:59.999Z',
  ],
  [
    'перехід на зимовий час 25.10.2026',
    '2026-10-25',
    '2026-10-24T21:00:00.000Z',
    '2026-10-25T21:59:59.999Z',
  ],
] as const;

describe('ReportsService — межі періоду за Києвом', () => {
  let service: ReportsService;
  let prisma: {
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    employee: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    calendarSlot: { findMany: ReturnType<typeof vi.fn> };
    stockItem: { findMany: ReturnType<typeof vi.fn> };
    stockMovement: { findMany: ReturnType<typeof vi.fn> };
    invoice: { aggregate: ReturnType<typeof vi.fn> };
    purchaseOrder: { aggregate: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue(null) },
      employee: { findFirst: vi.fn().mockResolvedValue(null) },
      warehouse: { findFirst: vi.fn().mockResolvedValue(null) },
      calendarSlot: { findMany: vi.fn().mockResolvedValue([]) },
      stockItem: { findMany: vi.fn().mockResolvedValue([]) },
      stockMovement: { findMany: vi.fn().mockResolvedValue([]) },
      invoice: { aggregate: vi.fn().mockResolvedValue({ _sum: { totalVat: 0 } }) },
      purchaseOrder: { aggregate: vi.fn().mockResolvedValue({ _sum: { totalVat: 0 } }) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const settings = {
      getOrganisationSettings: vi.fn().mockResolvedValue({ laborCostRatio: 0.4 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  /** Дати, інтерпольовані в N-й виклик tagged-template `$queryRaw` (ISO-рядками). */
  const sqlDates = (call = 0): string[] =>
    (prisma.$queryRaw.mock.calls[call] as unknown[])
      .slice(1)
      .filter((v): v is Date => v instanceof Date)
      .map(d => d.toISOString());

  describe.each(DAYS)('%s: один день %s', (_name, day, start, end) => {
    it('виручка: completedAt від київської півночі до кінця київської доби', async () => {
      await service.revenue(ORG, day, day);
      expect(sqlDates()).toEqual([start, end]);
    });

    it('звіт по нарядах: createdAt у тих самих межах', async () => {
      await service.workOrders(ORG, day, day);
      expect(sqlDates()).toEqual([start, end]);
    });

    it('рентабельність: обидва агрегати (наряди й запчастини) отримують ті самі межі', async () => {
      await service.profitability(ORG, day, day);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(sqlDates(0)).toEqual([start, end]);
      expect(sqlDates(1)).toEqual([start, end]);
    });

    it('завантаженість: startAt слота у межах київської доби', async () => {
      await service.load(ORG, day, day);
      const where = prisma.calendarSlot.findMany.mock.calls[0][0].where as {
        orgId: string;
        startAt: { gte: Date; lte: Date };
      };
      expect(where.orgId).toBe(ORG);
      expect(where.startAt.gte.toISOString()).toBe(start);
      expect(where.startAt.lte.toISOString()).toBe(end);
    });

    it('склад: рухи за createdAt у межах київської доби', async () => {
      await service.stock(ORG, undefined, day, day);
      const where = prisma.stockMovement.findMany.mock.calls[0][0].where as {
        orgId: string;
        createdAt: { gte: Date; lte: Date };
      };
      expect(where.orgId).toBe(ORG);
      expect(where.createdAt.gte.toISOString()).toBe(start);
      expect(where.createdAt.lte.toISOString()).toBe(end);
    });
  });

  it('період через перехід на літній час: початок за зимовим зсувом, кінець за літнім', async () => {
    await service.revenue(ORG, '2026-03-01', '2026-03-31');
    expect(sqlDates()).toEqual(['2026-02-28T22:00:00.000Z', '2026-03-31T20:59:59.999Z']);
  });

  it('період через перехід на зимовий час: початок за літнім зсувом, кінець за зимовим', async () => {
    await service.revenue(ORG, '2026-10-01', '2026-10-31');
    expect(sqlDates()).toEqual(['2026-09-30T21:00:00.000Z', '2026-10-31T21:59:59.999Z']);
  });

  it('наряд, завершений 10.10 о 00:30 за Києвом, входить у звіт за 10.10 і не входить у 09.10', async () => {
    const completedAt = new Date('2026-10-09T21:30:00.000Z');
    const inRange = (call: number) => {
      const [gte, lte] = sqlDates(call).map(s => new Date(s));
      return completedAt >= gte && completedAt <= lte;
    };
    await service.revenue(ORG, '2026-10-10', '2026-10-10');
    await service.revenue(ORG, '2026-10-09', '2026-10-09');
    expect(inRange(0)).toBe(true);
    expect(inRange(1)).toBe(false);
  });

  describe('склад: кожна межа необовʼязкова', () => {
    const movWhere = () =>
      prisma.stockMovement.findMany.mock.calls[0][0].where as {
        createdAt?: { gte?: Date; lte?: Date };
      };

    it('без дат — умови на createdAt немає', async () => {
      await service.stock(ORG);
      expect(movWhere()).not.toHaveProperty('createdAt');
    });

    it('лише «з» — тільки нижня межа, київська північ', async () => {
      await service.stock(ORG, undefined, '2026-10-10');
      expect(movWhere().createdAt).toEqual({ gte: new Date('2026-10-09T21:00:00.000Z') });
    });

    it('лише «по» — тільки верхня межа, кінець київської доби', async () => {
      await service.stock(ORG, undefined, undefined, '2026-10-10');
      expect(movWhere().createdAt).toEqual({ lte: new Date('2026-10-10T20:59:59.999Z') });
    });
  });

  describe('ПДВ: documentDate — дата без часу, межі календарні', () => {
    it.each([
      ['літо', '2026-09-01', '2026-09-30'],
      ['зима', '2026-01-01', '2026-01-31'],
      ['через переведення годинника', '2026-10-25', '2026-10-26'],
    ])('%s: рахунки й замовлення від %s до %s без зсуву на пояс', async (_name, from, to) => {
      await service.vatReport(ORG, from, to);
      const expected = {
        gte: new Date(`${from}T00:00:00.000Z`),
        lte: new Date(`${to}T00:00:00.000Z`),
      };
      for (const model of [prisma.invoice, prisma.purchaseOrder]) {
        const where = (model.aggregate.mock.calls[0]![0] as { where: Record<string, unknown> })
          .where;
        expect(where.documentDate).toEqual(expected);
        expect(where.orgId).toBe(ORG);
      }
    });
  });

  describe('початок пізніше кінця → 400, запит не виконується', () => {
    it.each(['revenue', 'workOrders', 'profitability', 'load', 'vatReport'] as const)(
      '%s',
      async method => {
        await expect(service[method](ORG, '2026-10-10', '2026-10-09')).rejects.toThrow(
          BadRequestException,
        );
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.calendarSlot.findMany).not.toHaveBeenCalled();
        expect(prisma.invoice.aggregate).not.toHaveBeenCalled();
      },
    );

    it('текст помилки — українською', async () => {
      await expect(service.revenue(ORG, '2026-10-10', '2026-10-09')).rejects.toThrow(
        /Дата початку/,
      );
    });
  });
});
