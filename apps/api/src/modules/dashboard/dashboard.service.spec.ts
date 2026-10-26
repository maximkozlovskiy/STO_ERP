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
 */
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

  beforeEach(() => {
    prisma = {
      workOrder: modelMock('count'),
      settlementTransaction: modelMock('aggregate'),
      invoice: Object.assign(modelMock('count'), { fields: { amount: AMOUNT_FIELD } }),
      $queryRaw: vi.fn(),
    };
    prisma.workOrder.count.mockResolvedValue(3);
    prisma.settlementTransaction.aggregate.mockResolvedValue({ _sum: { amount: 1250.5 } });
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
      expect(prisma.settlementTransaction.aggregate).not.toHaveBeenCalled();
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

    it('settlementTransaction.aggregate фільтрує по orgId і type=PAYMENT', async () => {
      await svc.getSummary(ORG);
      const where = prisma.settlementTransaction.aggregate.mock.calls[0][0].where;
      expect(where.orgId).toBe(ORG);
      expect(where.type).toBe('PAYMENT');
      expect(where.createdAt.gte).toBeInstanceOf(Date);
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
      const gte: Date = prisma.settlementTransaction.aggregate.mock.calls[0][0].where.createdAt.gte;
      // Київ влітку UTC+3 → північ 00:00 Kyiv = 21:00 попереднього дня UTC.
      // Взимку UTC+2 → 22:00. У будь-якому разі UTC-година НЕ 00 (інакше брали б UTC-добу).
      const h = gte.getUTCHours();
      expect([21, 22]).toContain(h);
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
      prisma.settlementTransaction.aggregate.mockRejectedValue(new Error('x'));
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
      prisma.settlementTransaction.aggregate.mockRejectedValue(new Error('statement timeout'));
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
    it('_sum.amount === null (немає платежів сьогодні) → todayRevenue 0', async () => {
      prisma.settlementTransaction.aggregate.mockResolvedValue({ _sum: { amount: null } });
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
