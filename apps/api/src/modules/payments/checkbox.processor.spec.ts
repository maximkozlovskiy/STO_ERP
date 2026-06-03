import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Job } from 'bull';
import { CheckboxProcessor } from './checkbox.processor';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #273 — regression guard for the Checkbox fiscal-receipt processor.
 *
 * Cycle 5 review (649a5db) added validatePublicUrl re-check at delivery time to
 * block OWNER/ADMIN-supplied internal URLs (validatePublicUrl rejects
 * 127.0.0.1 / link-local / RFC1918). Cycle 5 tester (THIS spec) adds the
 * SECOND security layer that was missing:
 *
 *   redirect: 'manual' + reject any 3xx response.
 *
 * Without that guard, an attacker with OWNER role could:
 *   1. Set checkboxApiUrl = "https://attacker.com"
 *      (legit external host — passes validatePublicUrl)
 *   2. Their server returns `302 Location: http://169.254.169.254/...`
 *      (AWS cloud metadata) or `http://10.0.0.1/...` (LAN-reachable Redis)
 *   3. Default node fetch follows redirect → POST with Authorization header
 *      lands inside the privately-routed VPC.
 *
 * Paired pattern: webhooks.processor.spec.ts:106 ("redirect handling").
 */

interface CheckboxJobData {
  paymentId: string;
  orgId: string;
  branchId: string | null;
  amount: number;
  method: string;
}

const makeJob = (data: Partial<CheckboxJobData> = {}): Job<CheckboxJobData> =>
  ({
    data: {
      paymentId: 'pay-1',
      orgId: 'org-1',
      branchId: 'br-1',
      amount: 100,
      method: 'cash',
      ...data,
    },
    attemptsMade: 0,
  }) as unknown as Job<CheckboxJobData>;

const makePrismaMock = () => ({
  branchSettings: {
    findFirst: vi.fn(),
  },
  payment: {
    findFirst: vi.fn().mockResolvedValue({ fiscalReceiptId: null }), // default: not yet fiscalized
    update: vi.fn().mockResolvedValue({}),
  },
});

describe('CheckboxProcessor.handleFiscalReceipt', () => {
  let processor: CheckboxProcessor;
  let prisma: ReturnType<typeof makePrismaMock>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module = await Test.createTestingModule({
      providers: [CheckboxProcessor, { provide: PrismaService, useValue: prisma }],
    }).compile();
    processor = module.get(CheckboxProcessor);
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('Bug #346: idempotency guard (fiscalReceiptId already set → skip)', () => {
    it('пропускає зовнішній виклик якщо fiscalReceiptId вже встановлено', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce({ fiscalReceiptId: 'fr-existing' });

      await expect(processor.handleFiscalReceipt(makeJob())).resolves.toBeUndefined();

      // Must NOT call Checkbox API or update payment
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('пропускає якщо платіж не знайдено (deleted / cross-tenant)', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce(null);

      await expect(processor.handleFiscalReceipt(makeJob())).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('продовжує до API якщо fiscalReceiptId = null', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce({ fiscalReceiptId: null });
      prisma.branchSettings.findFirst.mockResolvedValue({
        checkboxLicenseKey: null,
        fiscalEnabled: false,
      });

      // branchSettings → skip path (fiscalEnabled:false), но fetch НЕ викликається
      await expect(processor.handleFiscalReceipt(makeJob())).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Bug #273: redirect handling (SSRF defense-in-depth #2)', () => {
    beforeEach(() => {
      prisma.branchSettings.findFirst.mockResolvedValue({
        checkboxLicenseKey: 'key-1',
        fiscalEnabled: true,
        checkboxApiUrl: 'https://api.checkbox.ua',
      });
    });

    it('викликає fetch з redirect: "manual"', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'fr-1' }), { status: 200 }));

      await processor.handleFiscalReceipt(makeJob());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      expect(init).toMatchObject({ redirect: 'manual' });
    });

    it('302 → throw "перенаправлення" + НЕ оновлює payment (BullMQ retry на наступну спробу)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        }),
      );

      await expect(processor.handleFiscalReceipt(makeJob())).rejects.toThrow(/перенаправлення/);

      // No payment update — fiscal receipt MUST NOT be set when redirect blocked
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('301 теж блокується (permanent redirect)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 301,
          headers: { Location: 'http://internal.local/' },
        }),
      );
      await expect(processor.handleFiscalReceipt(makeJob())).rejects.toThrow(/перенаправлення/);
    });

    it('200 OK — payment.update викликається з fiscalReceiptId', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'fr-99' }), { status: 200 }),
      );

      await processor.handleFiscalReceipt(makeJob({ paymentId: 'pay-99' }));

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-99', orgId: 'org-1' },
        data: { fiscalReceiptId: 'fr-99' },
      });
    });
  });

  describe('Bug #273: SSRF URL guard pre-flight (cycle 5 review 649a5db)', () => {
    it('відхиляє loopback URL у checkboxApiUrl до fetch', async () => {
      prisma.branchSettings.findFirst.mockResolvedValue({
        checkboxLicenseKey: 'key-1',
        fiscalEnabled: true,
        checkboxApiUrl: 'http://127.0.0.1:8080',
      });

      await expect(processor.handleFiscalReceipt(makeJob())).rejects.toThrow(
        /Невалідний Checkbox API URL/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('відхиляє cloud-metadata URL (169.254.169.254) у checkboxApiUrl', async () => {
      prisma.branchSettings.findFirst.mockResolvedValue({
        checkboxLicenseKey: 'key-1',
        fiscalEnabled: true,
        checkboxApiUrl: 'http://169.254.169.254/latest/meta-data',
      });

      await expect(processor.handleFiscalReceipt(makeJob())).rejects.toThrow(
        /Невалідний Checkbox API URL/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('skip-paths (offline-first invariant)', () => {
    it('checkbox не налаштовано → пропускає, не throw', async () => {
      prisma.branchSettings.findFirst.mockResolvedValue({
        checkboxLicenseKey: null,
        fiscalEnabled: true,
        checkboxApiUrl: 'https://api.checkbox.ua',
      });
      await expect(processor.handleFiscalReceipt(makeJob())).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fiscalEnabled=false → пропускає, не throw', async () => {
      prisma.branchSettings.findFirst.mockResolvedValue({
        checkboxLicenseKey: 'key-1',
        fiscalEnabled: false,
        checkboxApiUrl: 'https://api.checkbox.ua',
      });
      await expect(processor.handleFiscalReceipt(makeJob())).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
