/**
 * WorkOrdersService.findAll — відбір списку нарядів за кількома статусами (`statuses`).
 *
 * Картки дашборду «В роботі» (IN_PROGRESS + ON_HOLD) і «Очікують» (DRAFT + ESTIMATE + APPROVED)
 * ведуть у список нарядів із тим самим набором статусів, що їх лічильник (UX-огляд 2026-10-29):
 * число на картці і кількість рядків у списку мають збігатися.
 *
 * Фейкова Prisma ВИКОНУЄ `where` над рядками в пам'яті (orgId, deletedAt, status — рівність і
 * `in`), а не повертає заготовку: тест про фільтр, тож перевіряє, які рядки пройшли.
 *
 * Mutation-verify (2026-10-29): гілку `statuses` у `findAll` вимкнено → падають «В роботі» й
 * «Очікують»; перетин замінено на сам `status` → падає кейс «перетин».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrderQueryDto } from './work-orders.dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const baseQuery = { page: 1, limit: 20 } as WorkOrderQueryDto;

interface Row {
  id: string;
  orgId: string;
  status: string;
  deletedAt: Date | null;
}

type StatusCond = string | { in: string[] } | undefined;

function matches(row: Row, where: Record<string, unknown>): boolean {
  if (where.orgId !== undefined && row.orgId !== where.orgId) return false;
  if ('deletedAt' in where && where.deletedAt === null && row.deletedAt !== null) return false;
  const status = where.status as StatusCond;
  if (typeof status === 'string' && row.status !== status) return false;
  if (status && typeof status === 'object' && !status.in.includes(row.status)) return false;
  return true;
}

const ROWS: Row[] = [
  { id: 'draft', orgId: ORG, status: 'DRAFT', deletedAt: null },
  { id: 'estimate', orgId: ORG, status: 'ESTIMATE', deletedAt: null },
  { id: 'approved', orgId: ORG, status: 'APPROVED', deletedAt: null },
  { id: 'in-progress', orgId: ORG, status: 'IN_PROGRESS', deletedAt: null },
  { id: 'on-hold', orgId: ORG, status: 'ON_HOLD', deletedAt: null },
  { id: 'completed', orgId: ORG, status: 'COMPLETED', deletedAt: null },
  { id: 'deleted-in-progress', orgId: ORG, status: 'IN_PROGRESS', deletedAt: new Date() },
  { id: 'foreign-in-progress', orgId: OTHER_ORG, status: 'IN_PROGRESS', deletedAt: null },
];

describe('WorkOrdersService.findAll — відбір за кількома статусами', () => {
  let service: WorkOrdersService;

  beforeEach(() => {
    const filter = (args: { where: Record<string, unknown> }) =>
      ROWS.filter(r => matches(r, args.where));
    const prisma = {
      workOrder: {
        findMany: (args: { where: Record<string, unknown> }) => Promise.resolve(filter(args)),
        count: (args: { where: Record<string, unknown> }) => Promise.resolve(filter(args).length),
      },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
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
      null as never, // totals
      null as never, // orgPrintInfo
      null as never, // calendar
    );
  });

  // Для відбору важить, скільки рядків пройшло `where`: `total` рахує той самий `where`, що й
  // `findMany`, і не залежить від мапера рядків у DTO.
  const total = async (query: Partial<WorkOrderQueryDto>) =>
    (await service.findAll(ORG, { ...baseQuery, ...query } as WorkOrderQueryDto)).total;

  it('«В роботі»: IN_PROGRESS + ON_HOLD — два наряди організації, без видалених і чужих', async () => {
    expect(
      await total({ statuses: ['IN_PROGRESS', 'ON_HOLD'] } as Partial<WorkOrderQueryDto>),
    ).toBe(2);
  });

  it('«Очікують»: DRAFT + ESTIMATE + APPROVED — три наряди', async () => {
    expect(
      await total({ statuses: ['DRAFT', 'ESTIMATE', 'APPROVED'] } as Partial<WorkOrderQueryDto>),
    ).toBe(3);
  });

  it('`status` разом зі `statuses` — перетин: статус поза набором не дає жодного рядка', async () => {
    expect(
      await total({ status: 'IN_PROGRESS', statuses: ['IN_PROGRESS', 'ON_HOLD'] } as never),
    ).toBe(1);
    expect(
      await total({ status: 'COMPLETED', statuses: ['IN_PROGRESS', 'ON_HOLD'] } as never),
    ).toBe(0);
  });

  it('без `statuses` поведінка як раніше: `status` — один статус, без обох — усі живі наряди', async () => {
    expect(await total({ status: 'ON_HOLD' } as Partial<WorkOrderQueryDto>)).toBe(1);
    expect(await total({})).toBe(6);
  });
});
