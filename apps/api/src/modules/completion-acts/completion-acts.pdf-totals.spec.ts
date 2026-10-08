/**
 * CompletionActsService.generatePdf — сума акта = сума наряду до сплати (BR-WO-007)
 *
 * Аспект: акт виконаних робіт друкує ту саму суму, що нарахована клієнтові боргом. У режимі
 * «ПДВ зверху» рядки акта — без ПДВ, тож сума рядків (700) менша за борг (840): акт мусить
 * нести `wo.totalAmount`, а суму без ПДВ і ПДВ передавати окремо — і лише коли ПДВ є.
 *
 * Сервіс збирається на Prisma-моку; `PdfService` — заглушка, перевіряємо ДАНІ, які він отримав.
 */
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect } from 'vitest';
import { CompletionActsService } from './completion-acts.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-1';
const ACT_ID = '11111111-1111-4111-8111-111111111111';

type PdfArg = {
  total: number;
  totalNet?: number;
  vatTotal?: number;
  lines: { amount: number }[];
};

function setup(
  woTotals: { totalNet: number; totalAmount: number } | null,
  rows?: { lines: unknown[]; parts: unknown[] },
) {
  const actFindFirst = vi.fn().mockResolvedValue(
    woTotals === null
      ? null
      : {
          id: ACT_ID,
          orgId: ORG,
          number: 'АКТ-2026-0001',
          createdAt: new Date('2026-10-01T09:00:00Z'),
          signedAt: null,
          signedBy: null,
          notes: null,
          workOrder: {
            number: 'НЗ-2026-000001',
            ...woTotals,
            counterparty: {
              firstName: 'Іван',
              lastName: 'Петренко',
              companyName: null,
              phone: '+380501112233',
              actualAddress: null,
            },
            vehicle: { make: 'Toyota', model: 'Corolla', licensePlate: 'AA1234BB' },
            ...(rows ?? {
              // 2 год × 100 = 200 (фактичні години мають пріоритет над нормо-годинами)
              lines: [
                {
                  normoHours: 5,
                  actualHours: 2,
                  price: 100,
                  amount: 500,
                  workId: 'w-1',
                  work: { name: 'Заміна масла' },
                },
              ],
              parts: [
                {
                  quantity: 1,
                  price: 500,
                  amount: 500,
                  goodId: 'g-1',
                  good: { name: 'Фільтр', unit: 'шт' },
                },
              ],
            }),
          },
        },
  );
  const prisma = {
    organisation: { findFirst: vi.fn().mockResolvedValue({ name: 'СТО Альфа' }) },
    completionAct: { findFirst: actFindFirst },
  } as unknown as PrismaService;
  const generateCompletionActPdf = vi.fn().mockResolvedValue(Buffer.from('%PDF'));
  const service = new CompletionActsService(
    prisma,
    null as never, // docNumbers
    null as never, // invoices
    { generateCompletionActPdf } as never,
    null as never, // events
  );
  const pdfArg = () => generateCompletionActPdf.mock.calls[0]?.[0] as PdfArg;
  return { service, actFindFirst, generateCompletionActPdf, pdfArg };
}

describe('CompletionActsService.generatePdf — сума акта з ПДВ (BR-WO-007)', () => {
  // guards: BR-WO-007
  it('«ПДВ зверху»: сума акта = wo.totalAmount (840), а не сума рядків (700); totalNet і vatTotal передано', async () => {
    const { service, pdfArg } = setup({ totalNet: 700, totalAmount: 840 });

    await service.generatePdf(ORG, ACT_ID);

    const arg = pdfArg();
    expect(arg.lines.reduce((s, l) => s + l.amount, 0)).toBe(700);
    expect(arg.total).toBe(840);
    expect(arg.totalNet).toBe(700);
    expect(arg.vatTotal).toBe(140);
  });

  // guards: BR-WO-007
  it('«ПДВ у ціні»: сума акта = wo.totalAmount (700), сума без ПДВ і ПДВ — з тоталів наряду', async () => {
    const { service, pdfArg } = setup({ totalNet: 583.33, totalAmount: 700 });

    await service.generatePdf(ORG, ACT_ID);

    const arg = pdfArg();
    expect(arg.total).toBe(700);
    expect(arg.totalNet).toBe(583.33);
    expect(arg.vatTotal).toBe(116.67);
  });

  // guards: BR-WO-007
  // guards: BR-WO-007
  it('наряд без ПДВ, сума рядків відстає на копійку (Bug #807): сума акта = wo.totalAmount (100.07), а не Σ рядків (100.06)', async () => {
    // Наряд округлює 3 × (0.3 × 111.11) + 0.07 = 100.069 РАЗ → 100.07 (це борг клієнта);
    // рядки акта округлені кожен окремо: 33.33 × 3 + 0.07 = 100.06.
    const line = {
      normoHours: 0.3,
      actualHours: null,
      price: 111.11,
      amount: 33.33,
      workId: 'w-1',
      work: { name: 'Діагностика' },
    };
    const { service, pdfArg } = setup(
      { totalNet: 100.07, totalAmount: 100.07 },
      {
        lines: [line, line, line],
        parts: [
          {
            quantity: 1,
            price: 0.07,
            amount: 0.07,
            goodId: 'g-1',
            good: { name: 'Шайба', unit: 'шт' },
          },
        ],
      },
    );

    await service.generatePdf(ORG, ACT_ID);

    const arg = pdfArg();
    expect(arg.lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(100.06, 2);
    expect(arg.total).toBe(100.07);
    expect(Object.prototype.hasOwnProperty.call(arg, 'vatTotal')).toBe(false);
  });

  // guards: BR-WO-007
  it('наряд без ПДВ: totalNet / vatTotal НЕ передаються (ключів немає), сума = сума наряду', async () => {
    const { service, pdfArg } = setup({ totalNet: 700, totalAmount: 700 });

    await service.generatePdf(ORG, ACT_ID);

    const arg = pdfArg();
    expect(arg.total).toBe(700);
    expect(Object.prototype.hasOwnProperty.call(arg, 'totalNet')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(arg, 'vatTotal')).toBe(false);
  });

  // guards: BR-WO-007
  it('акт читається у межах свого orgId разом із тоталами наряду; чужий/відсутній → 404, PDF не будується', async () => {
    const found = setup({ totalNet: 700, totalAmount: 840 });
    await found.service.generatePdf(ORG, ACT_ID);
    const query = found.actFindFirst.mock.calls[0]?.[0] as {
      where: unknown;
      include: { workOrder: { select: Record<string, unknown> } };
    };
    expect(query.where).toEqual({ id: ACT_ID, orgId: ORG, deletedAt: null });
    expect(query.include.workOrder.select).toMatchObject({ totalNet: true, totalAmount: true });

    const missing = setup(null);
    await expect(missing.service.generatePdf('org-2', ACT_ID)).rejects.toThrow(NotFoundException);
    expect(missing.generateCompletionActPdf).not.toHaveBeenCalled();
  });
});
