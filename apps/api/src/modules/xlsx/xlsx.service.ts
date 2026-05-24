import { Injectable, BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';

export interface GoodRow {
  sku?: string;
  name: string;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  category?: string;
  brandId?: string;
}

export interface WorkRow {
  categoryName: string;
  name: string;
  normoHours: number;
  price: number;
  description?: string;
}

export interface BrandRow {
  name: string;
}

export interface UnitRow {
  name: string;
  shortName: string;
}

export interface POLineRow {
  sku?: string;
  name: string;
  quantity: number;
  price: number;
}

@Injectable()
export class XlsxService {
  async generateGoodsTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Товари');

    sheet.columns = [
      { header: 'Артикул (SKU)', key: 'sku', width: 15 },
      { header: 'Назва товару', key: 'name', width: 30 },
      { header: 'Од. виміру', key: 'unit', width: 10 },
      { header: 'Ціна закупки, ₴', key: 'purchasePrice', width: 15 },
      { header: 'Ціна продажу, ₴', key: 'salePrice', width: 15 },
      { header: 'Категорія', key: 'category', width: 20 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563eb' } };

    sheet.addRow({
      sku: 'OIL-5W40',
      name: 'Масло моторне 5W-40',
      unit: 'л',
      purchasePrice: 350,
      salePrice: 500,
      category: 'Мастила',
    });

    const buf = await workbook.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }

  async generateWorksTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Роботи');

    sheet.columns = [
      { header: 'Категорія', key: 'categoryName', width: 20 },
      { header: 'Назва роботи', key: 'name', width: 30 },
      { header: 'Нормо-годин', key: 'normoHours', width: 12 },
      { header: 'Ціна, ₴', key: 'price', width: 12 },
      { header: 'Опис', key: 'description', width: 40 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563eb' } };

    sheet.addRow({
      categoryName: 'ТО',
      name: 'Заміна масла',
      normoHours: 1.5,
      price: 300,
      description: 'Заміна моторної олії та фільтра',
    });

    const buf = await workbook.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }

  async generateBrandsTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Бренди');

    sheet.columns = [
      { header: 'Назва бренду', key: 'name', width: 30 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563eb' } };

    sheet.addRow({ name: 'BMW' });
    sheet.addRow({ name: 'Bosch' });

    const buf = await workbook.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }

  async generateUnitsTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Одиниці');

    sheet.columns = [
      { header: 'Назва', key: 'name', width: 20 },
      { header: 'Скорочення', key: 'shortName', width: 10 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563eb' } };

    sheet.addRow({ name: 'штука', shortName: 'шт' });
    sheet.addRow({ name: 'кілограм', shortName: 'кг' });
    sheet.addRow({ name: 'літр', shortName: 'л' });

    const buf = await workbook.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }

  async generatePOLinesTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Позиції');

    sheet.columns = [
      { header: 'Артикул (SKU)', key: 'sku', width: 15 },
      { header: 'Назва товару', key: 'name', width: 30 },
      { header: 'К-ть', key: 'quantity', width: 10 },
      { header: 'Ціна, ₴', key: 'price', width: 12 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563eb' } };

    sheet.addRow({
      sku: 'OIL-5W40',
      name: 'Масло моторне 5W-40',
      quantity: 2,
      price: 450,
    });

    const buf = await workbook.xlsx.writeBuffer();
    return buf as unknown as Buffer;
  }

  async parseGoods(buffer: Buffer | Uint8Array): Promise<GoodRow[]> {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx as any).load(buffer);
    const sheet = workbook.getWorksheet('Товари') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Товари" не знайдено');

    const rows: GoodRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return; // Skip header
      rowNum = idx;
      try {
        const values = row.values as (unknown)[];
        const salePrice = this.parseNumber(values[5]);
        if (!salePrice) throw new Error('Ціна продажу обов\'язкова');
        rows.push({
          sku: String(values[1] || '').trim() || undefined,
          name: String(values[2] || '').trim(),
          unit: String(values[3] || '').trim() || undefined,
          purchasePrice: this.parseNumber(values[4]),
          salePrice,
          category: String(values[6] || '').trim() || undefined,
        });
      } catch (e: unknown) {
        throw new BadRequestException(`Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`);
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parseWorks(buffer: Buffer | Uint8Array): Promise<WorkRow[]> {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx as any).load(buffer);
    const sheet = workbook.getWorksheet('Роботи') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Роботи" не знайдено');

    const rows: WorkRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as (unknown)[];
        const normoHours = this.parseNumber(values[3]);
        const price = this.parseNumber(values[4]);
        rows.push({
          categoryName: String(values[1] || '').trim(),
          name: String(values[2] || '').trim(),
          normoHours: normoHours ?? 1,
          price: price ?? 0,
          description: String(values[5] || '').trim() || undefined,
        });
      } catch (e: unknown) {
        throw new BadRequestException(`Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`);
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parseBrands(buffer: Buffer | Uint8Array): Promise<BrandRow[]> {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx as any).load(buffer);
    const sheet = workbook.getWorksheet('Бренди') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Бренди" не знайдено');

    const rows: BrandRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as (unknown)[];
        const name = String(values[1] || '').trim();
        if (name) rows.push({ name });
      } catch (e: unknown) {
        throw new BadRequestException(`Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`);
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parseUnits(buffer: Buffer | Uint8Array): Promise<UnitRow[]> {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx as any).load(buffer);
    const sheet = workbook.getWorksheet('Одиниці') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Одиниці" не знайдено');

    const rows: UnitRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as (unknown)[];
        const name = String(values[1] || '').trim();
        const shortName = String(values[2] || '').trim();
        if (name && shortName) rows.push({ name, shortName });
      } catch (e: unknown) {
        throw new BadRequestException(`Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`);
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parsePOLines(buffer: Buffer | Uint8Array): Promise<POLineRow[]> {
    const workbook = new ExcelJS.Workbook();
    await (workbook.xlsx as any).load(buffer);
    const sheet = workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Таблиця не знайдена');

    const rows: POLineRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as (unknown)[];
        const qty = this.parseNumber(values[3]);
        const price = this.parseNumber(values[4]);
        if (!qty || !price) throw new Error('К-ть і ціна обов\'язкові');
        rows.push({
          sku: String(values[1] || '').trim() || undefined,
          name: String(values[2] || '').trim(),
          quantity: qty,
          price,
        });
      } catch (e: unknown) {
        throw new BadRequestException(`Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`);
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  private parseNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
}
