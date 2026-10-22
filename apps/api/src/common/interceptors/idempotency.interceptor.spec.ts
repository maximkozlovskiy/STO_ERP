import { vi, describe, it, expect, beforeEach } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import {
  IdempotencyInterceptor,
  RequireIdempotencyKey,
  RequiredIdempotencyInterceptor,
} from './idempotency.interceptor';

/**
 * A1 — reserve-first idempotency. Money-critical: доводимо, що:
 *  - без заголовка → pass-through (handler виконується, дедуплікації немає).
 *  - перший запит резервує (create) → виконує handler → кешує 2xx.
 *  - конкурентний/повторний з тим самим key+тілом → REPLAY (handler НЕ виконується вдруге).
 *  - той самий key з ІНШИМ тілом → 422.
 *  - key в обробці (responseStatus null) → 409.
 *  - handler throw → резервацію видалено (retry можливий).
 */

const P2002 = new Prisma.PrismaClientKnownRequestError('dup', {
  code: 'P2002',
  clientVersion: '5',
});

function makeCtx(headers: Record<string, string>, body: unknown = {}, orgId = 'org-1') {
  const req = {
    headers,
    method: 'POST',
    url: '/api/work-orders',
    routeOptions: { url: '/api/work-orders' },
    body,
    user: { orgId },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('IdempotencyInterceptor (reserve-first)', () => {
  let prisma: {
    idempotencyKey: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };
  let interceptor: IdempotencyInterceptor;
  const handler = (val: unknown) => ({ handle: () => of(val) });

  beforeEach(() => {
    prisma = {
      idempotencyKey: {
        create: vi.fn().mockResolvedValue(undefined),
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    interceptor = new IdempotencyInterceptor(prisma as never);
  });

  it('без Idempotency-Key → pass-through (handler виконується, create НЕ викликається)', async () => {
    const next = handler({ id: 'wo-1' });
    const result = await firstValueFrom(interceptor.intercept(makeCtx({}), next));
    expect(result).toEqual({ id: 'wo-1' });
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('перший запит: резервує → handler → кешує 2xx', async () => {
    const next = handler({ id: 'wo-1' });
    const result = await firstValueFrom(
      interceptor.intercept(makeCtx({ 'idempotency-key': 'k1' }), next),
    );
    expect(result).toEqual({ id: 'wo-1' });
    // reserve-first: create ПЕРЕД handler.
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.create.mock.calls[0][0].data).toMatchObject({
      orgId: 'org-1',
      key: 'k1',
    });
    // finalize закешував відповідь.
    expect(prisma.idempotencyKey.update.mock.calls[0][0].data).toMatchObject({
      responseStatus: 200,
      responseBody: { id: 'wo-1' },
    });
  });

  it('повтор із тим самим key+тілом → REPLAY (handler НЕ виконується вдруге)', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(P2002); // рядок уже існує
    // requestHash обчислюється однаково для того самого тіла — мокаємо збіг через реальний хеш.
    // Отримуємо очікуваний хеш, запустивши reserve один раз на «чистому» create — простіше:
    // findUnique повертає завершений запис із тим самим requestHash.
    // Обчислюємо requestHash так само, як інтерсептор (sha256 method:path:body).
    const { createHash } = await import('crypto');
    const hash = createHash('sha256')
      .update(`POST:/api/work-orders:${JSON.stringify({ a: 1 })}`)
      .digest('hex');
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: hash,
      responseStatus: 200,
      responseBody: { id: 'wo-cached' },
    });

    const handlerSpy = vi.fn(() => of({ id: 'wo-NEW' }));
    const next = { handle: handlerSpy };
    const result = await firstValueFrom(
      interceptor.intercept(makeCtx({ 'idempotency-key': 'k1' }, { a: 1 }), next),
    );
    expect(result).toEqual({ id: 'wo-cached' });
    // MUTATION-VERIFY: якщо прибрати replay-гілку — handler виконався б і повернув wo-NEW → впаде.
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('той самий key з ІНШИМ тілом → 422', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(P2002);
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: 'DIFFERENT_HASH',
      responseStatus: 200,
      responseBody: { id: 'wo-cached' },
    });
    const next = handler({ id: 'wo-NEW' });
    await expect(
      firstValueFrom(interceptor.intercept(makeCtx({ 'idempotency-key': 'k1' }, { a: 2 }), next)),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('key ще в обробці (responseStatus null) → 409', async () => {
    prisma.idempotencyKey.create.mockRejectedValue(P2002);
    const { createHash } = await import('crypto');
    const hash = createHash('sha256')
      .update(`POST:/api/work-orders:${JSON.stringify({})}`)
      .digest('hex');
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      requestHash: hash,
      responseStatus: null, // резервація ще не завершена
      responseBody: null,
    });
    const next = handler({ id: 'wo-NEW' });
    await expect(
      firstValueFrom(interceptor.intercept(makeCtx({ 'idempotency-key': 'k1' }), next)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('handler кинув → резервацію видалено (retry можливий), помилка проброшена', async () => {
    const boom = new Error('overpay');
    const throwingNext = { handle: () => throwError(() => boom) };
    await expect(
      firstValueFrom(interceptor.intercept(makeCtx({ 'idempotency-key': 'k1' }), throwingNext)),
    ).rejects.toBe(boom);
    expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({
      where: { orgId_key: { orgId: 'org-1', key: 'k1' } },
    });
    // MUTATION-VERIFY: прибрати release() у catch → delete не викликається → клієнт не зможе повторити.
  });

  // Рішення власника 2026-10-22: каса, оплати, сторно — без ключа 400, handler не виконується.
  it('RequiredIdempotencyInterceptor: без Idempotency-Key → 400, handler і резервація не виконуються', () => {
    const required = new RequiredIdempotencyInterceptor(prisma as never);
    const handle = vi.fn(() => of('created'));
    expect(() => required.intercept(makeCtx({}), { handle })).toThrow(BadRequestException);
    expect(handle).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('RequiredIdempotencyInterceptor: з ключем — той самий reserve-first потік', async () => {
    const required = new RequiredIdempotencyInterceptor(prisma as never);
    const res = await firstValueFrom(
      required.intercept(makeCtx({ 'idempotency-key': 'k-1' }), handler('created')),
    );
    expect(res).toBe('created');
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
  });

  // Вимога видна стороннім клієнтам у Swagger/openapi.json, а не лише з відповіді 400.
  it('RequireIdempotencyKey: інтерсептор із ключем і заголовок «обов’язковий» у Swagger', () => {
    class Ctrl {
      @RequireIdempotencyKey()
      create(): void {}
    }
    const handler = Ctrl.prototype.create;
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)).toEqual([
      RequiredIdempotencyInterceptor,
    ]);
    // ApiHeader на методі пишеться в параметри операції (`in: 'header'`), не в swagger/apiHeaders.
    const headers = Reflect.getMetadata('swagger/apiParameters', handler) as Array<{
      name: string;
      in: string;
      required?: boolean;
    }>;
    expect(headers).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]);
  });
});
