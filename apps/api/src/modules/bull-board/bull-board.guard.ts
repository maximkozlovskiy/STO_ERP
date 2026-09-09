import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../auth/auth.dto';

const BULL_BOARD_PREFIX = '/api/admin/queues';
const ALLOWED_ROLES = ['OWNER', 'ADMIN'];

/**
 * D3 — auth-guard для bull-board.
 *
 * bull-board (@bull-board/nestjs на Fastify) монтується як Fastify-plugin: його роути
 * `/api/admin/queues/*` обслуговуються повз Nest-pipeline, тож ані @UseGuards, ані NestMiddleware
 * (`consumer.apply(...).forRoutes`) до них не доходять — перевірено live (без токена віддавав 200).
 *
 * Тому захист реалізуємо на рівні Fastify: глобальний `onRequest`-хук, що спрацьовує для КОЖНОГО
 * запиту. Для шляхів під BULL_BOARD_PREFIX вимагаємо bearer-JWT + роль OWNER/ADMIN, звіряючи тими
 * самими примітивами, що й JwtStrategy (secret JWT_ACCESS_SECRET, tokenVersion-revocation, роль).
 *
 * Монтується лише non-prod (BullBoardModule.register() у prod повертає порожній модуль, роут відсутній),
 * тож у prod цей хук — no-op (жоден запит не матчить префікс, бо самого UI немає).
 */
export async function registerBullBoardGuard(app: NestFastifyApplication): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    return; // bull-board не монтується на проді — гард не потрібен.
  }

  const jwt = app.get(JwtService, { strict: false });
  const config = app.get(ConfigService, { strict: false });
  const prisma = app.get(PrismaService, { strict: false });
  const logger = new Logger('BullBoardGuard');
  const secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');

  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // req.url включає query-string; матчимо лише сам шлях префіксу bull-board.
    const path = req.url.split('?')[0];
    if (path !== BULL_BOARD_PREFIX && !path.startsWith(`${BULL_BOARD_PREFIX}/`)) {
      return; // не bull-board — пропускаємо у звичайний pipeline.
    }

    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;

    const deny = async (status: number, message: string): Promise<void> => {
      await reply.status(status).send({ statusCode: status, message });
    };

    if (!token) {
      return deny(401, 'Потрібна автентифікація');
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify<JwtPayload>(token, { secret });
    } catch {
      return deny(401, 'Сесія недійсна');
    }

    const employee = await prisma.employee.findFirst({
      where: { id: payload.sub, orgId: payload.orgId, deletedAt: null },
      select: { role: true, authAccount: { select: { tokenVersion: true } } },
    });

    if (!employee) {
      return deny(401, 'Сесія недійсна');
    }

    const currentVersion = employee.authAccount?.tokenVersion ?? 0;
    if ((payload.tokenVersion ?? 0) !== currentVersion) {
      return deny(401, 'Сесія недійсна');
    }

    if (!ALLOWED_ROLES.includes(employee.role)) {
      return deny(403, 'Недостатньо прав для перегляду черг');
    }

    // авторизовано — хук завершується без reply, запит іде далі у bull-board plugin.
  });

  logger.log(`bull-board захищено (${BULL_BOARD_PREFIX}, OWNER/ADMIN, non-prod)`);
}
