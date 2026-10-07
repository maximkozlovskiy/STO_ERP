import { vi } from 'vitest';
import { PayrollService } from './payroll.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const PID = '22222222-2222-4222-8222-222222222222';
export const BRANCH = '33333333-3333-4333-8333-333333333333';

/**
 * Фікстура аспектних спеків PayrollService (period-bounds / fsm / tenant).
 * Factory, не const: api-спеки йдуть з `isolate: false` без `clearMocks`, тож кожен
 * `beforeEach` мусить отримати свіжі моки. Форма моків — та сама, що в `payroll.service.spec.ts`.
 */
export function makePayrollFixture() {
  const tx = {
    payrollPeriod: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    payrollLine: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'line-1' }),
    },
    payrollLineWorkOrder: { deleteMany: vi.fn(), createMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const prisma = {
    payrollPeriod: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    payrollLine: { findMany: vi.fn().mockResolvedValue([]) },
    garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const cash = { createOperation: vi.fn().mockResolvedValue(undefined) };
  const service = new PayrollService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    cash as unknown as CashService,
  );
  return { tx, prisma, audit, cash, service };
}

/** Рядок періоду, як його повертає `payrollPeriod.findFirst` (вистачає і для toDto). */
export function periodRow(over: Record<string, unknown> = {}) {
  return {
    id: PID,
    orgId: ORG,
    branchId: null,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-09-30T00:00:00Z'),
    status: 'DRAFT',
    note: null,
    computedAt: null,
    paidAt: null,
    createdAt: new Date('2026-10-01T08:00:00Z'),
    updatedAt: new Date('2026-10-01T08:00:00Z'),
    lines: [],
    ...over,
  };
}

/** Рядок агрегату виробітку (`aggregate()` → $queryRaw). */
export function aggRow(over: Record<string, unknown> = {}) {
  return {
    employeeId: 'e1',
    firstName: 'Іван',
    lastName: 'Коваль',
    rateScheme: { type: 'percent_normo', params: { percent: 40 } },
    totalNormoHours: 10,
    totalAmount: 5000,
    linesCount: 3n,
    ...over,
  };
}

interface TaggedMock {
  mock: { calls: unknown[][] };
}

/** Інтерпольовані значення N-го виклику tagged-template (`$queryRaw` / `$executeRaw`). */
export function sqlValues(mock: TaggedMock, call = 0): unknown[] {
  return mock.mock.calls[call].slice(1);
}

/** Текст SQL N-го виклику tagged-template: статичні шматки, склеєні через `?`. */
export function sqlText(mock: TaggedMock, call = 0): string {
  return (mock.mock.calls[call][0] as readonly string[]).join('?').replace(/\s+/g, ' ');
}
