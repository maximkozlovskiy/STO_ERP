import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';

/**
 * Search — командна палітра (повнотекстовий пошук по нарядах/клієнтах/товарах через pg_trgm).
 * Модуль був БЕЗ тестів. Запити — сирий SQL ($queryRaw tagged-template), тож перевіряємо
 * не форму where-об'єкта, а те, що реально інтерполюється у кожен запит:
 *
 *  - **orgId у КОЖНОМУ з трьох запитів** — параметром `${orgId}::uuid`; пропуск = пошук по
 *    всій БД поза межами org;
 *  - **deletedAt IS NULL** у кожному запиті (видалені наряди/клієнти/товари не шукаються);
 *  - **per-type LIMIT** = ceil(limit/типів) передається у кожен запит (захист від виїмки всього);
 *  - **буфери склеюються у ПОРЯДКУ `types`** і зрізаються до `limit` (повільний good не витісняє wo);
 *  - **користувацький рядок передається параметром** (не склеюється в SQL → без ін'єкції).
 *
 * Контролер тримає DoS-гарди (порожній q, довжина, клемп limit) — тестуємо окремо.
 */
describe('SearchService', () => {
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };
  let svc: SearchService;
  const ORG = 'org-1';

  /** Повертає «значення» (інтерпольовані params) конкретного виклику $queryRaw. */
  const valuesOf = (callIndex: number) => prisma.$queryRaw.mock.calls[callIndex].slice(1);
  /** Повертає рядки SQL (template strings) конкретного виклику. */
  const sqlOf = (callIndex: number) =>
    (prisma.$queryRaw.mock.calls[callIndex][0] as string[]).join('?');

  beforeEach(() => {
    prisma = { $queryRaw: vi.fn().mockResolvedValue([]) };
    svc = new SearchService(prisma as never);
  });

  describe('tenant isolation + soft-delete у кожному запиті', () => {
    it('усі три типи: orgId інтерполюється параметром у кожен запит', async () => {
      await svc.search(ORG, 'bmw', ['wo', 'counterparty', 'good'], 9);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        expect(valuesOf(i)).toContain(ORG);
      }
    });

    it('кожен запит фільтрує deletedAt IS NULL саме на СВОЇЙ основній таблиці', async () => {
      await svc.search(ORG, 'bmw', ['wo', 'counterparty', 'good'], 9);
      // Перевіряємо префікс основної таблиці, а не JOIN-таблиці: інакше прибирання
      // deletedAt з головного фільтра маскувалось би deletedAt у приєднаному counterparty.
      expect(sqlOf(0)).toContain('wo."deletedAt" IS NULL'); // work_orders
      expect(sqlOf(1)).toContain('"deletedAt" IS NULL'); // counterparties (без префікса)
      expect(sqlOf(2)).toContain('g."deletedAt" IS NULL'); // goods
    });
  });

  describe('per-type LIMIT', () => {
    it('limit ділиться між типами (ceil) і передається параметром у кожен запит', async () => {
      await svc.search(ORG, 'bmw', ['wo', 'counterparty', 'good'], 9);
      // ceil(9/3) = 3 → останній параметр кожного запиту = LIMIT.
      for (let i = 0; i < 3; i++) {
        const vals = valuesOf(i);
        expect(vals[vals.length - 1]).toBe(3);
      }
    });

    it('один тип → весь limit йде йому', async () => {
      await svc.search(ORG, 'bmw', ['good'], 20);
      const vals = valuesOf(0);
      expect(vals[vals.length - 1]).toBe(20);
    });
  });

  describe('порядок і зріз результатів', () => {
    it('буфери склеюються у порядку types і зрізаються до limit', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'wo-1',
            number: 'WO-1',
            status: 'NEW',
            firstName: null,
            lastName: null,
            companyName: null,
          },
        ])
        .mockResolvedValueOnce([
          { id: 'cp-1', firstName: 'Іван', lastName: 'Петрів', companyName: null, phone: '099' },
        ])
        .mockResolvedValueOnce([{ id: 'g-1', name: 'Олива', sku: 'OIL', available: 5 }]);
      const res = await svc.search(ORG, 'x', ['wo', 'counterparty', 'good'], 2);
      // limit=2 → лишаються перші два у порядку types: wo, counterparty.
      expect(res).toHaveLength(2);
      expect(res[0].type).toBe('wo');
      expect(res[1].type).toBe('counterparty');
    });
  });

  describe('безпека вводу', () => {
    it('користувацький рядок передається параметром, а не склеюється у текст SQL', async () => {
      const malicious = "'); DROP TABLE work_orders;--";
      await svc.search(ORG, malicious, ['wo'], 10);
      // рядок має бути серед params; у самому тексті SQL його бути не повинно.
      expect(valuesOf(0)).toContain(malicious);
      expect(sqlOf(0)).not.toContain('DROP TABLE');
    });
  });

  describe('мапінг DTO', () => {
    it('wo: companyName має пріоритет над ПІБ у sub', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'wo-1',
          number: 'WO-7',
          status: 'NEW',
          firstName: 'Іван',
          lastName: 'Петрів',
          companyName: 'ТОВ Авто',
        },
      ]);
      const res = await svc.search(ORG, 'x', ['wo'], 10);
      expect(res[0]).toMatchObject({ type: 'wo', label: 'WO-7', sub: 'ТОВ Авто' });
    });

    it('good: available приводиться до числа у extra', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'g-1', name: 'Фільтр', sku: 'F1', available: '12' },
      ]);
      const res = await svc.search(ORG, 'x', ['good'], 10);
      expect(res[0].extra).toEqual({ available: 12 });
    });
  });
});

/**
 * SearchController — тонкий, але тримає DoS-гарди, яких НЕМАЄ у сервісі.
 * Їх легко «спростити» рефакторингом, тож фіксуємо тестом.
 */
describe('SearchController', () => {
  let service: { search: ReturnType<typeof vi.fn> };
  let ctrl: SearchController;
  const ORG = 'org-1';

  beforeEach(() => {
    service = { search: vi.fn().mockResolvedValue([]) };
    ctrl = new SearchController(service as never);
  });

  it('порожній q → { items: [], total: 0 } без звернення до сервісу', async () => {
    const r = await ctrl.search(ORG, '');
    expect(r).toEqual({ items: [], total: 0 });
    expect(service.search).not.toHaveBeenCalled();
  });

  it('q коротший за 2 символи → порожньо, сервіс не викликається', async () => {
    await ctrl.search(ORG, 'a');
    expect(service.search).not.toHaveBeenCalled();
  });

  it('наддовгий q обрізається до 100 символів (DoS/OOM guard pg_trgm)', async () => {
    await ctrl.search(ORG, 'a'.repeat(100_000));
    expect(service.search.mock.calls[0][1]).toHaveLength(100);
  });

  it('limit клемпиться у [1,50]: 999→50, 0/невалід→10', async () => {
    await ctrl.search(ORG, 'bmw', undefined, '999');
    expect(service.search.mock.calls[0][3]).toBe(50);

    service.search.mockClear();
    await ctrl.search(ORG, 'bmw', undefined, 'abc');
    expect(service.search.mock.calls[0][3]).toBe(10);

    service.search.mockClear();
    await ctrl.search(ORG, 'bmw', undefined, '0');
    expect(service.search.mock.calls[0][3]).toBe(10);
  });

  it('невідомі типи відкидаються; лишаються тільки з whitelist', async () => {
    await ctrl.search(ORG, 'bmw', 'wo,hacker,good');
    expect(service.search.mock.calls[0][2]).toEqual(['wo', 'good']);
  });

  it('усі типи невідомі → порожньо, сервіс не викликається (без divide-by-zero у service)', async () => {
    const r = await ctrl.search(ORG, 'bmw', 'nope,bad');
    expect(r).toEqual({ items: [], total: 0 });
    expect(service.search).not.toHaveBeenCalled();
  });

  it('без types → усі три за замовчуванням', async () => {
    await ctrl.search(ORG, 'bmw');
    expect(service.search.mock.calls[0][2]).toEqual(['wo', 'counterparty', 'good']);
  });

  it('orgId пробрасується у сервіс (tenant scope)', async () => {
    await ctrl.search(ORG, 'bmw');
    expect(service.search.mock.calls[0][0]).toBe(ORG);
  });
});
