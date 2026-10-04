import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { registerBullBoardGuard } from './bull-board.guard';

/**
 * bull-board.guard — НАЙКРИТИЧНІШИЙ модуль із партії без тестів: це єдиний захист
 * адмінки черг BullMQ (`/api/admin/queues/*`). bull-board монтується як Fastify-plugin
 * ПОВЗ Nest-pipeline, тож @UseGuards/@Roles його НЕ прикривають — захист тримається
 * виключно на `onRequest`-хуку, що реєструє ця функція. Якщо хук перестане
 * відхиляти (порожній токен, невалідний підпис, застарілий tokenVersion, не той роль),
 * будь-хто отримає доступ до керування чергами. Тому тут сторожимо:
 *
 *  - відсутній/порожній/не-Bearer хедер → 401, prisma НЕ опитується (fail-closed);
 *  - невалідний підпис JWT (jwt.verify кидає) → 401, НЕ 500 і НЕ пропуск;
 *  - employee не знайдений у СВОЇЙ org і не видалений → 401;
 *  - tokenVersion у токені ≠ поточному в AuthAccount (logout-all/зміна пароля) → 401;
 *  - роль не OWNER/ADMIN → 403 (MECHANIC/RECEPTIONIST не керують чергами);
 *  - лише валідний OWNER/ADMIN проходить (хук НЕ викликає reply);
 *  - запити ПОЗА префіксом bull-board пропускаються без будь-якої перевірки;
 *  - у production хук взагалі не реєструється (bull-board там не монтується).
 */

type OnRequestHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

describe('registerBullBoardGuard', () => {
  const ORG = 'org-1';
  const SUB = 'emp-1';
  const SECRET = 'test-secret';

  let jwt: { verify: ReturnType<typeof vi.fn> };
  let prisma: { employee: { findFirst: ReturnType<typeof vi.fn> } };
  let addHook: ReturnType<typeof vi.fn>;
  let app: NestFastifyApplication;
  let savedNodeEnv: string | undefined;

  /** Будує reply-заглушку, що фіксує статус і тіло (chainable як у Fastify). */
  const makeReply = () => {
    const state: { status?: number; body?: unknown } = {};
    const reply = {
      status: vi.fn((s: number) => {
        state.status = s;
        return reply;
      }),
      send: vi.fn((b: unknown) => {
        state.body = b;
        return reply;
      }),
    };
    return { reply: reply as unknown as FastifyReply, state };
  };

  const makeReq = (over: Partial<{ url: string; auth: string }> = {}): FastifyRequest =>
    ({
      url: over.url ?? '/api/admin/queues',
      headers:
        over.auth !== undefined ? { authorization: over.auth } : ({} as Record<string, string>),
    }) as unknown as FastifyRequest;

  /** Реєструє гард і повертає захоплений onRequest-хук. */
  const getHook = async (): Promise<OnRequestHook> => {
    await registerBullBoardGuard(app);
    expect(addHook).toHaveBeenCalledWith('onRequest', expect.any(Function));
    return addHook.mock.calls.find(c => c[0] === 'onRequest')![1] as OnRequestHook;
  };

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    jwt = { verify: vi.fn() };
    prisma = { employee: { findFirst: vi.fn() } };
    addHook = vi.fn();

    const config = { getOrThrow: vi.fn(() => SECRET) };
    const fastify = { addHook };

    app = {
      get: vi.fn((token: unknown) => {
        const name = (token as { name?: string })?.name;
        if (name === 'JwtService') return jwt;
        if (name === 'ConfigService') return config;
        if (name === 'PrismaService') return prisma;
        // Fallback за позиційною відповідністю, якщо .name мінімізовано.
        return jwt;
      }),
      getHttpAdapter: vi.fn(() => ({ getInstance: () => fastify })),
    } as unknown as NestFastifyApplication;

    // За замовчуванням — валідний OWNER (happy-path), окремі тести перевизначають.
    jwt.verify.mockReturnValue({ sub: SUB, orgId: ORG, role: 'OWNER', tokenVersion: 0 });
    prisma.employee.findFirst.mockResolvedValue({
      role: 'OWNER',
      authAccount: { tokenVersion: 0 },
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    vi.restoreAllMocks();
  });

  describe('production — гард не монтується', () => {
    it('у production addHook НЕ викликається (bull-board там відсутній)', async () => {
      process.env.NODE_ENV = 'production';
      await registerBullBoardGuard(app);
      expect(addHook).not.toHaveBeenCalled();
    });
  });

  describe('маршрутизація префіксу', () => {
    it('запит поза /api/admin/queues пропускається без перевірки токена', async () => {
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ url: '/api/work-orders' }), reply);
      expect(state.status).toBeUndefined(); // reply не чіпали → йде далі у pipeline
      expect(jwt.verify).not.toHaveBeenCalled();
      expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    });

    it('схожий, але не той префікс (/api/admin/queuesX) НЕ захищається', async () => {
      // startsWith(`${PREFIX}/`) — саме зі слешем; інакше /api/admin/queues-evil обходив би гард,
      // а водночас /api/admin/queues (точний матч) має лишатись захищеним.
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ url: '/api/admin/queuesX' }), reply);
      expect(state.status).toBeUndefined();
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it('точний /api/admin/queues захищається (без токена → 401)', async () => {
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ url: '/api/admin/queues', auth: undefined }), reply);
      expect(state.status).toBe(401);
    });

    it('підшлях /api/admin/queues/ui захищається; query-string відрізається при матчі', async () => {
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ url: '/api/admin/queues/ui?foo=bar', auth: undefined }), reply);
      expect(state.status).toBe(401);
    });
  });

  describe('fail-closed: відсутність/форма токена', () => {
    it('без Authorization-хедера → 401 і prisma НЕ опитується', async () => {
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: undefined }), reply);
      expect(state.status).toBe(401);
      expect(prisma.employee.findFirst).not.toHaveBeenCalled();
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it('порожній Bearer (`Bearer `) → 401, verify не викликається', async () => {
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer ' }), reply);
      // token = '' → falsy → deny(401) ДО jwt.verify
      expect(state.status).toBe(401);
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it('хедер без префікса Bearer (`token123`) → 401', async () => {
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'token123' }), reply);
      expect(state.status).toBe(401);
      expect(jwt.verify).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed: підпис і ревокація', () => {
    it('невалідний підпис (jwt.verify кидає) → 401, НЕ 500, pipeline не пускає далі', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('invalid signature');
      });
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer forged' }), reply);
      expect(state.status).toBe(401);
      expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    });

    it('verify викликається САМЕ з secret із конфіга (не з дефолтним/порожнім)', async () => {
      const hook = await getHook();
      const { reply } = makeReply();
      await hook(makeReq({ auth: 'Bearer good' }), reply);
      expect(jwt.verify).toHaveBeenCalledWith('good', { secret: SECRET });
    });

    it('employee не знайдений (чужа org / видалений) → 401', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer good' }), reply);
      expect(state.status).toBe(401);
    });

    it('employee шукається у СВОЇЙ org, за sub, і не видалений', async () => {
      const hook = await getHook();
      const { reply } = makeReply();
      await hook(makeReq({ auth: 'Bearer good' }), reply);
      expect(prisma.employee.findFirst.mock.calls[0][0].where).toEqual({
        id: SUB,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('tokenVersion у токені ≠ поточному в AuthAccount → 401 (logout-all/зміна пароля)', async () => {
      jwt.verify.mockReturnValue({ sub: SUB, orgId: ORG, role: 'OWNER', tokenVersion: 1 });
      prisma.employee.findFirst.mockResolvedValue({
        role: 'OWNER',
        authAccount: { tokenVersion: 2 },
      });
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer stale' }), reply);
      expect(state.status).toBe(401);
    });

    it('відсутній tokenVersion у токені трактується як 0 і збігається з 0 у БД', async () => {
      jwt.verify.mockReturnValue({ sub: SUB, orgId: ORG, role: 'OWNER' }); // без tokenVersion
      prisma.employee.findFirst.mockResolvedValue({ role: 'OWNER', authAccount: null });
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer legacy' }), reply);
      expect(state.status).toBeUndefined(); // пройшов
    });
  });

  describe('авторизація за роллю', () => {
    it.each(['MECHANIC', 'RECEPTIONIST', 'STOREKEEPER', 'ACCOUNTANT'])(
      'роль %s (не OWNER/ADMIN) → 403',
      async role => {
        jwt.verify.mockReturnValue({ sub: SUB, orgId: ORG, role, tokenVersion: 0 });
        prisma.employee.findFirst.mockResolvedValue({ role, authAccount: { tokenVersion: 0 } });
        const hook = await getHook();
        const { reply, state } = makeReply();
        await hook(makeReq({ auth: 'Bearer good' }), reply);
        expect(state.status).toBe(403);
      },
    );

    it('роль береться з БД, а не з токена (підміна role у payload не підвищує прав)', async () => {
      // payload каже OWNER, але в БД MECHANIC → має бути 403.
      jwt.verify.mockReturnValue({ sub: SUB, orgId: ORG, role: 'OWNER', tokenVersion: 0 });
      prisma.employee.findFirst.mockResolvedValue({
        role: 'MECHANIC',
        authAccount: { tokenVersion: 0 },
      });
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer good' }), reply);
      expect(state.status).toBe(403);
    });

    it.each(['OWNER', 'ADMIN'])('валідний %s проходить — reply НЕ викликається', async role => {
      jwt.verify.mockReturnValue({ sub: SUB, orgId: ORG, role, tokenVersion: 0 });
      prisma.employee.findFirst.mockResolvedValue({ role, authAccount: { tokenVersion: 0 } });
      const hook = await getHook();
      const { reply, state } = makeReply();
      await hook(makeReq({ auth: 'Bearer good' }), reply);
      expect(state.status).toBeUndefined();
      expect((reply as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    });
  });
});
