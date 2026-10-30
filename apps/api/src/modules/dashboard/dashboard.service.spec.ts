import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardService } from './dashboard.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * DashboardService — агрегатор головного екрана (SSE кожні 30s). Модуль був БЕЗ тестів.
 *
 * Тут не «CRUD», а чотири незалежні агрегати, і головні інваріанти:
 *  - **tenant isolation у КОЖНОМУ з 4 підзапитів** — including raw-SQL low-stock, де orgId
 *    передається параметром; пропуск orgId у будь-якому = виток чисел іншої org на дашборд;
 *  - **deletedAt-фільтр** на workOrder/invoice (SettlementTransaction append-only — свідомо без);
 *  - **cache-hit короткозамикає** — при попаданні в кеш жоден підзапит не йде в БД;
 *  - **timeout/reject одного поля → це поле стає null** (не 0: web показує запасне значення
 *    або «—»), а getSummary() НІКОЛИ не кидає (Promise.allSettled + withTimeout): повільний
 *    Postgres не має рвати SSE tick; деградований знімок не кешується;
 *  - **«сьогодні» = київська доба**, не server-local: виручка рахується від київської півночі.
 *  - **виручка чиста** (BR-PAY-030): оплати й аванси мінус повернення клієнтам і сторно, у базовій
 *    валюті. Журнал проводок — масив у пам'яті, і фейковий `groupBy` справді виконує `where`.
 */

interface JournalRow {
  orgId: string;
  type: string;
  amount: number;
  amountBase: number;
  createdAt: Date;
}

/** `groupBy({ by: ['type'], where, _sum: { amountBase } })`, що виконує `where` над журналом. */
function groupByType(
  journal: JournalRow[],
  args: {
    where: { orgId: string; type: { in: string[] }; createdAt: { gte: Date; lte: Date } };
  },
) {
  const { orgId, type, createdAt } = args.where;
  const sums = new Map<string, number>();
  for (const r of journal) {
    if (r.orgId !== orgId || !type.in.includes(r.type)) continue;
    if (r.createdAt < createdAt.gte || r.createdAt > createdAt.lte) continue;
    sums.set(r.type, (sums.get(r.type) ?? 0) + r.amountBase);
  }
  return [...sums].map(([t, sum]) => ({ type: t, _sum: { amountBase: sum } }));
}

describe('DashboardService', () => {
  let prisma: {
    workOrder: PrismaModelMock;
    settlementTransaction: PrismaModelMock;
    invoice: PrismaModelMock & { fields: { amount: unknown } };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let svc: DashboardService;

  const ORG = 'org-1';
  /** Field reference `prisma.invoice.fields.amount` — у моку маркер, з яким порівнюємо where. */
  const AMOUNT_FIELD = { modelName: 'Invoice', name: 'amount' };

  /** Журнал проводок за сьогодні (кейс дописує свої); `now` — мить «зараз» для меж доби. */
  let journal: JournalRow[];
  const now = () => new Date();
  const row = (type: string, amountBase: number, over: Partial<JournalRow> = {}): JournalRow => ({
    orgId: ORG,
    type,
    amount: amountBase,
    amountBase,
    createdAt: now(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workOrder: modelMock('count'),
      settlementTransaction: modelMock('groupBy'),
      invoice: Object.assign(modelMock('count'), { fields: { amount: AMOUNT_FIELD } }),
      $queryRaw: vi.fn(),
    };
    journal = [row('PAYMENT', 1250.5)];
    prisma.workOrder.count.mockResolvedValue(3);
    prisma.settlementTransaction.groupBy.mockImplementation(
      (args: Parameters<typeof groupByType>[1]) => Promise.resolve(groupByType(journal, args)),
    );
    prisma.invoice.count.mockResolvedValue(2);
    prisma.$queryRaw.mockResolvedValue([{ count: 7n }]);

    cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) };

    svc = new DashboardService(prisma as never, cache as never);
  });

  describe('happy path', () => {
    it('повертає всі чотири агрегати + timestamp', async () => {
      const r = await svc.getSummary(ORG);
      expect(r.activeWo).toBe(3);
      expect(r.todayRevenue).toBe(1250.5);
      expect(r.pendingInvoices).toBe(2);
      expect(r.lowStockCount).toBe(7); // bigint → Number
      expect(typeof r.timestamp).toBe('string');
    });

    it('результат кладеться в кеш під ключем своєї org', async () => {
      await svc.getSummary(ORG);
      expect(cache.set.mock.calls[0][0]).toBe(`dashboard:summary:${ORG}`);
      expect(cache.set.mock.calls[0][2]).toBe(25); // TTL
    });
  });

  describe('cache-hit короткозамикає', () => {
    it('при попаданні в кеш жоден підзапит до БД не виконується', async () => {
      const cached = {
        activeWo: 9,
        todayRevenue: 1,
        pendingInvoices: 0,
        lowStockCount: 0,
        timestamp: 'x',
      };
      cache.get.mockResolvedValue(cached);
      const r = await svc.getSummary(ORG);
      expect(r).toBe(cached);
      expect(prisma.workOrder.count).not.toHaveBeenCalled();
      expect(prisma.settlementTransaction.groupBy).not.toHaveBeenCalled();
      expect(prisma.invoice.count).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('cache-ключ ізольований per-org (інша org → інший ключ)', async () => {
      await svc.getSummary('org-A');
      await svc.getSummary('org-B');
      expect(cache.get.mock.calls[0][0]).toBe('dashboard:summary:org-A');
      expect(cache.get.mock.calls[1][0]).toBe('dashboard:summary:org-B');
    });
  });

  describe('tenant isolation — orgId у кожному підзапиті', () => {
    it('workOrder.count фільтрує по orgId, deletedAt=null і активними статусами', async () => {
      await svc.getSummary(ORG);
      const where = prisma.workOrder.count.mock.calls[0][0].where;
      expect(where.orgId).toBe(ORG);
      expect(where.deletedAt).toBeNull();
      expect(where.status.in).toEqual(['IN_PROGRESS', 'ON_HOLD']);
    });

    // guards: BR-PAY-030
    it('проводки виручки фільтруються по orgId і шести типах; сума — у базовій валюті', async () => {
      await svc.getSummary(ORG);
      const args = prisma.settlementTransaction.groupBy.mock.calls[0][0];
      expect(args.where.orgId).toBe(ORG);
      expect([...args.where.type.in].sort()).toEqual(
        [
          'PAYMENT',
          'PAYMENT_CANCEL',
          'PREPAYMENT',
          'PREPAYMENT_CANCEL',
          'REFUND_OUT',
          'REFUND_OUT_CANCEL',
        ].sort(),
      );
      expect(args._sum).toEqual({ amountBase: true });
    });

    // guards: BR-PAY-030
    it('проводки іншої організації у виручку не потрапляють', async () => {
      journal.push(row('PAYMENT', 9999, { orgId: 'org-2' }));
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(1250.5);
    });

    it('invoice.count фільтрує по orgId, deletedAt=null і pending-статусами', async () => {
      await svc.getSummary(ORG);
      const where = prisma.invoice.count.mock.calls[0][0].where;
      expect(where.orgId).toBe(ORG);
      expect(where.deletedAt).toBeNull();
      // Bug #854: частково оплачений рахунок лишається серед неоплачених — залишок не погашено.
      expect(where.status.in).toEqual(['DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE']);
    });

    it('invoice.count рахує лише рахунки із залишком: paidAmount < amount (TECH-DEBT §10 п. 18)', async () => {
      // Чернетка, повністю віддзеркалена з оплаченого наряду (paidAmount = amount), до сплати 0 —
      // у лічильник «рахунки до сплати» не потрапляє. Порівняння з колонкою — field reference.
      await svc.getSummary(ORG);
      const where = prisma.invoice.count.mock.calls[0][0].where;
      expect(where.paidAmount).toEqual({ lt: AMOUNT_FIELD });
      expect(where.paidAmount.lt).toBe(prisma.invoice.fields.amount);
    });

    it('raw low-stock запит отримує orgId параметром (tagged-template values)', async () => {
      await svc.getSummary(ORG);
      // $queryRaw`...${orgId}::uuid...` → orgId приходить як перший інтерпольований value.
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      expect(values).toContain(ORG);
    });
  });

  describe('«сьогодні» = київська доба', () => {
    it('нижня межа виручки — київська північ (НЕ UTC-північ)', async () => {
      await svc.getSummary(ORG);
      const gte: Date = prisma.settlementTransaction.groupBy.mock.calls[0][0].where.createdAt.gte;
      // Київ влітку UTC+3 → північ 00:00 Kyiv = 21:00 попереднього дня UTC.
      // Взимку UTC+2 → 22:00. У будь-якому разі UTC-година НЕ 00 (інакше брали б UTC-добу).
      const h = gte.getUTCHours();
      expect([21, 22]).toContain(h);
    });

    // guards: BR-PAY-030
    it('вчорашні оплати й сторно у виручку сьогодні не входять (межа — київська доба)', async () => {
      const gte: Date = await svc
        .getSummary(ORG)
        .then(() => prisma.settlementTransaction.groupBy.mock.calls[0][0].where.createdAt.gte);
      journal.push(
        row('PAYMENT', 700, { createdAt: new Date(gte.getTime() - 1) }),
        row('PAYMENT_CANCEL', 1250.5, { createdAt: new Date(gte.getTime() - 60_000) }),
      );
      cache.get.mockResolvedValue(null);
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(1250.5);
    });
  });

  // Рішення власника 2026-10-30 (TECH-DEBT (б) №39): «Виручка сьогодні» — чиста.
  describe('чиста виручка (BR-PAY-030)', () => {
    // guards: BR-PAY-030
    it('оплати + аванси − повернення клієнтам − сторно оплат і авансів + сторно повернень', async () => {
      journal = [
        row('PAYMENT', 1000),
        row('PREPAYMENT', 300),
        row('REFUND_OUT', 100),
        row('REFUND_OUT_CANCEL', 40),
        row('PAYMENT_CANCEL', 200),
        row('PREPAYMENT_CANCEL', 50),
      ];
      const r = await svc.getSummary(ORG);
      // 1000 + 300 − 100 + 40 − 200 − 50 = 990
      expect(r.todayRevenue).toBe(990);
    });

    // guards: BR-PAY-030
    it('сторно сьогоднішньої оплати зменшує виручку дня до нуля', async () => {
      journal = [row('PAYMENT', 500), row('PAYMENT_CANCEL', 500)];
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(0);
    });

    // guards: BR-PAY-030
    it('валютна оплата — у базовій валюті (amountBase), не в сумі документа', async () => {
      journal = [row('PAYMENT', 4150, { amount: 100 })];
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(4150);
    });

    // guards: BR-PAY-030
    it('нарахування, курсові різниці й проводки постачальників виручкою не є', async () => {
      journal = [
        row('PAYMENT', 100),
        row('CHARGE', 5000),
        row('FX_GAIN', 30),
        row('SUPPLIER_PAYMENT', 800),
        row('SUPPLIER_PAYMENT_RETURN', 70),
      ];
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(100);
    });
  });

  describe('стійкість: timeout / reject не валять дашборд', () => {
    it('reject одного підзапиту → його поле null (не 0), решта лишаються', async () => {
      prisma.workOrder.count.mockRejectedValue(new Error('pool exhausted'));
      const r = await svc.getSummary(ORG);
      expect(r.activeWo).toBeNull();
      expect(r.pendingInvoices).toBe(2); // інші не постраждали
      expect(r.lowStockCount).toBe(7);
    });

    it('усі підзапити reject → всі поля null, метод НЕ кидає', async () => {
      prisma.workOrder.count.mockRejectedValue(new Error('x'));
      prisma.settlementTransaction.groupBy.mockRejectedValue(new Error('x'));
      prisma.invoice.count.mockRejectedValue(new Error('x'));
      prisma.$queryRaw.mockRejectedValue(new Error('x'));
      const r = await svc.getSummary(ORG);
      expect(r).toMatchObject({
        activeWo: null,
        todayRevenue: null,
        pendingInvoices: null,
        lowStockCount: null,
      });
    });

    it('«Оплати сьогодні» не встигли → todayRevenue null, а не 0 (TECH-DEBT §8 п. 5)', async () => {
      prisma.settlementTransaction.groupBy.mockRejectedValue(new Error('statement timeout'));
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBeNull();
      expect(r.activeWo).toBe(3);
    });

    it('деградований знімок (хоч одне поле null) не кешується', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('x'));
      const r = await svc.getSummary(ORG);
      expect(r.lowStockCount).toBeNull();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('timeout підзапиту (резолвиться null за ceiling) → поле null', async () => {
      vi.useFakeTimers();
      // workOrder.count «ніколи» не резолвиться → спрацьовує withTimeout(8s)→null.
      prisma.workOrder.count.mockReturnValue(new Promise(() => {}));
      const p = svc.getSummary(ORG);
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await p;
      expect(r.activeWo).toBeNull();
      expect(cache.set).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('нормалізація значень', () => {
    it('проводок виручки сьогодні немає → todayRevenue 0 (не null)', async () => {
      journal = [];
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(0);
    });

    it('_sum.amountBase === null у групі → 0, не NaN', async () => {
      prisma.settlementTransaction.groupBy.mockResolvedValue([
        { type: 'PAYMENT', _sum: { amountBase: null } },
      ]);
      const r = await svc.getSummary(ORG);
      expect(r.todayRevenue).toBe(0);
    });

    it('порожній результат raw-запиту → lowStockCount 0 (не падає на [0])', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const r = await svc.getSummary(ORG);
      expect(r.lowStockCount).toBe(0);
    });
  });
});
