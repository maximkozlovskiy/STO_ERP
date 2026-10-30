import { Prisma } from '@prisma/client';
import { vi } from 'vitest';

interface StoredKey {
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
}

/**
 * `prisma.idempotencyKey` у пам'яті — для HTTP-контрактів маршрутів із `@RequireIdempotencyKey()`.
 * Поводиться як таблиця з `@@unique([orgId, key])`: другий `create` з тим самим ключем — P2002,
 * тож справжній `IdempotencyInterceptor` іде гілкою «повтор» і віддає збережену відповідь.
 * Factory, не `const`: `isolate: false` без `clearMocks` інакше ділив би рядки між спеками.
 */
export function makeIdempotencyStore() {
  const rows = new Map<string, StoredKey>();
  const id = (orgId: string, key: string) => `${orgId}|${key}`;
  const idempotencyKey = {
    create: vi.fn(({ data }: { data: { orgId: string; key: string; requestHash: string } }) => {
      const k = id(data.orgId, data.key);
      if (rows.has(k)) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        );
      }
      rows.set(k, { requestHash: data.requestHash, responseStatus: null, responseBody: null });
      return Promise.resolve({});
    }),
    findUnique: vi.fn(({ where }: { where: { orgId_key: { orgId: string; key: string } } }) =>
      Promise.resolve(rows.get(id(where.orgId_key.orgId, where.orgId_key.key)) ?? null),
    ),
    update: vi.fn(
      ({
        where,
        data,
      }: {
        where: { orgId_key: { orgId: string; key: string } };
        data: { responseStatus: number; responseBody: unknown };
      }) => {
        const row = rows.get(id(where.orgId_key.orgId, where.orgId_key.key));
        if (row) Object.assign(row, data);
        return Promise.resolve({});
      },
    ),
    delete: vi.fn(({ where }: { where: { orgId_key: { orgId: string; key: string } } }) => {
      rows.delete(id(where.orgId_key.orgId, where.orgId_key.key));
      return Promise.resolve({});
    }),
  };
  return { idempotencyKey, rows };
}
