import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped } from '../../common/tenant/tenant-context';
import { PaginatedDeadLetterDto } from './dead-letter.dto';

const REASON_MAX = 1000;
const STACK_MAX = 4000;
const PAYLOAD_MAX_DEPTH = 8;

// Ключі, чиє значення персистити у DLQ-payload plaintext НЕ можна (secrets-at-rest).
// Конвенція стеку — секрети НЕ клacти у job.data (резолвити point-of-use), але вебхук-черга
// свідомо носить `secret: ep.secret` (підписний ключ) у payload → без цього фільтра він осів би
// у dead_letter_jobs.payload відкритим текстом. Захист defence-in-depth: редагуємо за ІМЕНЕМ ключа
// рекурсивно, регістронезалежно, на випадок майбутніх черг, що додадуть креденшели у job.data.
const SENSITIVE_KEY_RE =
  /(secret|token|password|pass|pwd|api[-_]?key|credential|authorization|auth|private[-_]?key|access[-_]?key|secret[-_]?key|pin[-_]?code|signature|sign|licenseKey)/i;
const REDACTED = '[REDACTED]';

/**
 * Рекурсивно клонує payload, замінюючи значення sensitive-ключів на `[REDACTED]`.
 * Не мутує вхід (job.data лишається недоторканим для решти обробки). Обмежений глибиною
 * (циклічні/глибокі структури → обрізаються), масиви обходяться поелементно.
 */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth >= PAYLOAD_MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => sanitizePayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : sanitizePayload(v, depth + 1);
  }
  return out;
}

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
            // job.data → payload JSONB, але sensitive-ключі редагуються (webhooks-черга носить
            // `secret: ep.secret` — інакше підписний ключ осів би у БД plaintext, secrets-at-rest).
            payload: sanitizePayload(job.data ?? {}) as Prisma.InputJsonValue,
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
    // orgId у where БОТ у пошуку, І в самому апдейті (defence-in-depth: DeadLetterJob TENANT_EXEMPT,
    // тож guard НЕ додає scope автоматично; `update({where:{id}})` без orgId відкрив би race-вікно
    // на крос-tenant запис). updateMany дозволяє composite-where {id, orgId}; count===0 → 404.
    const res = await this.prisma.deadLetterJob.updateMany({
      where: { id, orgId },
      data: { resolved: true, resolvedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('DLQ-запис не знайдено');
    return { id, resolved: true };
  }
}
