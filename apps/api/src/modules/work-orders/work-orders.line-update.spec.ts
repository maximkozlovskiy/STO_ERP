/**
 * WorkOrdersService.updateLine — правка рядка роботи зберігає роботу й виконавця (BR-WO-011).
 *
 * Bug #836: `workId` / `employeeId` приймались у DTO, але в `update` не потрапляли. Картка наряду
 * після «Зберегти зміни» показувала нового виконавця, PATCH відповідав 200 зі СТАРИМ виконавцем,
 * у базі нічого не мінялось — а з виконавця рядка рахуються зарплата і блок «Виконавці» (BR-WO-010).
 *
 * Окремий файл: `work-orders.service.spec.ts` на межі гейта розміру. `updateLine` торкається
 * `this.prisma` і `this.totals`, решта залежностей — null.
 *
 * Mutation-verify (2026-10-13): прибрати `workId` / `employeeId` з `data` → падають кейси 1–2;
 * вимкнути перевірку існування → падають кейси 3–4.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const WO = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const WORK_OLD = '44444444-4444-4444-8444-444444444444';
const WORK_NEW = '55555555-5555-4555-8555-555555555555';
const EMP_OLD = '66666666-6666-4666-8666-666666666666';
const EMP_NEW = '77777777-7777-4777-8777-777777777777';

describe('WorkOrdersService.updateLine — робота й виконавець рядка', () => {
  let lineUpdate: ReturnType<typeof vi.fn>;
  let workFind: ReturnType<typeof vi.fn>;
  let employeeFind: ReturnType<typeof vi.fn>;
  let recalc: ReturnType<typeof vi.fn>;
  let service: WorkOrdersService;
  let woStatus: string;

  beforeEach(() => {
    woStatus = 'DRAFT';
    lineUpdate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: LINE,
        workOrderId: WO,
        workId: data.workId ?? WORK_OLD,
        employeeId: data.employeeId ?? EMP_OLD,
        liftId: null,
        normoHours: data.normoHours,
        actualHours: null,
        price: data.price,
        amount: data.amount,
        notes: null,
        work: { name: 'Робота' },
        employee: { firstName: 'Петро', lastName: 'Коваль' },
      }),
    );
    workFind = vi.fn().mockResolvedValue({ id: WORK_NEW });
    employeeFind = vi.fn().mockResolvedValue({ id: EMP_NEW });
    recalc = vi.fn().mockResolvedValue(undefined);
    const tx = { workOrderLine: { update: lineUpdate } };
    const prisma = {
      workOrder: { findFirst: vi.fn(() => Promise.resolve({ status: woStatus })) },
      workOrderLine: {
        findFirst: vi.fn().mockResolvedValue({
          normoHours: 1,
          price: 100,
          workId: WORK_OLD,
          employeeId: EMP_OLD,
        }),
      },
      work: { findFirst: workFind },
      employee: { findFirst: employeeFind },
      $transaction: vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as PrismaService;
    service = new WorkOrdersService(
      prisma,
      null as never, // stockEffects
      null as never, // docNumbers
      null as never, // pdf
      null as never, // audit
      null as never, // settingsService
      null as never, // exchangeRates
      null as never, // events
      { recalc } as never, // totals
      null as never, // orgPrintInfo
      null as never, // calendar
    );
  });

  const data = () => (lineUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

  // guards: BR-WO-011
  it('новий виконавець пишеться в рядок і повертається у відповіді', async () => {
    const res = await service.updateLine(ORG, WO, LINE, { employeeId: EMP_NEW });
    expect(data().employeeId).toBe(EMP_NEW);
    expect(res.employeeId).toBe(EMP_NEW);
    expect(employeeFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: EMP_NEW, orgId: ORG, deletedAt: null } }),
    );
    expect(recalc).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-011
  it('нова робота пишеться в рядок; години й ціна беруться з запиту, а не з роботи', async () => {
    await service.updateLine(ORG, WO, LINE, { workId: WORK_NEW, normoHours: 2.5, price: 40 });
    expect(data()).toMatchObject({ workId: WORK_NEW, normoHours: 2.5 });
    expect(Number(data().amount)).toBe(100);
    expect(workFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WORK_NEW, orgId: ORG, deletedAt: null } }),
    );
  });

  // guards: BR-FIN-MONEYCAP
  it('нормогодини × ціна понад Decimal(12,2) → 400, рядок не оновлюється (BR-FIN-MONEYCAP)', async () => {
    // Існуюча ціна рядка — 100; нормогодин у межах QTY_MAX, але добуток 20_000_000_000 > колонки.
    await expect(service.updateLine(ORG, WO, LINE, { normoHours: 200_000_000 })).rejects.toThrow(
      BadRequestException,
    );
    expect(lineUpdate).not.toHaveBeenCalled();
  });

  // guards: BR-FIN-MONEYCAP
  it('добуток рівно на межі Decimal(12,2) → проходить (BR-FIN-MONEYCAP)', async () => {
    await service.updateLine(ORG, WO, LINE, { normoHours: 1, price: 9_999_999_999.99 });
    expect(Number(data().amount)).toBe(9_999_999_999.99);
  });

  // guards: BR-WO-011
  it('виконавець чужої організації або видалений → 404, рядок не змінено', async () => {
    employeeFind.mockResolvedValueOnce(null);
    await expect(service.updateLine(ORG, WO, LINE, { employeeId: EMP_NEW })).rejects.toThrow(
      NotFoundException,
    );
    expect(lineUpdate).not.toHaveBeenCalled();
  });

  // guards: BR-WO-011
  it('робота чужої організації або видалена → 404, рядок не змінено', async () => {
    workFind.mockResolvedValueOnce(null);
    await expect(service.updateLine(ORG, WO, LINE, { workId: WORK_NEW })).rejects.toThrow(
      NotFoundException,
    );
    expect(lineUpdate).not.toHaveBeenCalled();
  });

  // guards: BR-WO-011
  it('ті самі робота й виконавець (картка шле їх щоразу) → без перевірки існування, поля не чіпаються', async () => {
    workFind.mockResolvedValue(null); // роботу вже видалено з довідника
    employeeFind.mockResolvedValue(null); // виконавця вже звільнено
    await service.updateLine(ORG, WO, LINE, {
      workId: WORK_OLD,
      employeeId: EMP_OLD,
      normoHours: 3,
    });
    expect(workFind).not.toHaveBeenCalled();
    expect(employeeFind).not.toHaveBeenCalled();
    expect(data().workId).toBeUndefined();
    expect(data().employeeId).toBeUndefined();
    expect(data().normoHours).toBe(3);
  });

  it('правка без роботи й виконавця (лише фактичні години) їх не чіпає', async () => {
    woStatus = 'IN_PROGRESS';
    await service.updateLine(ORG, WO, LINE, { actualHours: 1.5 });
    expect(data().workId).toBeUndefined();
    expect(data().employeeId).toBeUndefined();
    expect(data().actualHours).toBe(1.5);
  });

  it('зміна виконавця в наряді «В роботі» → 400: там правляться лише фактичні години', async () => {
    woStatus = 'IN_PROGRESS';
    await expect(service.updateLine(ORG, WO, LINE, { employeeId: EMP_NEW })).rejects.toThrow();
    expect(lineUpdate).not.toHaveBeenCalled();
  });
});
