/**
 * «Пов'язані документи» наряду, секція «Оплати» (BR-PAY-024): рядок оплати несе `sourceType` і
 * ознаку онлайн-оплати `isOnline` — web за ними вирішує, чи показати «Сторнувати» (касову оплату
 * сторнують у касі, QR — у кабінеті платіжного сервісу). Сам id онлайн-наміру клієнту не йде.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { memoryTable } from '../cash/cash.spec-fixture';

const ORG = '11111111-1111-4111-8111-111111111111';
const WO = 'd1000001-0000-4000-8000-000000000001';

function makeService() {
  const empty = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  const payment = memoryTable([
    {
      id: 'p-bank',
      orgId: ORG,
      workOrderId: WO,
      amount: '100.00',
      method: 'bank',
      createdAt: new Date('2026-10-20T09:00:00Z'),
      notes: null,
      fiscalStatus: null,
      reversedAt: null,
      sourceType: 'BANK_ACCOUNT',
      onlinePaymentIntentId: null,
    },
    {
      id: 'p-qr',
      orgId: ORG,
      workOrderId: WO,
      amount: '50.00',
      method: 'ONLINE',
      createdAt: new Date('2026-10-20T10:00:00Z'),
      notes: null,
      fiscalStatus: null,
      reversedAt: null,
      sourceType: null,
      onlinePaymentIntentId: 'f1000001-0000-4000-8000-000000000001',
    },
  ]);
  const prisma = {
    payment,
    invoice: empty(),
    calendarSlot: empty(),
    warranty: empty(),
    purchaseListItem: empty(),
  } as unknown as PrismaService;
  const service = new WorkOrdersService(
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
  return { service, payment };
}

describe('WorkOrdersService.getLinkedDocuments — рядок оплати для сторно (BR-PAY-024)', () => {
  // guards: BR-PAY-024
  it('select бере sourceType і onlinePaymentIntentId; відповідь — sourceType і isOnline, без id наміру', async () => {
    const { service, payment } = makeService();
    const res = await service.getLinkedDocuments(ORG, WO);
    const select = (payment.findMany.mock.calls[0]![0] as { select: Record<string, unknown> })
      .select;
    expect(select).toMatchObject({ sourceType: true, onlinePaymentIntentId: true });
    const byId = Object.fromEntries(res.payments.map(p => [p.id, p]));
    expect(byId['p-bank']).toMatchObject({ sourceType: 'BANK_ACCOUNT', isOnline: false });
    expect(byId['p-qr']).toMatchObject({ isOnline: true });
    for (const p of res.payments) expect(p).not.toHaveProperty('onlinePaymentIntentId');
  });
});
