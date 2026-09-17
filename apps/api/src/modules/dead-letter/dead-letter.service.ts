import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped } from '../../common/tenant/tenant-context';
import { PaginatedDeadLetterDto } from './dead-letter.dto';

const REASON_MAX = 1000;
const STACK_MAX = 4000;

/**
 * Централізований dead-letter writer/reader (аудит стеку, backend #2).
 *
 * `capture` викликається з DeadLetterWorkerHost.deadLetterOnFailed (терминальний провал будь-якої
 * черги). Fire-and-forget: помилка запису DLQ НЕ зриває обробку (дзеркалить IntegrationLogService).
 * Пишемо у `runUnscoped` + DeadLetterJob є TENANT_EXEMPT — бо listener біжить поза runWithTenant
 * і orgId nullable (org-agnostic scheduler-jobs). orgId — best-effort із job.data.orgId.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async capture(job: Job, err: Error, queueName: string): Promise<void> {
    try {
      const data = (job.data ?? {}) as { orgId?: unknown };
      const orgId = typeof data.orgId === 'string' ? data.orgId : null;
      const failedReason = (err?.message ?? job.failedReason ?? 'Помилка').slice(0, REASON_MAX);
      const stacktrace = job.stacktrace?.length
        ? job.stacktrace.join('\n').slice(0, STACK_MAX)
        : null;
      await runUnscoped(async () =>
        this.prisma.deadLetterJob.create({
          data: {
            orgId,
            queueName,
            jobName: job.name ?? 'unknown',
            bullJobId: String(job.id ?? ''),
            attemptsMade: job.attemptsMade,
            maxAttempts: job.opts.attempts ?? 1,
            failedReason,
            stacktrace,
            // job.data — plain-обʼєкт payload (секрети НЕ у job.data за конвенцією).
            payload: (job.data ?? {}) as Prisma.InputJsonValue,
          },
        }),
      );
      this.logger.warn(
        `DLQ: job ${queueName}/${job.id} вичерпав ${job.attemptsMade} спроб → ${failedReason}`,
      );
    } catch (e) {
      // Fail-open: втрата DLQ-запису не має зривати обробку черги.
      this.logger.error(
        `DLQ-запис не вдався (${queueName}/${job.id}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async findAll(
    orgId: string,
    page = 1,
    limit = 50,
    queueName?: string,
    resolved?: boolean,
  ): Promise<PaginatedDeadLetterDto> {
    // Controller фільтрує orgId вручну (модель TENANT_EXEMPT — guard не додає scope автоматично).
    // Оператор бачить лише DLQ свого org (+ org-agnostic рядки з orgId=null тут НЕ показуємо —
    // вони інфраструктурні; за потреби окремий admin-view).
    const where: Prisma.DeadLetterJobWhereInput = { orgId };
    if (queueName) where.queueName = queueName;
    if (resolved !== undefined) where.resolved = resolved;
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const [rows, total] = await Promise.all([
      this.prisma.deadLetterJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.deadLetterJob.count({ where }),
    ]);
    return {
      items: rows.map(r => ({
        id: r.id,
        orgId: r.orgId,
        queueName: r.queueName,
        jobName: r.jobName,
        bullJobId: r.bullJobId,
        attemptsMade: r.attemptsMade,
        maxAttempts: r.maxAttempts,
        failedReason: r.failedReason,
        stacktrace: r.stacktrace,
        payload: r.payload,
        resolved: r.resolved,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page: Math.max(page, 1),
      limit: take,
    };
  }

  /** Позначити DLQ-рядок опрацьованим (оператор розібрався / re-enqueue). orgId-scoped. */
  async resolve(orgId: string, id: string): Promise<{ id: string; resolved: boolean }> {
    const row = await this.prisma.deadLetterJob.findFirst({ where: { id, orgId } });
    if (!row) throw new NotFoundException('DLQ-запис не знайдено');
    const updated = await this.prisma.deadLetterJob.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    });
    return { id: updated.id, resolved: updated.resolved };
  }
}
