/**
 * SupplierPaymentsService.getSchedule() — шахматка оплат
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException } from '@nestjs/common';
import { it, expect } from 'vitest';
import { makeSpHarness, type SpHarness, ORG, SUPPLIER_ID } from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — schedule', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];

  beforeEach(async () => {
    ({ service, prisma } = await makeSpHarness());
  });

  // ──────────────────────────────────────────────────────────────────────
  // getSchedule() — шахматка оплат
  // ──────────────────────────────────────────────────────────────────────

  const poRow = (over: {
    supplierId?: string;
    supplierName?: string;
    totalAmount: number;
    paymentDate: string | null;
    paid?: number[];
  }) => ({
    id: '99999999-9999-4999-8999-999999999999',
    supplierId: over.supplierId ?? SUPPLIER_ID,
    totalAmount: over.totalAmount,
    paymentDate: over.paymentDate ? new Date(over.paymentDate + 'T00:00:00Z') : null,
    supplier: { firstName: null, lastName: null, companyName: over.supplierName ?? 'Acme' },
    supplierPayments: (over.paid ?? []).map(a => ({ amount: a })),
  });

  /** Мок кредит-лімітів (counterpartyContract.findMany). */
  const mockLimit = (limit: number, supplierId = SUPPLIER_ID) =>
    prisma.counterpartyContract.findMany.mockResolvedValueOnce([
      { counterpartyId: supplierId, creditLimit: limit },
    ]);

  /**
   * Мок АВТОРИТЕТНОГО боргу постачальника — SettlementAccount з від'ємним балансом.
   * payable = |balance|; balance зберігаємо від'ємним (ми винні постачальнику).
   */
  const mockPayable = (payable: number, over?: { supplierId?: string; name?: string }) =>
    prisma.settlementAccount.findMany.mockResolvedValueOnce([
      {
        counterpartyId: over?.supplierId ?? SUPPLIER_ID,
        balance: -payable,
        counterparty: { firstName: null, lastName: null, companyName: over?.name ?? 'Acme' },
      },
    ]);

  // guards: BR-SUPPAY-009
  it('getSchedule(): payable з балансу розподіляється по PO-датах (overdue/byDate/planned)', async () => {
    // Балансовий борг 4200 = точна сума PO-outstanding → FIFO покриває всі PO повністю.
    mockPayable(4200);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-10' }), // < from → overdue
      poRow({ totalAmount: 500, paymentDate: null }), // null → overdue
      poRow({ totalAmount: 2000, paymentDate: '2026-08-25' }), // у вікні
      poRow({ totalAmount: 700, paymentDate: '2026-12-31' }), // > to → planned
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.dates).toHaveLength(20);
    const row = r.suppliers[0];
    expect(row.overdue).toBe(1500); // 1000 + 500
    expect(row.byDate['2026-08-25']).toBe(2000);
    expect(row.planned).toBe(700);
    expect(row.total).toBe(4200);
    expect(r.totals.total).toBe(4200);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): FIFO — сума = balance, борг лягає на найстаріші PO (47 vs 30953)', async () => {
    // Ключовий регрес-guard: реальний борг = 47, а PO роздуті до 30953.
    // FIFO наливає 47 на НАЙСТАРІШИЙ PO (953-overdue за датою 08-10, nulls/asc порядок
    // з findMany orderBy) → увесь борг 47 в overdue; PO на 30000 (пізніший) не показується.
    mockPayable(47);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      // Порядок як з findMany: paymentDate asc → 08-10 перший (найстаріший).
      poRow({ totalAmount: 953, paymentDate: '2026-08-10' }), // overdue, найстаріший → бере 47
      poRow({ totalAmount: 30000, paymentDate: '2026-08-25' }), // пізніший → не дійшла черга
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.total).toBeCloseTo(47, 5);
    expect(row.overdue).toBeCloseTo(47, 5); // увесь борг на найстарішому (overdue)
    expect(row.byDate['2026-08-25']).toBeUndefined(); // пізніший PO не показується
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): FIFO часткове перекриття — перший PO повний, другий частково', async () => {
    // payable=1500 наливається: PO[0] (1000) повний, PO[1] (1000) отримує 500, решта відсічена.
    mockPayable(1500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }), // найстаріший у вікні → 1000
      poRow({ totalAmount: 1000, paymentDate: '2026-08-26' }), // наступний → 500
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.byDate['2026-08-25']).toBe(1000);
    expect(row.byDate['2026-08-26']).toBe(500);
    expect(row.total).toBe(1500);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): борг з балансу понад суму PO → надлишок в overdue', async () => {
    // payable=1200, єдиний PO outstanding=1000 → 1000 у дату, 200 надлишку → overdue.
    mockPayable(1200);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.byDate['2026-08-25']).toBe(1000);
    expect(row.overdue).toBe(200);
    expect(row.total).toBe(1200);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): борг з балансу без відкритих PO → усе в overdue', async () => {
    // Баланс від'ємний (борг з поверненя/коригування), жодного RECEIVED/PARTIAL PO.
    mockPayable(500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers[0].overdue).toBe(500);
    expect(r.suppliers[0].planned).toBe(0);
    expect(r.suppliers[0].total).toBe(500);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): постачальник з балансом ≥ 0 не показується (нічого не винні)', async () => {
    // Немає SettlementAccount з balance<0 → рядка немає, навіть якщо є відкриті PO.
    prisma.settlementAccount.findMany.mockResolvedValueOnce([]);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25' }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers).toHaveLength(0);
    expect(r.totals.total).toBe(0);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): кредит-ліміт віднімає з найпізніших (5000 борг, 2000 ліміт → 3000)', async () => {
    mockPayable(5000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25' }),
    ]);
    mockLimit(2000);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // єдина клітинка → ліміт зменшує її з 5000 до 3000
    expect(r.suppliers[0].byDate['2026-08-25']).toBe(3000);
    expect(r.suppliers[0].total).toBe(3000);
  });

  it('getSchedule(): ліміт з АКТИВНОГО договору навіть коли PO без contract (review #5)', async () => {
    // PO без contract, але у постачальника є PURCHASE-договір з лімітом → ліміт застосовується.
    mockPayable(5000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25' }),
    ]);
    mockLimit(2000);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers[0].total).toBe(3000);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): ліміт покриває planned ПЕРШИМ, overdue лишається повним', async () => {
    mockPayable(2000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-10' }), // overdue 1000
      poRow({ totalAmount: 1000, paymentDate: '2026-12-31' }), // planned 1000
    ]);
    mockLimit(1500);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // ліміт 1500: спочатку planned(1000)→0, потім overdue: 1000−500=500
    expect(r.suppliers[0].planned).toBe(0);
    expect(r.suppliers[0].overdue).toBe(500);
    expect(r.suppliers[0].total).toBe(500);
  });

  it('getSchedule(): ліміт ≥ борг → постачальник не показується', async () => {
    mockPayable(1000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }),
    ]);
    mockLimit(5000);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers).toHaveLength(0);
    expect(r.totals.total).toBe(0);
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): SettlementAccount-запит виключає видалених + не-supplier counterparty (Bug #599)', async () => {
    // Bug #599 — payableAccounts має відфільтрувати:
    //   (а) deleted counterparty (orphan-рядки — див. Bug #600 divergence зі звітом);
    //   (б) counterparty.type IN (SUPPLIER, BOTH) — CLIENT з prepayment refund НЕ повинен
    //       з'являтись у графіку оплат ПОСТАЧАЛЬНИКУ.
    // Регресія-guard проти повернення до filter без type-check.
    await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const where = (
      prisma.settlementAccount.findMany.mock.calls[0]![0] as {
        where: {
          balance?: unknown;
          counterparty?: { deletedAt: null; type?: { in: string[] } };
        };
      }
    ).where;
    expect(where.counterparty).toEqual({
      deletedAt: null,
      type: { in: ['SUPPLIER', 'BOTH'] },
    });
    expect(where.balance).toEqual({ lt: 0 });
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): PO-запит — лише RECEIVED/PARTIAL, FIFO-порядок paymentDate asc nulls first', async () => {
    // FIFO-налив іде у порядку, в якому PO прийшли з БД, тож порядок і фільтр статусів —
    // частина правила: інший orderBy тихо перекидає борг з прострочених на пізніші дати.
    await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const arg = prisma.purchaseOrder.findMany.mock.calls[0]![0] as {
      where: { orgId: string; deletedAt: null; status: { in: string[] } };
      orderBy: unknown[];
    };
    expect(arg.where.orgId).toBe(ORG);
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.status).toEqual({ in: ['RECEIVED', 'PARTIAL'] });
    expect(arg.orderBy[0]).toEqual({ paymentDate: { sort: 'asc', nulls: 'first' } });
  });

  // guards: BR-SUPPAY-009
  it('getSchedule(): залишок PO = totalAmount − Σ проведених оплат; повністю сплачений PO пропускається', async () => {
    // payable=1000. PO[0] сплачений повністю (1000 з 1000) → у FIFO не бере участі.
    // PO[1]: 1000 − 700 = 300 реального залишку → бере 300; PO[2] отримує решту 700.
    mockPayable(1000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-24', paid: [600, 400] }),
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25', paid: [700] }),
      poRow({ totalAmount: 1000, paymentDate: '2026-08-26' }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.byDate['2026-08-24']).toBeUndefined();
    expect(row.byDate['2026-08-25']).toBe(300);
    expect(row.byDate['2026-08-26']).toBe(700);
    expect(row.total).toBe(1000);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug #597 — regression guards for cross-field validation.
  // Guards існують у service (from > to → 400, windowDays > 100 → 400),
  // але без тестів наступний refactor може їх видалити → CI green → user
  // отримує 200 з empty/misleading result замість 400 helpful error.
  // Pattern: Bug #416 (Serializable inner re-check test).
  // ──────────────────────────────────────────────────────────────────────

  it('getSchedule(): from > to → BadRequestException, БЕЗ DB-виклику (Bug #597)', async () => {
    await expect(service.getSchedule(ORG, '2026-09-01', '2026-08-30')).rejects.toThrow(
      BadRequestException,
    );
    // DB не мали чіпати — cross-field guard спрацював ДО Promise.all.
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.counterpartyContract.findMany).not.toHaveBeenCalled();
  });

  it('getSchedule(): вікно > 100 днів → BadRequestException, БЕЗ DB-виклику (Bug #597)', async () => {
    // 2026-01-01 .. 2026-04-30 = 119 днів → windowDays=119 > 100 → 400.
    await expect(service.getSchedule(ORG, '2026-01-01', '2026-04-30')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
  });

  it('getSchedule(): windowDays на межі 100 → OK, DB викликано (Bug #597)', async () => {
    // 2026-01-01 .. 2026-04-10 = 99 днів різниці + 23:59:59 → Math.round → 100 → passes strict `> 100`.
    // Регресія-guard: якщо guard стане `>= 100` — цей тест червоний.
    await expect(service.getSchedule(ORG, '2026-01-01', '2026-04-10')).resolves.toBeDefined();
    expect(prisma.purchaseOrder.findMany).toHaveBeenCalledOnce();
  });

  it('getSchedule(): totals.byDate агрегує суми з усіх постачальників по датам (Bug #597)', async () => {
    // Два постачальники, один PO у одну дату, один у іншу.
    // Regression-guard для single-pass reduce (optimize cycle 2) — переконуємось
    // що totals.byDate НЕ пропускає жодного bucket-у і НЕ дублює.
    const SUPPLIER2 = '55555555-5555-4555-8555-555555555555';
    // Баланси = точні суми PO-outstanding → FIFO покриває всі PO повністю для обох.
    prisma.settlementAccount.findMany.mockResolvedValueOnce([
      {
        counterpartyId: SUPPLIER_ID,
        balance: -1600,
        counterparty: { firstName: null, lastName: null, companyName: 'Acme' },
      },
      {
        counterpartyId: SUPPLIER2,
        balance: -400,
        counterparty: { firstName: null, lastName: null, companyName: 'Beta' },
      },
    ]);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }), // supplier A → 25-го
      poRow({ totalAmount: 600, paymentDate: '2026-08-26' }), // supplier A → 26-го
      poRow({
        totalAmount: 400,
        paymentDate: '2026-08-25',
        supplierId: SUPPLIER2,
        supplierName: 'Beta',
      }), // supplier B → 25-го
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // 25-го = 1000 (A) + 400 (B) = 1400
    expect(r.totals.byDate['2026-08-25']).toBe(1400);
    // 26-го = 600 (A)
    expect(r.totals.byDate['2026-08-26']).toBe(600);
    // Порожні колонки не потрапляють у totals.byDate.
    expect(r.totals.byDate['2026-08-27']).toBeUndefined();
    // Sanity: сума збігається з grand total.
    expect(r.totals.total).toBe(2000);
    expect(r.suppliers).toHaveLength(2);
  });

  // ──────────────────────────────────────────────────────────────────────
  // getScheduleDocuments() — drill-down документів клітинки шахматки.
  // Ключовий інваріант: Σ allocated документів у бакеті == сума клітинки getSchedule
  // (спільний computeScheduleAllocations → немає sibling-drift панель↔клітинка).
  // ──────────────────────────────────────────────────────────────────────

  /** PO з унікальним id/number (getScheduleDocuments повертає їх). */
  const poDoc = (over: {
    id: string;
    number: string;
    supplierId?: string;
    supplierName?: string;
    totalAmount: number;
    paymentDate: string | null;
    paid?: number[];
  }) => ({
    id: over.id,
    number: over.number,
    supplierId: over.supplierId ?? SUPPLIER_ID,
    totalAmount: over.totalAmount,
    paymentDate: over.paymentDate ? new Date(over.paymentDate + 'T00:00:00Z') : null,
    supplier: { firstName: null, lastName: null, companyName: over.supplierName ?? 'Acme' },
    supplierPayments: (over.paid ?? []).map(a => ({ amount: a })),
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): date-бакет повертає лише PO цього дня + Σ allocated == клітинка', async () => {
    // 2 PO у 25-го, 1 у 26-го; balance=1600 покриває всі → date 25-го = 1000+400? Ні:
    // FIFO наливає 1600: PO1(1000)@25 повний, PO2(600)@26 повний → 25-го = 1000, 26-го = 600.
    mockPayable(1600);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-1', number: 'ЗАМ-1', totalAmount: 1000, paymentDate: '2026-08-25' }),
      poDoc({ id: 'po-2', number: 'ЗАМ-2', totalAmount: 600, paymentDate: '2026-08-26' }),
    ]);
    const docs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-25',
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].number).toBe('ЗАМ-1');
    expect(docs[0].poId).toBe('po-1');
    const sum = docs.reduce((s, d) => s + d.allocated, 0);
    expect(sum).toBe(1000); // == клітинка byDate['2026-08-25'] у getSchedule
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): overdue-бакет фільтрує лише прострочені/null-date', async () => {
    mockPayable(1500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-o1', number: 'OVR-1', totalAmount: 500, paymentDate: '2026-08-10' }), // overdue
      poDoc({ id: 'po-o2', number: 'OVR-2', totalAmount: 400, paymentDate: null }), // overdue
      poDoc({ id: 'po-d', number: 'DATE-1', totalAmount: 600, paymentDate: '2026-08-25' }), // byDate
    ]);
    const docs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'overdue',
    });
    expect(docs.map(d => d.number).sort()).toEqual(['OVR-1', 'OVR-2']);
    expect(docs.reduce((s, d) => s + d.allocated, 0)).toBe(900); // 500 + 400
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): planned-бакет — PO поза вікном', async () => {
    mockPayable(700);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-p', number: 'PLN-1', totalAmount: 700, paymentDate: '2026-12-31' }),
    ]);
    const docs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'planned',
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].number).toBe('PLN-1');
    expect(docs[0].allocated).toBe(700);
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): КОНСИСТЕНТНІСТЬ — Σ allocated бакета == клітинка getSchedule (той самий mock)', async () => {
    // Один набір даних → викликаємо ОБИДВА методи → суми мають збігатися по кожному бакету.
    const setup = () => {
      mockPayable(1500);
      prisma.purchaseOrder.findMany.mockResolvedValueOnce([
        poDoc({ id: 'po-a', number: 'A', totalAmount: 1000, paymentDate: '2026-08-25' }),
        poDoc({ id: 'po-b', number: 'B', totalAmount: 1000, paymentDate: '2026-08-26' }),
      ]);
    };
    setup();
    const sched = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    setup();
    const docs25 = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-25',
    });
    setup();
    const docs26 = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-26',
    });
    // FIFO: 1500 → 25-го 1000 (повний PO A), 26-го 500 (частковий PO B).
    expect(docs25.reduce((s, d) => s + d.allocated, 0)).toBe(
      sched.suppliers[0].byDate['2026-08-25'],
    );
    expect(docs26.reduce((s, d) => s + d.allocated, 0)).toBe(
      sched.suppliers[0].byDate['2026-08-26'],
    );
    expect(docs25[0].allocated).toBe(1000);
    expect(docs26[0].allocated).toBe(500);
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): кредит-ліміт зменшує allocated з найпізніших', async () => {
    // borg 2000: overdue 1000 + planned 1000; ліміт 1500 з'їдає planned(1000)→0 + overdue 500.
    mockPayable(2000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-ov', number: 'OV', totalAmount: 1000, paymentDate: '2026-08-10' }), // overdue
      poDoc({ id: 'po-pl', number: 'PL', totalAmount: 1000, paymentDate: '2026-12-31' }), // planned
    ]);
    mockLimit(1500);
    const overdueDocs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'overdue',
    });
    // planned повністю з'їдено лімітом → overdue лишається 500.
    expect(overdueDocs.reduce((s, d) => s + d.allocated, 0)).toBe(500);
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): supplierId звужує запити до одного постачальника', async () => {
    mockPayable(500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-x', number: 'X', totalAmount: 500, paymentDate: '2026-08-25' }),
    ]);
    await service.getScheduleDocuments(
      ORG,
      '2026-08-20',
      '2026-09-08',
      { kind: 'date', date: '2026-08-25' },
      SUPPLIER_ID,
    );
    // orgId + supplierId у where усіх 3 запитів (tenant + звуження).
    const poWhere = prisma.purchaseOrder.findMany.mock.calls[0]![0].where;
    expect(poWhere.orgId).toBe(ORG);
    expect(poWhere.supplierId).toBe(SUPPLIER_ID);
    const saWhere = prisma.settlementAccount.findMany.mock.calls[0]![0].where;
    expect(saWhere.counterpartyId).toBe(SUPPLIER_ID);
  });

  // guards: BR-SUPPAY-010
  it('getScheduleDocuments(): борг понад ΣPO → синтетичний рядок без документа (poId порожній) в overdue', async () => {
    // payable=1200, єдиний PO на 1000 у вікні → 200 надлишку не має документа.
    const setup = () => {
      mockPayable(1200);
      prisma.purchaseOrder.findMany.mockResolvedValueOnce([
        poDoc({ id: 'po-1', number: 'ЗАМ-1', totalAmount: 1000, paymentDate: '2026-08-25' }),
      ]);
    };
    setup();
    const overdue = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'overdue',
    });
    expect(overdue).toHaveLength(1);
    expect(overdue[0].poId).toBe(''); // маркер «некликабельний» для UI
    expect(overdue[0].paymentDate).toBeNull();
    expect(overdue[0].allocated).toBe(200);

    // Синтетичний рядок не «протікає» у бакет дати реального PO.
    setup();
    const byDate = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-25',
    });
    expect(byDate.map(d => d.poId)).toEqual(['po-1']);
  });

  it('getScheduleDocuments(): from > to → BadRequestException (спільний guard)', async () => {
    await expect(
      service.getScheduleDocuments(ORG, '2026-09-01', '2026-08-30', { kind: 'overdue' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
  });

  // Take-cap: графік читає три таблиці одним Promise.all. Без верхньої межі організація з
  // десятками тисяч PO/рахунків тягнула б усе в памʼять на кожне відкриття вкладки.
  it('getSchedule(): усі три запити графіка обмежені take-cap 5000', async () => {
    await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const queries = {
      purchaseOrder: prisma.purchaseOrder.findMany,
      settlementAccount: prisma.settlementAccount.findMany,
      counterpartyContract: prisma.counterpartyContract.findMany,
    };
    const takes = Object.fromEntries(
      Object.entries(queries).map(([model, fn]) => [model, fn.mock.calls[0]![0].take]),
    );
    expect(takes).toEqual({
      purchaseOrder: 5000,
      settlementAccount: 5000,
      counterpartyContract: 5000,
    });
  });
});
