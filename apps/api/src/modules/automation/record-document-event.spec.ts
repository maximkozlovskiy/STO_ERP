import { describe, expect, it } from 'vitest';
import { $Enums, type Prisma } from '@prisma/client';
import { AUTOMATION_DOCUMENT_TYPES, AUTOMATION_EVENT_KINDS } from '@sto/shared';
import { recordDocumentEvent, recordDocumentEvents } from './record-document-event';
import { domainEventMock } from '../../common/testing/prisma-mock';

const ORG = 'org-1';
const DOC = '11111111-1111-4111-8111-111111111111';

function makeTx() {
  const domainEvent = domainEventMock();
  return { tx: { domainEvent } as unknown as Prisma.TransactionClient, domainEvent };
}

describe('recordDocumentEvent — подія документа в outbox (BR-AUT-060)', () => {
  // guards: BR-AUT-060
  it('пише подію в ПЕРЕДАНИЙ клієнт транзакції з усіма полями', async () => {
    const { tx, domainEvent } = makeTx();
    await recordDocumentEvent(tx, {
      orgId: ORG,
      documentType: 'WORK_ORDER',
      documentId: DOC,
      kind: 'STATUS_CHANGED',
      fromStatus: 'APPROVED',
      toStatus: 'IN_PROGRESS',
      actorId: 'emp-1',
    });
    expect(domainEvent.create).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        documentType: 'WORK_ORDER',
        documentId: DOC,
        kind: 'STATUS_CHANGED',
        fromStatus: 'APPROVED',
        toStatus: 'IN_PROGRESS',
        actorId: 'emp-1',
      },
    });
  });

  // guards: BR-AUT-060
  it('«створено»: без попереднього статусу, ініціатор не заданий → null (система)', async () => {
    const { tx, domainEvent } = makeTx();
    await recordDocumentEvent(tx, {
      orgId: ORG,
      documentType: 'BOOKING',
      documentId: DOC,
      kind: 'CREATED',
      toStatus: 'PENDING',
    });
    expect(domainEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'CREATED', fromStatus: null, actorId: null }),
    });
  });

  // guards: BR-AUT-060
  it.each([
    ['той самий статус', 'SENT', 'SENT'],
    ['обидва порожні', null, null],
  ])('«статус змінено» без зміни (%s) → події немає', async (_l, from, to) => {
    const { tx, domainEvent } = makeTx();
    await recordDocumentEvent(tx, {
      orgId: ORG,
      documentType: 'INVOICE',
      documentId: DOC,
      kind: 'STATUS_CHANGED',
      fromStatus: from,
      toStatus: to,
    });
    expect(domainEvent.create).not.toHaveBeenCalled();
  });

  // guards: BR-AUT-060
  it('сторно оплати: псевдостатус REVERSED без попереднього — це подія', async () => {
    const { tx, domainEvent } = makeTx();
    await recordDocumentEvent(tx, {
      orgId: ORG,
      documentType: 'PAYMENT',
      documentId: DOC,
      kind: 'STATUS_CHANGED',
      toStatus: 'REVERSED',
    });
    expect(domainEvent.create).toHaveBeenCalledTimes(1);
  });

  // guards: BR-AUT-060
  it('recordDocumentEvents: одна вставка, події без зміни статусу відкинуто; порожньо — без запиту', async () => {
    const { tx, domainEvent } = makeTx();
    const base = { orgId: ORG, documentType: 'INVOICE' as const, kind: 'STATUS_CHANGED' as const };
    await recordDocumentEvents(tx, [
      { ...base, documentId: 'a', fromStatus: 'SENT', toStatus: 'OVERDUE' },
      { ...base, documentId: 'b', fromStatus: 'OVERDUE', toStatus: 'OVERDUE' },
    ]);
    expect(domainEvent.createMany).toHaveBeenCalledTimes(1);
    const rows = (domainEvent.createMany.mock.calls[0][0] as { data: { documentId: string }[] })
      .data;
    expect(rows.map(r => r.documentId)).toEqual(['a']);

    domainEvent.createMany.mockClear();
    await recordDocumentEvents(tx, [
      { ...base, documentId: 'b', fromStatus: 'OVERDUE', toStatus: 'OVERDUE' },
    ]);
    await recordDocumentEvents(tx, []);
    expect(domainEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('паритет переліків автоматизації: @sto/shared ↔ Prisma-enum', () => {
  // guards: BR-AUT-060
  it('AUTOMATION_DOCUMENT_TYPES == AutomationDocumentType', () => {
    expect([...AUTOMATION_DOCUMENT_TYPES].sort()).toEqual(
      Object.values($Enums.AutomationDocumentType).sort(),
    );
  });

  // guards: BR-AUT-060
  it('AUTOMATION_EVENT_KINDS == AutomationEventKind', () => {
    expect([...AUTOMATION_EVENT_KINDS].sort()).toEqual(
      Object.values($Enums.AutomationEventKind).sort(),
    );
  });
});
