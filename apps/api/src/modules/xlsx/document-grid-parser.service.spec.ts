import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { DocumentGridParserService } from './document-grid-parser.service';

describe('DocumentGridParserService', () => {
  let service: DocumentGridParserService;
  beforeEach(() => {
    service = new DocumentGridParserService();
  });

  /** Будує справжній .xlsx-буфер із сітки. */
  async function xlsxBuffer(rows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    rows.forEach(r => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  describe('detectKind / assertSupported', () => {
    it.each([
      ['invoice.xlsx', 'xlsx'],
      ['INVOICE.XLSX', 'xlsx'],
      ['statement.csv', 'csv'],
      ['Statement.Csv', 'csv'],
      ['nakladna.pdf', 'pdf'],
      ['NAKLADNA.PDF', 'pdf'],
    ])('%s → %s', (name, kind) => {
      expect(service.detectKind(name)).toBe(kind);
    });

    it.each(['file.txt', 'file.dbf', 'file.xls', 'noextension', ''])(
      '%s → не підтримується',
      name => {
        expect(service.detectKind(name)).toBeNull();
        expect(() => service.assertSupported(name)).toThrow(BadRequestException);
      },
    );
  });

  describe('CSV', () => {
    it('проста сітка з кирилицею', async () => {
      const csv = 'Артикул,Найменування,К-сть\nA1,Фільтр,2\nB2,Ремінь,5\n';
      const g = await service.parseGrid(Buffer.from(csv, 'utf-8'), 'f.csv');
      expect(g.kind).toBe('csv');
      expect(g.rows).toEqual([
        ['Артикул', 'Найменування', 'К-сть'],
        ['A1', 'Фільтр', '2'],
        ['B2', 'Ремінь', '5'],
      ]);
      expect(g.columnCount).toBe(3);
      expect(g.totalRows).toBe(3);
    });

    it('BOM на початку не псує перший заголовок', async () => {
      const csv = '﻿Артикул,Назва\nA1,Фільтр\n';
      const g = await service.parseGrid(Buffer.from(csv, 'utf-8'), 'f.csv');
      expect(g.rows[0]?.[0]).toBe('Артикул'); // не '﻿Артикул'
    });

    it('нерівні рядки не ламають парсинг (relax_column_count)', async () => {
      const csv = 'Артикул,Назва,К-сть\nA1,Фільтр,2\nВсього:\n';
      const g = await service.parseGrid(Buffer.from(csv, 'utf-8'), 'f.csv');
      expect(g.rows).toHaveLength(3);
      expect(g.rows[2]).toEqual(['Всього:']);
    });

    it('порожні рядки пропускаються', async () => {
      const csv = 'A,B\n\n1,2\n\n';
      const g = await service.parseGrid(Buffer.from(csv, 'utf-8'), 'f.csv');
      expect(g.rows).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });
  });

  describe('XLSX', () => {
    it('проста сітка', async () => {
      const buf = await xlsxBuffer([
        ['Артикул', 'Найменування', 'К-сть'],
        ['A1', 'Фільтр', 2],
      ]);
      const g = await service.parseGrid(buf, 'f.xlsx');
      expect(g.kind).toBe('xlsx');
      expect(g.rows[0]).toEqual(['Артикул', 'Найменування', 'К-сть']);
      expect(g.rows[1]).toEqual(['A1', 'Фільтр', '2']);
    });

    it('не-xlsx буфер → дружній 400, а не сирий 500', async () => {
      await expect(service.parseGrid(Buffer.from('not an xlsx'), 'f.xlsx')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rich-text / формула / помилка перетворюються на текст', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      const row = ws.addRow([]);
      row.getCell(1).value = { richText: [{ text: 'Фільтр ' }, { text: 'повітряний' }] };
      row.getCell(2).value = { formula: 'A1', result: 42 };
      row.getCell(3).value = { error: '#REF!' };
      row.commit();
      const buf = Buffer.from(await wb.xlsx.writeBuffer());

      const g = await service.parseGrid(buf, 'f.xlsx');
      expect(g.rows[0]?.[0]).toBe('Фільтр повітряний');
      expect(g.rows[0]?.[1]).toBe('42');
      expect(g.rows[0]?.[2]).toBe('#REF!');
    });
  });

  // ── Ключовий інваріант спільного представлення ──
  it('КРОС-ФОРМАТ: .xlsx і .csv з тими самими даними дають ОДНАКОВУ сітку', async () => {
    const data = [
      ['Артикул', 'Найменування', 'К-сть', 'Ціна'],
      ['04E-129-620', 'Фільтр повітряний', '2', '345,00'],
      ['WL7129', 'Фільтр масляний', '10', '85,50'],
    ];
    // Значення беремо в лапки: десяткова кома («345,00») інакше розбила б комірку на дві —
    // саме так і робить будь-який реальний CSV-експорт з українською локаллю.
    const csv = data.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const fromCsv = await service.parseGrid(Buffer.from(csv, 'utf-8'), 'f.csv');
    const fromXlsx = await service.parseGrid(await xlsxBuffer(data), 'f.xlsx');
    expect(fromXlsx.rows).toEqual(fromCsv.rows);
  });

  describe('PDF', () => {
    it('скан (image-only) → 400 з порадою попросити Excel/CSV', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const PDFDocument = require('pdfkit') as new (o: Record<string, unknown>) => {
        on(e: string, cb: (c?: Buffer) => void): void;
        rect(x: number, y: number, w: number, h: number): { fill(c: string): void };
        end(): void;
      };
      const pdf = await new Promise<Buffer>(resolve => {
        const doc = new PDFDocument({ size: 'A4' });
        const chunks: Buffer[] = [];
        doc.on('data', c => c && chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.rect(50, 50, 400, 600).fill('#dddddd');
        doc.end();
      });

      await expect(service.parseGrid(pdf, 'scan.pdf')).rejects.toThrow(BadRequestException);
    }, 30_000);

    it('не-PDF буфер → 400', async () => {
      await expect(service.parseGrid(Buffer.from('definitely not pdf'), 'f.pdf')).rejects.toThrow(
        BadRequestException,
      );
    }, 30_000);
  });
});
