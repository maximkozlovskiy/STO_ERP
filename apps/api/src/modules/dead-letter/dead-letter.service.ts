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
// рекурсивно, на випадок майбутніх черг, що додадуть креденшели у job.data.
//
// Bug #759 — стара `SENSITIVE_KEY_RE` матчила КОРОТКІ підрядки `auth|sign|pass` будь-де у ключі
// (unanchored), тож редагувала НЕсекретні діагностичні поля: `authorId`, `authorName`, `assignee`,
// `assignedTo`, `assignmentId`, `passenger`, `passportNumber`, `signedBy`, `signId`, `designId`,
// `bypass` тощо (`assign`/`design`/`bypass` містять `sign`/`pass`). Payload у DLQ існує САМЕ для
// розбору терминального провалу — масова over-redaction нищить його діагностичну цінність.
// Виправлення: розбиваємо ключ на токени (camelCase / snake / kebab / цифри) і матчимо за ЦІЛИМИ
// токенами, а не підрядками. Сильні терміни (secret/token/password/signature/…) редагують будь-де;
// слабкі неоднозначні (auth/sign/pass/key/pin/session/hash) — лише коли це весь ключ або поряд є
// компаньйон-токен (key/code/secret/token/hash/…), напр. `apiKey`, `authToken`, `passCode`, `signKey`.
const REDACTED = '[REDACTED]';

// Сильні терміни: секрет очевидний, редагуємо якщо токен зустрічається будь-де у ключі.
const STRONG_SECRET_TOKENS = new Set<string>([
  'secret',
  'token',
  'password',
  'passphrase',
  'passcode',
  'pwd',
  'credential',
  'credentials',
  'authorization',
  'signature',
  'apikey',
  'privatekey',
  'accesskey',
  'secretkey',
  'pincode',
  'licensekey',
  'jwt',
  'bearer',
  'cookie',
  'otp',
  'cvv',
  'cvc',
  'pan',
  'cardpan',
]);

// Слабкі неоднозначні терміни: редагуємо ЛИШЕ якщо це весь ключ (один токен) або поряд компаньйон.
const WEAK_SECRET_TOKENS = new Set<string>([
  'auth',
  'sign',
  'pass',
  'key',
  'pin',
  'session',
  'hash',
]);
const COMPANION_TOKENS = new Set<string>([
  'key',
  'code',
  'secret',
  'token',
  'hash',
  'hmac',
  'value',
  'phrase',
  'word',
]);

/** Розбиває ключ на нормалізовані lowercase-токени по camelCase / snake / kebab / цифрових межах. */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(t => t.toLowerCase());
}

/**
 * Чи є ключ носієм секрета (за токенами, не підрядками — Bug #759). Експортовано для тестів.
 */
export function isSensitiveKey(key: string): boolean {
  const toks = keyTokens(key);
  if (toks.length === 0) return false;
  const joined = toks.join('');
  if (STRONG_SECRET_TOKENS.has(joined)) return true;
  for (const t of toks) if (STRONG_SECRET_TOKENS.has(t)) return true;
  // Весь ключ — один слабкий токен: `{ sign }`, `{ pass }`, `{ key }`, `{ auth }`, `{ pin }`.
  if (toks.length === 1 && WEAK_SECRET_TOKENS.has(toks[0])) return true;
  // Слабкий токен поряд із компаньйоном → компаунд-секрет: apiKey, authToken, passCode, signKey.
  for (let i = 0; i < toks.length; i++) {
    if (!WEAK_SECRET_TOKENS.has(toks[i])) continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if ((next && COMPANION_TOKENS.has(next)) || (prev && COMPANION_TOKENS.has(prev))) return true;
    // xKey-компаунд (apiKey/secretKey/accessKey/signKey): `key` не на першій позиції.
    if (toks[i] === 'key' && i > 0) return true;
  }
  return false;
}

/**
 * Рекурсивно клонує payload, замінюючи значення sensitive-ключів на `[REDACTED]`.
 * Не мутує вхід (job.data лишається недоторканим для решти обробки). Обмежений глибиною
 * (циклічні/глибокі структури → обрізаються), масиви обходяться поелементно. Не-JSON-safe
 * значення (BigInt/Date/undefined/Buffer) нормалізуються, щоб Prisma JSONB-запис не кидав
 * і не втрачав увесь DLQ-рядок через fail-open (Bug #760).
 */
export function sanitizePayload(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (depth >= PAYLOAD_MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return null; // undefined → null (JSONB-safe)
  const t = typeof value;
  if (t === 'bigint') return (value as bigint).toString(); // BigInt не серіалізується у JSON
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (t !== 'object') return value; // string/number/boolean
  if (value instanceof Date) return value.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return '[Buffer]';
  // Циклічний ref → мітка (depth-cap теж є, але seen дає точнішу діагностику).
  const tracked = seen ?? new WeakSet<object>();
  if (tracked.has(value as object)) return '[CIRCULAR]';
  tracked.add(value as object);
  if (Array.isArray(value)) return value.map(v => sanitizePayload(v, depth + 1, tracked));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : sanitizePayload(v, depth + 1, tracked);
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
