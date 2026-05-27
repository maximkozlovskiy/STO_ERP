import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ENTITY_ID = '22222222-2222-2222-2222-222222222222';

const prismaMock = {
  auditEvent: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation(async (arr: Promise<unknown>[]) => Promise.all(arr)),
};

const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: { switchToHttp: () => { getRequest: () => { user: unknown } } }) => {
    ctx.switchToHttp().getRequest().user = { id: 'user-1', orgId: ORG_ID, role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Audit — HTTP Contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
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
    prismaMock.$transaction.mockImplementation(async (arr: Promise<unknown>[]) => Promise.all(arr));
  });

  describe('GET /audit', () => {
    it('повертає 400 при невалідному entityId UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/audit?entityType=WorkOrder&entityId=not-a-uuid`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при невідомому entityType (whitelist enforcement)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/audit?entityType=Counterfeit&entityId=${ENTITY_ID}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 200 з shape { items: AuditEventItem[], total: number }', async () => {
      prismaMock.auditEvent.findMany.mockResolvedValueOnce([
        {
          id: 'ev-1',
          action: 'UPDATE',
          diff: { status: { from: 'DRAFT', to: 'ESTIMATE' } },
          createdAt: new Date('2026-05-26T10:00:00Z'),
          user: { firstName: 'Іван', lastName: 'Петренко' },
        },
      ]);
      prismaMock.auditEvent.count.mockResolvedValueOnce(42);

      const res = await app.inject({
        method: 'GET',
        url: `/audit?entityType=WorkOrder&entityId=${ENTITY_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: unknown[]; total: number };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items).toHaveLength(1);
      expect(typeof body.total).toBe('number');
      // Bug #88 regression: total comes from prisma.count, NOT items.length.
      // With 1 item but count=42, the bug would have returned total=1 → 42 now.
      expect(body.total).toBe(42);
    });

    it('Bug #88 regression: коли findMany capped at 100, total має повернути справжній count з БД', async () => {
      const fakeItems = Array.from({ length: 100 }, (_, i) => ({
        id: `ev-${i}`,
        action: 'UPDATE',
        diff: {},
        createdAt: new Date(),
        user: { firstName: 'Test', lastName: 'User' },
      }));
      prismaMock.auditEvent.findMany.mockResolvedValueOnce(fakeItems);
      prismaMock.auditEvent.count.mockResolvedValueOnce(250);

      const res = await app.inject({
        method: 'GET',
        url: `/audit?entityType=Invoice&entityId=${ENTITY_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: unknown[]; total: number };
      expect(body.items).toHaveLength(100);
      expect(body.total).toBe(250);
    });

    it('кожен item містить id, action, diff, createdAt, user.firstName, user.lastName', async () => {
      prismaMock.auditEvent.findMany.mockResolvedValueOnce([
        {
          id: 'ev-1',
          action: 'CREATE',
          diff: { new: { status: 'DRAFT' } },
          createdAt: new Date('2026-05-26T10:00:00Z'),
          user: { firstName: 'Олена', lastName: 'Ковальчук' },
        },
      ]);
      prismaMock.auditEvent.count.mockResolvedValueOnce(1);

      const res = await app.inject({
        method: 'GET',
        url: `/audit?entityType=Vehicle&entityId=${ENTITY_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<Record<string, unknown>> };
      expect(body.items[0]).toMatchObject({
        id: expect.any(String),
        action: expect.any(String),
        diff: expect.any(Object),
        createdAt: expect.any(String),
        user: { firstName: expect.any(String), lastName: expect.any(String) },
      });
    });
  });
});
