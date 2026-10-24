import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { WorkOrderShareService } from './work-order-share.service';
import { EstimateExportService } from './work-orders-export.service';
import { WorkOrdersController } from './work-orders.controller';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── BR-WO-032: термін дії й відкликання посилання на кошторис ──────────────────────────────────
//
// Фейкова Prisma ВИКОНУЄ `where` (id, orgId, deletedAt, shareToken, shareTokenExpiresAt.gt,
// status.in) над таблицею в пам'яті — тест про відбір, тож заготовлена відповідь нічого б не
// довела: прострочений токен «знаходився» б і без фільтра.

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const WO = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-24T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_LATER = new Date(NOW.getTime() + 30 * DAY);
const INVALID = 'Посилання не дійсне або термін дії минув';

interface Row {
  id: string;
  orgId: string;
  status: string;
  deletedAt: Date | null;
  shareToken: string | null;
  shareTokenExpiresAt: Date | null;
}

type Cond = Record<string, unknown>;

function matches(row: Row, where: Cond): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { gt?: Date; in?: unknown[] };
      if ('gt' in c) return value instanceof Date && c.gt instanceof Date && value > c.gt;
      if ('in' in c) return (c.in ?? []).includes(value);
      throw new Error(`fake prisma: непідтримана умова для ${key}`);
    }
    return value === cond;
  });
}

function makeDb(rows: Row[]) {
  // Публічний кошторис і експорт читають ще й шапку/рядки — для відбору вони не важать.
  const asWorkOrder = (r: Row) => ({
    ...r,
    number: 'WO-2026-0001',
    documentDate: new Date('2026-10-24'),
    description: null,
    inMileage: null,
    totalLabor: 0,
    totalActualLabor: 0,
    totalParts: 0,
    totalNet: 0,
    totalAmount: 0,
    branch: { name: 'Філія' },
    counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
    vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA0000AA' },
    lines: [],
    parts: [],
  });
  const workOrder = {
    findFirst: vi.fn(({ where }: { where: Cond }) => {
      const row = rows.find(r => matches(r, where));
      return Promise.resolve(row ? asWorkOrder(row) : null);
    }),
    updateMany: vi.fn(({ where, data }: { where: Cond; data: Partial<Row> }) => {
      const hit = rows.filter(r => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return Promise.resolve({ count: hit.length });
    }),
  };
  const prisma = {
    workOrder,
    organisation: { findFirst: vi.fn().mockResolvedValue({ name: 'СТО', logoUrl: null }) },
    goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  return { prisma, workOrder };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: WO,
  orgId: ORG,
  status: 'ESTIMATE',
  deletedAt: null,
  shareToken: null,
  shareTokenExpiresAt: null,
  ...over,
});

const share = (prisma: PrismaService) =>
  new WorkOrderShareService(prisma, null as never, null as never);

describe('BR-WO-032 — посилання на кошторис: термін дії, перегенерація, відкликання', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-032
  it('новий токен живе рівно 30 днів: термін у БД і в відповіді', async () => {
    const rows = [row()];
    const { prisma } = makeDb(rows);

    const res = await share(prisma).getOrCreateShareToken(ORG, WO);

    expect(res.token).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0]?.shareToken).toBe(res.token);
    expect(rows[0]?.shareTokenExpiresAt?.toISOString()).toBe(THIRTY_DAYS_LATER.toISOString());
    expect(res.expiresAt).toBe(THIRTY_DAYS_LATER.toISOString());
  });

  // guards: BR-WO-032
  it('чинний токен повертається як є — без нового токена й без продовження терміну', async () => {
    const expiresAt = new Date(NOW.getTime() + 5 * DAY);
    const rows = [row({ shareToken: 'live-token', shareTokenExpiresAt: expiresAt })];
    const { prisma, workOrder } = makeDb(rows);

    const res = await share(prisma).getOrCreateShareToken(ORG, WO);

    expect(res).toEqual({ token: 'live-token', expiresAt: expiresAt.toISOString() });
    expect(workOrder.updateMany).not.toHaveBeenCalled();
    expect(rows[0]?.shareTokenExpiresAt).toBe(expiresAt);
  });

  // guards: BR-WO-032
  it('прострочений токен замінюється новим на 30 днів, старе посилання більше не відкривається', async () => {
    const rows = [
      row({ shareToken: 'stale-token', shareTokenExpiresAt: new Date(NOW.getTime() - 1) }),
    ];
    const { prisma } = makeDb(rows);
    const service = share(prisma);

    const res = await service.getOrCreateShareToken(ORG, WO);

    expect(res.token).not.toBe('stale-token');
    expect(res.expiresAt).toBe(THIRTY_DAYS_LATER.toISOString());
    await expect(service.findByShareToken('stale-token')).rejects.toThrow(INVALID);
    await expect(service.findByShareToken(res.token)).resolves.toMatchObject({
      number: 'WO-2026-0001',
    });
  });

  // guards: BR-WO-032
  it('токен без терміну (наряди до міграції) на POST отримує новий токен і термін', async () => {
    const rows = [row({ shareToken: 'legacy-token', shareTokenExpiresAt: null })];
    const { prisma } = makeDb(rows);

    const res = await share(prisma).getOrCreateShareToken(ORG, WO);

    expect(res.token).not.toBe('legacy-token');
    expect(rows[0]?.shareTokenExpiresAt?.toISOString()).toBe(THIRTY_DAYS_LATER.toISOString());
  });

  // guards: BR-WO-032
  it('паралельний POST уже замінив токен — повертається його токен, не перезаписується', async () => {
    const rows = [row()];
    const { prisma, workOrder } = makeDb(rows);
    // Між читанням і умовним update інший запит видав свій токен.
    const read = workOrder.findFirst.getMockImplementation()!;
    workOrder.findFirst.mockImplementationOnce(async args => {
      const snapshot = await read(args);
      Object.assign(rows[0]!, {
        shareToken: 'winner-token',
        shareTokenExpiresAt: THIRTY_DAYS_LATER,
      });
      return snapshot;
    });

    const res = await share(prisma).getOrCreateShareToken(ORG, WO);

    expect(res).toEqual({ token: 'winner-token', expiresAt: THIRTY_DAYS_LATER.toISOString() });
    expect(rows[0]?.shareToken).toBe('winner-token');
  });

  // guards: BR-WO-032
  it('кошторис відкривається до кінця терміну і не відкривається одразу після', async () => {
    const rows = [row()];
    const { prisma } = makeDb(rows);
    const service = share(prisma);
    const { token } = await service.getOrCreateShareToken(ORG, WO);

    vi.setSystemTime(new Date(THIRTY_DAYS_LATER.getTime() - 1));
    await expect(service.findByShareToken(token)).resolves.toMatchObject({ status: 'ESTIMATE' });

    vi.setSystemTime(THIRTY_DAYS_LATER);
    await expect(service.findByShareToken(token)).rejects.toThrow(INVALID);
  });

  // guards: BR-WO-032
  it('токен без терміну не відкриває кошторис — той самий «недійсне», що й невідомий токен', async () => {
    const rows = [row({ shareToken: 'legacy-token', shareTokenExpiresAt: null })];
    const service = share(makeDb(rows).prisma);

    await expect(service.findByShareToken('legacy-token')).rejects.toThrow(INVALID);
    await expect(service.findByShareToken('unknown-token')).rejects.toThrow(INVALID);
  });

  // guards: BR-WO-032
  it('відкликання: токен і термін у null, старе посилання мертве, наступний POST — новий токен', async () => {
    const rows = [row()];
    const { prisma } = makeDb(rows);
    const service = share(prisma);
    const { token } = await service.getOrCreateShareToken(ORG, WO);

    await expect(service.revokeShareToken(ORG, WO)).resolves.toEqual({
      token: null,
      expiresAt: null,
    });

    expect(rows[0]).toMatchObject({ shareToken: null, shareTokenExpiresAt: null });
    await expect(service.findByShareToken(token)).rejects.toThrow(INVALID);
    const again = await service.getOrCreateShareToken(ORG, WO);
    expect(again.token).not.toBe(token);
  });

  // guards: BR-WO-032
  it('відкликання чужого наряду — 404, посилання власника наряду живе (orgId у where)', async () => {
    const rows = [row({ shareToken: 'owner-token', shareTokenExpiresAt: THIRTY_DAYS_LATER })];
    const { prisma, workOrder } = makeDb(rows);
    const service = share(prisma);

    await expect(service.revokeShareToken(OTHER_ORG, WO)).rejects.toThrow('Наряд не знайдено');

    expect(workOrder.updateMany.mock.calls[0]?.[0].where).toMatchObject({ orgId: OTHER_ORG });
    expect(rows[0]?.shareToken).toBe('owner-token');
  });

  // guards: BR-WO-032
  it('експорт PDF/XLSX/DOCX бере той самий відбір: прострочений токен — 404, чинний — дані', async () => {
    const rows = [
      row({ shareToken: 'live-token', shareTokenExpiresAt: THIRTY_DAYS_LATER }),
      row({
        id: '22222222-2222-4222-8222-222222222222',
        shareToken: 'stale-token',
        shareTokenExpiresAt: new Date(NOW.getTime() - 1),
      }),
    ];
    const exportService = new EstimateExportService(makeDb(rows).prisma);

    await expect(exportService.getEstimateData('live-token')).resolves.toMatchObject({
      number: 'WO-2026-0001',
    });
    await expect(exportService.getEstimateData('stale-token')).rejects.toThrow(INVALID);
  });
});

describe('BR-WO-032 — маршрути посилання на кошторис', () => {
  const rolesOf = (handler: unknown): string[] =>
    [...((Reflect.getMetadata(ROLES_KEY, handler as object) as string[] | undefined) ?? [])].sort();
  const SHARE_ROLES = ['ADMIN', 'OWNER', 'RECEPTIONIST'];

  // guards: BR-WO-032
  it('DELETE /work-orders/:id/share-token відкликає посилання', () => {
    const handler = WorkOrdersController.prototype.revokeShareToken;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/share-token');
  });

  // guards: BR-WO-032
  it.each(['getShareToken', 'revokeShareToken'] as const)(
    '%s — лише власник, адміністратор і приймальник',
    method => {
      expect(rolesOf(WorkOrdersController.prototype[method])).toEqual(SHARE_ROLES);
    },
  );
});
