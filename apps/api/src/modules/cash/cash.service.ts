import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, CashOperationReason, Prisma } from '@prisma/client';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { type Money, money, moneyFromDecimal } from '../../common/utils/money';
import { kyivDayRangeFilter } from '../../common/utils/kyiv-date';
import { searchContains } from '../../common/utils/like-pattern';
import { uniqueDefinedIds } from '../../common/utils/linked-counts';
import { isSerializationConflict } from '../../common/utils/prisma-errors';
import { CashOperationResponseDto, type CashOperationReversalRefDto } from './cash.dto';

// Знак операції для балансу: IN додає готівку (+), OUT — віднімає (−). Баланс рахується
// SQL-агрегатами (Σ IN − Σ OUT) у computeBalance для ефективності — ця мапа документує конвенцію.

// Параметри створення операції — спільний вхід для ручних (контролер) і авто (payments/payroll) операцій.
export interface CreateCashOperationInput {
  cashRegisterId: string;
  direction: CashDirection;
  amount: number;
  reason: CashOperationReason;
  expenseCategoryId?: string | null;
  /**
   * true — рядок свідомо БЕЗ статті: стаття, закріплена за приводом (BR-CASH-022), не
   * підставляється. Для руху власних грошей, який не є ні доходом, ні витратою (готівка, знята
   * з банківського рахунку, BR-BANK-034).
   */
  withoutCategory?: boolean;
  counterpartyId?: string | null;
  employeeId?: string | null;
  documentType?: string | null;
  documentId?: string | null;
  /** Документ-підстава (наряд / замовлення постачальнику) — не платіжний документ рядка. */
  baseDocumentType?: string | null;
  baseDocumentId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  /**
   * Сума в базовій валюті й курс, які рядок бере ГОТОВИМИ замість курсу «зараз». Задає сторно
   * (BR-CASH-023): воно дзеркалить оригінал за його курсом — курс, доданий чи виправлений після
   * оригіналу, не має лишити різниці в базовій валюті.
   */
  conversion?: { rateUsed: number; amountBase: number } | null;
  /**
   * Рядок-сторно: id рядка, який він сторнує (BR-CASH-023). Стаття тоді береться як є — без
   * перевірки напряму й активності: сторно повторює рядок оригіналу, а не вибирає нову статтю.
   * `reversalOfId` унікальний у базі — друге сторно того самого рядка дає 400.
   */
  reversalOfId?: string | null;
}

/**
 * «Додатки касового рядка»: те, що каса (`CashDeskService`) знає про операцію, а сервіс оплат —
 * ні. Передаються ВНУТРІШНІМ параметром у `PaymentsService.create` і
 * `SupplierPaymentsService.confirm`, щоб єдиний рядок каси ніс їх одразу: журнал лише
 * дописується (BR-CASH-002), дописати статтю чи підставу пізніше нічим.
 */
export interface CashOperationExtras {
  expenseCategoryId?: string | null;
  baseDocumentType?: string | null;
  baseDocumentId?: string | null;
  notes?: string | null;
}

// Пошук історії за назвою контрагента: у CashOperation контрагент — лише id без зв'язку в схемі,
// тому спершу шукаємо контрагентів за назвою, потім рядки за їхніми id. Стеля — щоб запит
// «а» не розгорнувся у список id на всю базу контрагентів.
const COUNTERPARTY_SEARCH_LIMIT = 500;

type CashOperationRow = Prisma.CashOperationGetPayload<{
  include: { expenseCategory: { select: { name: true } } };
}>;

/**
 * Каса — рух готівки. CashService.createOperation — ЄДИНА точка руху (аналог
 * SettlementsService.createTransaction): append-only CashOperation, atomic, приймає зовнішній tx.
 * Фіскальна каса (isFiscal) → операція лише у відкриту зміну (cashShiftId). Нефіскальна → без зміни.
 * Баланс = initialBalance + Σ(CASH_SIGN*amount).
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  /**
   * Створити касову операцію. amount>0, знак із direction. Для фіскальної каси знаходить відкриту
   * зміну (кидає 400, якщо немає). Викликається з контролера (ручні) і з payments/payroll (авто, tx).
   */
  async createOperation(
    orgId: string,
    input: CreateCashOperationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CashOperationResponseDto> {
    const amount = money(input.amount);
    if (!(amount > 0))
      throw new BadRequestException(translateError('err.cash.amountMustBePositive', getLocale()));

    const db = tx ?? this.prisma;

    const register = await db.cashRegister.findFirst({
      where: { id: input.cashRegisterId, orgId, deletedAt: null },
      select: { id: true, isFiscal: true, branchId: true, currencyId: true },
    });
    if (!register)
      throw new NotFoundException(translateError('err.cashRegister.notFound', getLocale()));

    // Мультивалюта (Фаза 1): amountBase у базовій валюті org по курсу на дату операції. Валюта —
    // з каси (моно-валютна). Базова каса → rate=1, base=amount; інша валюта без курсу на дату → 400.
    // Сторно приносить курс оригіналу (`conversion`) — тоді курс не шукаємо.
    const conv =
      input.conversion ??
      (await this.exchangeRates.resolveBaseConversion(
        orgId,
        register.currencyId,
        new Date(),
        amount,
      ));

    const expenseCategoryId = input.reversalOfId
      ? (input.expenseCategoryId ?? null)
      : await this.resolveCategoryId(orgId, input, db);

    // Фіскальна каса → потрібна відкрита зміна цієї каси.
    let cashShiftId: string | null = null;
    if (register.isFiscal) {
      const shift = await db.cashShift.findFirst({
        where: { orgId, cashRegisterId: register.id, status: 'OPEN', deletedAt: null },
        select: { id: true },
      });
      if (!shift)
        throw new BadRequestException(
          translateError('err.cash.shiftRequiredForFiscal', getLocale()),
        );
      cashShiftId = shift.id;
    }

    const run = async (client: Prisma.TransactionClient) => {
      // Overdraft-guard: OUT не може вигнати касу в мінус. Баланс читаємо ТИМ САМИМ client, що й
      // insert нижче — тож multi-OUT в одній tx (payroll: OUT на співробітника) враховує вже-списане
      // цієї транзакції. Толеранс −0.001 лишається: з Money обидва операнди кратні копійці й
      // похибки вже немає, але поріг також поглинає легітимну копійчану різницю — знімати його
      // означало б змінити поведінку guard-а, а не прибрати мертвий код.
      if (input.direction === 'OUT') {
        // Черга видач однієї каси. Зовнішня транзакція викликача (проведення оплати постачальнику,
        // виплата зарплати) зазвичай ReadCommitted: дві одночасні видачі обидві читали той самий
        // залишок і обидві проходили — каса йшла в мінус (review 2026-10-14, наживо: дві оплати
        // різним постачальникам по 60 при залишку 100 → −20). Блокування живе до кінця транзакції;
        // друга видача чекає й читає залишок уже з першою. У власній Serializable-транзакції воно
        // зайве, але не шкодить: там конфлікт ловить SSI.
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-register:${register.id}`}))`;
        const balance = await this.getBalance(orgId, register.id, client);
        if (balance - amount < -0.001) {
          throw new BadRequestException(
            // Суми — у валюті каси (каса моно-валютна), тож без хардкоду ₴ (каса може бути USD/EUR).
            translateError('err.cash.insufficientCash', getLocale(), {
              available: balance,
              required: amount,
            }),
          );
        }
      }
      const op = await client.cashOperation.create({
        data: {
          orgId,
          cashRegisterId: register.id,
          cashShiftId,
          direction: input.direction,
          amount,
          amountBase: conv.amountBase,
          rateUsed: conv.rateUsed,
          reason: input.reason,
          expenseCategoryId,
          counterpartyId: input.counterpartyId ?? null,
          employeeId: input.employeeId ?? null,
          documentType: input.documentType ?? null,
          documentId: input.documentId ?? null,
          baseDocumentType: input.baseDocumentType ?? null,
          baseDocumentId: input.baseDocumentId ?? null,
          notes: input.notes ?? null,
          createdBy: input.createdBy ?? null,
          reversalOfId: input.reversalOfId ?? null,
        },
        include: { expenseCategory: { select: { name: true } } },
      });
      return op;
    };

    // Зовнішній tx: guard читає його ж стан (викликач керує isolation). Без tx: власна Serializable
    // транзакція — Postgres SSI ловить конкурентний OUT, що прочитав той самий залишок (Bug #416
    // патерн invoices). Конфлікт серіалізації (на запиті чи на COMMIT) → зрозуміла 400 замість 500.
    let op: Awaited<ReturnType<typeof run>>;
    try {
      op = tx
        ? await run(tx)
        : await this.prisma.$transaction(run, {
            timeout: TRANSACTION_TIMEOUT_MS,
            isolationLevel: 'Serializable',
          });
    } catch (e) {
      if (isSerializationConflict(e)) {
        throw new BadRequestException(translateError('err.cash.concurrentOperation', getLocale()));
      }
      // Єдиний унікальний ключ рядка, окрім id, — `reversalOfId`: паралельне сторно того самого
      // рядка вже записане (BR-CASH-023).
      if (
        input.reversalOfId &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException(translateError('err.cash.alreadyReversed', getLocale()));
      }
      throw e;
    }

    // Аудит (поза tx щоб не подовжувати транзакцію; best-effort).
    if (input.createdBy) {
      this.audit
        .record(orgId, 'CashOperation', op.id, 'CREATE', input.createdBy, undefined, {
          direction: input.direction,
          amount,
          reason: input.reason,
          ...(input.reversalOfId && { reversalOfId: input.reversalOfId }),
        })
        .catch(() => undefined);
    }
    return toCashOperationDto(op);
  }

  /**
   * Стаття руху коштів рядка. Задана — мусить існувати в org, бути активною й відповідати напряму
   * (OUT лише EXPENSE, IN лише INCOME — інакше звітність по статтях бреше). Не задана — береться
   * активна стаття, за якою закріплено привід операції (BR-CASH-022); такої немає — без статті.
   */
  private async resolveCategoryId(
    orgId: string,
    input: Pick<
      CreateCashOperationInput,
      'expenseCategoryId' | 'direction' | 'reason' | 'withoutCategory'
    >,
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<string | null> {
    const expected = input.direction === 'IN' ? 'INCOME' : 'EXPENSE';
    if (!input.expenseCategoryId) {
      if (input.withoutCategory) return null;
      // `type` у where — запобіжник: привід закріплюють лише за статтею свого напряму, але авто-
      // викликач може передати привід з іншим напрямом, і тоді стаття не підходить.
      const byReason = await db.expenseCategory.findFirst({
        where: {
          orgId,
          defaultReason: input.reason,
          type: expected,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true },
      });
      return byReason?.id ?? null;
    }
    const cat = await db.expenseCategory.findFirst({
      where: { id: input.expenseCategoryId, orgId, deletedAt: null },
      select: { type: true, isActive: true },
    });
    if (!cat) throw new NotFoundException(translateError('err.cash.categoryNotFound', getLocale()));
    // Bug #735: вимкнена стаття (isActive=false, напр. після toggleActive гілки) не має
    // приймати НОВІ операції — інакше вона «архівована» лише в UI, а пряме API її пропускає,
    // спотворюючи звітність по активних статтях. Історичні операції лишаються недоторканими.
    if (!cat.isActive)
      throw new BadRequestException(translateError('err.cash.categoryInactive', getLocale()));
    if (cat.type !== expected) {
      throw new BadRequestException(
        input.direction === 'IN'
          ? translateError('err.cash.categoryTypeIncome', getLocale())
          : translateError('err.cash.categoryTypeExpense', getLocale()),
      );
    }
    return input.expenseCategoryId;
  }

  /**
   * Поточний залишок каси = initialBalance + Σ(sign*amount). `db` — опційний tx-client: коли
   * передано, агрегація бачить незакомічені операції ТІЄЇ Ж транзакції (потрібно overdraft-guard-у
   * у createOperation, де multi-OUT списуються в одну tx і кожен наступний OUT має враховувати
   * попередні). Без `db` — звичайне читання поза транзакцією.
   */
  async getBalance(
    orgId: string,
    cashRegisterId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Money> {
    const register = await db.cashRegister.findFirst({
      where: { id: cashRegisterId, orgId, deletedAt: null },
      select: { initialBalance: true },
    });
    if (!register)
      throw new NotFoundException(translateError('err.cashRegister.notFound', getLocale()));
    return this.computeBalance(
      orgId,
      cashRegisterId,
      moneyFromDecimal(register.initialBalance),
      db,
    );
  }

  /**
   * Пакетний розрахунок балансів кількох кас ОДНИМ запитом (замість N×getBalance = 3×N запитів).
   * `initials` — мапа cashRegisterId → initialBalance (виклик уже має її з кешованого DTO, тож
   * реєстри не перечитуються). Один `groupBy` по (cashRegisterId, direction) з `cashRegisterId IN
   * [ids]` замінює 2×N агрегацій. Семантика ІДЕНТИЧНА getBalance: initial + Σ(IN) − Σ(OUT), money().
   * Пустий вхід → пуста мапа (0 запитів). Каси без операцій отримують чистий initialBalance.
   */
  async getBalances(orgId: string, initials: Map<string, number>): Promise<Map<string, Money>> {
    const ids = [...initials.keys()];
    const result = new Map<string, Money>();
    if (ids.length === 0) return result;
    const grouped = await this.prisma.cashOperation.groupBy({
      by: ['cashRegisterId', 'direction'],
      where: { orgId, cashRegisterId: { in: ids } },
      _sum: { amount: true },
    });
    // sign*amount акумулятор на реєстр (IN +, OUT −). Акумулятор — сирий number:
    // округлення раз у кінці (money() нижче), а не покроково.
    const deltas = new Map<string, number>();
    for (const g of grouped) {
      const sum = moneyFromDecimal(g._sum.amount);
      // `sum * -1`, а не `-sum`: унарний мінус до Money заборонений лінтом
      // (no-unsafe-unary-minus) — заперечення не зберігає інваріант бренду.
      const signed = g.direction === 'IN' ? sum : sum * -1;
      deltas.set(g.cashRegisterId, (deltas.get(g.cashRegisterId) ?? 0) + signed);
    }
    for (const [id, initial] of initials) {
      result.set(id, money(initial + (deltas.get(id) ?? 0)));
    }
    return result;
  }

  private async computeBalance(
    orgId: string,
    cashRegisterId: string,
    initial: number,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Money> {
    const [inAgg, outAgg] = await Promise.all([
      db.cashOperation.aggregate({
        where: { orgId, cashRegisterId, direction: 'IN' },
        _sum: { amount: true },
      }),
      db.cashOperation.aggregate({
        where: { orgId, cashRegisterId, direction: 'OUT' },
        _sum: { amount: true },
      }),
    ]);
    const inSum = moneyFromDecimal(inAgg._sum.amount);
    const outSum = moneyFromDecimal(outAgg._sum.amount);
    return money(initial + inSum - outSum);
  }

  async listOperations(
    orgId: string,
    cashRegisterId: string,
    limit?: number,
    filters: { q?: string; dateFrom?: string; dateTo?: string } = {},
  ): Promise<CashOperationResponseDto[]> {
    // Відбір за київським днем операції; пошук — за приміткою, статтею або назвою контрагента.
    const createdAt = kyivDayRangeFilter(filters.dateFrom, filters.dateTo);
    // limit приходить із query-рядка без DTO: `?limit=abc` давав NaN, а `take: NaN` Prisma
    // відхиляє (безіменний 400 «Некоректний запит»); від'ємне число вона читає як «останні N».
    // Усе, що не є додатним числом, — типові 100; стеля 500 лишається.
    const take =
      limit !== undefined && Number.isFinite(limit) && limit >= 1
        ? Math.min(Math.trunc(limit), 500)
        : 100;
    const contains = searchContains(filters.q);
    const counterpartyIds = contains ? await this.findCounterpartyIdsByName(orgId, contains) : [];
    const ops = await this.prisma.cashOperation.findMany({
      where: {
        orgId,
        cashRegisterId,
        ...(createdAt && { createdAt }),
        ...(contains && {
          OR: [
            { notes: contains },
            { expenseCategory: { name: contains } },
            ...(counterpartyIds.length ? [{ counterpartyId: { in: counterpartyIds } }] : []),
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: { expenseCategory: { select: { name: true } } },
    });
    return this.toHistoryDtos(orgId, ops);
  }

  /**
   * Один рядок журналу каси у формі рядка історії (назви, номери, сторно) — відповідь маршрутів,
   * що створюють рядок (сторно, BR-CASH-023). 404, якщо рядка в цій касі немає.
   */
  async getHistoryRow(
    orgId: string,
    cashRegisterId: string,
    operationId: string,
  ): Promise<CashOperationResponseDto> {
    const op = await this.prisma.cashOperation.findFirst({
      where: { id: operationId, orgId, cashRegisterId },
      include: { expenseCategory: { select: { name: true } } },
    });
    if (!op) throw new NotFoundException(translateError('err.cash.operationNotFound', getLocale()));
    const [row] = await this.toHistoryDtos(orgId, [op]);
    return row;
  }

  private async findCounterpartyIdsByName(
    orgId: string,
    contains: { contains: string; mode: 'insensitive' },
  ): Promise<string[]> {
    // Без `deletedAt: null` свідомо: історія каси показує й операції з видаленим контрагентом.
    const found = await this.prisma.counterparty.findMany({
      where: {
        orgId,
        OR: [{ companyName: contains }, { lastName: contains }, { firstName: contains }],
      },
      select: { id: true },
      take: COUNTERPARTY_SEARCH_LIMIT,
    });
    return found.map(c => c.id);
  }

  /**
   * Рядки журналу → рядки історії: назви контрагента й працівника, номер підстави, номер оплати
   * постачальнику, фіскальний статус оплати клієнта, сторно рядка (`reversedBy`, BR-CASH-023).
   * Пакетно — по одному запиту на вид довідки
   * для всієї сторінки (без N+1); вид без жодного id на сторінці не запитується взагалі.
   * Назви беремо й у видалених: історія не має втрачати підпис через пізніше видалення картки.
   */
  private async toHistoryDtos(
    orgId: string,
    ops: CashOperationRow[],
  ): Promise<CashOperationResponseDto[]> {
    const idsOf = (pick: (o: CashOperationRow) => string | null) => uniqueDefinedIds(ops.map(pick));
    const documentIds = (type: string) =>
      idsOf(o => (o.documentType === type ? o.documentId : null));
    const baseIds = (type: string) =>
      idsOf(o => (o.baseDocumentType === type ? o.baseDocumentId : null));

    const counterpartyIds = idsOf(o => o.counterpartyId);
    const employeeIds = idsOf(o => o.employeeId);
    const workOrderIds = baseIds('WorkOrder');
    const purchaseOrderIds = baseIds('PurchaseOrder');
    const paymentIds = documentIds('Payment');
    const supplierPaymentIds = documentIds('SupplierPayment');

    const opIds = ops.map(o => o.id);

    const [
      counterparties,
      employees,
      workOrders,
      purchaseOrders,
      payments,
      supplierPayments,
      reversals,
    ] = await Promise.all([
      counterpartyIds.length
        ? this.prisma.counterparty.findMany({
            where: { id: { in: counterpartyIds }, orgId },
            select: { id: true, firstName: true, lastName: true, companyName: true },
          })
        : [],
      employeeIds.length
        ? this.prisma.employee.findMany({
            where: { id: { in: employeeIds }, orgId },
            select: { id: true, firstName: true, lastName: true },
          })
        : [],
      workOrderIds.length
        ? this.prisma.workOrder.findMany({
            where: { id: { in: workOrderIds }, orgId },
            select: { id: true, number: true },
          })
        : [],
      purchaseOrderIds.length
        ? this.prisma.purchaseOrder.findMany({
            where: { id: { in: purchaseOrderIds }, orgId },
            select: { id: true, number: true },
          })
        : [],
      paymentIds.length
        ? this.prisma.payment.findMany({
            where: { id: { in: paymentIds }, orgId },
            select: { id: true, fiscalStatus: true },
          })
        : [],
      supplierPaymentIds.length
        ? this.prisma.supplierPayment.findMany({
            where: { id: { in: supplierPaymentIds }, orgId },
            select: { id: true, number: true },
          })
        : [],
      // Сторно рядків сторінки: рядок оригіналу не змінюється (журнал лише дописується), тож
      // «сторновано» видно лише через рядок, що посилається на нього (`reversalOfId` унікальний).
      opIds.length
        ? this.prisma.cashOperation.findMany({
            where: { orgId, reversalOfId: { in: opIds } },
            select: { id: true, reversalOfId: true, createdAt: true, notes: true },
          })
        : [],
    ]);

    const counterpartyName = new Map(
      counterparties.map(c => [c.id, formatPersonName(c.lastName, c.firstName, c.companyName)]),
    );
    const employeeName = new Map(
      employees.map(e => [e.id, formatPersonName(e.lastName, e.firstName)]),
    );
    const baseNumber = new Map([...workOrders, ...purchaseOrders].map(d => [d.id, d.number]));
    const fiscalStatus = new Map(payments.map(p => [p.id, p.fiscalStatus]));
    const supplierPaymentNumber = new Map(supplierPayments.map(p => [p.id, p.number]));
    const reversedBy = new Map<string, CashOperationReversalRefDto>();
    for (const r of reversals) {
      if (r.reversalOfId) {
        reversedBy.set(r.reversalOfId, {
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          reason: r.notes,
        });
      }
    }

    return ops.map(o => ({
      ...toCashOperationDto(o),
      counterpartyName: (o.counterpartyId && counterpartyName.get(o.counterpartyId)) || null,
      employeeName: (o.employeeId && employeeName.get(o.employeeId)) || null,
      baseDocumentNumber: (o.baseDocumentId && baseNumber.get(o.baseDocumentId)) || null,
      documentNumber:
        (o.documentType === 'SupplierPayment' &&
          o.documentId &&
          supplierPaymentNumber.get(o.documentId)) ||
        null,
      // Рядок сторно несе той самий платіжний документ, але чек належить оригіналу.
      fiscalStatus:
        (!o.reversalOfId &&
          o.documentType === 'Payment' &&
          o.documentId &&
          fiscalStatus.get(o.documentId)) ||
        null,
      reversedBy: reversedBy.get(o.id) ?? null,
    }));
  }
}

/**
 * Рядок журналу каси → DTO: суми числами, дата в ISO, назва статті з довідника. Чиста функція —
 * нею користується й каса-диригент (`CashDeskService`) для рядка, який написав сервіс оплат.
 */
export function toCashOperationDto(o: {
  id: string;
  cashRegisterId: string;
  cashShiftId: string | null;
  direction: CashDirection;
  amount: Prisma.Decimal;
  amountBase?: Prisma.Decimal | null;
  rateUsed?: Prisma.Decimal | null;
  reason: CashOperationReason;
  expenseCategoryId: string | null;
  counterpartyId: string | null;
  employeeId: string | null;
  documentType: string | null;
  documentId: string | null;
  baseDocumentType?: string | null;
  baseDocumentId?: string | null;
  reversalOfId?: string | null;
  notes: string | null;
  createdAt: Date;
  expenseCategory?: { name: string } | null;
}): CashOperationResponseDto {
  return {
    id: o.id,
    cashRegisterId: o.cashRegisterId,
    cashShiftId: o.cashShiftId,
    direction: o.direction,
    amount: Number(o.amount),
    amountBase: o.amountBase != null ? Number(o.amountBase) : null,
    rateUsed: o.rateUsed != null ? Number(o.rateUsed) : null,
    reason: o.reason,
    expenseCategoryId: o.expenseCategoryId,
    expenseCategoryName: o.expenseCategory?.name ?? null,
    counterpartyId: o.counterpartyId,
    employeeId: o.employeeId,
    documentType: o.documentType,
    documentId: o.documentId,
    baseDocumentType: o.baseDocumentType ?? null,
    baseDocumentId: o.baseDocumentId ?? null,
    reversalOfId: o.reversalOfId ?? null,
    notes: o.notes,
    createdAt: o.createdAt.toISOString(),
  };
}
