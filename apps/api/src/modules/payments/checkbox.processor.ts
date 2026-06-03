import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { validatePublicUrl } from '../../common/utils/url-guard';

interface FiscalReceiptJob {
  paymentId: string;
  orgId: string;
  branchId: string | null;
  amount: number;
  method: string;
}

@Processor('checkbox')
export class CheckboxProcessor {
  private readonly logger = new Logger(CheckboxProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  // concurrency: 3 — each fiscal-receipt job makes a 15s network call to Checkbox API.
  // Without concurrency the single-threaded Bull worker serializes jobs: 100 receipts ≈ 1500s.
  // concurrency: 3 caps parallelism to respect Checkbox's per-licence rate limits while
  // still draining the queue ~3× faster. Paired with AbortController timeout (15s) above.
  @Process({ name: 'fiscal-receipt', concurrency: 3 })
  async handleFiscalReceipt(job: Job<FiscalReceiptJob>) {
    const { paymentId, orgId, branchId, amount, method } = job.data;

    // Load branch settings to get Checkbox credentials — scoped to the specific branch
    const branchSettings = await this.prisma.branchSettings.findFirst({
      where: branchId ? { orgId, branchId } : { orgId },
    });

    if (!branchSettings?.checkboxLicenseKey || !branchSettings?.fiscalEnabled) {
      this.logger.debug(`Checkbox не налаштовано для org=${orgId}, пропускаємо`);
      return;
    }

    const apiUrl = branchSettings.checkboxApiUrl ?? 'https://api.checkbox.ua';

    // SSRF defense-in-depth: even an OWNER/ADMIN must not be able to point the Checkbox
    // API URL at internal services (Redis/Postgres/cloud-metadata). The settings DTO
    // accepts arbitrary strings — re-validate here at delivery time and fail fast.
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) {
      this.logger.warn(`Checkbox API URL для org=${orgId} відхилено: ${urlError}`);
      throw new Error(`Невалідний Checkbox API URL: ${urlError}`);
    }

    // Call Checkbox API.
    // SSRF defense-in-depth #2: `redirect: 'manual'`. Без цього атакувальник з OWNER/ADMIN
    // правом може поставити checkboxApiUrl на свій external host, який відповідає
    // 302 Location: http://169.254.169.254/... → fetch (default redirect: 'follow') слідує
    // у cloud metadata всередині privately-routed VPC, обходячи validatePublicUrl на оригіналі.
    // Парний патерн з webhooks.processor.ts:82.
    // Offline-first timeout: 15s — без abort signal зависле з'єднання блокує всю чергу
    // (ПРРО налаштовано на 288 retry × exponential backoff, але тільки якщо ми ВИЙШЛИ з fetch).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/v1/receipts/sell`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${branchSettings.checkboxLicenseKey}`,
          'Content-Type': 'application/json',
          'X-License-Key': branchSettings.checkboxLicenseKey,
        },
        body: JSON.stringify({
          goods: [
            {
              good: { name: 'Послуги автосервісу', price: Math.round(amount * 100) },
              quantity: 1000,
            },
          ],
          payments: [
            { type: method === 'cash' ? 'CASH' : 'CASHLESS', value: Math.round(amount * 100) },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Bug #273: any 3xx with redirect: 'manual' MUST be rejected — Checkbox API never
    // returns 3xx on a sell endpoint; if it does, treat as suspicious tampering.
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `Checkbox API повернув перенаправлення ${response.status} — підозріла поведінка, запит відхилено`,
      );
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Checkbox API error ${response.status}: ${err}`);
    }

    const receipt = (await response.json()) as { id?: string; fiscal_code?: string };
    const fiscalReceiptId = receipt.id ?? receipt.fiscal_code;

    await this.prisma.payment.update({
      where: { id: paymentId, orgId },
      data: { fiscalReceiptId },
    });

    this.logger.log(`Фіскальний чек ${fiscalReceiptId} для платежу ${paymentId}`);
  }
}
