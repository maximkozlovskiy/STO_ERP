import { describe, it, expect } from 'vitest';
import {
  workOrderHeaderSchema,
  workOrderUpdateSchema,
  workOrderLineSchema,
  workOrderLineUpdateSchema,
  workOrderPartSchema,
} from '@sto/shared';

const BRANCH = '11111111-1111-1111-1111-111111111111';
const VEHICLE = '22222222-2222-2222-2222-222222222222';
const CP = '33333333-3333-3333-3333-333333333333';
const WORK = '44444444-4444-4444-4444-444444444444';
const EMP = '55555555-5555-5555-5555-555555555555';
const GOOD = '66666666-6666-6666-6666-666666666666';
const WH = '77777777-7777-7777-7777-777777777777';

const header = { branchId: BRANCH, vehicleId: VEHICLE, counterpartyId: CP };

describe('workOrderHeaderSchema (спільна, web ↔ api)', () => {
  it('мінімальна валідна шапка (branch/vehicle/counterparty)', () => {
    expect(workOrderHeaderSchema.safeParse(header).success).toBe(true);
  });

  it('порожній counterpartyId (empty-select) → помилка «Оберіть контрагента»', () => {
    const r = workOrderHeaderSchema.safeParse({
      branchId: BRANCH,
      vehicleId: VEHICLE,
      counterpartyId: '',
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.find(i => i.path[0] === 'counterpartyId')?.message).toBe(
        'v.workOrder.counterparty.required',
      );
  });

  it('priority поза enum → помилка; порожній → undefined', () => {
    expect(workOrderHeaderSchema.safeParse({ ...header, priority: 'ZZZ' }).success).toBe(false);
    const ok = workOrderHeaderSchema.safeParse({ ...header, priority: '' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.priority).toBeUndefined();
  });

  it('repairCategory валідне значення проходить', () => {
    const r = workOrderHeaderSchema.safeParse({ ...header, repairCategory: 'DIAGNOSTICS' });
    expect(r.success).toBe(true);
  });

  it("inMileage від'ємний → помилка; '' → undefined", () => {
    expect(workOrderHeaderSchema.safeParse({ ...header, inMileage: '-5' }).success).toBe(false);
    const ok = workOrderHeaderSchema.safeParse({ ...header, inMileage: '' });
    expect(ok.success).toBe(true);
  });

  it('битий plannedAt/documentDate → помилка (validation-parity)', () => {
    expect(workOrderHeaderSchema.safeParse({ ...header, plannedAt: 'nope' }).success).toBe(false);
    expect(workOrderHeaderSchema.safeParse({ ...header, documentDate: 'nope' }).success).toBe(
      false,
    );
  });

  it('plannedAt повний ISO8601 datetime проходить', () => {
    const r = workOrderHeaderSchema.safeParse({ ...header, plannedAt: '2026-01-15T14:30:00.000Z' });
    expect(r.success).toBe(true);
  });
});

describe('workOrderUpdateSchema — nullable семантика', () => {
  it('порожній обʼєкт ok; усі поля опційні', () => {
    expect(workOrderUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('plannedAt/liftId/plannedHours/actualHours null очищає', () => {
    const r = workOrderUpdateSchema.safeParse({
      plannedAt: null,
      liftId: null,
      plannedHours: null,
      actualHours: null,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.plannedAt).toBeNull();
      expect(r.data.liftId).toBeNull();
      expect(r.data.plannedHours).toBeNull();
      expect(r.data.actualHours).toBeNull();
    }
  });

  it("actualHours від'ємний (не null) → помилка", () => {
    expect(workOrderUpdateSchema.safeParse({ actualHours: -1 }).success).toBe(false);
  });
});

describe('workOrderLineSchema (POST /lines)', () => {
  it('валідний рядок (workId+employeeId); normoHours коерситься', () => {
    const r = workOrderLineSchema.safeParse({ workId: WORK, employeeId: EMP, normoHours: '2.5' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.normoHours).toBe(2.5);
  });

  it('порожній employeeId (empty-select) → помилка «Оберіть виконавця»', () => {
    const r = workOrderLineSchema.safeParse({ workId: WORK, employeeId: '' });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.find(i => i.path[0] === 'employeeId')?.message).toBe(
        'v.workOrder.line.employee.required',
      );
  });

  it('normoHours < 0.01 → помилка (validation-parity @Min(0.01))', () => {
    expect(
      workOrderLineSchema.safeParse({ workId: WORK, employeeId: EMP, normoHours: '0' }).success,
    ).toBe(false);
  });

  it('update line — actualHours null очищає (Bug #426)', () => {
    const r = workOrderLineUpdateSchema.safeParse({ actualHours: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.actualHours).toBeNull();
  });
});

describe('workOrderPartSchema (POST /parts)', () => {
  it('валідна деталь (goodId+warehouseId+quantity); quantity коерситься', () => {
    const r = workOrderPartSchema.safeParse({ goodId: GOOD, warehouseId: WH, quantity: '3' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.quantity).toBe(3);
  });

  it('quantity ≤ 0 → помилка (validation-parity @Min(0.001))', () => {
    expect(
      workOrderPartSchema.safeParse({ goodId: GOOD, warehouseId: WH, quantity: '0' }).success,
    ).toBe(false);
  });

  it('порожній warehouseId (empty-select) → помилка «Оберіть склад»', () => {
    const r = workOrderPartSchema.safeParse({ goodId: GOOD, warehouseId: '', quantity: '1' });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.find(i => i.path[0] === 'warehouseId')?.message).toBe(
        'v.workOrder.part.warehouse.required',
      );
  });
});
