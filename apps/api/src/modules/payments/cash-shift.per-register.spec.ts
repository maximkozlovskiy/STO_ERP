import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CashShiftService } from './cash-shift.service';
import { FiscalProviderRegistry } from './fiscal/fiscal-provider-registry';
import { ProviderConfigService } from './provider-config.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * BR-CASH-027 — зміна фіскальної каси своя в кожної каси (TECH-DEBT §10.19).
 *
 * Фейкова Prisma ВИКОНУЄ `where` над таблицями в пам'яті: тест про фільтр, і заготовка-відповідь
 * не помітила б, що з запиту зник `cashRegisterId`. Сценарій — дві фіскальні каси A і B в одній
 * філії, зміна відкрита лише на A.
 *
 * Mutation-verify (2026-10-23):
 *  - прибрати `cashRegisterId` із where `getCurrent` → «B бачить null» червоний;
 *  - прибрати перевірку каси в `getCurrent` → обидва кейси 404 червоні;
 *  - лічильник каси за `workOrder.branchId` замість `cashRegisterId` → кейс лічильника червоний;
 *  - прибрати `cashRegisterId` із where `findOpenShift` → кейс обробника «B — null» червоний.
 */

type Row = Record<string, unknown>;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const BR = 'br-1';
const BR2 = 'br-2';
const REG_A = 'reg-a';
const REG_B = 'reg-b';

/** Рівність поля where: вкладений обʼєкт — фільтр за звʼязком (resolve повертає повʼязаний рядок). */
function matches(row: Row, where: Row, resolve: (rel: string, row: Row) => Row | null): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const related = resolve(key, row);
      return !!related && matches(related, cond as Row, resolve);
    }
    return (row[key] ?? null) === cond;
  });
}

function makeDb() {
  const tables = {
    cashRegister: [] as Row[],
    cashShift: [] as Row[],
    payment: [] as Row[],
    workOrder: [] as Row[],
  };
  const resolve = (rel: string, row: Row): Row | null => {
    if (rel === 'workOrder') return tables.workOrder.find(w => w.id === row.workOrderId) ?? null;
    if (rel === 'cashRegister')
      return tables.cashRegister.find(r => r.id === row.cashRegisterId) ?? null;
    return null;
  };
  const pick = (row: Row, select?: Row) =>
    select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : { ...row };
  const withInclude = (row: Row, include?: Row) =>
    include?.cashRegister
      ? { ...row, cashRegister: { name: resolve('cashRegister', row)?.name ?? null } }
      : { ...row };
  const latestFirst = (rows: Row[]) =>
    [...rows].sort((a, b) => (b.openedAt as Date).getTime() - (a.openedAt as Date).getTime());
  const oldestFirst = (rows: Row[]) =>
    [...rows].sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());

  const prisma = {
    cashRegister: {
      findFirst: vi.fn((args: { where: Row; select?: Row }) => {
        const hit = oldestFirst(tables.cashRegister).find(r => matches(r, args.where, resolve));
        return Promise.resolve(hit ? pick(hit, args.select) : null);
      }),
    },
    cashShift: {
      findFirst: vi.fn((args: { where: Row; select?: Row; include?: Row }) => {
        const hit = latestFirst(tables.cashShift).find(s => matches(s, args.where, resolve));
        if (!hit) return Promise.resolve(null);
        return Promise.resolve(
          args.select ? pick(hit, args.select) : withInclude(hit, args.include),
        );
      }),
      create: vi.fn((args: { data: Row; include?: Row }) => {
        const row = {
          id: `shift-${tables.cashShift.length + 1}`,
          openedAt: new Date('2026-10-23T09:00:00Z'),
          closedAt: null,
          zReportId: null,
          deletedAt: null,
          ...args.data,
        };
        tables.cashShift.push(row);
        return Promise.resolve(withInclude(row, args.include));
      }),
    },
    payment: {
      count: vi.fn((args: { where: Row }) =>
        Promise.resolve(tables.payment.filter(p => matches(p, args.where, resolve)).length),
      ),
    },
  };
  return { tables, prisma };
}

describe('CashShiftService — зміна своя в кожної каси (BR-CASH-027)', () => {
  let service: CashShiftService;
  let db: ReturnType<typeof makeDb>;
  const signIn = vi.fn();
  const openShift = vi.fn();

  beforeEach(async () => {
    db = makeDb();
    signIn.mockReset().mockResolvedValue({ accessToken: 'tok', expiresAt: '2030-01-01' });
    openShift.mockReset().mockResolvedValue({ providerShiftId: 'cbx-new' });
    const cfg = { provider: 'checkbox', apiUrl: 'https://x', credentials: {}, shiftMode: 'MANUAL' };
    db.tables.cashRegister.push(
      {
        id: REG_A,
        orgId: ORG,
        branchId: BR,
        name: 'Каса A',
        fiscalProvider: null,
        deletedAt: null,
        createdAt: new Date('2026-01-01'),
      },
      {
        id: REG_B,
        orgId: ORG,
        branchId: BR,
        name: 'Каса B',
        fiscalProvider: null,
        deletedAt: null,
        createdAt: new Date('2026-02-01'),
      },
      {
        id: 'reg-other-branch',
        orgId: ORG,
        branchId: BR2,
        name: 'Каса філії 2',
        fiscalProvider: null,
        deletedAt: null,
        createdAt: new Date('2026-01-15'),
      },
      {
        id: 'reg-foreign',
        orgId: OTHER_ORG,
        branchId: BR,
        name: 'Чужа каса',
        fiscalProvider: null,
        deletedAt: null,
        createdAt: new Date('2025-01-01'),
      },
    );
    db.tables.cashShift.push({
      id: 'shift-a',
      orgId: ORG,
      branchId: BR,
      cashRegisterId: REG_A,
      status: 'OPEN',
      checkboxShiftId: 'cbx-a',
      openedAt: new Date('2026-10-23T08:00:00Z'),
      closedAt: null,
      zReportId: null,
      deletedAt: null,
      checkboxAccessToken: 'secret',
    });
    db.tables.workOrder.push({ id: 'wo-1', branchId: BR });
    const module = await Test.createTestingModule({
      providers: [
        CashShiftService,
        { provide: PrismaService, useValue: db.prisma },
        {
          provide: FiscalProviderRegistry,
          useValue: { get: () => ({ code: 'checkbox', signIn, openShift }) },
        },
        {
          provide: ProviderConfigService,
          useValue: {
            resolveActive: () => Promise.resolve(cfg),
            resolveByCode: () => Promise.resolve(cfg),
          },
        },
        {
          provide: IntegrationLogService,
          useValue: { wrap: (_ctx: unknown, fn: () => unknown) => fn() },
        },
      ],
    }).compile();
    service = module.get(CashShiftService);
  });

  describe('getCurrent з касою', () => {
    // guards: BR-CASH-027
    it('зміна відкрита на A: каса B бачить null, каса A — свою зміну', async () => {
      expect(await service.getCurrent(ORG, BR, REG_B)).toBeNull();
      const a = await service.getCurrent(ORG, BR, REG_A);
      expect(a).toMatchObject({ id: 'shift-a', cashRegisterId: REG_A, cashRegisterName: 'Каса A' });
      expect(JSON.stringify(a)).not.toMatch(/token|secret/i);
    });

    // guards: BR-CASH-027
    it('без каси — як раніше: найновіша OPEN-зміна філії (зворотна сумісність)', async () => {
      expect(await service.getCurrent(ORG, BR)).toMatchObject({ id: 'shift-a' });
    });

    // guards: BR-CASH-027
    it('каса іншої організації → 404, зміна не шукається', async () => {
      await expect(service.getCurrent(ORG, BR, 'reg-foreign')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.prisma.cashShift.findFirst).not.toHaveBeenCalled();
    });

    // guards: BR-CASH-027
    it('каса іншої філії тієї ж організації → 404', async () => {
      await expect(service.getCurrent(ORG, BR, 'reg-other-branch')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('видалена каса → 404', async () => {
      db.tables.cashRegister.find(r => r.id === REG_A)!.deletedAt = new Date();
      await expect(service.getCurrent(ORG, BR, REG_A)).rejects.toBeInstanceOf(NotFoundException);
    });

    // guards: BR-CASH-027
    it('«чеків очікує» каси — QUEUED-оплати саме цієї каси; без каси — за нарядами філії', async () => {
      db.tables.payment.push(
        {
          id: 'p1',
          orgId: ORG,
          fiscalStatus: 'QUEUED',
          cashRegisterId: REG_A,
          workOrderId: 'wo-1',
        },
        { id: 'p2', orgId: ORG, fiscalStatus: 'QUEUED', cashRegisterId: REG_A, workOrderId: null },
        {
          id: 'p3',
          orgId: ORG,
          fiscalStatus: 'QUEUED',
          cashRegisterId: REG_B,
          workOrderId: 'wo-1',
        },
        { id: 'p4', orgId: ORG, fiscalStatus: 'QUEUED', cashRegisterId: null, workOrderId: 'wo-1' },
        { id: 'p5', orgId: ORG, fiscalStatus: 'DONE', cashRegisterId: REG_A, workOrderId: 'wo-1' },
        {
          id: 'p6',
          orgId: OTHER_ORG,
          fiscalStatus: 'QUEUED',
          cashRegisterId: REG_A,
          workOrderId: null,
        },
      );
      expect((await service.getCurrent(ORG, BR, REG_A))?.pendingReceipts).toBe(2);
      // Режим філії не змінився: лічать оплати нарядів філії (p1, p3, p4), без наряду — ні.
      expect((await service.getCurrent(ORG, BR))?.pendingReceipts).toBe(3);
    });
  });

  describe('findOpenShift і відкриття за касою', () => {
    // guards: BR-CASH-027
    it('findOpenShift з касою B — null, з A — зміна A; без каси — будь-яка OPEN-зміна філії', async () => {
      expect(await service.findOpenShift(ORG, BR, REG_B)).toBeNull();
      expect(await service.findOpenShift(ORG, BR, REG_A)).toEqual({
        id: 'shift-a',
        checkboxShiftId: 'cbx-a',
      });
      expect(await service.findOpenShift(ORG, BR)).toEqual({
        id: 'shift-a',
        checkboxShiftId: 'cbx-a',
      });
    });

    // guards: BR-CASH-027
    // Касу перевели в іншу філію, поки зміна відкрита (PATCH каси дозволяє `branchId`): зміна
    // лишається зміною цієї каси. Фільтр за філією сховав би її від віджета й обробника, а `open()`
    // бачить → «зміна вже відкрита», закрити нічим, чеки чекають вічно (review 2026-10-23).
    // Mutation-verify: повернути `branchId` у where режиму каси → кейс червоний.
    it('каса переведена в іншу філію при відкритій зміні → її зміну й далі видно', async () => {
      db.tables.cashRegister.find(r => r.id === REG_A)!.branchId = BR2;
      expect(await service.getCurrent(ORG, BR2, REG_A)).toMatchObject({ id: 'shift-a' });
      expect(await service.findOpenShift(ORG, BR2, REG_A)).toEqual({
        id: 'shift-a',
        checkboxShiftId: 'cbx-a',
      });
      // Режим філії не змінився: нова філія без своїх змін — null.
      expect(await service.findOpenShift(ORG, BR2)).toBeNull();
    });

    // guards: BR-CASH-027
    it('відкриття на касі B, коли відкрита A, — нова зміна саме B; після цього B бачить свою', async () => {
      const opened = await service.open(ORG, BR, 'user-1', REG_B);
      expect(opened).toMatchObject({ cashRegisterId: REG_B, status: 'OPEN' });
      expect(await service.getCurrent(ORG, BR, REG_B)).toMatchObject({ id: opened.id });
      expect(await service.getCurrent(ORG, BR, REG_A)).toMatchObject({ id: 'shift-a' });
    });
  });
});
