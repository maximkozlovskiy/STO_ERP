import { describe, it, expect, vi } from 'vitest';
import { EstimateExportService } from './work-orders-export.service';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── Regression spec для Bug #508/#528 — totalAmount=planned у public export ──
//
// commit ca5aef48 змінив семантику WorkOrder.totalAmount:
//   ДО:    SUM(normoHours × price) + totalParts             (planned)
//   ПІСЛЯ: SUM((actualHours ?? normoHours) × price) + totalParts  (actual)
//
// Bug #508 виявлений у findByShareToken (JSON public endpoint). Bug #528 —
// парний sibling-endpoint у EstimateExportService.getEstimateData (живить PDF/
// XLSX/DOCX export). Тут teж totalAmount має бути PLANNED, бо це КОШТОРИС, а не
// акт виконаних робіт. Math у рядках (sum of l.amount = normoHours × price)
// має збігатися з ЗАГАЛЬНА СУМА — інакше підрив довіри клієнта.
//
// Цей spec ловить регресію: будь-який refactor що повертає `Number(wo.totalAmount)`
// у getEstimateData → CI червоніє.

const TOKEN = 'share-token-abc-123-def-456';

function makePrisma(opts: {
  totalLabor: number;
  totalActualLabor: number;
  totalParts: number;
  totalAmount: number;
}) {
  const workOrderFindFirst = vi.fn().mockResolvedValue({
    id: 'wo-1',
    orgId: 'org-1',
    number: 'WO-2026-0001',
    status: 'DRAFT',
    documentDate: new Date('2026-06-17'),
    description: 'Test',
    totalLabor: opts.totalLabor,
    totalActualLabor: opts.totalActualLabor,
    totalParts: opts.totalParts,
    totalAmount: opts.totalAmount,
    branch: { name: 'Філія 1' },
    counterparty: { firstName: 'Іван', lastName: 'Петров', companyName: null },
    vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AB1234CD' },
    lines: [],
    parts: [],
  });
  const organisationFindFirst = vi.fn().mockResolvedValue({
    name: 'СТО 1',
    logoUrl: null,
  });
  const goodUoMFindMany = vi.fn().mockResolvedValue([]);

  const prisma = {
    workOrder: { findFirst: workOrderFindFirst },
    organisation: { findFirst: organisationFindFirst },
    goodUoM: { findMany: goodUoMFindMany },
  } as unknown as PrismaService;

  return prisma;
}

describe('EstimateExportService.getEstimateData — totalAmount semantics (Bug #508/#528)', () => {
  it('totalAmount = totalLabor + totalParts (NOT wo.totalAmount)', async () => {
    // Симулюємо WO у DRAFT де хтось вручну заповнив actualHours → totalActualLabor > totalLabor.
    // wo.totalAmount у БД = 1300 (actual + parts).
    // Очікуваний export: 1200 = totalLabor (planned) + totalParts.
    const prisma = makePrisma({
      totalLabor: 1000,
      totalActualLabor: 1100, // actualHours додали 100 грн
      totalParts: 200,
      totalAmount: 1300, // wo.totalAmount = totalActualLabor + totalParts
    });
    const service = new EstimateExportService(prisma);

    const data = await service.getEstimateData(TOKEN);

    // КРИТИЧНО: export повертає PLANNED amount, не actual.
    expect(data.totalAmount).toBe(1200); // 1000 + 200
    // А не 1300 (wo.totalAmount = totalActualLabor + totalParts).
    expect(data.totalAmount).not.toBe(1300);
    expect(data.totalLabor).toBe(1000);
    expect(data.totalParts).toBe(200);
  });

  it('у звичайному кейсі (actualHours=null → totalActualLabor === totalLabor) export відповідає wo.totalAmount', async () => {
    // Більш частий кейс: actualHours не заповнено → totalActualLabor === totalLabor → wo.totalAmount = totalLabor + totalParts.
    // Тут export-totalAmount має бути ідентичним wo.totalAmount — sanity-check.
    const prisma = makePrisma({
      totalLabor: 500,
      totalActualLabor: 500,
      totalParts: 100,
      totalAmount: 600,
    });
    const service = new EstimateExportService(prisma);

    const data = await service.getEstimateData(TOKEN);
    expect(data.totalAmount).toBe(600);
  });

  it('лише запчастини, без рядків робіт → totalAmount = totalParts', async () => {
    const prisma = makePrisma({
      totalLabor: 0,
      totalActualLabor: 0,
      totalParts: 250,
      totalAmount: 250,
    });
    const service = new EstimateExportService(prisma);

    const data = await service.getEstimateData(TOKEN);
    expect(data.totalAmount).toBe(250);
  });

  it('NotFoundException якщо токен не знайдено (sanity)', async () => {
    const prisma = {
      workOrder: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new EstimateExportService(prisma);

    await expect(service.getEstimateData('bad-token')).rejects.toThrow(
      'Посилання не дійсне або термін дії минув',
    );
  });
});
