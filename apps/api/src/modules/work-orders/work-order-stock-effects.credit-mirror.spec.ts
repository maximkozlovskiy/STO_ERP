/**
 * Сторно боргу скасованого наряду — дзеркало його CHARGE (TECH-DEBT §17.1, BR-WO-031).
 *
 * `writeOffPartsAndCharge` нараховує CHARGE за курсом на дату документа, а якщо курсу на ту дату ще
 * немає — за «останнім» (`fallbackToLatest`). `returnPartsAndCredit` раніше шукав курс заново тим
 * самим правилом: курс, внесений чи виправлений між завершенням і скасуванням, давав CREDIT_NOTE з
 * іншим `amountBase`, і в базовій валюті лишався залишок. Тепер сторно бере суму, валюту й конвертацію
 * з CHARGE цього наряду (один на документ, BR-SETL-015); без CHARGE (старі дані) — як раніше.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-1';
const WO = { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 100 as never };
const EUR = 'cur-eur';

function makeSvc(charge: Record<string, unknown> | null) {
  const findCharge = vi.fn().mockResolvedValue(charge);
  const createTransaction = vi.fn().mockResolvedValue({});
  const prisma = {
    workOrderPart: { findMany: vi.fn().mockResolvedValue([]) },
    workOrder: {
      findFirst: vi.fn().mockResolvedValue({
        totalAmount: 100,
        currencyId: EUR,
        documentDate: new Date('2026-10-01T00:00:00Z'),
      }),
    },
    settlementTransaction: { findFirst: findCharge },
    goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const svc = new WorkOrderStockEffectsService(
    prisma,
    { createMovement: vi.fn() } as never,
    { createTransaction } as never,
    null as never,
    {
      onWorkOrderClosed: () => Promise.resolve(),
      onWorkOrderPartsChanged: () => Promise.resolve(),
    } as never,
  );
  return { svc, findCharge, createTransaction };
}

describe('returnPartsAndCredit — CREDIT_NOTE дзеркалить CHARGE наряду', () => {
  // guards: BR-WO-031
  it('є CHARGE: та сама сума, валюта й конвертація; курс заново не шукається', async () => {
    const { svc, findCharge, createTransaction } = makeSvc({
      amount: 100,
      currencyId: EUR,
      rateUsed: 44.5,
      amountBase: 4450,
    });

    await svc.returnPartsAndCredit(ORG, WO, 'user-1');

    expect(findCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: ORG, type: 'CHARGE', documentType: 'WorkOrder', documentId: WO.id },
      }),
    );
    const dto = createTransaction.mock.calls[0]![1] as Record<string, unknown>;
    expect(dto).toMatchObject({
      type: 'CREDIT_NOTE',
      amount: 100,
      currencyId: EUR,
      conversion: { rateUsed: 44.5, amountBase: 4450 },
      documentType: 'WorkOrder',
      documentId: WO.id,
    });
    // Курс не шукається вдруге: ні дати, ні «останнього курсу».
    expect(dto).not.toHaveProperty('date');
    expect(dto).not.toHaveProperty('fallbackToLatest');
  });

  // guards: BR-WO-031
  it('CHARGE немає (старі дані): сума наряду за курсом на дату документа, як раніше', async () => {
    const { svc, createTransaction } = makeSvc(null);

    await svc.returnPartsAndCredit(ORG, WO, 'user-1');

    const dto = createTransaction.mock.calls[0]![1] as Record<string, unknown>;
    expect(dto).toMatchObject({
      type: 'CREDIT_NOTE',
      amount: 100,
      currencyId: EUR,
      date: new Date('2026-10-01T00:00:00Z'),
      fallbackToLatest: true,
    });
    expect(dto).not.toHaveProperty('conversion');
  });
});
