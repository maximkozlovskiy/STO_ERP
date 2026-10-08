import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { handleDbUnavailable } from '../../common/testing/require-db';
import { PayrollService } from './payroll.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';

/**
 * ІНТЕГРАЦІЙНИЙ спек нарахування зарплати проти ЖИВОЇ dev-БД. Джерело виробітку, умова «наряд уже
 * в іншій відомості» і блокування організації живуть у сирому SQL — unit-спеки з моком $queryRaw
 * бачать лише параметри, не результат. Тут SQL справді виконується (BR-PAYR-001, BR-PAYR-015).
 *
 * Дані — у далекому майбутньому (березень–квітень 2031), щоб не перетнутись із dev-нарядами:
 * агрегат іде по всій організації за датою завершення. Перевірки дивляться лише на СВОЇХ
 * працівників (інші окладники організації теж потрапляють у відомість — це правило, не шум).
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД — SKIP.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let dbAvailable = false;
let raw: PrismaClient;
let service: PayrollService;
let orgId: string;
let percentEmployeeId: string;
let salariedEmployeeId: string;

const stamp = Date.now();
const periodIds: string[] = [];
const workOrderIds: string[] = [];
const employeeIds: string[] = [];

async function cleanup() {
  if (!raw) return;
  const run = (sql: string, ids: string[]) =>
    ids.length ? raw.$executeRawUnsafe(sql, ids).catch(() => undefined) : Promise.resolve();
  await run(
    `DELETE FROM payroll_line_work_orders WHERE "payrollLineId" IN
       (SELECT id FROM payroll_lines WHERE "periodId" = ANY($1::uuid[]))`,
    periodIds,
  );
  await run(`DELETE FROM payroll_lines WHERE "periodId" = ANY($1::uuid[])`, periodIds);
  await run(`DELETE FROM payroll_periods WHERE id = ANY($1::uuid[])`, periodIds);
  await run(`DELETE FROM work_order_lines WHERE "workOrderId" = ANY($1::uuid[])`, workOrderIds);
  await run(`DELETE FROM work_orders WHERE id = ANY($1::uuid[])`, workOrderIds);
  await run(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, employeeIds);
}

async function makeWorkOrder(
  template: { branchId: string; vehicleId: string; counterpartyId: string; currencyId: string },
  workId: string,
  opts: { suffix: string; status: string; completedAt: Date; employeeId: string; amount: number },
): Promise<string> {
  const wo = await raw.workOrder.create({
    data: {
      orgId,
      branchId: template.branchId,
      vehicleId: template.vehicleId,
      counterpartyId: template.counterpartyId,
      currencyId: template.currencyId,
      number: `PAYR-IT-${stamp}-${opts.suffix}`,
      status: opts.status as never,
      completedAt: opts.completedAt,
    },
    select: { id: true },
  });
  workOrderIds.push(wo.id);
  await raw.workOrderLine.create({
    data: {
      orgId,
      workOrderId: wo.id,
      workId,
      employeeId: opts.employeeId,
      normoHours: 2,
      price: opts.amount / 2,
      amount: opts.amount,
    },
  });
  return wo.id;
}

async function newPeriod(from: string, to: string): Promise<string> {
  const period = await service.create(orgId, { periodStart: from, periodEnd: to } as never);
  periodIds.push(period.id);
  return period.id;
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    await raw.$queryRawUnsafe(`SELECT 1 FROM "payroll_periods" LIMIT 0`);
  } catch {
    handleDbUnavailable('connection failed or schema is not migrated');
    return;
  }
  // From here on the DB is reachable: a failure in data preparation must FAIL the suite, not
  // skip it. A silent skip here once made all seven cases green while none of them ran.
  {
    // Реквізити наряду — із довідників seed, а НЕ з готового наряду: seed нарядів не створює,
    // тож у CI (чиста база + seed) пошук «будь-якого наряду» лишав спек без даних (Bug #806).
    const branch = await raw.garageBranch.findFirst({
      where: { deletedAt: null },
      select: { id: true, orgId: true },
    });
    const [vehicle, counterparty, currency] = branch
      ? await Promise.all([
          raw.vehicle.findFirst({
            where: { orgId: branch.orgId, deletedAt: null },
            select: { id: true },
          }),
          raw.counterparty.findFirst({
            where: { orgId: branch.orgId, deletedAt: null },
            select: { id: true },
          }),
          raw.currency.findFirst({
            where: { orgId: branch.orgId, deletedAt: null, isSystem: true },
            select: { id: true },
          }),
        ])
      : [null, null, null];
    const template =
      branch && vehicle && counterparty && currency
        ? {
            orgId: branch.orgId,
            branchId: branch.id,
            vehicleId: vehicle.id,
            counterpartyId: counterparty.id,
            currencyId: currency.id,
          }
        : null;
    const work = template
      ? await raw.work.findFirst({
          where: { orgId: template.orgId, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (!template || !work) {
      handleDbUnavailable('у seed немає філії, авто, контрагента, валюти або роботи');
      return;
    }
    orgId = template.orgId;

    const percent = await raw.employee.create({
      data: {
        orgId,
        firstName: 'PAYR-IT',
        lastName: `Percent-${stamp}`,
        role: 'MECHANIC',
        rateScheme: { type: 'percent_normo', params: { percent: 40 } },
      },
      select: { id: true },
    });
    const salaried = await raw.employee.create({
      data: {
        orgId,
        firstName: 'PAYR-IT',
        lastName: `Salary-${stamp}`,
        role: 'RECEPTIONIST',
        rateScheme: { type: 'fixed_plus_bonus', params: { fixedMonthly: 31_000, bonusPercent: 0 } },
      },
      select: { id: true },
    });
    percentEmployeeId = percent.id;
    salariedEmployeeId = salaried.id;
    employeeIds.push(percent.id, salaried.id);

    // Завершений наряд 20.03.2031 на 1000 грн робіт → 40% = 400.
    await makeWorkOrder(template, work.id, {
      suffix: 'done',
      status: 'COMPLETED',
      completedAt: new Date('2031-03-20T10:00:00Z'),
      employeeId: percent.id,
      amount: 1000,
    });
    // Наряд у роботі з проставленим completedAt — у базу не входить (статус поза переліком).
    await makeWorkOrder(template, work.id, {
      suffix: 'wip',
      status: 'IN_PROGRESS',
      completedAt: new Date('2031-03-21T10:00:00Z'),
      employeeId: percent.id,
      amount: 5000,
    });

    service = new PayrollService(
      raw as unknown as PrismaService,
      { record: () => Promise.resolve(undefined) } as unknown as AuditService,
      { createOperation: () => Promise.resolve(undefined) } as unknown as CashService,
    );
    dbAvailable = true;
  }
}, 60_000);

afterAll(async () => {
  await cleanup();
  if (raw) await raw.$disconnect();
});

const lineOf = (period: { lines: { employeeId: string }[] }, employeeId: string) =>
  period.lines.find(l => l.employeeId === employeeId) as
    { baseAmount: number; accruedAmount: number; linesCount: number } | undefined;

describe('PayrollService — нарахування на живій БД (integration)', () => {
  let marchId: string;

  it('передумова: dev-БД доступна', () => {
    if (!dbAvailable) console.warn('[payroll.accrual.integration] dev-БД недоступна — пропущено');
    expect(true).toBe(true);
  });

  // guards: BR-PAYR-001
  it('березнева відомість: завершений наряд входить (40% від 1000), наряд у роботі — ні', async () => {
    if (!dbAvailable) return;
    marchId = await newPeriod('2031-03-01', '2031-03-31');

    const period = await service.compute(orgId, marchId);

    expect(period.status).toBe('COMPUTED');
    const line = lineOf(period, percentEmployeeId);
    expect(line).toMatchObject({ baseAmount: 1000, accruedAmount: 400, linesCount: 1 });
  });

  // guards: BR-PAYR-001, BR-PAYR-006
  it('окладник без жодної роботи отримує рядок: повний місяць → повний оклад', async () => {
    if (!dbAvailable) return;
    const period = await service.findOne(orgId, marchId);

    expect(lineOf(period, salariedEmployeeId)).toMatchObject({
      baseAmount: 0,
      linesCount: 0,
      accruedAmount: 31_000,
    });
  });

  // guards: BR-PAYR-015
  it('перетинна відомість (15.03–15.04): той самий наряд удруге НЕ нараховується', async () => {
    if (!dbAvailable) return;
    const overlapId = await newPeriod('2031-03-15', '2031-04-15');

    const period = await service.compute(orgId, overlapId);

    // Єдиний наряд працівника вже у березневій відомості → рядка з виробітком немає.
    expect(lineOf(period, percentEmployeeId)).toBeUndefined();
    // Оклад — лише за свою частку: 17/31 березня + 15/30 квітня.
    expect(lineOf(period, salariedEmployeeId)?.accruedAmount).toBe(
      Math.round(31_000 * (17 / 31 + 15 / 30) * 100) / 100,
    );
  });

  // guards: BR-PAYR-015
  it('попередній розрахунок за той самий період теж не показує вже нарахований наряд', async () => {
    if (!dbAvailable) return;
    const preview = await service.preview(orgId, '2031-03-01', '2031-03-31');

    expect(preview.lines.find(l => l.employeeId === percentEmployeeId)).toBeUndefined();
  });

  // guards: BR-PAYR-015
  it('видалена відомість звільняє свої наряди: нова на ті самі дати нараховує їх знову', async () => {
    if (!dbAvailable) return;
    await service.remove(orgId, marchId);
    const againId = await newPeriod('2031-03-01', '2031-03-31');

    const period = await service.compute(orgId, againId);

    expect(lineOf(period, percentEmployeeId)).toMatchObject({
      baseAmount: 1000,
      accruedAmount: 400,
    });
  });

  // guards: BR-PAYR-015
  it('два одночасні розрахунки перетинних відомостей: наряд дістається рівно одній', async () => {
    if (!dbAvailable) return;
    // Звільняємо наряд: прибираємо всі наші розраховані відомості.
    for (const id of [...periodIds]) await service.remove(orgId, id).catch(() => undefined);
    const a = await newPeriod('2031-03-01', '2031-03-31');
    const b = await newPeriod('2031-03-10', '2031-03-25');

    const [pa, pb] = await Promise.all([service.compute(orgId, a), service.compute(orgId, b)]);

    const accrued = [pa, pb].map(p => lineOf(p, percentEmployeeId)?.accruedAmount ?? 0);
    expect(accrued.sort()).toEqual([0, 400]);
  });
});
