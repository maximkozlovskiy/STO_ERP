import { vi, describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';
import { InvoiceOverdueProcessor } from './invoice-overdue.processor';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';

/**
 * InvoiceOverdueProcessor — щоденне позначення прострочених рахунків OVERDUE (BR-INV-005) і подія
 * outbox на кожен рахунок (BR-AUT-060). Таблиці в пам'яті виконують `where` по-справжньому, тож
 * фільтр перевіряється результатом (які рядки змінились), а не формою запиту.
 */
const ORG = 'org-1';
const OTHER_ORG = 'org-9';
const yesterday = () => addDaysKyiv(kyivToday(), -1);
const tomorrow = () => addDaysKyiv(kyivToday(), 1);

function inv(id: string, over: MemRow = {}): MemRow {
  return { id, orgId: ORG, status: 'SENT', dueDate: yesterday(), deletedAt: null, ...over };
}

function harness(rows: MemRow[]) {
  const invoice = memoryTable(rows);
  // Prisma віддає ЗНІМОК рядка, а не посилання: прочитаний статус не змінюється від запису.
  const select = invoice.findMany.getMockImplementation()!;
  invoice.findMany.mockImplementation(async args =>
    ((await select(args)) as MemRow[]).map(r => ({ ...r })),
  );
  const domainEvent = memoryTable([]);
  const tables = [invoice.rows, domainEvent.rows];
  const prisma = {
    invoice,
    domainEvent,
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      const snapshot = tables.map(t => t.map(r => structuredClone(r)));
      try {
        return await cb(prisma);
      } catch (e) {
        tables.forEach((t, i) => t.splice(0, t.length, ...snapshot[i]));
        throw e;
      }
    }),
  };
  const processor = new InvoiceOverdueProcessor(prisma as never, { capture: vi.fn() } as never);
  const run = (orgId = ORG) => processor.process({ data: { orgId } } as Job<{ orgId: string }>);
  const statusOf = (id: string) => invoice.rows.find(r => r.id === id)?.status;
  return { prisma, invoice, domainEvent, run, statusOf };
}

describe('InvoiceOverdueProcessor', () => {
  // guards: BR-INV-005
  it('SENT і PARTIALLY_PAID з терміном до сьогодні своєї організації → OVERDUE; решта не змінюється', async () => {
    const h = harness([
      inv('sent'),
      inv('partial', { status: 'PARTIALLY_PAID' }),
      inv('paid', { status: 'PAID' }),
      inv('cancelled', { status: 'CANCELLED' }),
      inv('draft', { status: 'DRAFT' }),
      inv('already', { status: 'OVERDUE' }),
      inv('no-due', { dueDate: null }),
      inv('future', { dueDate: tomorrow() }),
      inv('today', { dueDate: kyivToday() }),
      inv('deleted', { deletedAt: new Date() }),
      inv('foreign', { orgId: OTHER_ORG }),
    ]);

    await h.run();

    const statuses = Object.fromEntries(h.invoice.rows.map(r => [r.id, r.status]));
    expect(statuses).toEqual({
      sent: 'OVERDUE',
      partial: 'OVERDUE',
      paid: 'PAID',
      cancelled: 'CANCELLED',
      draft: 'DRAFT',
      already: 'OVERDUE',
      'no-due': 'SENT',
      future: 'SENT',
      today: 'SENT',
      deleted: 'SENT',
      foreign: 'SENT',
    });
  });

  // guards: BR-AUT-060
  it('подія на КОЖЕН прострочений рахунок: з якого статусу, у OVERDUE, ініціатор — система', async () => {
    const h = harness([
      inv('a'),
      inv('b', { status: 'PARTIALLY_PAID' }),
      inv('paid', { status: 'PAID' }),
    ]);

    await h.run();

    const events = h.domainEvent.rows.map(e => ({
      documentId: e.documentId,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
    }));
    expect(events).toEqual(
      expect.arrayContaining([
        { documentId: 'a', fromStatus: 'SENT', toStatus: 'OVERDUE' },
        { documentId: 'b', fromStatus: 'PARTIALLY_PAID', toStatus: 'OVERDUE' },
      ]),
    );
    expect(events).toHaveLength(2);
    for (const e of h.domainEvent.rows) {
      expect(e).toMatchObject({
        orgId: ORG,
        documentType: 'INVOICE',
        kind: 'STATUS_CHANGED',
        actorId: null,
      });
    }
  });

  // guards: BR-AUT-060
  it('рахунок, що змінився між вибіркою і записом (оплата), не позначається і події не має', async () => {
    const h = harness([inv('a'), inv('b')]);
    // Паралельна оплата: між findMany і CAS рахунок «b» став PAID.
    const select = h.invoice.findMany.getMockImplementation()!;
    h.invoice.findMany.mockImplementationOnce(async args => {
      const rows = await select(args);
      const b = h.invoice.rows.find(r => r.id === 'b')!;
      b.status = 'PAID';
      return rows;
    });

    await h.run();

    expect(h.statusOf('a')).toBe('OVERDUE');
    expect(h.statusOf('b')).toBe('PAID');
    expect(h.domainEvent.rows.map(e => e.documentId)).toEqual(['a']);
  });

  // guards: BR-AUT-060
  it('збій запису події відкочує і статус рахунку (одна транзакція)', async () => {
    const h = harness([inv('a')]);
    h.domainEvent.createMany.mockRejectedValueOnce(new Error('db down'));

    await expect(h.run()).rejects.toThrow('db down');

    expect(h.statusOf('a')).toBe('SENT');
    expect(h.domainEvent.rows).toHaveLength(0);
  });

  it('повторний прогін нічого не змінює і нових подій не пише (ідемпотентність)', async () => {
    const h = harness([inv('a')]);
    await h.run();
    await h.run();
    expect(h.statusOf('a')).toBe('OVERDUE');
    expect(h.domainEvent.rows).toHaveLength(1);
  });
});
