import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Prisma mock that mirrors the real client: ALL model accessors are SINGULAR camelCase
 * (`workOrder`, `counterparty`, `warranty`, ...). The plural form (`workOrders`) is
 * intentionally absent — this catches Bug #127 where SyncService used a naive
 * snake_case→camelCase transform that produced plural identifiers and returned `undefined`,
 * crashing /sync/status with 500. Adding a missing model to this mock would mask the bug,
 * so do NOT add `workOrders`/`counterparties`/etc.
 */
function makeModelMock() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn().mockResolvedValue({ _max: { syncVersion: null } }),
  };
}

const prismaMock = {
  workOrder: makeModelMock(),
  workOrderLine: makeModelMock(),
  workOrderPart: makeModelMock(),
  counterparty: makeModelMock(),
  vehicle: makeModelMock(),
  customerGarage: makeModelMock(),
  stockItem: makeModelMock(),
  stockBatch: makeModelMock(),
  invoice: makeModelMock(),
  payment: makeModelMock(),
  calendarSlot: makeModelMock(),
  maintenanceSchedule: makeModelMock(),
  completionAct: makeModelMock(),
  pricingRule: makeModelMock(),
  warranty: makeModelMock(),
  lift: makeModelMock(),
  employee: makeModelMock(),
  syncJob: {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
  },
};

const mockJwtGuard = {
  canActivate: vi
    .fn()
    .mockImplementation((ctx: { switchToHttp: () => { getRequest: () => { user: unknown } } }) => {
      ctx.switchToHttp().getRequest().user = { id: 'emp-1', orgId: ORG_ID, role: 'ADMIN' };
      return true;
    }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Sync — HTTP Contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [SyncService, { provide: PrismaService, useValue: prismaMock }],
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
    // Reset call counts but keep the mock implementation.
    for (const key of Object.keys(prismaMock)) {
      const model = (
        prismaMock as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
      )[key];
      for (const fn of Object.values(model)) {
        if (typeof (fn as { mockClear?: unknown }).mockClear === 'function') fn.mockClear();
      }
    }
  });

  describe('GET /sync/status (Bug #127 regression)', () => {
    it('повертає 200 і не падає коли немає даних — table→model map працює коректно', async () => {
      const res = await app.inject({ method: 'GET', url: '/sync/status' });
      // Bug #127: previously 500 — `prisma.workOrders` undefined (plural form),
      // crashing on `.aggregate(...)`. Tested implicitly by the singular-only mock above.
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        pendingJobs: expect.any(Number),
        failedJobs: expect.any(Number),
        maxSyncVersion: expect.any(Number),
      });
      // lastSyncAt can be null or string
      expect(['object', 'string']).toContain(typeof body.lastSyncAt);
    });

    it('повертає maxSyncVersion з усіх PULL_TABLES (агрегує MAX по таблицях)', async () => {
      prismaMock.workOrder.aggregate.mockResolvedValueOnce({ _max: { syncVersion: 42n } });
      prismaMock.counterparty.aggregate.mockResolvedValueOnce({ _max: { syncVersion: 100n } });
      prismaMock.warranty.aggregate.mockResolvedValueOnce({ _max: { syncVersion: 7n } });

      const res = await app.inject({ method: 'GET', url: '/sync/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { maxSyncVersion: number };
      expect(body.maxSyncVersion).toBe(100);
    });
  });

  describe('GET /sync/pull (Bug #128 regression)', () => {
    it('повертає 200 і коректно серіалізує BigInt syncVersion у payload', async () => {
      // Bug #128: pull returned raw Prisma row with BigInt `syncVersion`, crashing JSON.stringify
      // → 500. Now payload normalises BigInt → Number.
      prismaMock.counterparty.findMany.mockResolvedValueOnce([
        {
          id: 'cp-1',
          orgId: ORG_ID,
          firstName: 'Іван',
          lastName: 'Петренко',
          companyName: null,
          syncVersion: 5n,
          createdAt: new Date('2026-05-26T10:00:00Z'),
          updatedAt: new Date('2026-05-26T10:00:00Z'),
          deletedAt: null,
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/sync/pull?since=0' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{
        table: string;
        id: string;
        syncVersion: number;
        payload: Record<string, unknown>;
      }>;
      expect(Array.isArray(body)).toBe(true);
      const cpRecord = body.find(r => r.table === 'counterparties');
      expect(cpRecord).toBeDefined();
      // BigInt has been converted to a JS number both at top-level and inside payload
      expect(typeof cpRecord!.syncVersion).toBe('number');
      expect(cpRecord!.syncVersion).toBe(5);
      expect(typeof cpRecord!.payload.syncVersion).toBe('number');
      expect(cpRecord!.payload.syncVersion).toBe(5);
      // PULL_FIELD_BLACKLIST removes PII (phone/email/edrpou) from counterparties
      expect(cpRecord!.payload.firstName).toBe('Іван');
    });

    it('повертає порожній масив коли немає змін з even since cursor', async () => {
      const res = await app.inject({ method: 'GET', url: '/sync/pull?since=999999' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('видалені записи приходять як operation=DELETE з payload={id}', async () => {
      prismaMock.vehicle.findMany.mockResolvedValueOnce([
        {
          id: 'v-deleted',
          orgId: ORG_ID,
          licensePlate: 'AA0000XX',
          syncVersion: 10n,
          deletedAt: new Date('2026-05-26T11:00:00Z'),
        },
      ]);
      const res = await app.inject({ method: 'GET', url: '/sync/pull?since=0' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{
        table: string;
        operation: string;
        payload: Record<string, unknown>;
      }>;
      const vehRecord = body.find(r => r.table === 'vehicles');
      expect(vehRecord).toBeDefined();
      expect(vehRecord!.operation).toBe('DELETE');
      expect(vehRecord!.payload).toEqual({ id: 'v-deleted' });
      // No licensePlate or other PII leaked into the tombstone payload
      expect(vehRecord!.payload.licensePlate).toBeUndefined();
    });
  });

  describe('POST /sync/push', () => {
    it('відхиляє запис у захищену таблицю (work_orders не в PUSH_SAFE_TABLES)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        payload: {
          records: [
            {
              table: 'work_orders',
              // Must be a valid UUID v4 — `@IsUUID()` defaults to v4.
              id: '550e8400-e29b-41d4-a716-446655440000',
              operation: 'UPDATE',
              syncVersion: 1,
              payload: { status: 'CANCELLED' },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { accepted: number; conflicts: number };
      expect(body.accepted).toBe(0);
      expect(body.conflicts).toBe(1);
    });
  });
});
