import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { Observable, from, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

const HEADER = 'idempotency-key';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 год — вікно, у якому retry того ж запиту дедуплікується

/**
 * A1 — Idempotency-Key interceptor для create-документів (WO/Invoice/PO/StockDocument/Payment/
 * CompletionAct). Захищає від ДУБЛЮВАННЯ документа коли offline-клієнт повторює POST після обриву
 * мережі (мережа впала ПІСЛЯ запису, ДО отримання відповіді).
 *
 * RESERVE-FIRST (критично): рядок IdempotencyKey вставляється ПЕРЕД викликом handler. `@@unique
 * ([orgId,key])` слугує локом — два конкурентні запити з тим самим ключем: перший резервує, другий
 * ловить P2002. Кеш-після-успіху НЕ захистив би (обидва встигли б виконати handler). Логіка:
 *   - немає заголовка → pass-through (не примушуємо клієнтів; сумісність).
 *   - reserve create; P2002 → рядок існує:
 *       • responseStatus заповнено + той самий requestHash → REPLAY закешованої відповіді;
 *       • responseStatus заповнено + ІНШИЙ requestHash → 422 (ключ повторно з іншим тілом);
 *       • responseStatus null → 409 (запит ще в обробці паралельно).
 *   - handler success (2xx) → зберегти статус+тіло; handler throw → видалити резервацію (retry можливий).
 *
 * orgId береться з автентифікованого користувача (JwtAuthGuard уже відпрацював до інтерсептора).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { orgId?: string } }>();
    const rawKey = req.headers[HEADER];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const orgId = req.user?.orgId;

    // Без ключа або без orgId (публічний роут) — звичайний потік, без дедуплікації.
    if (!key || !orgId) {
      return next.handle();
    }

    const method = req.method;
    const path = (req.routeOptions?.url ?? req.url).split('?')[0];
    const requestHash = createHash('sha256')
      .update(`${method}:${path}:${JSON.stringify(req.body ?? {})}`)
      .digest('hex');

    return from(this.reserveOrResolve(orgId, key, method, path, requestHash)).pipe(
      switchMap(resolved => {
        // Уже є завершений результат (replay) — повертаємо його, handler НЕ виконується.
        if (resolved.replay) {
          return of(resolved.body);
        }
        // Резервацію створено нами — виконуємо handler, кешуємо результат.
        return next.handle().pipe(
          switchMap(body => from(this.finalize(orgId, key, body)).pipe(switchMap(() => of(body)))),
          catchError(err =>
            // handler кинув — видаляємо резервацію, щоб клієнт міг легітимно повторити.
            from(this.release(orgId, key)).pipe(
              switchMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Резервує ключ або вирішує колізію. Повертає {replay:true, body} для повтору, або {replay:false}
   * якщо ми щойно зарезервували й маємо виконати handler.
   */
  private async reserveOrResolve(
    orgId: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<{ replay: true; body: unknown } | { replay: false }> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          orgId,
          key,
          method,
          path,
          requestHash,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      return { replay: false };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') {
        throw e; // не unique-конфлікт — реальна помилка
      }
    }

    // Рядок уже існує — вирішуємо replay / 422 / 409.
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { orgId_key: { orgId, key } },
      select: { requestHash: true, responseStatus: true, responseBody: true },
    });

    if (!existing) {
      // Гонка: рядок зник між P2002 і read (purge/rollback). Безпечно трактувати як «в обробці».
      throw new ConflictException('Запит з цим Idempotency-Key вже обробляється');
    }
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'Idempotency-Key вже використано з іншим тілом запиту',
      );
    }
    if (existing.responseStatus == null) {
      // Резервація ще не завершена — інший запит з тим самим ключем виконується паралельно.
      throw new ConflictException('Запит з цим Idempotency-Key вже обробляється');
    }
    return { replay: true, body: existing.responseBody };
  }

  private async finalize(orgId: string, key: string, body: unknown): Promise<void> {
    await this.prisma.idempotencyKey
      .update({
        where: { orgId_key: { orgId, key } },
        data: {
          responseStatus: 200,
          responseBody: (body ?? null) as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      })
      .catch(err => {
        // Кеш-запис не має зривати вже-успішну відповідь клієнту (документ створено).
        this.logger.warn(`IdempotencyKey finalize failed key=${key}: ${err}`);
      });
  }

  private async release(orgId: string, key: string): Promise<void> {
    await this.prisma.idempotencyKey
      .delete({ where: { orgId_key: { orgId, key } } })
      .catch(() => undefined); // резервації могло вже не бути — не критично
  }
}
