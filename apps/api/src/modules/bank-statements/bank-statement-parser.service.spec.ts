import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BankStatementParserService, type ColumnMapping } from './bank-statement-parser.service';

// Парсер — чистий сервіс без DI. Тестуємо РЕАЛЬНУ поведінку на байтах файлу:
// UA-число (кома-десяткова, пробіли-тисячі), дата DD.MM.YYYY + ISO fallback, невалідні дати
// (31.02 rollover-guard), startRow, пропуск порожніх/підсумкових рядків, IBAN-нормалізація.

const MAPPING: ColumnMapping = {
  startRow: 2,
  dateCol: 1,
  amountCol: 2,
  externalIdCol: 3,
  payerNameCol: 4,
  payerIbanCol: 5,
  payerEdrpouCol: 6,
  purposeCol: 7,
};

function csvBuf(text: string): Buffer {
  return Buffer.from(text, 'utf-8');
}

async function xlsxBuf(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach(r => ws.addRow(r));
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

describe('BankStatementParserService.parseRows — CSV', () => {
  let service: BankStatementParserService;
  beforeEach(() => {
    service = new BankStatementParserService();
  });

  it('UA-число «1 250,00» + дата DD.MM.YYYY → RawTx з amount 1250 і UTC-північ', async () => {
    // Сума «1 250,00» містить кому-десяткову → мусить бути у лапках, інакше CSV розіб'є на колонки.
    const csv =
      'Дата,Сума,ID,Платник,IBAN,ЄДРПОУ,Призначення\n' +
      '01.03.2026,"1 250,00",ext-1,ТОВ Клієнт,UA12 3456,12345678,Оплата рахунок №777\n';
    const rows = await service.parseRows(csvBuf(csv), 'stmt.csv', MAPPING);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(1250);
    expect(rows[0]!.operationDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(rows[0]!.externalId).toBe('ext-1');
    // IBAN нормалізується (upper + без пробілів).
    expect(rows[0]!.payerIban).toBe('UA123456');
    expect(rows[0]!.payerEdrpou).toBe('12345678');
    expect(rows[0]!.purpose).toContain('777');
  });

  it('startRow=2 пропускає рядок заголовка', async () => {
    const csv = 'Дата,Сума,ID\n02.03.2026,100,ext-2\n';
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    const rows = await service.parseRows(csvBuf(csv), 'stmt.csv', m);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe('ext-2');
  });

  it('порожні та підсумкові рядки (без дати/суми/id) пропускаються', async () => {
    const csv =
      'Дата,Сума,ID\n' +
      '01.03.2026,100,ext-a\n' +
      ',,\n' + // порожній
      'Разом,999,\n' + // підсумковий — нема валідної дати + нема externalId
      '02.03.2026,200,ext-b\n';
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    const rows = await service.parseRows(csvBuf(csv), 'stmt.csv', m);
    expect(rows.map(r => r.externalId)).toEqual(['ext-a', 'ext-b']);
  });

  it('ISO-дата (YYYY-MM-DD) як fallback теж парситься', async () => {
    const csv = 'Дата,Сума,ID\n2026-03-05,50,ext-iso\n';
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    const rows = await service.parseRows(csvBuf(csv), 'stmt.csv', m);
    expect(rows[0]!.operationDate.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });

  it('РЕГРЕС: неіснуюча дата 31.02.2026 НЕ rollover у березень — рядок відкидається', async () => {
    // 31.02 → JS Date перекотив би у 03.03; parseDate тепер повертає null → рядок пропускається
    // (немає валідної дати). Раніше створювалась би транзакція з зіпсованою operationDate.
    const csv =
      'Дата,Сума,ID\n' +
      '31.02.2026,100,ext-bad\n' + // неіснуюча
      '15.03.2026,200,ext-ok\n';
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    const rows = await service.parseRows(csvBuf(csv), 'stmt.csv', m);
    expect(rows.map(r => r.externalId)).toEqual(['ext-ok']);
    expect(rows[0]!.operationDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('жодного валідного рядка → BadRequestException (noDataRows)', async () => {
    const csv = 'Дата,Сума,ID\nсміття,абв,\n';
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    await expect(service.parseRows(csvBuf(csv), 'stmt.csv', m)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('непідтримуваний формат файлу → BadRequestException', async () => {
    await expect(service.parseRows(csvBuf('x'), 'stmt.txt', MAPPING)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('відсутні опційні колонки (IBAN/ЄДРПОУ) → null, не падає', async () => {
    const csv = 'Дата,Сума,ID\n01.03.2026,100,ext-min\n';
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    const rows = await service.parseRows(csvBuf(csv), 'stmt.csv', m);
    expect(rows[0]!.payerIban).toBeNull();
    expect(rows[0]!.payerEdrpou).toBeNull();
    expect(rows[0]!.payerName).toBeNull();
    expect(rows[0]!.purpose).toBeNull();
  });
});

describe('BankStatementParserService.parseRows — XLSX', () => {
  let service: BankStatementParserService;
  beforeEach(() => {
    service = new BankStatementParserService();
  });

  it('xlsx з датою-коміркою (Date) та числом парситься у RawTx', async () => {
    const buf = await xlsxBuf([
      ['Дата', 'Сума', 'ID'],
      ['01.03.2026', 1250.5, 'ext-x1'],
    ]);
    const m: ColumnMapping = { startRow: 2, dateCol: 1, amountCol: 2, externalIdCol: 3 };
    const rows = await service.parseRows(buf, 'stmt.xlsx', m);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(1250.5);
    expect(rows[0]!.externalId).toBe('ext-x1');
  });
});

describe('BankStatementParserService.rawPreview', () => {
  let service: BankStatementParserService;
  beforeEach(() => {
    service = new BankStatementParserService();
  });

  it('CSV → сира сітка перших рядків + totalRows/columnCount', async () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n';
    const res = await service.rawPreview(csvBuf(csv), 'stmt.csv', 50);
    expect(res.rows[0]).toEqual(['a', 'b', 'c']);
    expect(res.totalRows).toBe(3);
    expect(res.columnCount).toBe(3);
  });

  it('непідтримуваний файл → BadRequestException', async () => {
    await expect(service.rawPreview(csvBuf('x'), 'stmt.pdf')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
