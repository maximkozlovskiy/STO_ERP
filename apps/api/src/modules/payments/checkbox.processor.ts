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

  @Process('fiscal-receipt')
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

    // Call Checkbox API
    const response = await fetch(`${apiUrl}/api/v1/receipts/sell`, {
      method: 'POST',
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
    });

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
