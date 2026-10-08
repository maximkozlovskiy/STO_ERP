import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * WorkOrdersService.generatePdf — підсумок друкованого наряду (BR-WO-007)
 *
 * Аспект: друкований наряд несе суму ДО СПЛАТИ (`wo.totalAmount`, з ПДВ) і окремо суму без ПДВ
 * та ПДВ — з тоталів наряду, а не перераховані з рядків. У режимі «ПДВ зверху» рядки — без ПДВ
 * (700), тож «Разом» із суми рядків розійшлося б із боргом клієнта (840).
 *
 * `PdfService` — заглушка: перевіряємо дані, які він отримав.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';

type PdfArg = {
  total: number;
  totalNet: number;
  vatTotal: number;
  works: { total: number }[];
  parts: { total: number }[];
};

function setup(woTotals: { totalNet: number; totalAmount: number } | null) {
  const woFindFirst = vi.fn().mockResolvedValue(
    woTotals === null
      ? null
      : {
          number: 'НЗ-2026-000001',
          createdAt: new Date('2026-10-01T09:00:00Z'),
          ...woTotals,
          vehicle: { make: 'Toyota', model: 'Corolla', licensePlate: 'AA1234BB' },
          counterparty: {
            firstName: 'Іван',
            lastName: 'Петренко',
            companyName: null,
            phone: '+380501112233',
          },
          // 2 год × 100 = 200
          lines: [
            {
              normoHours: 2,
              actualHours: null,
              price: 100,
              amount: 200,
              work: { name: 'Заміна масла' },
            },
          ],
          parts: [{ quantity: 1, price: 500, amount: 500, good: { name: 'Фільтр' } }],
        },
  );
  const prisma = {
    workOrder: { findFirst: woFindFirst },
    organisation: { findFirst: vi.fn().mockResolvedValue({ name: 'СТО Альфа', edrpou: null }) },
  } as unknown as PrismaService;
  const generateWorkOrderPdf = vi.fn().mockResolvedValue(Buffer.from('%PDF'));
  const service = new WorkOrdersService(
    prisma,
    null as never, // stockEffects
    null as never, // docNumbers
    { generateWorkOrderPdf } as never, // pdf
    null as never, // audit
    null as never, // settingsService
    null as never, // exchangeRates
    null as never, // events
    null as never, // totals
  );
  const pdfArg = () => generateWorkOrderPdf.mock.calls[0]?.[0] as PdfArg;
  return { service, woFindFirst, generateWorkOrderPdf, pdfArg };
}

describe('WorkOrdersService.generatePdf — підсумок із тоталів наряду (BR-WO-007)', () => {
  // guards: BR-WO-007
  it('«ПДВ зверху»: total = wo.totalAmount (840, до сплати), totalNet = 700, vatTotal = 140 — не сума рядків', async () => {
    const { service, pdfArg } = setup({ totalNet: 700, totalAmount: 840 });

    await service.generatePdf(ORG, WO_ID);

    const arg = pdfArg();
    const rowsSum = [...arg.works, ...arg.parts].reduce((s, r) => s + r.total, 0);
    expect(rowsSum).toBe(700);
    expect(arg.total).toBe(840);
    expect(arg.totalNet).toBe(700);
    expect(arg.vatTotal).toBe(140);
  });

  // guards: BR-WO-007
  it('«ПДВ у ціні»: total = сума рядків (700), ПДВ виділено тоталами наряду; vatTotal квантовано до копійки', async () => {
    const { service, pdfArg } = setup({ totalNet: 583.33, totalAmount: 700 });

    await service.generatePdf(ORG, WO_ID);

    const arg = pdfArg();
    expect(arg.total).toBe(700);
    expect(arg.totalNet).toBe(583.33);
    // 700 − 583.33 у float = 116.66999999999996
    expect(arg.vatTotal).toBe(116.67);
  });

  // guards: BR-WO-007
  it('наряд без ПДВ: vatTotal = 0 (підсумок друкується одним рядком), total = totalNet', async () => {
    const { service, pdfArg } = setup({ totalNet: 700, totalAmount: 700 });

    await service.generatePdf(ORG, WO_ID);

    const arg = pdfArg();
    expect(arg.total).toBe(700);
    expect(arg.totalNet).toBe(700);
    expect(arg.vatTotal).toBe(0);
  });

  // guards: BR-WO-007
  it('наряд читається у межах свого orgId разом із totalNet/totalAmount; чужий → 404, PDF не будується', async () => {
    const found = setup({ totalNet: 700, totalAmount: 840 });
    await found.service.generatePdf(ORG, WO_ID);
    const query = found.woFindFirst.mock.calls[0]?.[0] as {
      where: unknown;
      select: Record<string, unknown>;
    };
    expect(query.where).toEqual({ id: WO_ID, orgId: ORG, deletedAt: null });
    expect(query.select).toMatchObject({ totalNet: true, totalAmount: true });

    const missing = setup(null);
    await expect(missing.service.generatePdf('other-org', WO_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(missing.generateWorkOrderPdf).not.toHaveBeenCalled();
  });
});
