import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { CheckboxProcessor } from './checkbox.processor';
import { FiscalUnauthorizedError } from './fiscal/fiscal-provider.interface';
import { ProviderConfigService } from './provider-config.service';
import { CashShiftService } from './cash-shift.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';

/**
 * ПРРО Крок 2/registry — processor пробиває чек у ВІДКРИТУ зміну через активний FiscalProvider
 * (Bearer=cashier access-token), резолвлений з ensureToken(). Тести:
 *  - idempotency (fiscalReceiptId уже є → skip);
 *  - SKIPPED коли ПРРО не налаштовано (resolveActive→null);
 *  - MANUAL без зміни → throw (чек чекає, лишається QUEUED); AUTO_OPEN → авто-open→sell;
 *  - 401 (FiscalUnauthorizedError) від sell → refreshToken → повтор;
 *  - success → DONE; onFailed пише FAILED лише на термінальній спробі.
 */
interface CheckboxJobData {
  paymentId: string;
  orgId: string;
  branchId: string | null;
  amount: number;
  method: string;
  isCash?: boolean;
}

const makeJob = (data: Partial<CheckboxJobData> = {}, attemptsMade = 0): Job<CheckboxJobData> =>
  ({
    data: {
      paymentId: 'pay-1',
      orgId: 'org-1',
      branchId: 'br-1',
      amount: 100,
      method: 'cash',
      ...data,
    },
    attemptsMade,
    opts: { attempts: 288 },
  }) as unknown as Job<CheckboxJobData>;

describe('CheckboxProcessor (ПРРО registry — sell у зміну)', () => {
  let processor: CheckboxProcessor;

  const paymentFindFirst = vi.fn();
  const paymentUpdate = vi.fn().mockResolvedValue({});
  // Bug #713: DONE-write тепер через updateMany (CAS where fiscalReceiptId:null). SKIPPED-write
  // лишається update. Default count:1 = виграв запис.
  const paymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    payment: { findFirst: paymentFindFirst, update: paymentUpdate, updateMany: paymentUpdateMany },
  } as unknown as PrismaService;

  const resolveActive = vi.fn();
  const providerConfig = { resolveActive } as unknown as ProviderConfigService;

  // Активний провайдер (мок FiscalProvider) — sellReceipt зараз викликає processor.
  const sellReceipt = vi.fn();
  const providerMock = { code: 'checkbox', sellReceipt };
  const cfg = {
    apiUrl: 'https://api.checkbox.ua',
    credentials: { licenseKey: 'lic', pinCode: 'pin' },
  };

  const findOpenShift = vi.fn();
  const open = vi.fn();
  const ensureToken = vi.fn();
  const refreshToken = vi.fn();
  const shifts = { findOpenShift, open, ensureToken, refreshToken } as unknown as CashShiftService;

  beforeEach(async () => {
    vi.clearAllMocks();
    paymentFindFirst.mockResolvedValue({ fiscalReceiptId: null }); // ще не фіскалізовано
    resolveActive.mockResolvedValue({
      provider: 'checkbox',
      apiUrl: cfg.apiUrl,
      credentials: cfg.credentials,
      shiftMode: 'MANUAL',
    });
    findOpenShift.mockResolvedValue({ id: 'shift-1', checkboxShiftId: 'cbx-1' });
    ensureToken.mockResolvedValue({ provider: providerMock, cfg, token: 'tok' });
    sellReceipt.mockResolvedValue({ fiscalReceiptId: 'fr-1' });

    const module = await Test.createTestingModule({
      providers: [
        CheckboxProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: ProviderConfigService, useValue: providerConfig },
        { provide: CashShiftService, useValue: shifts },
        {
          provide: IntegrationLogService,
          useValue: { wrap: (_ctx: unknown, fn: () => unknown) => fn() },
        },
        { provide: DeadLetterService, useValue: { capture: vi.fn() } },
      ],
    }).compile();
    processor = module.get(CheckboxProcessor);
    // Централізований DLQ (backend #2): onFailed → deadLetterOnFailed читає this.worker.name.
    // У unit-тесті BullMQ-воркер не реєструється (WorkerHost.worker кинув би), тож підставляємо
    // легкий стаб імені черги — DeadLetterService.capture уже замокано у providers.
    (processor as unknown as { _worker: { name: string } })._worker = { name: 'checkbox' };
  });

  it('idempotency: fiscalReceiptId уже є → skip (no sell)', async () => {
    paymentFindFirst.mockResolvedValueOnce({ fiscalReceiptId: 'fr-existing' });
    await processor.process(makeJob());
    expect(sellReceipt).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('платіж не знайдено → skip (deleted/cross-tenant)', async () => {
    paymentFindFirst.mockResolvedValueOnce(null);
    await processor.process(makeJob());
    expect(sellReceipt).not.toHaveBeenCalled();
  });

  it('ПРРО не налаштовано (resolveActive→null) → SKIPPED, без sell', async () => {
    resolveActive.mockResolvedValueOnce(null);
    await processor.process(makeJob());
    expect(sellReceipt).not.toHaveBeenCalled();
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fiscalStatus: 'SKIPPED' } }),
    );
  });

  it('MANUAL без відкритої зміни → throw (чек чекає, лишається QUEUED), без sell', async () => {
    findOpenShift.mockResolvedValueOnce(null);
    await expect(processor.process(makeJob())).rejects.toThrow(/зміни/);
    expect(open).not.toHaveBeenCalled();
    expect(sellReceipt).not.toHaveBeenCalled();
  });

  it('AUTO_OPEN без зміни → авто-open → sell → DONE', async () => {
    resolveActive.mockResolvedValueOnce({
      provider: 'checkbox',
      apiUrl: cfg.apiUrl,
      credentials: cfg.credentials,
      shiftMode: 'AUTO_OPEN',
    });
    findOpenShift.mockResolvedValueOnce(null);
    open.mockResolvedValueOnce({ id: 'shift-new', checkboxShiftId: 'cbx-new' });
    await processor.process(makeJob());
    // Оплата без каси — найстаріша каса філії, як раніше (BR-CASH-027).
    expect(open).toHaveBeenCalledWith('org-1', 'br-1', undefined, undefined);
    expect(sellReceipt).toHaveBeenCalledTimes(1);
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fiscalReceiptId: 'fr-1', fiscalStatus: 'DONE' }),
      }),
    );
  });

  it('AUTO_OPEN, open падає → throw (retry)', async () => {
    resolveActive.mockResolvedValueOnce({
      provider: 'checkbox',
      apiUrl: cfg.apiUrl,
      credentials: cfg.credentials,
      shiftMode: 'AUTO_OPEN',
    });
    findOpenShift.mockResolvedValueOnce(null);
    open.mockRejectedValueOnce(new Error('ПРРО недоступний'));
    await expect(processor.process(makeJob())).rejects.toThrow(/Авто-відкриття/);
    expect(sellReceipt).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-019
  it('тип оплати — з job (isCash за довідником); job до ознаки — за кодом cash', async () => {
    await processor.process(makeJob({ method: 'CASH_DESK', isCash: true }));
    await processor.process(makeJob({ method: 'cash', isCash: false }));
    await processor.process(makeJob({ method: 'cash' }));
    expect(sellReceipt.mock.calls.map(c => (c[2] as { isCash: boolean }).isCash)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('success: sell у зміну через provider(cfg,token) → DONE + fiscalReceiptId', async () => {
    await processor.process(makeJob());
    expect(ensureToken).toHaveBeenCalledWith('org-1', 'shift-1');
    // provider.sellReceipt(cfg, token, {amount, method})
    expect(sellReceipt).toHaveBeenCalledWith(cfg, 'tok', {
      amount: 100,
      method: 'cash',
      isCash: true,
    });
    // Bug #713: CAS-write несе fiscalReceiptId:null у where → атомарний single-writer.
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', orgId: 'org-1', fiscalReceiptId: null },
      data: { fiscalReceiptId: 'fr-1', fiscalStatus: 'DONE', fiscalError: null },
    });
  });

  // Bug #713 mutation-verified: якщо CAS-write повертає count:0 (інший job уже записав чек
  // паралельно), processor НЕ кидає і НЕ перезатирає — просто логує й виходить. Без CAS
  // (plain update) БД зберегла б ID другого чека, приховавши дубль у Checkbox.
  it('Bug #713: CAS-write count:0 (паралельний чек) → не throw, не перезапис', async () => {
    paymentUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    // update (SKIPPED-шлях) НЕ викликається — жодного перезапису вже-збереженого чека.
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('401 (FiscalUnauthorizedError) від sell → refreshToken → повтор sell → DONE', async () => {
    sellReceipt
      .mockRejectedValueOnce(new FiscalUnauthorizedError('401'))
      .mockResolvedValueOnce({ fiscalReceiptId: 'fr-2' });
    refreshToken.mockResolvedValueOnce({ provider: providerMock, cfg, token: 'tok2' });
    await processor.process(makeJob());
    expect(refreshToken).toHaveBeenCalledWith('org-1', 'shift-1');
    expect(sellReceipt).toHaveBeenCalledTimes(2);
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fiscalReceiptId: 'fr-2' }) }),
    );
  });

  it('не-401 помилка sell → throw (retry), без DONE', async () => {
    sellReceipt.mockRejectedValueOnce(new Error('Checkbox 500'));
    await expect(processor.process(makeJob())).rejects.toThrow('Checkbox 500');
    expect(refreshToken).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  // Bug #707 (re-sign-in loop guard, IMPORTANT для Вчасно): якщо токен ГЕНУЇННО недійсний —
  // а Вчасно.signIn лише повертає той самий статичний токен з кредів (не обмінює) — то
  // refreshToken re-sign-in дає ТОЙ САМИЙ поганий токен → 2-й sell знову 401. Processor
  // робить РІВНО один re-sign-in+повтор (не цикл): 2-й FiscalUnauthorizedError НЕ ловиться
  // (лише перший try/catch), тож ПРОКИДАЄТЬСЯ з process() → BullMQ обмежує загальну кількість
  // спроб (opts.attempts=288). Тобто «нескінченного re-sign» немає — падає чисто й обмежено.
  it('Bug #707: 401 і ПІСЛЯ refresh знову 401 (незмінний bad-токен Вчасно) → throw, БЕЗ циклу/DONE', async () => {
    // Обидві спроби sell — 401 (статичний токен не «полагодився» re-sign-in-ом).
    sellReceipt
      .mockRejectedValueOnce(new FiscalUnauthorizedError('401'))
      .mockRejectedValueOnce(new FiscalUnauthorizedError('401 знову — токен той самий'));
    refreshToken.mockResolvedValueOnce({ provider: providerMock, cfg, token: 'same-bad-tok' });

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(FiscalUnauthorizedError);

    // РІВНО один re-sign-in і РІВНО дві спроби sell — не цикл (інакше було б >2).
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sellReceipt).toHaveBeenCalledTimes(2);
    // Чек НЕ позначено DONE (жодного payment.update у process — FAILED пише лише onFailed на
    // термінальній спробі, коли BullMQ вичерпає opts.attempts).
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('Bug #707: onFailed після вичерпання спроб на постійному 401 → FAILED (обмежено, не вічно)', async () => {
    // Симулюємо термінальну спробу BullMQ (attemptsMade сягнув opts.attempts=288) на 401-error:
    // статус стає FAILED РІВНО раз — доказ, що незмінний-токен-loop має обмежений хвіст.
    await processor.onFailed(makeJob({}, 288), new FiscalUnauthorizedError('токен недійсний'));
    expect(paymentUpdate).toHaveBeenCalledWith({
      where: { id: 'pay-1', orgId: 'org-1' },
      data: { fiscalStatus: 'FAILED', fiscalError: 'токен недійсний' },
    });
  });

  it('cashier access-token НІКОЛИ не потрапляє у лог (жоден рівень)', async () => {
    ensureToken.mockResolvedValueOnce({
      provider: providerMock,
      cfg,
      token: 'SUPER-SECRET-TOKEN-xyz',
    });
    const logged: unknown[] = [];
    const proc = processor as unknown as {
      logger: { log: unknown; debug: unknown; warn: unknown; error: unknown };
    };
    for (const lvl of ['log', 'debug', 'warn', 'error'] as const) {
      proc.logger[lvl] = (...a: unknown[]) => logged.push(...a);
    }
    await processor.process(makeJob());
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain('SUPER-SECRET-TOKEN-xyz');
    expect(logged.length).toBeGreaterThan(0);
  });

  it('401→refresh: token з refreshToken теж не логується', async () => {
    ensureToken.mockResolvedValueOnce({ provider: providerMock, cfg, token: 'first-tok-AAA' });
    refreshToken.mockResolvedValueOnce({ provider: providerMock, cfg, token: 'refreshed-tok-BBB' });
    sellReceipt
      .mockRejectedValueOnce(new FiscalUnauthorizedError('401'))
      .mockResolvedValueOnce({ fiscalReceiptId: 'fr-9' });
    const logged: unknown[] = [];
    const proc = processor as unknown as {
      logger: { log: unknown; debug: unknown; warn: unknown; error: unknown };
    };
    for (const lvl of ['log', 'debug', 'warn', 'error'] as const) {
      proc.logger[lvl] = (...a: unknown[]) => logged.push(...a);
    }
    await processor.process(makeJob());
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain('first-tok-AAA');
    expect(dump).not.toContain('refreshed-tok-BBB');
  });

  describe('onFailed: FAILED лише на термінальній спробі', () => {
    it('проміжна спроба (attemptsMade < attempts) → payment.update НЕ викликано', async () => {
      await processor.onFailed(makeJob({}, 5), new Error('rej'));
      expect(paymentUpdate).not.toHaveBeenCalled();
    });

    it('термінальна (attemptsMade >= attempts) → FAILED + fiscalError', async () => {
      await processor.onFailed(makeJob({}, 288), new Error('остаточна помилка'));
      expect(paymentUpdate).toHaveBeenCalledWith({
        where: { id: 'pay-1', orgId: 'org-1' },
        data: { fiscalStatus: 'FAILED', fiscalError: 'остаточна помилка' },
      });
    });

    it('fiscalError обрізається до 500 символів', async () => {
      await processor.onFailed(makeJob({}, 288), new Error('x'.repeat(1000)));
      const data = paymentUpdate.mock.calls[0][0].data;
      expect(data.fiscalError.length).toBe(500);
    });
  });

  // Зміна — своя в кожної фіскальної каси: чек готівкової оплати йде в зміну її каси, а не в
  // будь-яку OPEN-зміну філії; авто-відкриття — саме цієї каси (TECH-DEBT §10.19).
  describe('зміна за касою оплати (BR-CASH-027)', () => {
    const autoOpen = () =>
      resolveActive.mockResolvedValueOnce({
        provider: 'checkbox',
        apiUrl: cfg.apiUrl,
        credentials: cfg.credentials,
        shiftMode: 'AUTO_OPEN',
      });
    const viaRegister = (over: Record<string, unknown> = {}) =>
      paymentFindFirst.mockResolvedValueOnce({
        fiscalReceiptId: null,
        reversedAt: null,
        cashRegister: { id: 'reg-b', branchId: 'br-1', isFiscal: true, deletedAt: null, ...over },
      });

    // guards: BR-CASH-027
    it('оплата через фіскальну касу → findOpenShift із касою оплати, чек у її зміну', async () => {
      viaRegister();
      findOpenShift.mockResolvedValueOnce({ id: 'shift-b', checkboxShiftId: 'cbx-b' });
      await processor.process(makeJob());
      expect(findOpenShift).toHaveBeenCalledWith('org-1', 'br-1', 'reg-b');
      expect(ensureToken).toHaveBeenCalledWith('org-1', 'shift-b');
      expect(sellReceipt).toHaveBeenCalledTimes(1);
    });

    // guards: BR-CASH-027
    it('AUTO_OPEN без зміни каси → відкривається саме каса оплати', async () => {
      autoOpen();
      viaRegister();
      findOpenShift.mockResolvedValueOnce(null);
      open.mockResolvedValueOnce({ id: 'shift-b', checkboxShiftId: 'cbx-b' });
      await processor.process(makeJob());
      expect(open).toHaveBeenCalledWith('org-1', 'br-1', undefined, 'reg-b');
      expect(ensureToken).toHaveBeenCalledWith('org-1', 'shift-b');
    });

    // guards: BR-CASH-027
    it('MANUAL: зміна каси оплати закрита → чек чекає, навіть коли інша каса філії відкрита', async () => {
      viaRegister();
      // findOpenShift з касою повертає null — зміна іншої каси сюди не потрапляє.
      findOpenShift.mockImplementationOnce((_o: string, _b: string, reg?: string) =>
        Promise.resolve(reg ? null : { id: 'shift-a', checkboxShiftId: 'cbx-a' }),
      );
      await expect(processor.process(makeJob())).rejects.toThrow(/зміни/);
      expect(sellReceipt).not.toHaveBeenCalled();
    });

    // guards: BR-CASH-027
    it('філія — та, де стоїть каса: наряд іншої філії чи оплата без наряду не змінюють зміну', async () => {
      viaRegister({ branchId: 'br-cash' });
      await processor.process(makeJob({ branchId: null }));
      expect(resolveActive).toHaveBeenCalledWith('org-1', 'br-cash', 'FISCAL');
      expect(findOpenShift).toHaveBeenCalledWith('org-1', 'br-cash', 'reg-b');
    });

    // guards: BR-CASH-027
    it('оплата без каси (картка, QR) → зміна й авто-відкриття за філією, як раніше', async () => {
      autoOpen();
      paymentFindFirst.mockResolvedValueOnce({
        fiscalReceiptId: null,
        reversedAt: null,
        cashRegister: null,
      });
      findOpenShift.mockResolvedValueOnce(null);
      open.mockResolvedValueOnce({ id: 'shift-x', checkboxShiftId: 'cbx-x' });
      await processor.process(makeJob());
      expect(findOpenShift).toHaveBeenCalledWith('org-1', 'br-1', undefined);
      expect(open).toHaveBeenCalledWith('org-1', 'br-1', undefined, undefined);
    });

    // guards: BR-CASH-027
    // Оплата без каси й без наряду (job.branchId=null): філії немає ні з каси, ні з наряду.
    // Зміну «будь-якої філії» не шукаємо й навмання не відкриваємо — чек чекає (throw → retry).
    // Mutation-verify (review 2026-10-23): кликати findOpenShift/open без філії → кейс червоний.
    it('оплата без каси й без наряду → зміну не шукає й не відкриває, чек чекає (retry)', async () => {
      autoOpen();
      paymentFindFirst.mockResolvedValueOnce({
        fiscalReceiptId: null,
        reversedAt: null,
        cashRegister: null,
      });
      await expect(processor.process(makeJob({ branchId: null }))).rejects.toThrow(/зміни/);
      expect(resolveActive).toHaveBeenCalledWith('org-1', null, 'FISCAL');
      expect(findOpenShift).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(sellReceipt).not.toHaveBeenCalled();
    });

    // guards: BR-CASH-027
    it('AUTO_OPEN: відкрити зміну каси оплати не вдалось → throw для BullMQ retry, без sell', async () => {
      autoOpen();
      viaRegister();
      findOpenShift.mockResolvedValueOnce(null);
      open.mockRejectedValueOnce(new Error('ПРРО недоступний'));
      await expect(processor.process(makeJob())).rejects.toThrow(/Авто-відкриття/);
      expect(open).toHaveBeenCalledWith('org-1', 'br-1', undefined, 'reg-b');
      expect(sellReceipt).not.toHaveBeenCalled();
    });

    // guards: BR-CASH-027
    it('оплата через НЕфіскальну касу → за філією (у нефіскальної каси змін немає)', async () => {
      viaRegister({ isFiscal: false, branchId: 'br-cash' });
      await processor.process(makeJob());
      expect(findOpenShift).toHaveBeenCalledWith('org-1', 'br-1', undefined);
    });
  });
});

// Конфіг воркера живе в декораторі `@Processor('checkbox', { concurrency })` і не проходить крізь
// жоден виклик process() — без цього сторожа зміна числа не валила жодного тесту. Читаємо метадані,
// які @nestjs/bullmq кладе на клас і з яких потім будує Worker (ключі — bull.constants.js пакета).
describe('CheckboxProcessor — конфіг воркера (метадані @Processor)', () => {
  it("слухає чергу 'checkbox'", () => {
    expect(Reflect.getMetadata('bullmq:processor_metadata', CheckboxProcessor)).toEqual({
      name: 'checkbox',
    });
  });

  it('concurrency = 3 — кожен job це мережевий виклик ПРРО до 15 с: число обмежує паралелізм (rate-limit ліцензії) і дренить чергу ~3× швидше', () => {
    expect(Reflect.getMetadata('bullmq:worker_metadata', CheckboxProcessor)).toEqual({
      concurrency: 3,
    });
  });
});
