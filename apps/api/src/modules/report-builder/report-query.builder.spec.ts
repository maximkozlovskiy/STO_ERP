import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { buildQuery, REPORT_TAKE_CAP } from './report-query.builder';

/** Базова валюта тестової організації (у застосунку — з OrganisationSettings). */
const BASE = 'UAH';

const ORG = 'org-1';

describe('report-query.builder', () => {
  // guards: BR-RPT-006, BR-RPT-007
  it('інжектить orgId + deletedAt для FULL-профілю', () => {
    const q = buildQuery({ entity: 'workOrder', columns: ['number'], groupBy: [] }, ORG, BASE);
    expect(q.model).toBe('workOrder');
    expect(q.args.where).toMatchObject({ orgId: ORG, deletedAt: null });
    expect(q.args.take).toBe(REPORT_TAKE_CAP);
  });

  // guards: BR-RPT-001
  it('невідома сутність → BadRequestException', () => {
    expect(() => buildQuery({ entity: 'hacker', columns: [], groupBy: [] }, ORG, BASE)).toThrow(
      BadRequestException,
    );
  });

  // guards: BR-RPT-001
  it('proto-injection у entity (__proto__/constructor) → BadRequestException', () => {
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      expect(() => buildQuery({ entity: bad, columns: [], groupBy: [] }, ORG, BASE)).toThrow(
        BadRequestException,
      );
    }
  });

  // guards: BR-RPT-002
  it('невідоме поле у columns → BadRequestException', () => {
    expect(() =>
      buildQuery({ entity: 'workOrder', columns: ['secretField'], groupBy: [] }, ORG, BASE),
    ).toThrow(BadRequestException);
  });

  it('relation-колонка будує nested select (без include/select mix — Bug #617)', () => {
    const q = buildQuery(
      { entity: 'workOrderPart', columns: ['good.brand.name'], groupBy: [] },
      ORG,
      BASE,
    );
    // good → select → brand → select:{name:true}. Все "усередині" — тільки select
    // (Prisma забороняє include+select на одному рівні).
    expect(q.args.include).toEqual({
      good: {
        select: {
          brand: { select: { name: true } },
        },
      },
    });
  });

  it('Bug #617: include-merge спільних префіксів (good.name + good.brand.name) — тільки select', () => {
    const q = buildQuery(
      { entity: 'workOrderPart', columns: ['good.name', 'good.brand.name'], groupBy: [] },
      ORG,
      BASE,
    );
    const good = (q.args.include as Record<string, unknown>).good as Record<string, unknown>;
    // Bug #617: раніше було good.select + good.include одночасно → Prisma 400.
    // Тепер обидва leaf-и лежать всередині select — Prisma це приймає.
    expect(good.include).toBeUndefined();
    expect(good.select).toEqual({
      name: true,
      brand: { select: { name: true } },
    });
  });

  it('Bug #617: multi-hop (workOrder.counterparty.companyName + workOrder.number) — тільки select', () => {
    const q = buildQuery(
      {
        entity: 'workOrderPart',
        columns: ['workOrder.number', 'workOrder.counterparty.companyName'],
        groupBy: [],
      },
      ORG,
      BASE,
    );
    const wo = (q.args.include as Record<string, unknown>).workOrder as Record<string, unknown>;
    expect(wo.include).toBeUndefined();
    expect(wo.select).toEqual({
      number: true,
      counterparty: { select: { companyName: true } },
    });
  });

  // guards: BR-RPT-004
  it('enum-фільтр з валідним значенням проходить, з невалідним → 400', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'status', op: 'eq', value: 'COMPLETED' }],
        },
        ORG,
        BASE,
      ),
    ).not.toThrow();
    expect(() =>
      buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'status', op: 'eq', value: 'HACKED' }],
        },
        ORG,
        BASE,
      ),
    ).toThrow(BadRequestException);
  });

  // До 2026-10-25 фільтр по зв'язку ставив `deletedAt: null` на хоп (Bug #607), і «Тип контрагента =
  // CLIENT» не бачив нарядів видаленого клієнта, які група «Клієнт» показувала. Тепер видалений
  // пов'язаний запис — звичайне значення і для фільтра, і для групи. Мутація: повернути deletedAt
  // на хоп у setWherePath → кейс червоніє.
  // guards: BR-RPT-028
  it('фільтр по зв’язку не відсікає видалений пов’язаний запис — як і групування', () => {
    const q = buildQuery(
      {
        entity: 'workOrder',
        columns: [],
        groupBy: [],
        filters: [{ field: 'counterparty.type', op: 'eq', value: 'CLIENT' }],
      },
      ORG,
      BASE,
    );
    expect(q.args.where.counterparty).toEqual({ type: 'CLIENT' });
  });

  // «Порожнє» = група «(порожньо)»: немає зв'язку на необов'язковому хопі, NULL, порожній рядок.
  // guards: BR-RPT-028
  it('«порожнє» по полю за необов’язковим зв’язком — OR: зв’язку немає / колонка NULL / порожній рядок', () => {
    const where = (entity: string, field: string, value: unknown) =>
      buildQuery(
        { entity, columns: [], groupBy: [], filters: [{ field, op: 'isNull', value }] },
        ORG,
        BASE,
      ).args.where;
    // бренд товару необов'язковий, назва бренду — текст
    expect(where('workOrderPart', 'good.brand.name', true).AND).toEqual([
      { OR: [{ good: { brand: null } }, { good: { brand: { name: '' } } }] },
    ]);
    // «заповнене» — непорожній текст (і тим самим зв'язок є)
    expect(where('workOrderPart', 'good.brand.name', false)).toMatchObject({
      good: { brand: { name: { not: '' } } },
    });
    // наряд у платежі необов'язковий: «порожнє» = наряду немає або номер порожній
    expect(where('payment', 'workOrder.number', true).AND).toEqual([
      { OR: [{ workOrder: null }, { workOrder: { number: '' } }] },
    ]);
    expect(where('payment', 'workOrder.number', false)).toMatchObject({
      workOrder: { number: { not: '' } },
    });
  });

  it('dateRange → фільтр по entity.dateField (Kyiv-межі)', () => {
    const q = buildQuery(
      {
        entity: 'workOrder',
        columns: [],
        groupBy: [],
        dateRange: { from: '2026-09-01', to: '2026-09-30' },
      },
      ORG,
      BASE,
    );
    const w = q.args.where as Record<string, { gte: Date; lte: Date }>;
    expect(w.documentDate.gte).toBeInstanceOf(Date);
    expect(w.documentDate.lte).toBeInstanceOf(Date);
    expect(w.documentDate.gte.getTime()).toBeLessThan(w.documentDate.lte.getTime());
  });

  it('orderBy fallback на defaultSort коли sort порожній', () => {
    const q = buildQuery({ entity: 'workOrder', columns: ['number'], groupBy: [] }, ORG, BASE);
    expect(q.args.orderBy).toEqual([{ createdAt: 'desc' }]);
  });

  it('sort по relation-полю будує вкладений orderBy', () => {
    const q = buildQuery(
      {
        entity: 'workOrderPart',
        columns: [],
        groupBy: [],
        sort: [{ field: 'good.name', dir: 'asc' }],
      },
      ORG,
      BASE,
    );
    expect(q.args.orderBy).toEqual([{ good: { name: 'asc' } }]);
  });

  // ── Білий список полів, операторів і фільтрів ─────────────────────────────────

  // guards: BR-RPT-002
  it.each([
    ['groupBy', { groupBy: ['secretField'] }],
    ['filters', { filters: [{ field: 'secretField', op: 'eq' as const, value: 1 }] }],
    ['sort', { sort: [{ field: 'secretField', dir: 'asc' as const }] }],
  ])('невідоме поле у %s → BadRequestException', (_slot, part) => {
    expect(() =>
      buildQuery({ entity: 'workOrder', columns: [], groupBy: [], ...part }, ORG, BASE),
    ).toThrow(BadRequestException);
  });

  // guards: BR-RPT-003
  it('оператор фільтра поза білим списком → BadRequestException', () => {
    for (const op of ['startsWith', 'search', 'OR', '__proto__']) {
      expect(() =>
        buildQuery(
          {
            entity: 'workOrder',
            columns: [],
            groupBy: [],
            filters: [{ field: 'number', op: op as never, value: 'WO' }],
          },
          ORG,
          BASE,
        ),
      ).toThrow(BadRequestException);
    }
  });

  // guards: BR-RPT-003
  it('contains для enum-, number- і decimal-поля → BadRequestException, для тексту — нечутливий до регістру', () => {
    const run = (entity: string, field: string, value: unknown) =>
      buildQuery(
        { entity, columns: [], groupBy: [], filters: [{ field, op: 'contains', value }] },
        ORG,
        BASE,
      );
    expect(() => run('workOrder', 'status', 'COMPLETED')).toThrow(BadRequestException); // enum
    expect(() => run('workOrderPart', 'quantity', 5)).toThrow(BadRequestException); // number
    expect(() => run('invoice', 'amount', 100)).toThrow(BadRequestException); // decimal
    expect(run('workOrder', 'number', 'wo-1').args.where).toMatchObject({
      number: { contains: 'wo-1', mode: 'insensitive' },
    });
  });

  // guards: BR-RPT-003
  it('contains шукає «%», «_» і «\\» буквально — символи шаблону LIKE екрануються (Bug #976)', () => {
    // Без екранування «Спосіб містить a_h» знаходив «cash», а «%» — усі платежі (і Prisma, і SQL).
    const where = buildQuery(
      {
        entity: 'payment',
        columns: [],
        groupBy: [],
        filters: [{ field: 'method', op: 'contains', value: 'bank_100%\\x' }],
      },
      ORG,
      BASE,
    ).args.where;
    expect(where.method).toEqual({ contains: 'bank\\_100\\%\\\\x', mode: 'insensitive' });
  });

  // guards: BR-RPT-003, BR-CASH-024
  it('оплати: «Сторновано» — фільтр isNull відділяє чинні оплати від сторнованих', () => {
    const run = (value: boolean) =>
      buildQuery(
        {
          entity: 'payment',
          columns: ['amount', 'reversedAt'],
          groupBy: [],
          filters: [{ field: 'reversedAt', op: 'isNull', value }],
        },
        ORG,
        BASE,
      ).args.where;
    expect(run(true)).toMatchObject({ orgId: ORG, reversedAt: null });
    expect(run(false)).toMatchObject({ orgId: ORG, reversedAt: { not: null } });
  });

  // guards: BR-RPT-003
  it('оператор in без масиву → BadRequestException', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'number', op: 'in', value: 'WO-1' }],
        },
        ORG,
        BASE,
      ),
    ).toThrow(BadRequestException);
  });

  // guards: BR-RPT-005
  it('фільтр по нефільтровному полю (stockMovement.quantity) → BadRequestException', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'stockMovement',
          columns: [],
          groupBy: [],
          filters: [{ field: 'quantity', op: 'gt', value: 0 }],
        },
        ORG,
        BASE,
      ),
    ).toThrow(BadRequestException);
  });

  // ── Ліміт рядків ──────────────────────────────────────────────────────────────

  // guards: BR-RPT-008
  it('take завжди 5000 — для кожної сутності реєстру, незалежно від config', () => {
    for (const entity of [
      'workOrder',
      'workOrderPart',
      'purchaseOrderLine',
      'invoice',
      'payment',
      'settlementTransaction',
      'stockMovement',
      'stockBatch',
      'stockItem',
    ]) {
      const q = buildQuery(
        { entity, columns: [], groupBy: [], take: 1_000_000 } as never,
        ORG,
        BASE,
      );
      expect(q.args.take, entity).toBe(5000);
    }
  });

  // ── Період за Києвом ──────────────────────────────────────────────────────────

  // guards: BR-RPT-009
  it('dateRange — межі київської доби: літо UTC+3 і зима UTC+2', () => {
    const range = (from: string, to: string) =>
      (
        buildQuery(
          { entity: 'payment', columns: [], groupBy: [], dateRange: { from, to } },
          ORG,
          BASE,
        ).args.where as Record<string, { gte: Date; lte: Date }>
      ).createdAt;
    const summer = range('2026-09-01', '2026-09-30');
    expect(summer.gte.toISOString()).toBe('2026-08-31T21:00:00.000Z'); // 01.09 00:00 Київ
    // Верхня межа — кінець київської доби 30.09. Точне значення не фіксуємо: kyivOffsetMs губить
    // мілісекунди, тож межа зсунута на 999 мс за північ (знахідка в дос'є, «Знахідки 2026-10-08»).
    expect(summer.lte.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-09-30T20:59:59.999Z'));
    expect(summer.lte.getTime()).toBeLessThan(Date.parse('2026-09-30T21:00:01.000Z'));
    const winter = range('2026-01-15', '2026-01-15');
    expect(winter.gte.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(winter.lte.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-01-15T21:59:59.999Z'));
    expect(winter.lte.getTime()).toBeLessThan(Date.parse('2026-01-15T22:00:01.000Z'));
  });

  // Prisma зводить параметр до типу колонки `@db.Date`: київська межа «з 20.10» (19.10 21:00 UTC)
  // ставала 19.10, і звіт за 20.10 показував наряди й рахунки 19.10. Мутація: у dateRange узяти
  // kyivDayStart/kyivDayEnd і для documentDate → кейс червоніє.
  // guards: BR-RPT-009
  it('dateRange на колонці @db.Date (наряд, рахунок) — самі дати, без зсуву на київський пояс', () => {
    for (const entity of ['workOrder', 'invoice']) {
      const r = (
        buildQuery(
          { entity, columns: [], groupBy: [], dateRange: { from: '2026-10-20', to: '2026-10-20' } },
          ORG,
          BASE,
        ).args.where as Record<string, { gte: Date; lte: Date }>
      ).documentDate;
      expect(r.gte.toISOString(), entity).toBe('2026-10-20T00:00:00.000Z');
      expect(r.lte.toISOString(), entity).toBe('2026-10-20T00:00:00.000Z');
    }
  });

  // guards: BR-RPT-009
  it('dateRange лягає на dateField сутності (stockMovement → createdAt), а не на фіксоване поле', () => {
    const where = buildQuery(
      {
        entity: 'stockMovement',
        columns: [],
        groupBy: [],
        dateRange: { from: '2026-09-01', to: '2026-09-01' },
      },
      ORG,
      BASE,
    ).args.where;
    expect(Object.keys(where).sort()).toEqual(['createdAt', 'orgId']);
  });

  // guards: BR-RPT-009
  it('dateRange: початок пізніше кінця → BadRequestException', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'invoice',
          columns: [],
          groupBy: [],
          dateRange: { from: '2026-09-30', to: '2026-09-01' },
        },
        ORG,
        BASE,
      ),
    ).toThrow(BadRequestException);
  });

  // До 2026-10-08 друга умова на те саме поле перезаписувала першу: «сума від 100 до 500»
  // мовчки показувала все до 500, а фільтр по даті документа замінював обраний період.
  describe('кілька умов на одне поле діють разом (BR-RPT-022)', () => {
    // guards: BR-RPT-022
    it('«від 100 до 500»: перша умова лишається на полі, друга йде в AND — жодна не губиться', () => {
      const q = buildQuery(
        {
          entity: 'invoice',
          columns: ['number'],
          groupBy: [],
          filters: [
            { field: 'amount', op: 'gte', value: 100 },
            { field: 'amount', op: 'lte', value: 500 },
          ],
        },
        ORG,
        BASE,
      );
      expect(q.args.where.amount).toEqual({ gte: 100 });
      expect(q.args.where.AND).toEqual([{ amount: { lte: 500 } }]);
    });

    // guards: BR-RPT-022
    it('три умови на одне поле → одна на полі й дві в AND, у порядку запиту', () => {
      const q = buildQuery(
        {
          entity: 'invoice',
          columns: ['number'],
          groupBy: [],
          filters: [
            { field: 'amount', op: 'gte', value: 100 },
            { field: 'amount', op: 'lte', value: 500 },
            { field: 'amount', op: 'ne', value: 250 },
          ],
        },
        ORG,
        BASE,
      );
      expect(q.args.where.amount).toEqual({ gte: 100 });
      expect(q.args.where.AND).toEqual([{ amount: { lte: 500 } }, { amount: { not: 250 } }]);
    });

    // guards: BR-RPT-022, BR-RPT-009
    it('фільтр по полю дати звужує обраний період, а не замінює його', () => {
      const q = buildQuery(
        {
          entity: 'invoice',
          columns: ['number'],
          groupBy: [],
          dateRange: { from: '2026-09-01', to: '2026-09-30' },
          filters: [{ field: 'documentDate', op: 'gte', value: '2026-09-15' }],
        },
        ORG,
        BASE,
      );
      const period = q.args.where.documentDate as { gte: Date; lte: Date };
      expect(period.gte).toBeInstanceOf(Date);
      expect(period.lte).toBeInstanceOf(Date);
      expect(q.args.where.AND).toHaveLength(1);
      expect(Object.keys(q.args.where.AND[0] as object)).toEqual(['documentDate']);
    });

    // guards: BR-RPT-022, BR-RPT-006
    it('умови в AND не чіпають orgId і deletedAt кореня', () => {
      const q = buildQuery(
        {
          entity: 'invoice',
          columns: ['number'],
          groupBy: [],
          filters: [
            { field: 'amount', op: 'gte', value: 1 },
            { field: 'amount', op: 'lte', value: 2 },
          ],
        },
        ORG,
        BASE,
      );
      expect(q.args.where.orgId).toBe(ORG);
      expect(q.args.where.deletedAt).toBeNull();
    });

    it('одна умова на поле — форма where як раніше, AND не з’являється', () => {
      const q = buildQuery(
        {
          entity: 'invoice',
          columns: ['number'],
          groupBy: [],
          filters: [{ field: 'amount', op: 'gte', value: 100 }],
        },
        ORG,
        BASE,
      );
      expect(q.args.where.amount).toEqual({ gte: 100 });
      expect(q.args.where.AND).toBeUndefined();
    });
  });

  // TECH-DEBT §8 «звіти»: значення фільтра йшло в Prisma як є, тож `{ startsWith: 'A' }` чи
  // `{ not: … }` обходили білий список операторів. Мутація: у buildQuery передати `f.value`
  // замість нормалізованого значення → кейси «об'єкт → 400» і «число рядком» червоніють.
  describe('значення фільтра — примітив за типом поля (BR-RPT-024)', () => {
    const where = (entity: string, field: string, op: string, value: unknown) =>
      buildQuery(
        { entity, columns: [], groupBy: [], filters: [{ field, op: op as never, value }] },
        ORG,
        BASE,
      ).args.where;
    const rejects = (entity: string, field: string, op: string, value: unknown) =>
      expect(() => where(entity, field, op, value)).toThrow('Неприпустиме значення фільтра');

    // guards: BR-RPT-024
    it.each([
      ['eq', { startsWith: 'A' }],
      ['ne', { not: 'x' }],
      ['gt', ['A']],
      ['contains', { contains: 'A' }],
      ['isNull', { not: null }],
    ])(
      "текстове поле, оператор %s з об'єктом чи масивом → 400, у Prisma не потрапляє",
      (op, value) => {
        // «Порожнє» — лише для поля, що може бути порожнім (номер наряду обов'язковий).
        rejects('workOrder', op === 'isNull' ? 'counterparty.companyName' : 'number', op, value);
      },
    );

    // Обов'язкова колонка: Prisma відповідала загальною 400 «Некоректні дані запиту».
    // guards: BR-RPT-024
    it("«порожнє / заповнене» на обов'язковому полі → 400 з назвою поля", () => {
      expect(() => where('workOrder', 'status', 'isNull', true)).toThrow(
        'Поле "Статус" завжди заповнене',
      );
      expect(() => where('payment', 'amount', 'isNull', false)).toThrow('завжди заповнене');
    });

    // guards: BR-RPT-024
    it('in: масив з об’єктом → 400; понад 500 значень → 400', () => {
      rejects('workOrder', 'number', 'in', ['WO-1', { startsWith: 'W' }]);
      rejects(
        'workOrder',
        'number',
        'in',
        Array.from({ length: 501 }, (_, i) => `WO-${i}`),
      );
      expect(where('workOrder', 'number', 'in', ['WO-1', 'WO-2'])).toMatchObject({
        number: { in: ['WO-1', 'WO-2'] },
      });
    });

    // guards: BR-RPT-024
    it('тип значення має збігатися з типом поля: число в текстовому, текст у числовому, дата-сміття → 400', () => {
      rejects('workOrder', 'number', 'eq', 42);
      rejects('workOrderPart', 'quantity', 'gte', 'багато');
      rejects('invoice', 'amount', 'gt', '1e400');
      rejects('workOrder', 'completedAt', 'gte', 'вчора');
      rejects('stockBatch', 'isActive', 'eq', 'так');
      rejects('workOrder', 'status', 'eq', 7);
    });

    // guards: BR-RPT-024
    it('рядок із поля «значення» UI приводиться: ціле → Number, десяткове лишається рядком, так/ні → boolean', () => {
      expect(where('workOrderPart', 'quantity', 'gte', ' 5 ')).toMatchObject({
        quantity: { gte: 5 },
      });
      expect(where('invoice', 'amount', 'lt', '100.50')).toMatchObject({
        amount: { lt: '100.50' },
      });
      expect(where('stockBatch', 'isActive', 'eq', 'false')).toMatchObject({ isActive: false });
    });

    // guards: BR-RPT-024
    it('isNull: рядок, лишений у value після зміни оператора, не заважає; false / "false" — «заповнено»', () => {
      expect(where('payment', 'reversedAt', 'isNull', 'abc')).toMatchObject({ reversedAt: null });
      expect(where('payment', 'reversedAt', 'isNull', 'false')).toMatchObject({
        reversedAt: { not: null },
      });
    });
  });

  // Значення фільтра дати йшло в Prisma рядком: «2026-10-01» і «01.10.2026» Prisma відхиляла (400
  // «Некоректні дані запиту»), а `Date.parse('01.10.2026')` до того ж читав 10 січня. Фільтр по даті
  // з UI не працював жодним форматом. Мутація: повернути `v` замість дня в scalarFilterValue('date')
  // або прибрати buildDateCond → кейси червоніють.
  describe('фільтр дати порівнює цілими днями (BR-RPT-025)', () => {
    const cond = (entity: string, field: string, op: string, value: unknown) =>
      (
        buildQuery(
          { entity, columns: [], groupBy: [], filters: [{ field, op: op as never, value }] },
          ORG,
          BASE,
        ).args.where as Record<string, unknown>
      )[field];
    const iso = (d: unknown) => (d as Date).toISOString();

    // guards: BR-RPT-025
    it('ДД.ММ.РРРР і РРРР-ММ-ДД — той самий день; «01.10» не стає 10 січня', () => {
      const a = cond('payment', 'createdAt', 'gte', '01.10.2026') as { gte: Date };
      const b = cond('payment', 'createdAt', 'gte', '2026-10-01') as { gte: Date };
      expect(iso(a.gte)).toBe('2026-09-30T21:00:00.000Z'); // 01.10 00:00 Київ (літо)
      expect(iso(b.gte)).toBe(iso(a.gte));
    });

    // guards: BR-RPT-025
    it('мітка часу: = день — уся київська доба; > день — після кінця доби; < день — до її початку', () => {
      const eq = cond('payment', 'createdAt', 'eq', '20.10.2026') as { gte: Date; lte: Date };
      expect(iso(eq.gte)).toBe('2026-10-19T21:00:00.000Z');
      expect(eq.lte.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-20T20:59:59.999Z'));
      expect(eq.lte.getTime()).toBeLessThan(Date.parse('2026-10-20T21:00:01.000Z'));
      const gt = cond('payment', 'createdAt', 'gt', '20.10.2026') as { gt: Date };
      expect(gt.gt.getTime()).toBe(eq.lte.getTime());
      const lt = cond('payment', 'createdAt', 'lt', '20.10.2026') as { lt: Date };
      expect(iso(lt.lt)).toBe('2026-10-19T21:00:00.000Z');
    });

    // Bug #973: `{ not: { gte, lte } }` Prisma розкладає на NOT(≥) AND NOT(≤) — порожня множина,
    // і «≠ 22.10» давав 0 рядків на живій базі (553 наряди за SQL). Мутація: повернути
    // `{ not: { gte: start, lte: end } }` у buildDateCond('ne') → кейс червоніє.
    // guards: BR-RPT-025
    it('≠ день — OR «до початку дня» / «після кінця дня» в AND, разом із періодом', () => {
      const where = buildQuery(
        {
          entity: 'payment',
          columns: [],
          groupBy: [],
          dateRange: { from: '2026-10-18', to: '2026-10-24' },
          filters: [{ field: 'createdAt', op: 'ne', value: '20.10.2026' }],
        },
        ORG,
        BASE,
      ).args.where as {
        createdAt: unknown;
        AND: Array<{ OR: Array<{ createdAt: Record<string, Date> }> }>;
      };
      expect(where.createdAt).toMatchObject({ gte: new Date('2026-10-17T21:00:00.000Z') });
      expect(where.AND).toHaveLength(1);
      const [before, after] = where.AND[0].OR;
      expect(iso(before.createdAt.lt)).toBe('2026-10-19T21:00:00.000Z');
      expect(after.createdAt.gt.getTime()).toBeGreaterThanOrEqual(
        Date.parse('2026-10-20T20:59:59.999Z'),
      );
      expect(JSON.stringify(where)).not.toContain('"not"');
      // @db.Date — межі є самою датою
      const wo = buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'documentDate', op: 'ne', value: '2026-10-22' }],
        },
        ORG,
        BASE,
      ).args.where as Record<string, unknown>;
      expect(wo.AND).toEqual([
        {
          OR: [
            { documentDate: { lt: new Date('2026-10-22T00:00:00.000Z') } },
            { documentDate: { gt: new Date('2026-10-22T00:00:00.000Z') } },
          ],
        },
      ]);
    });

    // guards: BR-RPT-025
    it('колонка @db.Date (дата наряду) — межі є самою датою', () => {
      expect(cond('workOrder', 'documentDate', 'eq', '20.10.2026')).toEqual({
        gte: new Date('2026-10-20T00:00:00.000Z'),
        lte: new Date('2026-10-20T00:00:00.000Z'),
      });
      expect(cond('workOrder', 'documentDate', 'lte', '2026-10-20')).toEqual({
        lte: new Date('2026-10-20T00:00:00.000Z'),
      });
    });

    // guards: BR-RPT-025
    it('не день (31.02, мітка часу, «вчора») → 400; «в списку» і «містить» для дати → 400', () => {
      for (const v of ['31.02.2026', '2026-09-15T00:00:00.000Z', 'вчора', '1.10.2026']) {
        expect(() => cond('workOrder', 'completedAt', 'gte', v), v).toThrow(
          'Неприпустиме значення фільтра',
        );
      }
      expect(() => cond('workOrder', 'completedAt', 'in', ['2026-10-01'])).toThrow(
        BadRequestException,
      );
      expect(() => cond('workOrder', 'completedAt', 'contains', '2026-10-01')).toThrow(
        BadRequestException,
      );
    });

    // guards: BR-RPT-025
    it('«порожнє» для дати лишається умовою на null, без дня', () => {
      expect(cond('payment', 'reversedAt', 'isNull', undefined)).toBeNull();
    });

    // Збережений до 2026-10-25 звіт із «містить» на даті: помилка має називати оператор, а не
    // значення (поле дати в UI для нього порожнє).
    // guards: BR-RPT-025
    it('«містить» на даті без значення → помилка про оператор, не про значення', () => {
      expect(() => cond('workOrder', 'documentDate', 'contains', undefined)).toThrow(
        'Оператор «містить» — лише для текстових полів',
      );
    });
  });

  // Видалення закупівлі / наряду позначає лише документ; його рядки лишаються з deletedAt: null.
  // У dev-базі 2026-10-25 так у звіт потрапляли 277 рядків видалених закупівель і 504 запчастини
  // видалених нарядів. Мутація: прибрати `parentRelations` у buildQuery → кейси червоніють.
  describe('рядки видаленого документа не потрапляють у звіт (BR-RPT-007)', () => {
    // Сторінка залишків відсікає видалені товари й склади, а конструктор показував їх: 62 рядки
    // залишків і 2563 партії dev-бази. Рухи — історія, їх ця умова не стосується.
    // guards: BR-RPT-007
    it('залишки й партії — умова deletedAt: null на товар і склад; рухи — без неї', () => {
      for (const entity of ['stockItem', 'stockBatch']) {
        expect(
          buildQuery({ entity, columns: [], groupBy: [] }, ORG, BASE).args.where,
          entity,
        ).toMatchObject({ good: { deletedAt: null }, warehouse: { deletedAt: null } });
      }
      const mov = buildQuery({ entity: 'stockMovement', columns: [], groupBy: [] }, ORG, BASE);
      expect(mov.args.where).not.toHaveProperty('good');
      expect(mov.args.where).not.toHaveProperty('warehouse');
    });

    // guards: BR-RPT-007
    it('рядки закупівлі й запчастини наряду — умова deletedAt: null і на документ-власник', () => {
      const pol = buildQuery({ entity: 'purchaseOrderLine', columns: [], groupBy: [] }, ORG, BASE);
      expect(pol.args.where).toMatchObject({ deletedAt: null, purchaseOrder: { deletedAt: null } });
      const wop = buildQuery({ entity: 'workOrderPart', columns: [], groupBy: [] }, ORG, BASE);
      expect(wop.args.where).toMatchObject({ deletedAt: null, workOrder: { deletedAt: null } });
    });

    // guards: BR-RPT-007
    it('фільтр по полю документа-власника не знімає умову на його deletedAt', () => {
      const q = buildQuery(
        {
          entity: 'workOrderPart',
          columns: [],
          groupBy: [],
          filters: [{ field: 'workOrder.number', op: 'eq', value: 'WO-1' }],
        },
        ORG,
        BASE,
      );
      expect(q.args.where).toMatchObject({ workOrder: { deletedAt: null, number: 'WO-1' } });
    });
  });

  // guards: BR-RPT-004
  it('тип руху «Повернення» (RETURN) є в переліку — фільтр по ньому не 400', () => {
    const q = buildQuery(
      {
        entity: 'stockMovement',
        columns: [],
        groupBy: [],
        filters: [{ field: 'type', op: 'eq', value: 'RETURN' }],
      },
      ORG,
      BASE,
    );
    expect(q.args.where).toMatchObject({ type: 'RETURN' });
  });

  // До 2026-10-25 «Платежі клієнтів» рахували й сторновані оплати (113 на 34 312,03 грн у
  // dev-базі), хоча рахунки, звірка й лояльність їх не рахують. Рішення власника — виключати за
  // замовчуванням. Мутація: прибрати умову voidedField у buildQuery → перший кейс червоніє.
  describe('сторновані платежі за замовчуванням не входять у звіт (BR-RPT-026)', () => {
    const where = (filters?: { field: string; op: string; value?: unknown }[]) =>
      buildQuery(
        { entity: 'payment', columns: [], groupBy: [], filters: filters as never },
        ORG,
        BASE,
      ).args.where;

    // guards: BR-RPT-026
    it('без фільтра по «Сторновано» — лише чинні оплати (reversedAt: null)', () => {
      expect(where()).toMatchObject({ reversedAt: null });
    });

    // guards: BR-RPT-026
    it('фільтр користувача по «Сторновано» замінює умову: «заповнене» показує саме сторновані', () => {
      expect(where([{ field: 'reversedAt', op: 'isNull', value: false }])).toMatchObject({
        reversedAt: { not: null },
      });
      const byDay = where([{ field: 'reversedAt', op: 'gte', value: '2026-10-01' }]);
      expect(byDay.reversedAt).toHaveProperty('gte');
      expect(byDay.AND).toBeUndefined();
    });

    // guards: BR-RPT-026
    it('інші сутності без позначки сторно умови не отримують', () => {
      const w = buildQuery({ entity: 'invoice', columns: [], groupBy: [] }, ORG, BASE).args.where;
      expect(w).not.toHaveProperty('reversedAt');
    });
  });

  describe('BR-RPT-029: порожня валюта = базова', () => {
    const payFilter = (op: string, value: unknown) =>
      buildQuery(
        {
          entity: 'payment',
          columns: [],
          groupBy: [],
          filters: [{ field: 'currency.code', op, value }] as never,
        },
        ORG,
        'EUR',
      ).args.where;

    // Мутація: прибрати OR-гілку «валюти немає» в addCond → «= базова» губить платежі без валюти.
    // guards: BR-RPT-029
    it('умова, під яку підходить базова валюта, бере й документи без валюти (OR)', () => {
      expect(payFilter('eq', 'EUR').AND).toEqual([
        { OR: [{ currency: { code: 'EUR' } }, { currency: null }] },
      ]);
      expect(payFilter('in', ['USD', 'EUR']).AND).toEqual([
        { OR: [{ currency: { code: { in: ['USD', 'EUR'] } } }, { currency: null }] },
      ]);
      expect(payFilter('ne', 'USD').AND).toEqual([
        { OR: [{ currency: { code: { not: 'USD' } } }, { currency: null }] },
      ]);
      expect(payFilter('contains', 'eu').AND).toEqual([
        {
          OR: [{ currency: { code: { contains: 'eu', mode: 'insensitive' } } }, { currency: null }],
        },
      ]);
    });

    // Мутація: прибрати гілку 'bounds' у baseCurrencyMatches → «код ≥ D» губить платежі без валюти,
    // які SQL `COALESCE(код, базова) >= 'D'` рахує (паритет SQL = Prisma).
    // guards: BR-RPT-029
    it('межі на коді («≥ / <»), під які підходить базова, теж беруть документи без валюти', () => {
      expect(payFilter('gte', 'D').AND).toEqual([
        { OR: [{ currency: { code: { gte: 'D' } } }, { currency: null }] },
      ]);
      const below = payFilter('lt', 'D');
      expect(below.currency).toEqual({ code: { lt: 'D' } });
      expect(below.AND).toBeUndefined();
    });

    // guards: BR-RPT-029
    it('умова, під яку базова не підходить, — без гілки «валюти немає»', () => {
      const eqOther = payFilter('eq', 'USD');
      expect(eqOther.currency).toEqual({ code: 'USD' });
      expect(eqOther.AND).toBeUndefined();
      expect(payFilter('ne', 'EUR').currency).toEqual({ code: { not: 'EUR' } });
    });

    // guards: BR-RPT-029
    it("обов'язкова валюта (наряд) — без гілки; колонка у валюті документа тягне код валюти", () => {
      const q = buildQuery(
        {
          entity: 'workOrderPart',
          columns: ['amount'],
          groupBy: [],
          filters: [{ field: 'workOrder.currency.code', op: 'eq', value: 'EUR' }],
        },
        ORG,
        'EUR',
      );
      expect(q.args.where.workOrder.currency).toEqual({ code: 'EUR' });
      expect(q.args.where.AND).toBeUndefined();
      expect(q.args.include).toEqual({
        workOrder: { select: { currency: { select: { code: true } } } },
      });
    });
  });
});
