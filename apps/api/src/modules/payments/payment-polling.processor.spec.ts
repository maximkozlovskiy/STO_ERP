import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { PaymentPollingProcessor } from './payment-polling.processor';

/**
 * QR-оплата monobank — PaymentPollingProcessor (MONEY-CRITICAL, 0 тестів на файл).
 * Доводимо once-only + crash-recovery + термінальні стани + tenant isolation:
 *  - paid + PENDING → CAS count=1 → payments.create РІВНО один раз + paymentId set.
 *  - конкурентний 2-й poll → CAS count=0 → payments.create НЕ викликається (no double Payment).
 *  - crash-recovery: intent уже PAID + paymentId=null → finalize створює Payment (review-fix).
 *  - idempotency: PAID + paymentId set → no-op.
 *  - finalize failure → PAID+error + re-enqueue до MAX_FINALIZE_ATTEMPTS, далі стоп.
 *  - MONEY: create вдалося але link-write впав → повторний reconcile НЕ подвоює Payment.
 *  - term-стани: failed→FAILED, expired→EXPIRED, wall-clock past→EXPIRED без monobank, pending→re-enqueue.
 *  - tenant: CAS updateMany + усі intent-запити несуть orgId.
 */

const MAX_FINALIZE_ATTEMPTS = 360;
const MAX_POLL_ATTEMPTS = 1_440;

function makeJob(data: {
  intentId: string;
  orgId: string;
  finalizeAttempts?: number;
  pollAttempts?: number;
}): Job<typeof data> {
  return { data } as Job<typeof data>;
}

describe('PaymentPollingProcessor (QR monobank polling)', () => {
  let processor: PaymentPollingProcessor;
  let prisma: {
    onlinePaymentIntent: {
      findFirst: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    payment: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn> };
  };
  let gatewayImpl: { getStatus: ReturnType<typeof vi.fn> };
  let gateways: { get: ReturnType<typeof vi.fn> };
  let providerConfig: { resolveByCode: ReturnType<typeof vi.fn> };
  let payments: { create: ReturnType<typeof vi.fn> };
  let pollQueue: { add: ReturnType<typeof vi.fn> };
  // Аліас для читабельності старих assert-ів (тепер це gateway з registry).
  let monobank: { getStatus: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const INTENT_ID = 'intent-1';
  const CP_ID = 'cp-1';
  const INV_ID = 'inv-1';

  const paidIntentSnapshot = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING',
    gateway: 'monobank',
    gatewayInvoiceId: 'gw-1',
    expiresAt: new Date(Date.now() + 60_000),
    counterpartyId: CP_ID,
    invoiceId: INV_ID,
    amount: 500,
    workOrderId: null,
    paymentId: null,
    ...over,
  });

  beforeEach(() => {
    prisma = {
      onlinePaymentIntent: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      // За замовч. немає наявного Payment для наміру (перший finalize).
      payment: { findFirst: vi.fn().mockResolvedValue(null) },
      workOrder: { findFirst: vi.fn() },
    };
    gatewayImpl = { getStatus: vi.fn() };
    monobank = gatewayImpl; // старі assert-и звертаються до monobank.getStatus
    gateways = { get: vi.fn().mockReturnValue(gatewayImpl) };
    providerConfig = {
      resolveByCode: vi.fn().mockResolvedValue({
        provider: 'monobank',
        apiUrl: null,
        credentials: { token: 'T' },
        shiftMode: 'MANUAL',
      }),
    };
    payments = { create: vi.fn().mockResolvedValue({ id: 'pay-1' }) };
    pollQueue = { add: vi.fn().mockResolvedValue(undefined) };
    processor = new PaymentPollingProcessor(
      prisma as never,
      gateways as never,
      providerConfig as never,
      payments as never,
      pollQueue as never,
      { wrap: (_c: unknown, fn: () => unknown) => fn() } as never,
    );
  });

  it('intent видалено → стоп (return, нічого не робимо)', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(null);
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(monobank.getStatus).not.toHaveBeenCalled();
    expect(payments.create).not.toHaveBeenCalled();
  });

  // ── once-only + CAS ──────────────────────────────────────────────────────────
  it('paid + PENDING → CAS count=1 → payments.create РІВНО один раз + paymentId set', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'paid', raw: 'success' });
    prisma.onlinePaymentIntent.updateMany.mockResolvedValue({ count: 1 });

    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));

    // CAS PENDING→PAID з orgId.
    expect(prisma.onlinePaymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG, status: 'PENDING' },
      data: { status: 'PAID' },
    });
    // Payment створено РІВНО один раз, з idempotency-лінком на намір.
    expect(payments.create).toHaveBeenCalledTimes(1);
    expect(payments.create).toHaveBeenCalledWith(ORG, {
      counterpartyId: CP_ID,
      invoiceId: INV_ID,
      amount: 500,
      method: 'monobank_qr',
      onlinePaymentIntentId: INTENT_ID,
    });
    // paymentId залінковано.
    expect(prisma.onlinePaymentIntent.update).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG },
      data: { paymentId: 'pay-1', error: null },
    });
  });

  it('конкурентний 2-й poll: paid але CAS count=0 → payments.create НЕ викликається (no double)', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'paid', raw: 'success' });
    prisma.onlinePaymentIntent.updateMany.mockResolvedValue({ count: 0 }); // інший poll виграв

    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));

    expect(payments.create).not.toHaveBeenCalled();
    // MUTATION-VERIFY: якщо прибрати `if (won.count === 0) return` — цей assert впаде
    // (Payment створився б удруге).
  });

  // ── crash-recovery (review-fix) ──────────────────────────────────────────────
  it('crash-recovery: intent уже PAID + paymentId=null → finalize створює Payment', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ status: 'PAID', paymentId: null }),
    );

    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));

    // monobank НЕ опитується — намір уже PAID, лише доводимо Payment.
    expect(monobank.getStatus).not.toHaveBeenCalled();
    // CAS НЕ повторюється (вже PAID).
    expect(prisma.onlinePaymentIntent.updateMany).not.toHaveBeenCalled();
    // Payment створено (гроші у gateway є — не можна лишати без Payment).
    expect(payments.create).toHaveBeenCalledTimes(1);
    expect(prisma.onlinePaymentIntent.update).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG },
      data: { paymentId: 'pay-1', error: null },
    });
    // MUTATION-VERIFY: якщо прибрати reconcile-гілку (рядок `if (intent.status === 'PAID')`) —
    // process робив би early-return на `status !== PENDING` → Payment НІКОЛИ не створився б → гроші втрачено.
  });

  it('idempotent: PAID + paymentId set → no-op (жодного другого Payment)', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ status: 'PAID', paymentId: 'pay-existing' }),
    );
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(payments.create).not.toHaveBeenCalled();
    expect(monobank.getStatus).not.toHaveBeenCalled();
  });

  // ── Bug #688: idempotency-лінк проти double-charge ───────────────────────────
  it('Bug #688: reconcile після create-succeeds-link-fails → наявний Payment ЗНАЙДЕНО, create НЕ повторюється (no double-charge)', async () => {
    // Вікно збою: попередній finalize створив Payment (onlinePaymentIntentId=intentId), але
    // link-write paymentId упав → intent досі PAID+paymentId=null. Наступний poll:
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ status: 'PAID', paymentId: null }),
    );
    // У БД ВЖЕ є Payment для цього наміру.
    prisma.payment.findFirst.mockResolvedValue({ id: 'pay-existing' });

    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));

    // create НЕ викликається — знайдено наявний.
    expect(payments.create).not.toHaveBeenCalled();
    // існуючий Payment до-лінковано.
    expect(prisma.onlinePaymentIntent.update).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG },
      data: { paymentId: 'pay-existing', error: null },
    });
    // MUTATION-VERIFY: прибрати pre-create `payment.findFirst` guard → create викликається →
    // другий Payment → double-charge → цей assert падає.
    // Пошук scoped по orgId + onlinePaymentIntentId.
    expect(prisma.payment.findFirst.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      onlinePaymentIntentId: INTENT_ID,
    });
  });

  it('Bug #688: P2002 на create (гонка) → дістає наявний Payment і лінкує (не помилка, не дубль)', async () => {
    const { Prisma } = await import('@prisma/client');
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'paid', raw: 'success' });
    prisma.onlinePaymentIntent.updateMany.mockResolvedValue({ count: 1 });
    // pre-check не бачить (гонка), create кидає P2002, повторний findFirst бачить winner.
    prisma.payment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pay-race-winner' });
    payments.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '5',
      }),
    );

    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));

    // намір залінковано на winner, error очищено — не re-enqueue, не термінальна помилка.
    expect(prisma.onlinePaymentIntent.update).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG },
      data: { paymentId: 'pay-race-winner', error: null },
    });
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  // ── finalize failure → re-enqueue + cap ──────────────────────────────────────
  it('finalize failure → PAID+error + re-enqueue з finalizeAttempts+1', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'paid', raw: 'success' });
    prisma.onlinePaymentIntent.updateMany.mockResolvedValue({ count: 1 });
    payments.create.mockRejectedValue(new Error('invoice overpaid'));

    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));

    // error записано (PAID лишається — НЕ відкат).
    const errUpd = prisma.onlinePaymentIntent.update.mock.calls.find(
      (c: [{ data?: { error?: string } }]) => typeof c[0]?.data?.error === 'string',
    );
    expect(errUpd![0].data.error).toContain('Payment не створено');
    // re-enqueue з finalizeAttempts=1.
    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    expect(pollQueue.add.mock.calls[0][1]).toEqual({
      intentId: INTENT_ID,
      orgId: ORG,
      finalizeAttempts: 1,
    });
  });

  it('finalize failure на останній спробі (MAX) → стоп, НЕ re-enqueue', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ status: 'PAID', paymentId: null }),
    );
    payments.create.mockRejectedValue(new Error('permanent'));

    await processor.process(
      makeJob({ intentId: INTENT_ID, orgId: ORG, finalizeAttempts: MAX_FINALIZE_ATTEMPTS }),
    );

    // next = MAX+1 > MAX → лишаємо PAID+error, НЕ ставимо новий job.
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  // ── термінальні стани ────────────────────────────────────────────────────────
  it('monobank failed → CAS FAILED', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'failed', raw: 'failure' });
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(prisma.onlinePaymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Оплату відхилено' },
    });
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('monobank expired → CAS EXPIRED', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'expired', raw: 'expired' });
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(prisma.onlinePaymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG, status: 'PENDING' },
      data: { status: 'EXPIRED', error: 'Час на оплату вичерпано' },
    });
  });

  it('wall-clock expiresAt у минулому → EXPIRED БЕЗ виклику monobank', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(monobank.getStatus).not.toHaveBeenCalled();
    expect(prisma.onlinePaymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG, status: 'PENDING' },
      data: { status: 'EXPIRED', error: 'Час на оплату вичерпано' },
    });
  });

  it('pending → re-enqueue poll (jobId-дедуп) + pollAttempts+1', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'pending', raw: 'processing' });
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG, pollAttempts: 5 }));
    expect(payments.create).not.toHaveBeenCalled();
    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    expect(pollQueue.add.mock.calls[0][2].jobId).toBe(`payment-poll-${INTENT_ID}`);
    // F2: лічильник опитувань інкрементиться → стеля колись спрацює навіть без expiresAt.
    expect(pollQueue.add.mock.calls[0][1].pollAttempts).toBe(6);
  });

  it('F2: pollAttempts ≥ MAX + без expiresAt → EXPIRED, НЕ re-enqueue (стеля-запобіжник)', async () => {
    // Намір без expiresAt (wall-clock guard не спрацює), шлюз навічно pending.
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot({ expiresAt: null }));
    monobank.getStatus.mockResolvedValue({ status: 'pending', raw: 'processing' });

    await processor.process(
      makeJob({ intentId: INTENT_ID, orgId: ORG, pollAttempts: MAX_POLL_ATTEMPTS }),
    );

    // Стеля досягнута → EXPIRED, gateway НЕ опитується, poll НЕ переставляється.
    expect(monobank.getStatus).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
    expect(prisma.onlinePaymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG, status: 'PENDING' },
      data: { status: 'EXPIRED', error: 'Час на оплату вичерпано (стеля опитувань)' },
    });
    // MUTATION-VERIFY: прибрати F2-гілку `pollAttempts >= MAX_POLL_ATTEMPTS` → intent без expiresAt
    // опитувався б вічно (getStatus викликається, poll re-enqueue) → ці assert-и падають.
  });

  it('термінальний FAILED вже у БД → стоп (не опитуємо)', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ status: 'FAILED' }),
    );
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(monobank.getStatus).not.toHaveBeenCalled();
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('немає gatewayInvoiceId → стоп (нема що опитувати)', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ gatewayInvoiceId: null }),
    );
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(monobank.getStatus).not.toHaveBeenCalled();
  });

  it('шлюз більше не налаштовано (config зник) → FAILED', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    providerConfig.resolveByCode.mockResolvedValue(null);
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(prisma.onlinePaymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: INTENT_ID, orgId: ORG, status: 'PENDING' },
      data: { status: 'FAILED', error: 'Платіжний шлюз більше не налаштовано' },
    });
  });

  // ── tenant isolation ─────────────────────────────────────────────────────────
  it('усі intent-запити несуть orgId (findFirst + CAS)', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(paidIntentSnapshot());
    monobank.getStatus.mockResolvedValue({ status: 'paid', raw: 'success' });
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    expect(prisma.onlinePaymentIntent.findFirst.mock.calls[0][0].where).toMatchObject({
      id: INTENT_ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(prisma.onlinePaymentIntent.updateMany.mock.calls[0][0].where.orgId).toBe(ORG);
    // MUTATION-VERIFY: якщо прибрати orgId з CAS where — крос-tenant intent був би переведений.
  });

  it('workOrder-branch: провайдер резолвиться по branchId наряду + intent.gateway', async () => {
    prisma.onlinePaymentIntent.findFirst.mockResolvedValue(
      paidIntentSnapshot({ workOrderId: 'wo-1' }),
    );
    prisma.workOrder.findFirst.mockResolvedValue({ branchId: 'branch-9' });
    monobank.getStatus.mockResolvedValue({ status: 'pending', raw: 'created' });
    await processor.process(makeJob({ intentId: INTENT_ID, orgId: ORG }));
    // workOrder lookup несе orgId.
    expect(prisma.workOrder.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'wo-1',
      orgId: ORG,
    });
    // resolveByCode(orgId, branchId, 'PAYMENT', intent.gateway)
    expect(providerConfig.resolveByCode).toHaveBeenCalledWith(
      ORG,
      'branch-9',
      'PAYMENT',
      'monobank',
    );
  });
});
