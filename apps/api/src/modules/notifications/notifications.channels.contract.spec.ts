import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotificationChannelsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

/**
 * HTTP-контракт POST /notification-channels/:branchId/activate (ексклюзивна активація).
 * Перевіряє: ParseUUIDPipe на branchId, ValidationPipe(whitelist) на ActivateProviderDto,
 * прокидання orgId з JWT у сервіс, мапінг доменних винятків (BadRequest→400, NotFound→404),
 * happy-path {activeProvider}.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const BRANCH_ID = '22222222-2222-2222-2222-222222222222';

const serviceMock = {
  activateProvider: vi.fn(),
};

const mockJwtGuard = {
  canActivate: vi
    .fn()
    .mockImplementation((ctx: { switchToHttp: () => { getRequest: () => { user: unknown } } }) => {
      ctx.switchToHttp().getRequest().user = { id: 'user-1', orgId: ORG_ID, role: 'ADMIN' };
      return true;
    }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('NotificationChannels — POST /:branchId/activate contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [NotificationChannelsController],
      providers: [{ provide: NotificationsService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy-path: 201/200 + {activeProvider}, orgId з JWT прокинутий у сервіс', async () => {
    serviceMock.activateProvider.mockResolvedValue({ activeProvider: 'turbosms' });
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/${BRANCH_ID}/activate`,
      payload: { provider: 'turbosms' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(JSON.parse(res.body)).toEqual({ activeProvider: 'turbosms' });
    // Сервіс отримав саме (orgId з JWT, branchId з URL, provider з body).
    expect(serviceMock.activateProvider).toHaveBeenCalledWith(ORG_ID, BRANCH_ID, 'turbosms');
  });

  it('branchId не UUID → 400 (ParseUUIDPipe), сервіс не викликано', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/not-a-uuid/activate`,
      payload: { provider: 'turbosms' },
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.activateProvider).not.toHaveBeenCalled();
  });

  it('body без provider → 400 (ValidationPipe), сервіс не викликано', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/${BRANCH_ID}/activate`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.activateProvider).not.toHaveBeenCalled();
  });

  it('provider не рядок (число) → 400 (@IsString)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/${BRANCH_ID}/activate`,
      payload: { provider: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.activateProvider).not.toHaveBeenCalled();
  });

  it('зайві поля відкидаються whitelist-ом (лише provider доходить)', async () => {
    serviceMock.activateProvider.mockResolvedValue({ activeProvider: 'turbosms' });
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/${BRANCH_ID}/activate`,
      payload: { provider: 'turbosms', enabled: true, orgId: 'evil-org' },
    });
    expect(res.statusCode).toBeLessThan(300);
    // orgId з body проігноровано — сервіс отримав orgId з JWT.
    expect(serviceMock.activateProvider).toHaveBeenCalledWith(ORG_ID, BRANCH_ID, 'turbosms');
  });

  it('невідомий провайдер (сервіс кидає BadRequestException) → 400', async () => {
    serviceMock.activateProvider.mockRejectedValue(new BadRequestException('Невідомий провайдер'));
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/${BRANCH_ID}/activate`,
      payload: { provider: 'ghost' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('філія поза org (сервіс кидає NotFoundException) → 404', async () => {
    serviceMock.activateProvider.mockRejectedValue(new NotFoundException('Філію не знайдено'));
    const res = await app.inject({
      method: 'POST',
      url: `/notification-channels/${BRANCH_ID}/activate`,
      payload: { provider: 'turbosms' },
    });
    expect(res.statusCode).toBe(404);
  });
});
