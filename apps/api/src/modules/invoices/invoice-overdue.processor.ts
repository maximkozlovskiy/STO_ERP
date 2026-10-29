import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { kyivToday } from '../../common/utils/kyiv-date';
import { DeadLetterWorkerHost } from '../../modules/dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';
import { recordDocumentEvents, type DocumentEventInput } from '../automation/record-document-event';

/** З яких статусів рахунок стає простроченим. */
const OVERDUE_FROM: InvoiceStatus[] = [InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID];
/** Скільки рахунків в одній транзакції нічного прогону. */
const OVERDUE_BATCH = 200;
/** Пачка — до OVERDUE_BATCH окремих CAS-записів; типових 5 с Prisma на неї замало. */
const OVERDUE_TX_TIMEOUT_MS = 30_000;

interface OverdueJob {
  orgId: string;
}

/**
 * Позначає прострочені рахунки OVERDUE: SENT/PARTIALLY_PAID з dueDate < сьогодні (Kyiv).
 * Системний фоновий перехід — CAS-ом за статусом (оминає FSM transition(), як інші processor'и, що
 * пишуть статус); подія outbox — на кожен рахунок (BR-AUT-060), ініціатор — система. FSM-мапа
 * INV_TRANSITIONS лишається для РУЧНИХ endpoint.
 * Ідемпотентний: повторний прогін не чіпає вже-OVERDUE (не у SENT/PARTIALLY_PAID) чи оплачені.
 */
@Injectable()
@Processor('invoice-overdue', { concurrency: 1 })
export class InvoiceOverdueProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(InvoiceOverdueProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job<OverdueJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId } = job.data;
      const today = kyivToday(); // UTC-північ Kyiv-дати; dueDate — @db.Date

      let total = 0;
      // Пачками: подія на КОЖЕН рахунок (BR-AUT-060) потребує id і попереднього статусу, тож
      // замість одного `updateMany` — вибірка й CAS за прочитаним статусом. Рахунок, що змінився
      // між вибіркою і записом (оплата), не чіпаємо — він вийде з вибірки або прийде наступною.
      for (;;) {
        const due = await this.prisma.invoice.findMany({
          where: {
            orgId,
            deletedAt: null,
            status: { in: OVERDUE_FROM },
            dueDate: { not: null, lt: today },
          },
          select: { id: true, status: true },
          orderBy: { id: 'asc' },
          take: OVERDUE_BATCH,
        });
        if (due.length === 0) break;
        const moved = await this.markOverdueBatch(orgId, today, due);
        total += moved;
        // Жоден не перейшов — пачка складається з рахунків, що змінились паралельно; повтор
        // взяв би ту саму пачку, тож виходимо (наступний прогін job-а підбере решту).
        if (moved === 0 || due.length < OVERDUE_BATCH) break;
      }

      if (total > 0) {
        this.logger.log(`Прострочено ${total} рахунк(ів) для org=${orgId}`);
      }
    });
  }

  /**
   * Пачка: кожен рахунок — CAS за прочитаними статусом і терміном (термін могли перенести між
   * вибіркою і записом) і подія, усе однією транзакцією.
   */
  private async markOverdueBatch(
    orgId: string,
    today: Date,
    due: ReadonlyArray<{ id: string; status: InvoiceStatus }>,
  ): Promise<number> {
    return this.prisma.$transaction(
      async tx => {
        const events: DocumentEventInput[] = [];
        for (const { id, status: from } of due) {
          const res = await tx.invoice.updateMany({
            where: { id, orgId, deletedAt: null, status: from, dueDate: { not: null, lt: today } },
            data: { status: InvoiceStatus.OVERDUE },
          });
          if (res.count === 0) continue;
          events.push({
            orgId,
            documentType: 'INVOICE',
            documentId: id,
            kind: 'STATUS_CHANGED',
            fromStatus: from,
            toStatus: InvoiceStatus.OVERDUE,
          });
        }
        await recordDocumentEvents(tx, events);
        return events.length;
      },
      { timeout: OVERDUE_TX_TIMEOUT_MS },
    );
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob (аудит стеку, backend #2).
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
