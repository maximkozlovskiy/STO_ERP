import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OnlinePaymentService } from './online-payment.service';

/**
 * QR-оплата monobank — OnlinePaymentService.createIntent (MONEY-critical). 0 тестів на файл.
 * Доводимо:
 *  - рахунок не SENT/PARTIALLY_PAID → 400 (оплата неможлива).
 *  - overpay (amount > remaining) → 400.
 *  - немає monobankToken (еквайринг не налаштовано) → 400.
 *  - happy: intent PENDING створено ПЕРШИМ → monobank.createInvoice → pageUrl → poll-job enqueued.
 *  - monobank.createInvoice throws → intent → FAILED + throw + poll-job НЕ enqueued (ordering!).
 *  - amount default = remaining (amount-Number(paidAmount)); cents = Math.round(amount*100).
 *  - getIntent orgId-scoped; НЕ повертає monobankToken.
 */
describe('OnlinePaymentService.createIntent (QR monobank)', () => {
  let service: OnlinePaymentService;
  let prisma: {
    invoice: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn> };
    branchSettings: { findFirst: ReturnType<typeof vi.fn> };
    onlinePaymentIntent: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
  let monobank: { createInvoice: ReturnType<typeof vi.fn> };
  let pollQueue: { add: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const INV_ID = '33333333-3333-4333-8333-333333333333';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const INTENT_ID = 'intent-abc';

  beforeEach(() => {
    prisma = {
      invoice: { findFirst: vi.fn() },
      workOrder: { findFirst: vi.fn() },
      branchSettings: { findFirst: vi.fn() },
      onlinePaymentIntent: {
        create: vi.fn().mockResolvedValue({ id: INTENT_ID }),
        update: vi.fn().mockResolvedValue({
          id: INTENT_ID,
          status: 'PENDING',
          pageUrl: 'https://pay.mono/x',
          amount: 500,
          paymentId: null,
          error: null,
        }),
        findFirst: vi.fn(),
      },
    };
    monobank = {
      createInvoice: vi
        .fn()
        .mockResolvedValue({ gatewayInvoiceId: 'gw-1', pageUrl: 'https://pay.mono/x' }),
    };
    pollQueue = { add: vi.fn().mockResolvedValue(undefined) };
    service = new OnlinePaymentService(prisma as never, monobank as never, pollQueue as never);
  });

  const sentInvoice = (over: Record<string, unknown> = {}) => ({
    counterpartyId: CP_ID,
    workOrderId: null,
    amount: 500,
    paidAmount: 0,
    status: 'SENT',
    ...over,
  });

  it('рахунок не знайдено → NotFound', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(service.createIntent(ORG, { invoiceId: INV_ID })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('рахунок у статусі DRAFT → 400 (оплата неможлива)', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice({ status: 'DRAFT' }));
    await expect(service.createIntent(ORG, { invoiceId: INV_ID })).rejects.toThrow(
      /оплата неможлива/,
    );
  });

  it('рахунок PAID → 400', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice({ status: 'PAID' }));
    await expect(service.createIntent(ORG, { invoiceId: INV_ID })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('PARTIALLY_PAID дозволено (не кидає на статусі)', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      sentInvoice({ status: 'PARTIALLY_PAID', paidAmount: 200 }),
    );
    prisma.branchSettings.findFirst.mockResolvedValue({
      monobankToken: 'T',
      monobankApiUrl: null,
    });
    const dto = await service.createIntent(ORG, { invoiceId: INV_ID });
    expect(dto.status).toBe('PENDING');
    // remaining = 500 - 200 = 300 → cents 30000
    expect(monobank.createInvoice.mock.calls[0][2].amountCents).toBe(30000);
  });

  it('overpay (amount > remaining) → 400', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice());
    await expect(service.createIntent(ORG, { invoiceId: INV_ID, amount: 600 })).rejects.toThrow(
      /перевищує залишок/,
    );
  });

  it('amount <= 0 (немає залишку) → 400', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice({ paidAmount: 500 }));
    await expect(service.createIntent(ORG, { invoiceId: INV_ID })).rejects.toThrow(/Немає залишку/);
  });

  it('немає monobankToken → 400 (еквайринг не налаштовано); intent НЕ створюється; monobank НЕ викликається', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice());
    prisma.branchSettings.findFirst.mockResolvedValue({ monobankToken: null });
    await expect(service.createIntent(ORG, { invoiceId: INV_ID })).rejects.toThrow(
      /не налаштовано/,
    );
    expect(prisma.onlinePaymentIntent.create).not.toHaveBeenCalled();
    expect(monobank.createInvoice).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('happy: intent PENDING створено ПЕРШИМ → monobank → pageUrl → poll enqueued', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice());
    prisma.branchSettings.findFirst.mockResolvedValue({
      monobankToken: 'MERCH',
      monobankApiUrl: 'https://api.monobank.ua',
    });

    const dto = await service.createIntent(ORG, { invoiceId: INV_ID });

    // intent створено з orgId, PENDING, amount, reference-стабільним id.
    const createArg = prisma.onlinePaymentIntent.create.mock.calls[0][0];
    expect(createArg.data.orgId).toBe(ORG);
    expect(createArg.data.status).toBe('PENDING');
    expect(createArg.data.amount).toBe(500);
    expect(createArg.data.counterpartyId).toBe(CP_ID);
    expect(createArg.data.expiresAt).toBeInstanceOf(Date);

    // monobank викликано з cents=Math.round(500*100), reference=intent.id.
    const [apiUrl, token, params] = monobank.createInvoice.mock.calls[0];
    expect(apiUrl).toBe('https://api.monobank.ua');
    expect(token).toBe('MERCH');
    expect(params.amountCents).toBe(50000);
    expect(params.reference).toBe(INTENT_ID);

    // poll-job enqueued з jobId-дедупом.
    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = pollQueue.add.mock.calls[0];
    expect(jobName).toBe('poll');
    expect(jobData).toEqual({ intentId: INTENT_ID, orgId: ORG });
    expect(jobOpts.jobId).toBe(`payment-poll-${INTENT_ID}`);

    expect(dto.pageUrl).toBe('https://pay.mono/x');
    expect(dto.status).toBe('PENDING');
  });

  it('ORDERING: intent створюється ПЕРЕД monobank.createInvoice', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice());
    prisma.branchSettings.findFirst.mockResolvedValue({ monobankToken: 'T', monobankApiUrl: null });
    const order: string[] = [];
    prisma.onlinePaymentIntent.create.mockImplementation(async () => {
      order.push('create-intent');
      return { id: INTENT_ID };
    });
    monobank.createInvoice.mockImplementation(async () => {
      order.push('monobank');
      return { gatewayInvoiceId: 'gw', pageUrl: 'p' };
    });
    await service.createIntent(ORG, { invoiceId: INV_ID });
    expect(order).toEqual(['create-intent', 'monobank']);
  });

  it('monobank.createInvoice throws → intent → FAILED + throw + poll НЕ enqueued', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice());
    prisma.branchSettings.findFirst.mockResolvedValue({ monobankToken: 'T', monobankApiUrl: null });
    monobank.createInvoice.mockRejectedValue(new Error('gateway 500'));

    await expect(service.createIntent(ORG, { invoiceId: INV_ID })).rejects.toThrow(
      /не вдалося створити рахунок/,
    );

    // intent переведено у FAILED з error.
    const updArg = prisma.onlinePaymentIntent.update.mock.calls.find(
      (c: [{ data?: { status?: string } }]) => c[0]?.data?.status === 'FAILED',
    );
    expect(updArg).toBeTruthy();
    expect(updArg![0].data.error).toContain('gateway 500');
    // MONEY-critical ordering: poll-job НІКОЛИ не ставиться коли gateway впав.
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('createIntent scope-ить invoice по orgId', async () => {
    prisma.invoice.findFirst.mockResolvedValue(sentInvoice());
    prisma.branchSettings.findFirst.mockResolvedValue({ monobankToken: 'T', monobankApiUrl: null });
    await service.createIntent(ORG, { invoiceId: INV_ID });
    expect(prisma.invoice.findFirst.mock.calls[0][0].where).toMatchObject({
      id: INV_ID,
      orgId: ORG,
      deletedAt: null,
    });
  });

  describe('getIntent', () => {
    it('orgId-scoped; НЕ повертає monobankToken/секрети', async () => {
      prisma.onlinePaymentIntent.findFirst.mockResolvedValue({
        id: INTENT_ID,
        status: 'PAID',
        pageUrl: 'https://pay.mono/x',
        amount: 500,
        paymentId: 'pay-1',
        error: null,
      });
      const dto = await service.getIntent(ORG, INTENT_ID);
      expect(prisma.onlinePaymentIntent.findFirst.mock.calls[0][0].where).toMatchObject({
        id: INTENT_ID,
        orgId: ORG,
        deletedAt: null,
      });
      // select не тягне monobankToken; DTO не має жодного секрет-поля.
      const selectKeys = Object.keys(prisma.onlinePaymentIntent.findFirst.mock.calls[0][0].select);
      expect(selectKeys).not.toContain('monobankToken');
      expect(Object.keys(dto)).toEqual(['id', 'status', 'pageUrl', 'amount', 'paymentId', 'error']);
      expect(JSON.stringify(dto)).not.toContain('monobankToken');
    });

    it('намір не знайдено → NotFound', async () => {
      prisma.onlinePaymentIntent.findFirst.mockResolvedValue(null);
      await expect(service.getIntent(ORG, INTENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
