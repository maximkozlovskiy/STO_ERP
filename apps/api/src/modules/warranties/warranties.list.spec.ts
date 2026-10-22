import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WARRANTY_EXPIRING_DAYS, WARRANTY_STATES, type WarrantyState } from '@sto/shared';
import { WarrantiesService } from './warranties.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { WarrantyListQueryDto } from './warranties.dto';

/**
 * Список вкладки «Гарантії» (BR-WAR-001…003) над сховищем у пам'яті: Prisma `where`, `orderBy`,
 * `skip/take` справді обчислюються над рядками, тож тест описує ПОВЕДІНКУ (що потрапило у
 * список і в якому стані), а не форму запиту. `contains` — як `ILIKE` Postgres: `_` і `%` без
 * екранування працюють як шаблон — інакше тест на буквальний `_` пройшов би й без екранування.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const cmp = (v: unknown) => (v instanceof Date ? v.getTime() : v);

/** LIKE-шаблон Prisma `contains` → RegExp, як його бачить Postgres ILIKE. */
function likeToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '_') re += '.';
    else if (ch === '%') re += '.*';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re, 'i');
}

function matches(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR') {
      if (!(cond as Where[]).some(w => matches(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Where[]).every(w => matches(row, w))) return false;
      continue;
    }
    if (!(key in row)) throw new Error(`fake: поле «${key}» відсутнє в рядку`);
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      if (cmp(value) !== cmp(cond)) return false;
      continue;
    }
    const ops = cond as Where;
    for (const [op, operand] of Object.entries(ops)) {
      if (op === 'mode') continue;
      const a = cmp(value) as number;
      const b = cmp(operand) as number;
      if (op === 'gt') {
        if (value === null || !(a > b)) return false;
      } else if (op === 'lte') {
        if (value === null || !(a <= b)) return false;
      } else if (op === 'not') {
        // SQL `<> x` / `IS NOT NULL`
        if (operand === null ? value === null : value === null || a === b) return false;
      } else if (op === 'contains') {
        if (ops.mode !== 'insensitive') throw new Error('fake: contains без mode insensitive');
        if (typeof value !== 'string' || !likeToRegExp(operand as string).test(value)) return false;
      } else if (op === 'is') {
        if (value === null || typeof value !== 'object') return false;
        if (!matches(value as Row, operand as Where)) return false;
      } else {
        throw new Error(`fake: оператор «${op}» не підтримано`);
      }
    }
  }
  return true;
}

function sortRows(rows: Row[], orderBy: Array<Record<string, 'asc' | 'desc'>>): Row[] {
  return [...rows].sort((x, y) => {
    for (const o of orderBy) {
      const [field, dir] = Object.entries(o)[0];
      const a = cmp(x[field]) as number | string;
      const b = cmp(y[field]) as number | string;
      if (a === b) continue;
      return (a < b ? -1 : 1) * (dir === 'asc' ? 1 : -1);
    }
    return 0;
  });
}

const ORG = 'org-1';
const DAY = 86_400_000;
// 00:30 23.10.2026 за Києвом (EEST, +03:00) — у UTC ще 22.10: межа «закінчується» мусить
// рахуватися від київського дня, інакше поріг зсунеться на добу.
const NOW = new Date('2026-10-22T21:30:00.000Z');
// addDaysKyiv(NOW, 30): київська дата 23.10 + 30 днів = 22.11, UTC-опівніч.
const UNTIL = new Date('2026-11-22T00:00:00.000Z');

interface WOpts {
  id: string;
  expiresAt: Date;
  claimedAt?: Date | null;
  orgId?: string;
  deletedAt?: Date | null;
  createdAt?: Date;
  number?: string;
  woDeletedAt?: Date | null;
  plate?: string | null;
  vehicle?: boolean;
  client?: { companyName?: string | null; lastName?: string | null; firstName?: string | null };
}

function wRow(o: WOpts): Row {
  return {
    id: o.id,
    orgId: o.orgId ?? ORG,
    workOrderId: `wo-${o.id}`,
    workOrderLineId: null,
    workOrderPartId: null,
    counterpartyId: `cp-${o.id}`,
    expiresAt: o.expiresAt,
    description: `Гарантія ${o.id}`,
    claimedAt: o.claimedAt ?? null,
    claimWoId: o.claimedAt ? 'wo-claim' : null,
    createdAt: o.createdAt ?? new Date('2026-10-01T10:00:00.000Z'),
    deletedAt: o.deletedAt ?? null,
    workOrder: {
      number: o.number ?? `WO-${o.id}`,
      deletedAt: o.woDeletedAt ?? null,
      vehicle:
        o.vehicle === false
          ? null
          : { make: 'Toyota', model: 'Corolla', licensePlate: o.plate ?? 'AA0000AA' },
    },
    counterparty: {
      companyName: o.client?.companyName ?? null,
      lastName: o.client?.lastName ?? 'Петренко',
      firstName: o.client?.firstName ?? 'Іван',
    },
  };
}

function buildPrisma(rows: Row[]) {
  const select = (where: Where) => rows.filter(r => matches(r, where));
  return {
    warranty: {
      findMany: vi.fn(
        (args: {
          where: Where;
          orderBy: Array<Record<string, 'asc' | 'desc'>>;
          skip: number;
          take: number;
        }) =>
          Promise.resolve(
            sortRows(select(args.where), args.orderBy).slice(args.skip, args.skip + args.take),
          ),
      ),
      count: vi.fn((args: { where: Where }) => Promise.resolve(select(args.where).length)),
    },
  };
}

const q = (over: Partial<WarrantyListQueryDto> = {}): WarrantyListQueryDto =>
  ({ page: 1, limit: 50, ...over }) as WarrantyListQueryDto;

// Стани рядків при NOW (BR-WAR-002): назва рядка → очікуваний стан.
const STATE_ROWS: Array<[WOpts, WarrantyState]> = [
  [{ id: 'w-active', expiresAt: new Date(UNTIL.getTime() + 1) }, 'ACTIVE'],
  [{ id: 'w-edge', expiresAt: UNTIL }, 'EXPIRING'],
  [{ id: 'w-soon', expiresAt: new Date(NOW.getTime() + 1) }, 'EXPIRING'],
  [{ id: 'w-now', expiresAt: NOW }, 'EXPIRED'],
  [{ id: 'w-past', expiresAt: new Date(NOW.getTime() - 5 * DAY) }, 'EXPIRED'],
  [{ id: 'w-claimed', expiresAt: new Date(NOW.getTime() + 90 * DAY), claimedAt: NOW }, 'CLAIMED'],
  [
    {
      id: 'w-claimed-past',
      expiresAt: new Date(NOW.getTime() - DAY),
      claimedAt: new Date(NOW.getTime() - 3 * DAY),
    },
    'CLAIMED',
  ],
];

describe('WarrantiesService.findAll — список вкладки «Гарантії»', () => {
  let service: WarrantiesService;
  let prisma: ReturnType<typeof buildPrisma>;

  async function setup(rows: Row[]) {
    prisma = buildPrisma(rows);
    const module = await Test.createTestingModule({
      providers: [WarrantiesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(WarrantiesService);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('BR-WAR-001: що потрапляє у список і форма відповіді', () => {
    // guards: BR-WAR-001
    it('лише своя організація, без видалених гарантій і без гарантій видалених нарядів', async () => {
      const future = new Date(NOW.getTime() + 60 * DAY);
      await setup([
        wRow({ id: 'w-own', expiresAt: future }),
        wRow({ id: 'w-foreign', expiresAt: future, orgId: 'org-2' }),
        wRow({ id: 'w-deleted', expiresAt: future, deletedAt: NOW }),
        wRow({ id: 'w-wo-deleted', expiresAt: future, woDeletedAt: NOW }),
      ]);

      const res = await service.findAll(ORG, q());

      expect(res.items.map(i => i.id)).toEqual(['w-own']);
      expect(res.total).toBe(1);
    });

    // guards: BR-WAR-001
    it('відповідь { items, total, page, limit }; рядок — поля гарантії + vehicleSummary і state', async () => {
      await setup([
        wRow({
          id: 'w-1',
          expiresAt: new Date(NOW.getTime() + 60 * DAY),
          number: 'WO-2026-0042',
          plate: 'AA1234BB',
          client: { companyName: 'ТОВ Колесо' },
        }),
        wRow({ id: 'w-2', expiresAt: new Date(NOW.getTime() + 61 * DAY), vehicle: false }),
      ]);

      const res = await service.findAll(ORG, q({ page: 1, limit: 20 }));

      expect(res).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(res.items[0]).toMatchObject({
        id: 'w-1',
        orgId: ORG,
        workOrderId: 'wo-w-1',
        workOrderNumber: 'WO-2026-0042',
        counterpartyName: 'ТОВ Колесо',
        vehicleSummary: 'Toyota Corolla (AA1234BB)',
        state: 'ACTIVE',
        isActive: true,
        claimedAt: null,
        expiresAt: new Date(NOW.getTime() + 60 * DAY).toISOString(),
      });
      // Наряд без авто — порожнє поле, а не «undefined undefined».
      expect(res.items[1].vehicleSummary).toBeNull();
    });

    // guards: BR-WAR-001
    it('порядок за замовчуванням — expiresAt за зростанням, при рівних — за id', async () => {
      const same = new Date(NOW.getTime() + 40 * DAY);
      await setup([
        wRow({ id: 'w-late', expiresAt: new Date(NOW.getTime() + 80 * DAY) }),
        wRow({ id: 'w-b', expiresAt: same }),
        wRow({ id: 'w-early', expiresAt: new Date(NOW.getTime() + 2 * DAY) }),
        wRow({ id: 'w-a', expiresAt: same }),
      ]);

      const res = await service.findAll(ORG, q());

      expect(res.items.map(i => i.id)).toEqual(['w-early', 'w-a', 'w-b', 'w-late']);
    });

    // guards: BR-WAR-001
    it('sortBy=createdAt&sortDir=desc — новіші першими; другий ключ id', async () => {
      await setup([
        wRow({
          id: 'w-old',
          expiresAt: new Date(NOW.getTime() + 2 * DAY),
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        wRow({
          id: 'w-new',
          expiresAt: new Date(NOW.getTime() + 90 * DAY),
          createdAt: new Date('2026-10-01T00:00:00Z'),
        }),
      ]);

      const res = await service.findAll(ORG, q({ sortBy: 'createdAt', sortDir: 'desc' }));

      expect(res.items.map(i => i.id)).toEqual(['w-new', 'w-old']);
    });

    // guards: BR-WAR-001
    it('пагінація: page/limit → зріз, total — усі відібрані', async () => {
      await setup(
        [1, 2, 3, 4, 5].map(n =>
          wRow({ id: `w-${n}`, expiresAt: new Date(NOW.getTime() + n * 10 * DAY) }),
        ),
      );

      const res = await service.findAll(ORG, q({ page: 2, limit: 2 }));

      expect(res.items.map(i => i.id)).toEqual(['w-3', 'w-4']);
      expect(res).toMatchObject({ total: 5, page: 2, limit: 2 });
    });

    it('?id= — лише ця гарантія (посилання з «Пов’язаних документів»)', async () => {
      const future = new Date(NOW.getTime() + 60 * DAY);
      await setup([wRow({ id: 'w-x', expiresAt: future }), wRow({ id: 'w-y', expiresAt: future })]);

      const res = await service.findAll(ORG, q({ id: 'w-y' }));

      expect(res.items.map(i => i.id)).toEqual(['w-y']);
    });
  });

  describe('BR-WAR-002: стан гарантії і фільтр ?state=', () => {
    // guards: BR-WAR-002
    it('стан на межах: зараз = закінчилась, поріг Київ-сьогодні + 30 днів = закінчується', async () => {
      await setup(STATE_ROWS.map(([o]) => wRow(o)));
      expect(WARRANTY_EXPIRING_DAYS).toBe(30);

      const res = await service.findAll(ORG, q());

      const got = Object.fromEntries(res.items.map(i => [i.id, i.state]));
      expect(got).toEqual(Object.fromEntries(STATE_ROWS.map(([o, s]) => [o.id, s])));
      // isActive (старе поле DTO) узгоджене зі станом: діє лише ACTIVE / EXPIRING.
      for (const i of res.items) {
        expect(i.isActive).toBe(i.state === 'ACTIVE' || i.state === 'EXPIRING');
      }
    });

    // guards: BR-WAR-002
    it.each(WARRANTY_STATES)(
      'фільтр state=%s відбирає в базі рівно рядки з цим обчисленим станом',
      async state => {
        await setup(STATE_ROWS.map(([o]) => wRow(o)));

        const res = await service.findAll(ORG, q({ state: [state] }));

        const expected = STATE_ROWS.filter(([, s]) => s === state).map(([o]) => o.id);
        expect(res.items.map(i => i.id).sort()).toEqual([...expected].sort());
        expect(res.items.every(i => i.state === state)).toBe(true);
        expect(res.total).toBe(expected.length);
      },
    );

    // guards: BR-WAR-002
    it('кілька станів (ACTIVE,EXPIRING) — обʼєднання', async () => {
      await setup(STATE_ROWS.map(([o]) => wRow(o)));

      const res = await service.findAll(ORG, q({ state: ['ACTIVE', 'EXPIRING'] }));

      expect(res.items.map(i => i.id)).toEqual(['w-soon', 'w-edge', 'w-active']);
    });

    // guards: BR-WAR-002
    it('взимку (EET, +02:00) поріг теж від київського дня: 22:30 UTC = вже наступна доба', async () => {
      const winterNow = new Date('2026-12-31T22:30:00.000Z'); // 00:30 01.01.2027 за Києвом
      vi.setSystemTime(winterNow);
      const until = new Date('2027-01-31T00:00:00.000Z'); // 01.01 + 30 днів
      await setup([
        wRow({ id: 'w-edge', expiresAt: until }),
        wRow({ id: 'w-after', expiresAt: new Date(until.getTime() + 1) }),
      ]);

      const res = await service.findAll(ORG, q());

      expect(Object.fromEntries(res.items.map(i => [i.id, i.state]))).toEqual({
        'w-edge': 'EXPIRING',
        'w-after': 'ACTIVE',
      });
    });
  });

  describe('BR-WAR-003: пошук ?q=', () => {
    const rows = () => [
      wRow({
        id: 'w-num',
        expiresAt: new Date(NOW.getTime() + 50 * DAY),
        number: 'WO-2026-0777',
      }),
      wRow({
        id: 'w-company',
        expiresAt: new Date(NOW.getTime() + 51 * DAY),
        client: { companyName: 'ТОВ Автосвіт', lastName: null, firstName: null },
      }),
      wRow({
        id: 'w-person',
        expiresAt: new Date(NOW.getTime() + 52 * DAY),
        client: { lastName: 'Коваленко', firstName: 'Олена' },
      }),
      wRow({ id: 'w-plate', expiresAt: new Date(NOW.getTime() + 53 * DAY), plate: 'AB_12CE' }),
      wRow({ id: 'w-plate2', expiresAt: new Date(NOW.getTime() + 54 * DAY), plate: 'ABX12CE' }),
    ];

    // guards: BR-WAR-003
    it.each([
      ['номер наряду', 'wo-2026-0777', ['w-num']],
      ['назва клієнта', 'автосвіт', ['w-company']],
      ['прізвище клієнта', 'КОВАЛЕНКО', ['w-person']],
      ["ім'я клієнта", 'олена', ['w-person']],
      ['номер авто', 'abx12', ['w-plate2']],
    ])('за %s без урахування регістру', async (_what, text, expected) => {
      await setup(rows());

      const res = await service.findAll(ORG, q({ q: text }));

      expect(res.items.map(i => i.id)).toEqual(expected);
    });

    // guards: BR-WAR-003
    it('`_` і `%` — звичайні символи, не шаблон', async () => {
      await setup(rows());

      expect((await service.findAll(ORG, q({ q: 'ab_12' }))).items.map(i => i.id)).toEqual([
        'w-plate',
      ]);
      expect((await service.findAll(ORG, q({ q: '%' }))).items).toEqual([]);
    });

    // guards: BR-WAR-003
    it('пошук разом із фільтром стану — перетин', async () => {
      await setup([
        ...rows(),
        wRow({
          id: 'w-num-claimed',
          expiresAt: new Date(NOW.getTime() + 50 * DAY),
          number: 'WO-2026-0777-1',
          claimedAt: NOW,
        }),
      ]);

      const res = await service.findAll(ORG, q({ q: '0777', state: ['CLAIMED'] }));

      expect(res.items.map(i => i.id)).toEqual(['w-num-claimed']);
    });

    it('пробіли — це «пошуку немає»', async () => {
      await setup(rows());

      expect((await service.findAll(ORG, q({ q: '   ' }))).total).toBe(5);
    });
  });
});
