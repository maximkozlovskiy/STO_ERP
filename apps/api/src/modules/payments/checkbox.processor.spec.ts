import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Job } from 'bullmq';
import { CheckboxProcessor } from './checkbox.processor';
import { CheckboxClient, CheckboxUnauthorizedError } from './checkbox.client';
import { CashShiftService } from './cash-shift.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ПРРО Крок 2 — processor пробиває чек у ВІДКРИТУ зміну через CheckboxClient (Bearer=cashier
 * access-token), а не license-key. Тести:
 *  - idempotency (fiscalReceiptId уже є → skip);
 *  - SKIPPED коли ПРРО вимкнено;
 *  - MANUAL без зміни → throw (чек чекає, лишається QUEUED); AUTO_OPEN → авто-open→sell;
 *  - 401 від sell → refreshToken → повтор;
 *  - success → DONE; onFailed пише FAILED лише на термінальній спробі.
 */
interface CheckboxJobData {
  paymentId: string;
  orgId: string;
  branchId: string | null;
  amount: number;
  method: string;
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

describe('CheckboxProcessor (ПРРО Крок 2 — sell у зміну)', () => {
  let processor: CheckboxProcessor;

  const paymentFindFirst = vi.fn();
  const paymentUpdate = vi.fn().mockResolvedValue({});
  const branchSettingsFindFirst = vi.fn();
  const prisma = {
    payment: { findFirst: paymentFindFirst, update: paymentUpdate },
    branchSettings: { findFirst: branchSettingsFindFirst },
  } as unknown as PrismaService;

  const sellReceipt = vi.fn();
  const checkbox = { sellReceipt } as unknown as CheckboxClient;

  const findOpenShift = vi.fn();
  const open = vi.fn();
  const ensureToken = vi.fn();
  const refreshToken = vi.fn();
  const shifts = { findOpenShift, open, ensureToken, refreshToken } as unknown as CashShiftService;

  beforeEach(async () => {
    vi.clearAllMocks();
    paymentFindFirst.mockResolvedValue({ fiscalReceiptId: null }); // ще не фіскалізовано
    branchSettingsFindFirst.mockResolvedValue({
      fiscalEnabled: true,
      checkboxLicenseKey: 'lic',
      shiftMode: 'MANUAL',
    });
    findOpenShift.mockResolvedValue({ id: 'shift-1', checkboxShiftId: 'cbx-1' });
    ensureToken.mockResolvedValue({ apiUrl: 'https://api.checkbox.ua', token: 'tok' });
    sellReceipt.mockResolvedValue({ fiscalReceiptId: 'fr-1' });

    const module = await Test.createTestingModule({
      providers: [
        CheckboxProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: CheckboxClient, useValue: checkbox },
        { provide: CashShiftService, useValue: shifts },
      ],
    }).compile();
    processor = module.get(CheckboxProcessor);
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

  it('ПРРО вимкнено (fiscalEnabled=false) → SKIPPED, без sell', async () => {
    branchSettingsFindFirst.mockResolvedValueOnce({
      fiscalEnabled: false,
      checkboxLicenseKey: 'lic',
      shiftMode: 'MANUAL',
    });
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
    branchSettingsFindFirst.mockResolvedValueOnce({
      fiscalEnabled: true,
      checkboxLicenseKey: 'lic',
      shiftMode: 'AUTO_OPEN',
    });
    findOpenShift.mockResolvedValueOnce(null);
    open.mockResolvedValueOnce({ id: 'shift-new', checkboxShiftId: 'cbx-new' });
    await processor.process(makeJob());
    expect(open).toHaveBeenCalledWith('org-1', 'br-1');
    expect(sellReceipt).toHaveBeenCalledTimes(1);
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fiscalReceiptId: 'fr-1', fiscalStatus: 'DONE' }),
      }),
    );
  });

  it('AUTO_OPEN, open падає → throw (retry)', async () => {
    branchSettingsFindFirst.mockResolvedValueOnce({
      fiscalEnabled: true,
      checkboxLicenseKey: 'lic',
      shiftMode: 'AUTO_OPEN',
    });
    findOpenShift.mockResolvedValueOnce(null);
    open.mockRejectedValueOnce(new Error('ПРРО недоступний'));
    await expect(processor.process(makeJob())).rejects.toThrow(/Авто-відкриття/);
    expect(sellReceipt).not.toHaveBeenCalled();
  });

  it('success: sell у зміну → DONE + fiscalReceiptId (Bearer=token, не license-key)', async () => {
    await processor.process(makeJob());
    expect(ensureToken).toHaveBeenCalledWith('org-1', 'shift-1');
    expect(sellReceipt).toHaveBeenCalledWith('https://api.checkbox.ua', 'tok', {
      amount: 100,
      method: 'cash',
    });
    expect(paymentUpdate).toHaveBeenCalledWith({
      where: { id: 'pay-1', orgId: 'org-1' },
      data: { fiscalReceiptId: 'fr-1', fiscalStatus: 'DONE', fiscalError: null },
    });
  });

  it('401 від sell → refreshToken → повтор sell → DONE', async () => {
    sellReceipt
      .mockRejectedValueOnce(new CheckboxUnauthorizedError('401'))
      .mockResolvedValueOnce({ fiscalReceiptId: 'fr-2' });
    refreshToken.mockResolvedValueOnce({ apiUrl: 'https://api.checkbox.ua', token: 'tok2' });
    await processor.process(makeJob());
    expect(refreshToken).toHaveBeenCalledWith('org-1', 'shift-1');
    expect(sellReceipt).toHaveBeenCalledTimes(2);
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fiscalReceiptId: 'fr-2' }) }),
    );
  });

  it('не-401 помилка sell → throw (retry), без DONE', async () => {
    sellReceipt.mockRejectedValueOnce(new Error('Checkbox 500'));
    await expect(processor.process(makeJob())).rejects.toThrow('Checkbox 500');
    expect(refreshToken).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it('cashier access-token НІКОЛИ не потрапляє у лог (жоден рівень)', async () => {
    // Секрет-token не повинен витікати у логи (спостережувані у продакшні). Мокаємо ВСІ рівні
    // логера і доводимо, що жоден аргумент лог-виклику не містить значення токена.
    ensureToken.mockResolvedValueOnce({
      apiUrl: 'https://api.checkbox.ua',
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
    // sanity: щось усе-таки залоговано (success-лог), тобто перевірка не пуста
    expect(logged.length).toBeGreaterThan(0);
  });

  it('401→refresh: token з refreshToken теж не логується', async () => {
    ensureToken.mockResolvedValueOnce({
      apiUrl: 'https://api.checkbox.ua',
      token: 'first-tok-AAA',
    });
    refreshToken.mockResolvedValueOnce({
      apiUrl: 'https://api.checkbox.ua',
      token: 'refreshed-tok-BBB',
    });
    sellReceipt
      .mockRejectedValueOnce(new CheckboxUnauthorizedError('401'))
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
});
