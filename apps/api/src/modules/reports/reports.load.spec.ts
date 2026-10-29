import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';

/**
 * Звіт «Завантаженість» (`ReportsService.load`) — що в ньому є (огляд звітів 2026-10-29).
 *
 * Підйомники без жодного запису за період теж у звіті (`totalSlots = 0`), щоб web показав їх
 * рядком «Ще N без записів», а не мовчки пропустив; видалені й чужі — ні; з філією — лише її.
 * Відсоток — з одним знаком після коми: 3 години за рік — «0,1 %», а не «0 %».
 * Довідник підйомників — сховище, що ВИКОНУЄ `where` (`matchesWhere`).
 *
 * Mutation-verify (2026-10-29): прибрати додавання підйомників без слотів → падає «без записів»;
 * прибрати `deletedAt: null` → падає «видалений»; `Math.round(x * 100)` → падає «один знак».
 */
type Row = Record<string, unknown>;
const ORG = 'org-1';
const lift = (id: string, over: Row = {}): Row => ({
  id,
  orgId: ORG,
  deletedAt: null,
  name: `П-${id}`,
  zone: { name: 'Зона', branchId: 'br-1', orgId: ORG },
  ...over,
});
const slot = (liftId: string, startIso: string, hours: number) => ({
  liftId,
  startAt: new Date(startIso),
  endAt: new Date(new Date(startIso).getTime() + hours * 3_600_000),
  lift: { name: `П-${liftId}`, zone: { name: 'Зона' } },
});

describe('ReportsService.load — завантаженість підйомників', () => {
  let service: ReportsService;
  let lifts: Row[];
  let slots: ReturnType<typeof slot>[];

  beforeEach(async () => {
    lifts = [];
    slots = [];
    const prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1' }) },
      calendarSlot: { findMany: vi.fn(() => Promise.resolve(slots)) },
      lift: {
        findMany: vi.fn(({ where }: { where: Row }) =>
          Promise.resolve(lifts.filter(l => matchesWhere(l, where))),
        ),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: {} },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  it('підйомник без записів за період — у звіті з нулями; видалений і чужий — ні', async () => {
    lifts = [
      lift('a'),
      lift('b'),
      lift('del', { deletedAt: new Date('2026-10-01T00:00:00Z') }),
      lift('foreign', { orgId: 'org-2' }),
    ];
    slots = [slot('a', '2026-10-05T07:00:00.000Z', 4)];
    const r = await service.load(ORG, '2026-10-01', '2026-10-31');
    const byId = Object.fromEntries(r.rows.map(x => [x.liftId, x]));
    expect(Object.keys(byId).sort()).toEqual(['a', 'b']);
    expect(byId.a).toMatchObject({ totalSlots: 1, totalHours: 4 });
    expect(byId.b).toMatchObject({
      liftName: 'П-b',
      zoneName: 'Зона',
      totalSlots: 0,
      loadPercent: 0,
    });
  });

  it('з філією — лише підйомники зон цієї філії', async () => {
    lifts = [lift('a'), lift('other', { zone: { name: 'Інша', branchId: 'br-2', orgId: ORG } })];
    const r = await service.load(ORG, '2026-10-01', '2026-10-31', 'br-1');
    expect(r.rows.map(x => x.liftId)).toEqual(['a']);
  });

  it('відсоток — з одним знаком після коми (3 години за рік — 0,1 %, не 0 %)', async () => {
    lifts = [lift('a')];
    slots = [slot('a', '2026-03-03T07:00:00.000Z', 3)];
    const r = await service.load(ORG, '2026-01-01', '2026-12-31');
    // 3 / (365 × 9) × 100 = 0.0913… → 0.1
    expect(r.rows[0]?.loadPercent).toBe(0.1);
  });
});
