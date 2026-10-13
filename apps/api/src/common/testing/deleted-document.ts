import { Test } from '@nestjs/testing';
import { NotFoundException, type INestApplication, type Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Стенд «документ, позначений на видалення» для спеків правила BR-WO-012.
 *
 * Навіщо. Правило має дві половини: (1) `findOne(..., { withDeleted: true })` показує видалений
 * документ; (2) жодна ЗМІННА операція його не бачить. Другу половину не перевірити моком
 * «findFirst повертає null» — такий мок відповість null на будь-який запит і тест буде зеленим,
 * навіть якщо сервіс перестав фільтрувати `deletedAt: null`.
 *
 * Тому тут Prisma-двійник, який ПОВОДИТЬСЯ як база з одним видаленим документом: читання
 * моделі документа повертає рядок лише тоді, коли `where` збігається за `id` та `orgId` і НЕ
 * містить `deletedAt: null`. Запит із фільтром отримує null — як у справжній базі. Усі записи
 * (update/create/…) у будь-яку модель потрапляють у журнал `writes`.
 */

const READ_ONE = new Set(['findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow']);
const WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

type Where = Record<string, unknown> | undefined;
type Args = { where?: Where } | undefined;

export interface DeletedDocumentWorld {
  /** Двійник PrismaService. */
  prisma: PrismaService;
  /** Журнал записів: `модель.метод`. Порожній — у базу нічого не писали. */
  writes: string[];
  /** `where` усіх читань моделі документа — щоб перевірити фільтр буквально. */
  documentReads: Where[];
}

/**
 * @param model  назва делегата Prisma (`workOrder`, `invoice`, …)
 * @param doc    рядок документа з `id`, `orgId` і заповненим `deletedAt`
 */
export function deletedDocumentWorld(
  model: string,
  doc: { id: string; orgId: string } & Record<string, unknown>,
): DeletedDocumentWorld {
  const writes: string[] = [];
  const documentReads: Where[] = [];

  /** Чи бачить запит наш документ: свій id, своя організація, без фільтра «не видалені». */
  const sees = (where: Where): boolean =>
    !!where &&
    where.id === doc.id &&
    where.orgId === doc.orgId &&
    !('deletedAt' in where && where.deletedAt === null);

  const delegates = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const delegate = (name: string) => {
    let d = delegates.get(name);
    if (d) return d;
    const fns = new Map<string, ReturnType<typeof vi.fn>>();
    d = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined;
        let fn = fns.get(method);
        if (fn) return fn;
        fn = vi.fn((args: Args) => {
          const isDoc = name === model;
          if (READ_ONE.has(method)) {
            if (isDoc) documentReads.push(args?.where);
            const row = isDoc && sees(args?.where) ? doc : null;
            if (!row && method.endsWith('OrThrow')) {
              return Promise.reject(new Error(`${name}.${method}: рядок не знайдено`));
            }
            return Promise.resolve(row);
          }
          if (WRITES.has(method)) {
            // updateMany із фільтром, що документа не бачить, нічого не змінює — це не запис.
            if (isDoc && method === 'updateMany' && !sees(args?.where)) {
              return Promise.resolve({ count: 0 });
            }
            writes.push(`${name}.${method}`);
            return Promise.resolve(method.endsWith('Many') ? { count: 1 } : {});
          }
          if (method === 'findMany' || method === 'groupBy') return Promise.resolve([]);
          if (method === 'count') return Promise.resolve(0);
          if (method === 'aggregate') return Promise.resolve({ _sum: {}, _count: {} });
          return Promise.resolve(null);
        });
        fns.set(method, fn);
        return fn;
      },
    });
    delegates.set(name, d);
    return d;
  };

  const prisma: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (prop === '$transaction') {
          return (arg: unknown) =>
            typeof arg === 'function'
              ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
              : Promise.all(arg as Promise<unknown>[]);
        }
        if (prop.startsWith('$') || prop.startsWith('on')) return undefined;
        return delegate(prop);
      },
    },
  );

  return { prisma: prisma as PrismaService, writes, documentReads };
}

/**
 * Збирає сервіс зі справжнім кодом і двійником Prisma; решта залежностей — порожні заглушки
 * (будь-який метод повертає undefined). Зміни конструктора сервісу стенд не ламають: зайві
 * залежності тут не потрібні, бо операція над видаленим документом має зупинитись на 404 ДО них.
 */
export async function serviceWithPrisma<T>(service: Type<T>, prisma: PrismaService): Promise<T> {
  const stub = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string' || prop === 'then' || prop.startsWith('on')) {
            return undefined;
          }
          return () => undefined;
        },
      },
    );
  const module = await Test.createTestingModule({
    providers: [service, { provide: PrismaService, useValue: prisma }],
  })
    .useMocker(stub)
    .compile();
  return module.get(service);
}

export interface DeletedDocumentSuite<T> {
  /** Назва групи тестів (потрапляє у baseline — не міняти без потреби). */
  title: string;
  service: Type<T>;
  /** Делегат Prisma документа: `workOrder`, `invoice`, … */
  model: string;
  /**
   * Рядок документа з усіма зв'язками, яких потребує `findOne` → DTO. `id`, `orgId` і
   * `deletedAt` стенд проставляє сам.
   */
  row: Record<string, unknown>;
  /** Виклик `findOne` сервісу (сигнатури різняться: у наряду третім іде роль). */
  findOne: (
    svc: T,
    orgId: string,
    id: string,
    opts?: { withDeleted?: boolean },
  ) => Promise<{ id: string; deletedAt?: string | null }>;
  /** Змінні операції над документом: назва → виклик. Кожна мусить дати 404 без записів. */
  mutations: Record<string, (svc: T, orgId: string, id: string) => Promise<unknown>>;
}

export const DELETED_DOC_ORG = '0a000000-0000-4000-8000-000000000001';
export const DELETED_DOC_OTHER_ORG = '0b000000-0000-4000-8000-000000000002';
export const DELETED_DOC_ID = '0d000000-0000-4000-8000-00000000000d';
const DELETED_AT = new Date('2026-10-12T09:30:00.000Z');

/**
 * Однаковий набір кейсів BR-WO-012 для сервісу документа. Викликається зі спека модуля:
 * кейси належать тому спеку, тут лише їхній спільний текст.
 */
export function describeDeletedDocument<T>(suite: DeletedDocumentSuite<T>): void {
  describe(suite.title, () => {
    let svc: T;
    let world: DeletedDocumentWorld;

    beforeEach(async () => {
      world = deletedDocumentWorld(suite.model, {
        ...suite.row,
        id: DELETED_DOC_ID,
        orgId: DELETED_DOC_ORG,
        deletedAt: DELETED_AT,
      });
      svc = await serviceWithPrisma(suite.service, world.prisma);
    });

    describe('findOne', () => {
      it('без прапорця видалений документ не знайдено: запит фільтрує deletedAt: null', async () => {
        await expect(suite.findOne(svc, DELETED_DOC_ORG, DELETED_DOC_ID)).rejects.toThrow(
          NotFoundException,
        );
        expect(world.documentReads[0]).toEqual({
          id: DELETED_DOC_ID,
          orgId: DELETED_DOC_ORG,
          deletedAt: null,
        });
      });

      it('withDeleted: false — те саме, що без прапорця', async () => {
        await expect(
          suite.findOne(svc, DELETED_DOC_ORG, DELETED_DOC_ID, { withDeleted: false }),
        ).rejects.toThrow(NotFoundException);
        expect(world.documentReads[0]).toMatchObject({ deletedAt: null });
      });

      it('withDeleted: true → документ повернуто з заповненим deletedAt; orgId у запиті лишається', async () => {
        const dto = await suite.findOne(svc, DELETED_DOC_ORG, DELETED_DOC_ID, {
          withDeleted: true,
        });

        expect(dto.id).toBe(DELETED_DOC_ID);
        expect(dto.deletedAt).toBe(DELETED_AT.toISOString());
        // Знято ЛИШЕ фільтр видалення: ні id, ні організація з where не зникли.
        expect(world.documentReads[0]).toEqual({ id: DELETED_DOC_ID, orgId: DELETED_DOC_ORG });
      });

      it('чужа організація → 404 і з withDeleted: true', async () => {
        await expect(
          suite.findOne(svc, DELETED_DOC_OTHER_ORG, DELETED_DOC_ID, { withDeleted: true }),
        ).rejects.toThrow(NotFoundException);
        expect(world.documentReads[0]).toEqual({
          id: DELETED_DOC_ID,
          orgId: DELETED_DOC_OTHER_ORG,
        });
      });

      it('читання нічого не пише в базу', async () => {
        await suite.findOne(svc, DELETED_DOC_ORG, DELETED_DOC_ID, { withDeleted: true });
        expect(world.writes).toEqual([]);
      });
    });

    describe('змінити видалений документ неможливо', () => {
      it.each(Object.keys(suite.mutations))('%s → 404, у базу нічого не записано', async name => {
        await expect(suite.mutations[name](svc, DELETED_DOC_ORG, DELETED_DOC_ID)).rejects.toThrow(
          NotFoundException,
        );
        expect(world.writes).toEqual([]);
        // Операція шукала документ саме серед невидалених — тому й не знайшла.
        expect(world.documentReads.length).toBeGreaterThan(0);
        for (const where of world.documentReads) {
          expect(where).toMatchObject({ orgId: DELETED_DOC_ORG, deletedAt: null });
        }
      });
    });
  });
}

export interface WithDeletedRouteSuite {
  /** Шлях колекції: `/work-orders`, `/invoices`, … */
  path: string;
  /** Застосунок контракт-спека (створюється в його `beforeAll`, тому — функція). */
  app: () => INestApplication;
  /** Мок `findOne` сервісу з контракт-спека. */
  findOne: ReturnType<typeof vi.fn>;
  /** Організація з токена (її ставить мок JwtAuthGuard контракт-спека). */
  callerOrgId: string;
}

/**
 * HTTP-кейси BR-WO-012 для маршруту `GET <path>/:id?withDeleted=`. Сервіс у контракт-спеку —
 * мок; тут він грає роль «бази з одним видаленим документом»: віддає його лише своїй
 * організації й лише з `{ withDeleted: true }`. Саму фільтрацію в `where` перевіряє
 * `<модуль>.with-deleted.spec.ts`; тут — що прапорець доходить із URL до сервісу без спотворень.
 */
export function describeWithDeletedRoute(suite: WithDeletedRouteSuite): void {
  describe(`GET ${suite.path}/:id?withDeleted — документ, позначений на видалення (BR-WO-012)`, () => {
    const deletedAt = DELETED_AT.toISOString();
    let ownerOrgId: string;

    const get = (query = '') =>
      (suite.app() as NestFastifyApplication).inject({
        method: 'GET',
        url: `${suite.path}/${DELETED_DOC_ID}${query}`,
      });

    /** Останній аргумент виклику сервісу — опції (у наряду перед ними йде роль). */
    const passedOptions = (): unknown => suite.findOne.mock.calls[0].at(-1);

    beforeEach(() => {
      ownerOrgId = suite.callerOrgId;
      suite.findOne.mockReset();
      const asDatabase = (orgId: string, id: string, ...rest: unknown[]): unknown => {
        const opts = rest.at(-1) as { withDeleted?: boolean } | undefined;
        if (orgId !== ownerOrgId || id !== DELETED_DOC_ID || opts?.withDeleted !== true) {
          return Promise.reject(new NotFoundException('Документ не знайдено'));
        }
        return Promise.resolve({ id, orgId, deletedAt });
      };
      suite.findOne.mockImplementation(asDatabase);
    });

    // Мок належить контракт-спеку: після цієї групи повертаємо його порожнім.
    afterAll(() => {
      suite.findOne.mockReset();
    });

    it('без прапорця видалений документ → 404; сервіс отримує withDeleted: false', async () => {
      const res = await get();

      expect(res.statusCode).toBe(404);
      expect(passedOptions()).toEqual({ withDeleted: false });
    });

    it('withDeleted=true → 200, у відповіді заповнений deletedAt', async () => {
      const res = await get('?withDeleted=true');

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: DELETED_DOC_ID, deletedAt });
      expect(passedOptions()).toEqual({ withDeleted: true });
      expect(suite.findOne.mock.calls[0].slice(0, 2)).toEqual([suite.callerOrgId, DELETED_DOC_ID]);
    });

    it('withDeleted=false → 404, як без прапорця', async () => {
      const res = await get('?withDeleted=false');

      expect(res.statusCode).toBe(404);
      expect(passedOptions()).toEqual({ withDeleted: false });
    });

    it.each(['abc', '1', 'TRUE', 'yes', ''])(
      'withDeleted=%j → 400 українською, сервіс не викликається',
      async value => {
        const res = await get(`?withDeleted=${value}`);

        expect(res.statusCode).toBe(400);
        expect(res.json<{ message: string[] }>().message).toEqual([
          'Поле "withDeleted" має бути "true" або "false"',
        ]);
        expect(suite.findOne).not.toHaveBeenCalled();
      },
    );

    it('повтор параметра (withDeleted=true&withDeleted=false) → 400', async () => {
      const res = await get('?withDeleted=true&withDeleted=false');

      expect(res.statusCode).toBe(400);
      expect(suite.findOne).not.toHaveBeenCalled();
    });

    it('документ чужої організації → 404 і з withDeleted=true; організація береться з токена', async () => {
      ownerOrgId = DELETED_DOC_OTHER_ORG;

      const res = await get('?withDeleted=true');

      expect(res.statusCode).toBe(404);
      expect(suite.findOne.mock.calls[0][0]).toBe(suite.callerOrgId);
    });
  });
}
