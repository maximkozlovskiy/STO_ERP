import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { VehicleMileagePoint } from '@sto/shared';
import { VehiclesService } from './vehicles.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * Аспект: історія пробігу авто — `VehiclesService.getMileageHistory(orgId, vehicleId)`.
 * Правила BR-VEH-001…005 (docs/objects/vehicle.md). Тести написано З ПРАВИЛ, до появи коду.
 *
 * Чому тут не `mockResolvedValue`, а маленька in-memory "таблиця". Контракт не каже, де
 * саме сервіс відсіює, сортує й обрізає — у `where`/`orderBy`/`take` запиту чи в коді після
 * нього. Статичний мок завалив би чесну реалізацію першого типу (повернув би 205 рядків
 * попри `take: 200`) або пропустив би зламану другого. Тому `findMany`/`findFirst` нижче
 * ВИКОНУЮТЬ передані `where`/`orderBy`/`skip`/`take` над рядками тесту, і тести дивляться
 * на РЕЗУЛЬТАТ методу. Підмножина Prisma свідомо вузька: скалярні поля, `AND`/`OR`/`NOT`,
 * `equals`/`not`/`in`/`notIn`/`lt`/`lte`/`gt`/`gte`. Усе інше кидає помилку з префіксом
 * `[fake prisma]` — це межа тесту, а не порушення правила.
 */

type Row = Record<string, unknown>;
type FindArgs = { where?: Row; orderBy?: unknown; skip?: number; take?: number };

const FAKE = '[fake prisma]';
const norm = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);
const compare = (a: unknown, b: unknown): number => {
  const x = norm(a) as number | string;
  const y = norm(b) as number | string;
  if (x === y) return 0;
  return x < y ? -1 : 1;
};
const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true; // Prisma ігнорує undefined-умову
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
    return norm(value) === norm(cond);
  }
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case 'equals':
        return norm(value) === norm(arg);
      case 'not':
        return !matchField(value, arg);
      case 'in':
        return (arg as unknown[]).some(a => norm(a) === norm(value));
      case 'notIn':
        return !(arg as unknown[]).some(a => norm(a) === norm(value));
      case 'lt':
        return value != null && compare(value, arg) < 0;
      case 'lte':
        return value != null && compare(value, arg) <= 0;
      case 'gt':
        return value != null && compare(value, arg) > 0;
      case 'gte':
        return value != null && compare(value, arg) >= 0;
      default:
        throw new Error(`${FAKE} непідтримуваний оператор where: "${op}"`);
    }
  });
}

function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return asArray(cond as Row | Row[]).every(w => matchWhere(row, w));
    if (key === 'OR') return (cond as Row[]).some(w => matchWhere(row, w));
    if (key === 'NOT') return asArray(cond as Row | Row[]).every(w => !matchWhere(row, w));
    if (!(key in row)) throw new Error(`${FAKE} невідоме поле у where: "${key}"`);
    return matchField(row[key], cond);
  });
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = asArray(orderBy as Row | Row[]).flatMap(o => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [field, raw] of specs) {
      if (!(field in a)) throw new Error(`${FAKE} невідоме поле в orderBy: "${field}"`);
      const dir = typeof raw === 'string' ? raw : (raw as { sort: string }).sort;
      // Postgres за замовчуванням: ASC → NULLS LAST, DESC → NULLS FIRST.
      const nulls =
        (typeof raw === 'string' ? undefined : (raw as { nulls?: string }).nulls) ??
        (dir === 'asc' ? 'last' : 'first');
      const av = a[field];
      const bv = b[field];
      if (av == null || bv == null) {
        if (av == null && bv == null) continue;
        return (av == null) === (nulls === 'first') ? -1 : 1;
      }
      const c = compare(av, bv);
      if (c !== 0) return dir === 'asc' ? c : -c;
    }
    return 0;
  });
}

function runFind(rows: Row[], args: FindArgs = {}): Row[] {
  let out = sortRows(
    rows.filter(r => matchWhere(r, args.where)),
    args.orderBy,
  );
  if (args.skip) out = out.slice(args.skip);
  if (typeof args.take === 'number') {
    out = args.take >= 0 ? out.slice(0, args.take) : out.slice(args.take);
  }
  return out;
}

const DAY = 24 * 60 * 60 * 1000;
const d = (iso: string) => new Date(iso);

describe('VehiclesService — історія пробігу (BR-VEH-001…005)', () => {
  let service: VehiclesService;
  let prisma: { vehicle: PrismaModelMock; workOrder: PrismaModelMock };
  let vehicles: Row[];
  let workOrders: Row[];

  const vehicle = (overrides: Row = {}): Row => ({
    id: 'veh-1',
    orgId: 'org-1',
    customerGarageId: 'gar-1',
    make: 'Toyota',
    model: 'Camry',
    currentMileage: null,
    deletedAt: null,
    ...overrides,
  });

  /** Наряд свого авто у своїй org; пробіг за замовчуванням НЕ зафіксовано. */
  const wo = (id: string, overrides: Row = {}): Row => ({
    id,
    orgId: 'org-1',
    vehicleId: 'veh-1',
    number: `WO-${id}`,
    status: 'COMPLETED',
    inMileage: null,
    outMileage: null,
    completedAt: null,
    documentDate: d('2026-01-01T00:00:00Z'),
    createdAt: d('2026-01-01T00:00:00Z'),
    updatedAt: d('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  const history = (orgId = 'org-1', vehicleId = 'veh-1'): Promise<VehicleMileagePoint[]> =>
    service.getMileageHistory(orgId, vehicleId);

  const ids = (points: VehicleMileagePoint[]) => points.map(p => p.workOrderId);
  const time = (p: VehicleMileagePoint) => new Date(p.date).getTime();

  beforeEach(async () => {
    vehicles = [vehicle()];
    workOrders = [];
    prisma = {
      vehicle: {
        findFirst: vi.fn((args?: FindArgs) => Promise.resolve(runFind(vehicles, args)[0] ?? null)),
      },
      workOrder: {
        findMany: vi.fn((args?: FindArgs) => Promise.resolve(runFind(workOrders, args))),
      },
    };

    const module = await Test.createTestingModule({
      providers: [VehiclesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(VehiclesService);
  });

  describe('BR-VEH-001 — які наряди входять і звідки пробіг', () => {
    // guards: BR-VEH-001
    it('пробіг запису = outMileage, а якщо його немає — inMileage', async () => {
      workOrders = [
        wo('a', {
          number: 'WO-000101',
          inMileage: 119_000,
          outMileage: 120_000,
          completedAt: d('2026-02-01T10:00:00Z'),
        }),
        wo('b', {
          number: 'WO-000102',
          inMileage: 130_000,
          outMileage: null,
          completedAt: d('2026-03-01T10:00:00Z'),
        }),
      ];

      const res = await history();

      expect(res).toHaveLength(2);
      expect(res[0]).toMatchObject({
        workOrderId: 'a',
        workOrderNumber: 'WO-000101',
        mileage: 120_000,
      });
      expect(res[1]).toMatchObject({
        workOrderId: 'b',
        workOrderNumber: 'WO-000102',
        mileage: 130_000,
      });
    });

    // guards: BR-VEH-001
    it('наряд без inMileage і без outMileage в історію не входить', async () => {
      workOrders = [
        wo('with', { outMileage: 100_000, completedAt: d('2026-02-01T10:00:00Z') }),
        wo('without', { completedAt: d('2026-03-01T10:00:00Z') }),
      ];

      const res = await history();

      expect(ids(res)).toEqual(['with']);
      expect(res.every(p => typeof p.mileage === 'number')).toBe(true);
    });

    // guards: BR-VEH-001
    it('CANCELLED-наряд не входить навіть із пробігом; решта статусів входять', async () => {
      workOrders = [
        wo('draft', {
          status: 'DRAFT',
          inMileage: 100_000,
          documentDate: d('2026-02-01T00:00:00Z'),
        }),
        wo('progress', {
          status: 'IN_PROGRESS',
          inMileage: 101_000,
          documentDate: d('2026-02-02T00:00:00Z'),
        }),
        wo('cancelled', {
          status: 'CANCELLED',
          inMileage: 102_000,
          outMileage: 102_500,
          documentDate: d('2026-02-03T00:00:00Z'),
        }),
        wo('archived', {
          status: 'ARCHIVED',
          outMileage: 103_000,
          completedAt: d('2026-02-04T10:00:00Z'),
        }),
      ];

      expect(ids(await history())).toEqual(['draft', 'progress', 'archived']);
    });

    // guards: BR-VEH-001
    it('soft-deleted наряд (deletedAt) не входить', async () => {
      workOrders = [
        wo('alive', { outMileage: 100_000, completedAt: d('2026-02-01T10:00:00Z') }),
        wo('deleted', {
          outMileage: 105_000,
          completedAt: d('2026-03-01T10:00:00Z'),
          deletedAt: d('2026-03-05T00:00:00Z'),
        }),
      ];

      expect(ids(await history())).toEqual(['alive']);
    });

    // guards: BR-VEH-001
    it('наряд іншого авто або іншої організації не входить', async () => {
      workOrders = [
        wo('mine', { outMileage: 100_000, completedAt: d('2026-02-01T10:00:00Z') }),
        wo('other-vehicle', {
          vehicleId: 'veh-2',
          outMileage: 50_000,
          completedAt: d('2026-02-02T10:00:00Z'),
        }),
        wo('other-org', {
          orgId: 'org-2',
          outMileage: 60_000,
          completedAt: d('2026-02-03T10:00:00Z'),
        }),
      ];

      expect(ids(await history())).toEqual(['mine']);
    });

    // guards: BR-VEH-001
    it('запит нарядів обмежено у where: orgId + vehicleId + deletedAt:null (tenant isolation)', async () => {
      workOrders = [wo('mine', { outMileage: 100_000, completedAt: d('2026-02-01T10:00:00Z') })];

      await history('org-1', 'veh-1');

      expect(prisma.workOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ orgId: 'org-1', vehicleId: 'veh-1', deletedAt: null }),
        }),
      );
    });
  });

  describe('BR-VEH-002 — дата запису і порядок', () => {
    // guards: BR-VEH-002
    it('дата = completedAt, а якщо наряд не завершено — documentDate; це ISO-рядок', async () => {
      workOrders = [
        wo('done', {
          outMileage: 100_000,
          documentDate: d('2026-02-01T00:00:00Z'),
          completedAt: d('2026-02-05T14:30:00Z'),
        }),
        wo('open', {
          status: 'IN_PROGRESS',
          inMileage: 101_000,
          documentDate: d('2026-03-01T00:00:00Z'),
          completedAt: null,
        }),
      ];

      const res = await history();
      const done = res.find(p => p.workOrderId === 'done');
      const open = res.find(p => p.workOrderId === 'open');

      expect(typeof done?.date).toBe('string');
      expect(typeof open?.date).toBe('string');
      expect(done && time(done)).toBe(d('2026-02-05T14:30:00Z').getTime()); // не documentDate
      expect(open && time(open)).toBe(d('2026-03-01T00:00:00Z').getTime());
    });

    // guards: BR-VEH-002
    it('від старішого до новішого за ДАТОЮ ЗАПИСУ, хоч би в якому порядку прийшли рядки', async () => {
      // За самим documentDate вийшло б late, early, mid; за самим completedAt "mid" (null)
      // опинився б скраю. Правильний порядок — лише за completedAt ?? documentDate.
      // Номери навмисно йдуть у зворотному порядку: сортування за номером теж дасть не те.
      const early = wo('early', {
        number: 'WO-000903',
        outMileage: 100_000,
        documentDate: d('2026-01-20T00:00:00Z'),
        completedAt: d('2026-02-01T10:00:00Z'),
      });
      const mid = wo('mid', {
        number: 'WO-000902',
        status: 'IN_PROGRESS',
        inMileage: 101_000,
        documentDate: d('2026-02-10T00:00:00Z'),
        completedAt: null,
      });
      const late = wo('late', {
        number: 'WO-000901',
        outMileage: 102_000,
        documentDate: d('2026-01-10T00:00:00Z'),
        completedAt: d('2026-03-01T10:00:00Z'),
      });

      for (const order of [
        [early, mid, late],
        [late, mid, early],
        [mid, late, early],
      ]) {
        workOrders = order;
        const res = await history();
        expect(ids(res)).toEqual(['early', 'mid', 'late']);
        expect(res.map(time)).toEqual([...res.map(time)].sort((a, b) => a - b));
      }
    });

    // guards: BR-VEH-002
    it('рівна дата → за номером наряду', async () => {
      const same = d('2026-02-01T10:00:00Z');
      const first = wo('n1', { number: 'WO-000101', outMileage: 100_000, completedAt: same });
      const second = wo('n2', { number: 'WO-000102', outMileage: 100_100, completedAt: same });
      const third = wo('n3', { number: 'WO-000103', outMileage: 100_200, completedAt: same });

      for (const order of [
        [third, first, second],
        [second, third, first],
      ]) {
        workOrders = order;
        expect((await history()).map(p => p.workOrderNumber)).toEqual([
          'WO-000101',
          'WO-000102',
          'WO-000103',
        ]);
      }
    });
    // guards: BR-VEH-002, BR-VEH-003
    it('Bug #798: наряд, відкритий того ж дня ПІСЛЯ завершеного, стоїть за ним — завершений не стає відкатом', async () => {
      // documentDate — дата без часу (опівніч UTC), completedAt — момент того ж дня. Порівняння
      // міток часу ставило відкритий наряд (00:00Z) перед завершеним (17:23Z), і завершений
      // із меншим пробігом хибно отримував isRollback. Відтворено на живому API.
      const done = wo('done', {
        number: 'WO-001091',
        inMileage: 50_000,
        outMileage: 50_100,
        documentDate: d('2026-10-07T00:00:00Z'),
        completedAt: d('2026-10-07T17:23:57Z'),
      });
      const open = wo('open', {
        number: 'WO-001092',
        status: 'DRAFT',
        inMileage: 50_200,
        documentDate: d('2026-10-07T00:00:00Z'),
        completedAt: null,
      });

      for (const order of [
        [done, open],
        [open, done],
      ]) {
        workOrders = order;
        const res = await history();
        expect(ids(res)).toEqual(['done', 'open']);
        expect(res.map(p => p.isRollback)).toEqual([false, false]);
        // Дата запису лишається за правилом: completedAt / documentDate.
        expect(res.map(time)).toEqual([
          d('2026-10-07T17:23:57Z').getTime(),
          d('2026-10-07T00:00:00Z').getTime(),
        ]);
      }
    });

    // guards: BR-VEH-002
    it('Bug #798: день запису — за Києвом: завершений о 01:30 за Києвом належить новому дню, а не дню UTC', async () => {
      // 22:30Z 06.10 = 01:30 07.10 за Києвом (UTC+3). За днем UTC "night" потрапив би у 06.10
      // і став би перед "open" попри більший номер; за Києвом вони одного дня → за номером.
      const open = wo('open', {
        number: 'WO-000201',
        status: 'IN_PROGRESS',
        inMileage: 70_000,
        documentDate: d('2026-10-07T00:00:00Z'),
        completedAt: null,
      });
      const night = wo('night', {
        number: 'WO-000202',
        outMileage: 70_300,
        documentDate: d('2026-10-06T00:00:00Z'),
        completedAt: d('2026-10-06T22:30:00Z'),
      });
      // Контроль: попередній київський день справді стоїть раніше.
      const before = wo('before', {
        number: 'WO-000203',
        outMileage: 69_000,
        documentDate: d('2026-10-06T00:00:00Z'),
        completedAt: d('2026-10-06T20:30:00Z'), // 23:30 06.10 за Києвом
      });

      for (const order of [
        [night, open, before],
        [open, before, night],
      ]) {
        workOrders = order;
        const res = await history();
        expect(ids(res)).toEqual(['before', 'open', 'night']);
        expect(res.map(p => p.isRollback)).toEqual([false, false, false]);
      }
    });
  });

  describe('BR-VEH-003 — відкат пробігу', () => {
    // guards: BR-VEH-003
    it('пробіг менший за попередній → isRollback:true; запис лишається з внесеним значенням', async () => {
      workOrders = [
        wo('a', { outMileage: 100_000, completedAt: d('2026-01-10T10:00:00Z') }),
        wo('b', { outMileage: 120_000, completedAt: d('2026-02-10T10:00:00Z') }),
        wo('c', { outMileage: 90_000, completedAt: d('2026-03-10T10:00:00Z') }),
      ];

      const res = await history();

      expect(res.map(p => [p.workOrderId, p.mileage, p.isRollback])).toEqual([
        ['a', 100_000, false],
        ['b', 120_000, false],
        ['c', 90_000, true], // не відкинуто і не "виправлено" до 120 000
      ]);
    });

    // guards: BR-VEH-003
    it('порівняння з ПОПЕРЕДНІМ записом (не з максимумом); рівний пробіг і перший запис — не відкат', async () => {
      workOrders = [
        wo('a', { outMileage: 120_000, completedAt: d('2026-01-10T10:00:00Z') }),
        wo('b', { outMileage: 90_000, completedAt: d('2026-02-10T10:00:00Z') }),
        // > 90 000 (попередній), хоч і < 120 000 (максимум)
        wo('c', { outMileage: 95_000, completedAt: d('2026-03-10T10:00:00Z') }),
        wo('e', { outMileage: 95_000, completedAt: d('2026-04-10T10:00:00Z') }), // рівний
      ];

      const res = await history();

      expect(res.map(p => [p.workOrderId, p.isRollback])).toEqual([
        ['a', false],
        ['b', true],
        ['c', false],
        ['e', false],
      ]);
    });

    // guards: BR-VEH-003
    it('"попередній" — за порядком дат, а не за порядком рядків із БД', async () => {
      // У порядку вставки пробіг росте (100 000 → 150 000), у порядку дат — падає.
      workOrders = [
        wo('later', { outMileage: 100_000, completedAt: d('2026-02-10T10:00:00Z') }),
        wo('earlier', { outMileage: 150_000, completedAt: d('2026-01-10T10:00:00Z') }),
      ];

      const res = await history();

      expect(res.map(p => [p.workOrderId, p.isRollback])).toEqual([
        ['earlier', false],
        ['later', true],
      ]);
    });
  });

  describe('BR-VEH-004 — авто чужої організації або видалене → 404', () => {
    // Наряди з пробігом Є: без перевірки авто метод повернув би історію, а не 404.
    const seedHistory = () => {
      workOrders = [
        wo('a', { orgId: 'org-2', outMileage: 100_000, completedAt: d('2026-01-10T10:00:00Z') }),
        wo('b', { orgId: 'org-1', outMileage: 110_000, completedAt: d('2026-02-10T10:00:00Z') }),
      ];
    };

    // guards: BR-VEH-004
    it('авто чужої організації → NotFoundException, наряди не запитуються', async () => {
      vehicles = [vehicle({ orgId: 'org-2' })];
      seedHistory();

      await expect(history('org-1', 'veh-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workOrder.findMany).not.toHaveBeenCalled();
    });

    // guards: BR-VEH-004
    it('видалене авто → NotFoundException, наряди не запитуються', async () => {
      vehicles = [vehicle({ deletedAt: d('2026-03-01T00:00:00Z') })];
      seedHistory();

      await expect(history('org-1', 'veh-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workOrder.findMany).not.toHaveBeenCalled();
    });

    // guards: BR-VEH-004
    it('неіснуюче авто → NotFoundException, наряди не запитуються', async () => {
      vehicles = [];
      seedHistory();

      await expect(history('org-1', 'veh-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workOrder.findMany).not.toHaveBeenCalled();
    });

    // guards: BR-VEH-004
    it('текст 404 — той самий, що в GET /vehicles/:id («Автомобіль не знайдено»), для чужої org і для видаленого', async () => {
      const textOf = (p: Promise<unknown>) =>
        p.then(
          () => 'не кинуло',
          (e: unknown) =>
            e instanceof NotFoundException ? e.message : `інша помилка: ${String(e)}`,
        );

      for (const state of [
        [vehicle({ orgId: 'org-2' })],
        [vehicle({ deletedAt: d('2026-03-01T00:00:00Z') })],
      ]) {
        vehicles = state;
        seedHistory();
        const mileageText = await textOf(history('org-1', 'veh-1'));
        expect(mileageText).toBe('Автомобіль не знайдено');
        expect(mileageText).toBe(await textOf(service.findOne('org-1', 'veh-1')));
      }
    });

    // guards: BR-VEH-004
    it('своє активне авто: перевірка окремим findFirst з id + orgId + deletedAt:null → масив', async () => {
      const res = await history('org-1', 'veh-1');

      expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'veh-1', orgId: 'org-1', deletedAt: null }),
        }),
      );
      expect(res).toEqual([]); // авто без нарядів — порожній МАСИВ, не { items, total } і не 404
    });
  });

  describe('BR-VEH-005 — не більше 200 останніх записів', () => {
    const BASE = d('2025-01-01T10:00:00Z').getTime();
    /** n завершених нарядів: i-й — на i-й день, пробіг росте; рядки ПЕРЕМІШАНІ (крок 37). */
    const seed = (n: number): Row[] => {
      const rows = Array.from({ length: n }, (_, i) =>
        wo(`w${i}`, {
          number: `WO-${String(i).padStart(6, '0')}`,
          outMileage: 100_000 + i * 100,
          documentDate: new Date(BASE + i * DAY - 10 * 60 * 60 * 1000),
          completedAt: new Date(BASE + i * DAY),
        }),
      );
      return rows.map((_, i) => rows[(i * 37) % n]);
    };
    const expectedIds = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => `w${from + k}`);

    // guards: BR-VEH-005
    it('205 записів → рівно 200 ОСТАННІХ, від старішого до новішого', async () => {
      workOrders = seed(205);

      const res = await history();

      expect(res).toHaveLength(200);
      expect(ids(res)).toEqual(expectedIds(5, 204)); // 5 найстаріших відрізано, найновіший — останній
    });

    // guards: BR-VEH-005
    it('рівно 200 записів → усі 200 (межа включна)', async () => {
      workOrders = seed(200);

      expect(ids(await history())).toEqual(expectedIds(0, 199));
    });

    // guards: BR-VEH-003, BR-VEH-005
    it('відкат на межі обрізання: перший запис вікна лишається isRollback, хоча його попередника відрізано', async () => {
      // 201 запис: w0 відрізається. w1 (перший у вікні) має пробіг МЕНШИЙ за w0 — відкат
      // видно лише з повної історії. Позначка, порахована після slice, тут зникла б.
      workOrders = seed(201).map(row => (row.id === 'w0' ? { ...row, outMileage: 500_000 } : row));

      const res = await history();

      expect(res).toHaveLength(200);
      expect(res[0]?.workOrderId).toBe('w1');
      expect(res[0]?.isRollback).toBe(true);
      expect(res.slice(1).some(p => p.isRollback)).toBe(false);
    });

    // guards: BR-VEH-003, BR-VEH-005
    it('і навпаки: перший запис вікна без відкату не отримує позначку лише тому, що він перший', async () => {
      workOrders = seed(201);

      const res = await history();

      expect(res[0]?.workOrderId).toBe('w1');
      expect(res.some(p => p.isRollback)).toBe(false);
    });

    // guards: BR-VEH-005, BR-VEH-001
    it('ліміт рахує ЗАПИСИ історії: новіші наряди без пробігу / CANCELLED / видалені їх не витісняють', async () => {
      const after = (k: number) => new Date(BASE + (300 + k) * DAY);
      workOrders = [
        wo('no-mileage-1', { completedAt: after(1) }),
        wo('no-mileage-2', { completedAt: after(2) }),
        wo('cancelled', { status: 'CANCELLED', outMileage: 999_000, completedAt: after(3) }),
        wo('deleted', { outMileage: 998_000, completedAt: after(4), deletedAt: after(5) }),
        ...seed(205),
      ];

      const res = await history();

      expect(res).toHaveLength(200);
      expect(ids(res)).toEqual(expectedIds(5, 204));
    });

    // guards: BR-VEH-005, BR-VEH-002
    it('"останні" — за ДАТОЮ ЗАПИСУ: давно відкритий, але щойно завершений наряд не відрізається', async () => {
      // П'ять найновіших за completedAt нарядів відкрито ще 2020 року. Обрізання в запиті
      // за documentDate (take 200) викинуло б саме їх — мутація, яку решта кейсів не ловила.
      workOrders = seed(205).map(row =>
        ['w200', 'w201', 'w202', 'w203', 'w204'].includes(row.id as string)
          ? { ...row, documentDate: d('2020-01-01T00:00:00Z') }
          : row,
      );

      expect(ids(await history())).toEqual(expectedIds(5, 204));
    });
  });
});
