import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
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
  totalNet?: number;
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
    totalNet: opts.totalNet ?? opts.totalAmount,
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

// ─── BR-WO-007: кошторис несе той самий ПДВ, що й наряд ─────────────────────
//
// Плановий підсумок (totalLabor + totalParts) із ПДВ за режимом наряду: три величини
// totalNet / totalVat / totalAmount. Рядки «Сума без ПДВ» і «ПДВ» друкуються лише коли
// ПДВ > 0, і тоді підсумок підписано «ЗАГАЛЬНА СУМА З ПДВ».
describe('EstimateExportService — ПДВ у кошторисі (BR-WO-007)', () => {
  // план 1000 + 200 = 1200; факт 1100 + 200 = 1300.
  const EXCL = {
    totalLabor: 1000,
    totalActualLabor: 1100,
    totalParts: 200,
    totalNet: 1300,
    totalAmount: 1560, // «ПДВ зверху» 20%
  };
  const NO_VAT = { ...EXCL, totalNet: 1300, totalAmount: 1300 };

  /** Усі текстові комірки аркуша → число в колонці E того самого рядка. */
  async function xlsxLabels(buffer: Buffer): Promise<Map<string, unknown>> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const labels = new Map<string, unknown>();
    ws?.eachRow(row => {
      row.eachCell(cell => {
        if (typeof cell.value === 'string') labels.set(cell.value, row.getCell(5).value);
      });
    });
    return labels;
  }

  const docxText = (buffer: Buffer): string =>
    new PizZip(buffer).file('word/document.xml')?.asText() ?? '';

  // guards: BR-WO-007
  it('getEstimateData, «ПДВ зверху»: totalNet = план, totalVat = ПДВ на план, totalAmount = план + ПДВ', async () => {
    const service = new EstimateExportService(makePrisma(EXCL));

    const data = await service.getEstimateData(TOKEN);

    expect(data.totalNet).toBe(1200);
    expect(data.totalVat).toBe(240);
    expect(data.totalAmount).toBe(1440);
  });

  // guards: BR-WO-007
  it('getEstimateData, «ПДВ у ціні»: totalAmount = план, ПДВ виділено з нього', async () => {
    const service = new EstimateExportService(
      makePrisma({ ...EXCL, totalNet: 1083.33, totalAmount: 1300 }),
    );

    const data = await service.getEstimateData(TOKEN);

    expect(data.totalAmount).toBe(1200);
    expect(data.totalVat).toBe(200);
    expect(data.totalNet).toBe(1000);
  });

  // guards: BR-WO-007
  it('getEstimateData, наряд без ПДВ: totalVat = 0, totalNet = totalAmount = план', async () => {
    const service = new EstimateExportService(makePrisma(NO_VAT));

    const data = await service.getEstimateData(TOKEN);

    expect(data.totalVat).toBe(0);
    expect(data.totalNet).toBe(1200);
    expect(data.totalAmount).toBe(1200);
  });

  // guards: BR-WO-007
  it('XLSX з ПДВ: рядки «Сума без ПДВ» і «ПДВ», підсумок «ЗАГАЛЬНА СУМА З ПДВ» = сума до сплати', async () => {
    const service = new EstimateExportService(makePrisma(EXCL));

    const labels = await xlsxLabels((await service.generateXlsx(TOKEN)).buffer);

    expect(labels.get('Сума без ПДВ:')).toBe(1200);
    expect(labels.get('ПДВ:')).toBe(240);
    expect(labels.get('ЗАГАЛЬНА СУМА З ПДВ:')).toBe(1440);
    expect(labels.has('ЗАГАЛЬНА СУМА:')).toBe(false);
  });

  // guards: BR-WO-007
  it('XLSX без ПДВ: рядків «Сума без ПДВ» / «ПДВ» немає, підсумок «ЗАГАЛЬНА СУМА»', async () => {
    const service = new EstimateExportService(makePrisma(NO_VAT));

    const labels = await xlsxLabels((await service.generateXlsx(TOKEN)).buffer);

    expect(labels.has('Сума без ПДВ:')).toBe(false);
    expect(labels.has('ПДВ:')).toBe(false);
    expect(labels.has('ЗАГАЛЬНА СУМА З ПДВ:')).toBe(false);
    expect(labels.get('ЗАГАЛЬНА СУМА:')).toBe(1200);
  });

  // guards: BR-WO-007
  it('DOCX з ПДВ: «Сума без ПДВ», «ПДВ» і «ЗАГАЛЬНА СУМА З ПДВ» із сумою до сплати', async () => {
    const service = new EstimateExportService(makePrisma(EXCL));

    const xml = docxText((await service.generateDocx(TOKEN)).buffer);

    // Роздільник тисяч у uk-UA — нерозривний пробіл; не прив'язуємось до його коду.
    expect(xml).toMatch(/Сума без ПДВ: 1\s?200,00/u);
    expect(xml).toMatch(/>ПДВ: 240,00/u);
    expect(xml).toMatch(/ЗАГАЛЬНА СУМА З ПДВ: 1\s?440,00/u);
  });

  // guards: BR-WO-007
  it('DOCX без ПДВ: жодного рядка про ПДВ, підсумок «ЗАГАЛЬНА СУМА» = план', async () => {
    const service = new EstimateExportService(makePrisma(NO_VAT));

    const xml = docxText((await service.generateDocx(TOKEN)).buffer);

    expect(xml).not.toContain('ПДВ');
    expect(xml).toMatch(/ЗАГАЛЬНА СУМА: 1\s?200,00/u);
  });
});
