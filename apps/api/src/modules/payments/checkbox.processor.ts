import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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

    // Call Checkbox API
    const response = await fetch(`${apiUrl}/api/v1/receipts/sell`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${branchSettings.checkboxLicenseKey}`,
        'Content-Type': 'application/json',
        'X-License-Key': branchSettings.checkboxLicenseKey,
      },
      body: JSON.stringify({
        goods: [{ good: { name: 'Послуги автосервісу', price: Math.round(amount * 100) }, quantity: 1000 }],
        payments: [{ type: method === 'cash' ? 'CASH' : 'CASHLESS', value: Math.round(amount * 100) }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Checkbox API error ${response.status}: ${err}`);
    }

    const receipt = await response.json();
    const fiscalReceiptId = receipt.id ?? receipt.fiscal_code;

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { fiscalReceiptId },
    });

    this.logger.log(`Фіскальний чек ${fiscalReceiptId} для платежу ${paymentId}`);
  }
}
