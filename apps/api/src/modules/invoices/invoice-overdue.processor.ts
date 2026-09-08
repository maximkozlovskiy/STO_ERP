import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { kyivToday } from '../../common/utils/kyiv-date';

interface OverdueJob {
  orgId: string;
}

/**
 * Позначає прострочені рахунки OVERDUE: SENT/PARTIALLY_PAID з dueDate < сьогодні (Kyiv).
 * Системний фоновий перехід — виконується прямим updateMany (оминає FSM transition(), як інші
 * processor'и, що пишуть статус). FSM-мапа INV_TRANSITIONS лишається для РУЧНИХ endpoint.
 * Ідемпотентний: повторний прогін не чіпає вже-OVERDUE (не у SENT/PARTIALLY_PAID) чи оплачені.
 */
@Injectable()
@Processor('invoice-overdue', { concurrency: 1 })
export class InvoiceOverdueProcessor extends WorkerHost {
  private readonly logger = new Logger(InvoiceOverdueProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<OverdueJob>): Promise<void> {
    const { orgId } = job.data;
    const today = kyivToday(); // UTC-північ Kyiv-дати; dueDate — @db.Date

    const res = await this.prisma.invoice.updateMany({
      where: {
        orgId,
        deletedAt: null,
        status: { in: ['SENT', 'PARTIALLY_PAID'] },
        dueDate: { not: null, lt: today },
      },
      data: { status: 'OVERDUE' },
    });

    if (res.count > 0) {
      this.logger.log(`Прострочено ${res.count} рахунк(ів) для org=${orgId}`);
    }
  }
}
