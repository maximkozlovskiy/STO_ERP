import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { calculatePagination } from '../../common/utils/pagination';
import { IntegrationLogResponseDto, PaginatedIntegrationLogsDto } from './integration-logs.dto';

const ERROR_MAX_LEN = 500;

/** Контекст обміну — усе, що потрібно для рядка логу (БЕЗ секретів). */
export interface IntegrationLogContext {
  orgId: string;
  branchId?: string | null;
  provider: string;
  operation: string;
  documentType?: string | null;
  documentId?: string | null;
}

/**
 * Логування зовнішніх HTTP-обмінів з інтеграціями — МЕТАДАНІ ЛИШЕ (без тіл, без секретів).
 *
 * `wrap()` — єдиний seam: обгортає виклик провайдера у процесорі/сервісі (де orgId/branchId/
 * provider/operation/documentId уже в скоупі — на рівні клієнтського fetch їх немає). Таймінг +
 * fire-and-forget запис + **re-throw** (control flow незмінний → лог НІКОЛИ не зриває money/fiscal).
 *
 * httpStatus: клієнти вбудовують статус у текст помилки (`monobank ${status}: ${body}`) → парсимо
 * `[1-5]\d{2}` на fail; на успіху null. Upgrade-шлях: клієнти кидатимуть типізований
 * IntegrationHttpError{status} → regex стане fallback, схема не зміниться (httpStatus nullable).
 *
 * Секрети: пишемо лише whitelist-скаляри явним об'єктом (ніколи не спредимо cfg/credentials).
 * `error` = Error.message = response BODY провайдера (креди/токен ідуть у заголовках, які ми не
 * серіалізуємо) → truncate ERROR_MAX_LEN.
 */
@Injectable()
export class IntegrationLogService {
  private readonly logger = new Logger(IntegrationLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async wrap<T>(ctx: IntegrationLogContext, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      const result = await fn();
      void this.record(ctx, { ok: true, durationMs: Math.round(performance.now() - t0) });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void this.record(ctx, {
        ok: false,
        httpStatus: this.parseStatus(msg),
        error: msg.slice(0, ERROR_MAX_LEN),
        durationMs: Math.round(performance.now() - t0),
      });
      throw e;
    }
  }

  /** Парсить дату або кидає 400 (invalid → чистий BadRequest, не Prisma-500). undefined→undefined. */
  private parseDateOr400(value: string | undefined, field: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`Невірний формат дати у полі "${field}"`);
    }
    return d;
  }

  /** HTTP-статус з тексту помилки провайдера (`... 502: ...`); null якщо не знайдено. */
  private parseStatus(message: string): number | null {
    const m = /\b([1-5]\d{2})\b/.exec(message);
    return m ? Number(m[1]) : null;
  }

  /** Fire-and-forget запис — помилка логу НЕ зриває операцію (дзеркалить SmsProcessor.log). */
  private async record(
    ctx: IntegrationLogContext,
    extra: { ok: boolean; httpStatus?: number | null; error?: string; durationMs?: number },
  ): Promise<void> {
    try {
      await this.prisma.integrationLog.create({
        data: {
          orgId: ctx.orgId,
          branchId: ctx.branchId ?? null,
          provider: ctx.provider,
          operation: ctx.operation,
          documentType: ctx.documentType ?? null,
          documentId: ctx.documentId ?? null,
          ok: extra.ok,
          httpStatus: extra.httpStatus ?? null,
          durationMs: extra.durationMs ?? null,
          error: extra.error ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`IntegrationLog не записано: ${e instanceof Error ? e.message : e}`);
    }
  }

  async findAll(
    orgId: string,
    page = 1,
    limit = 50,
    provider?: string,
    operation?: string,
    ok?: boolean,
    documentType?: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<PaginatedIntegrationLogsDto> {
    const where: Prisma.IntegrationLogWhereInput = { orgId };
    if (provider) where.provider = provider;
    if (operation) where.operation = operation;
    if (ok !== undefined) where.ok = ok;
    if (documentType) where.documentType = documentType;
    // Семантична валідація дат (Bug #595 class): контролер бере dateFrom/dateTo сирими рядками
    // (@Query, не DTO) → garbage `?dateFrom=abc` дав би new Date('abc')=Invalid → Prisma 500.
    // Чистий 400 замість 500.
    const gte = this.parseDateOr400(dateFrom, 'dateFrom');
    const lte = dateTo ? this.parseDateOr400(dateTo + 'T23:59:59.999Z', 'dateTo') : undefined;
    if (gte || lte) {
      where.createdAt = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
    }

    const { skip, take } = calculatePagination({ page, limit, maxLimit: 200 });
    const [items, total] = await Promise.all([
      this.prisma.integrationLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.integrationLog.count({ where }),
    ]);
    return { items: items.map(i => this.toDto(i)), total, page, limit: take };
  }

  private toDto(i: {
    id: string;
    branchId: string | null;
    provider: string;
    operation: string;
    ok: boolean;
    httpStatus: number | null;
    durationMs: number | null;
    documentType: string | null;
    documentId: string | null;
    error: string | null;
    createdAt: Date;
  }): IntegrationLogResponseDto {
    return {
      id: i.id,
      branchId: i.branchId,
      provider: i.provider,
      operation: i.operation,
      ok: i.ok,
      httpStatus: i.httpStatus,
      durationMs: i.durationMs,
      documentType: i.documentType,
      documentId: i.documentId,
      error: i.error,
      createdAt: i.createdAt.toISOString(),
    };
  }
}
