import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from '../inventory/pricing.service';

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

export interface ImportResult {
  created: number;
  updated: number;
  errors: string[];
}

@Injectable()
export class XlsxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}
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

  async generateSDLinesTemplate(): Promise<Buffer> {
    return this.generatePOLinesTemplate();
  }

  async generateWOPartsTemplate(): Promise<Buffer> {
    return this.generatePOLinesTemplate();
  }

  generatePricingListTemplate(): Buffer {
    const bom = '﻿';
    const csv = `${bom}sku,barcode,name\nOIL-5W40,,Масло моторне 5W-40\n,4820123456789,Фільтр оливи\n`;
    return Buffer.from(csv, 'utf-8');
  }

  // ─── Document line imports ────────────────────────────────────────────────────

  async importPOLines(orgId: string, poId: string, buffer: Buffer | Uint8Array): Promise<ImportResult> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, orgId, deletedAt: null },
    });
    if (!po) throw new NotFoundException('Замовлення постачальника не знайдено');
    if (po.status !== 'DRAFT') throw new ForbiddenException('Замовлення не в статусі DRAFT');

    const rows = await this.parsePOLines(buffer);
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        const good = await this.prisma.good.findFirst({
          where: {
            orgId,
            deletedAt: null,
            OR: [
              ...(row.sku ? [{ sku: row.sku }] : []),
              { name: row.name },
            ],
          },
        });
        if (!good) {
          result.errors.push(`Товар не знайдено: ${row.sku ?? row.name}`);
          continue;
        }

        const existing = await this.prisma.purchaseOrderLine.findFirst({
          where: { purchaseOrderId: poId, goodId: good.id, orgId, deletedAt: null },
        });

        if (existing) {
          await this.prisma.purchaseOrderLine.update({
            where: { id: existing.id },
            data: { quantity: row.quantity, price: row.price },
          });
          result.updated++;
        } else {
          await this.prisma.purchaseOrderLine.create({
            data: {
              orgId,
              purchaseOrderId: poId,
              goodId: good.id,
              quantity: row.quantity,
              price: row.price,
            },
          });
          result.created++;
        }
      } catch (e: unknown) {
        result.errors.push(`${row.sku ?? row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    return result;
  }

  async importSDLines(orgId: string, docId: string, buffer: Buffer | Uint8Array): Promise<ImportResult> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id: docId, orgId, deletedAt: null },
    });
    if (!doc) throw new NotFoundException('Складський документ не знайдено');
    if (doc.status !== 'DRAFT') throw new ForbiddenException('Документ не в статусі DRAFT');

    const rows = await this.parsePOLines(buffer);
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        const good = await this.prisma.good.findFirst({
          where: {
            orgId,
            deletedAt: null,
            OR: [
              ...(row.sku ? [{ sku: row.sku }] : []),
              { name: row.name },
            ],
          },
        });
        if (!good) {
          result.errors.push(`Товар не знайдено: ${row.sku ?? row.name}`);
          continue;
        }

        const existing = await this.prisma.stockDocumentLine.findFirst({
          where: { stockDocumentId: docId, goodId: good.id, orgId, deletedAt: null },
        });

        if (existing) {
          await this.prisma.stockDocumentLine.update({
            where: { id: existing.id },
            data: { quantity: row.quantity, price: row.price },
          });
          result.updated++;
        } else {
          await this.prisma.stockDocumentLine.create({
            data: {
              orgId,
              stockDocumentId: docId,
              goodId: good.id,
              quantity: row.quantity,
              price: row.price,
            },
          });
          result.created++;
        }
      } catch (e: unknown) {
        result.errors.push(`${row.sku ?? row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    return result;
  }

  async importWOParts(orgId: string, woId: string, buffer: Buffer | Uint8Array): Promise<ImportResult> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: woId, orgId, deletedAt: null },
    });
    if (!wo) throw new NotFoundException('Наряд-замовлення не знайдено');
    if (!['DRAFT', 'ESTIMATE'].includes(wo.status)) throw new ForbiddenException('Наряд не в статусі DRAFT або ESTIMATE');

    const rows = await this.parsePOLines(buffer);
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        const good = await this.prisma.good.findFirst({
          where: {
            orgId,
            deletedAt: null,
            OR: [
              ...(row.sku ? [{ sku: row.sku }] : []),
              { name: row.name },
            ],
          },
        });
        if (!good) {
          result.errors.push(`Товар не знайдено: ${row.sku ?? row.name}`);
          continue;
        }

        const existing = await this.prisma.workOrderPart.findFirst({
          where: { workOrderId: woId, goodId: good.id, orgId, deletedAt: null },
        });

        const amount = row.quantity * row.price;

        if (existing) {
          await this.prisma.workOrderPart.update({
            where: { id: existing.id },
            data: { quantity: row.quantity, price: row.price, amount },
          });
          result.updated++;
        } else {
          // WorkOrderPart requires warehouseId — use the first warehouse for the org
          const warehouse = await this.prisma.warehouse.findFirst({
            where: { orgId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
          });
          if (!warehouse) {
            result.errors.push(`${row.sku ?? row.name}: склад не знайдено для організації`);
            continue;
          }
          await this.prisma.workOrderPart.create({
            data: {
              orgId,
              workOrderId: woId,
              goodId: good.id,
              warehouseId: warehouse.id,
              quantity: row.quantity,
              price: row.price,
              amount,
            },
          });
          result.created++;
        }
      } catch (e: unknown) {
        result.errors.push(`${row.sku ?? row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    return result;
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

  async applyPricingFromList(
    orgId: string,
    buffer: Buffer,
    fileType: 'xlsx' | 'csv',
  ): Promise<{
    found: number;
    updated: number;
    notFound: string[];
    details: { goodId: string; goodName: string; sku: string | null; costPrice: number; oldSalePrice: number; newSalePrice: number }[];
  }> {
    let items: Array<{ sku?: string; barcode?: string }>;

    if (fileType === 'csv') {
      const text = buffer.toString('utf-8').replace(/^﻿/, ''); // strip BOM
      const records = parseCSV(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
      items = records.map(r => ({
        sku: r['sku'] || r['SKU'] || r['Артикул'] || undefined,
        barcode: r['barcode'] || r['Штрихкод'] || undefined,
      })).filter(r => r.sku || r.barcode);
    } else {
      const workbook = new ExcelJS.Workbook();
      await (workbook.xlsx as any).load(buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new BadRequestException('Таблиця не знайдена');
      items = [];
      sheet.eachRow((row, idx) => {
        if (idx === 1) return; // skip header
        const values = row.values as unknown[];
        const sku = String(values[1] ?? '').trim() || undefined;
        const barcode = String(values[2] ?? '').trim() || undefined;
        if (sku || barcode) items.push({ sku, barcode });
      });
    }

    if (items.length === 0) throw new BadRequestException('Файл не містить жодного рядка даних');

    const notFound: string[] = [];
    const details: { goodId: string; goodName: string; sku: string | null; costPrice: number; oldSalePrice: number; newSalePrice: number }[] = [];

    for (const item of items) {
      const orConditions: Array<Record<string, unknown>> = [];
      if (item.sku) orConditions.push({ sku: item.sku });
      if (item.barcode) orConditions.push({ barcodes: { some: { barcode: item.barcode } } });

      const good = await this.prisma.good.findFirst({
        where: { orgId, deletedAt: null, OR: orConditions },
        include: { brand: true },
      });

      if (!good) {
        notFound.push(item.sku ?? item.barcode ?? '?');
        continue;
      }

      const costPrice = Number(good.purchasePrice ?? 0);
      const oldSalePrice = Number(good.salePrice);
      const newSalePrice = await this.pricingService.calculateSalePrice(
        orgId,
        good.id,
        good.category,
        good.goodType,
        good.brandId,
        costPrice,
      );

      if (Math.abs(newSalePrice - oldSalePrice) < 0.001) {
        details.push({ goodId: good.id, goodName: good.name, sku: good.sku, costPrice, oldSalePrice, newSalePrice });
        continue;
      }

      await this.prisma.$transaction([
        this.prisma.good.update({ where: { id: good.id }, data: { salePrice: newSalePrice } }),
        this.prisma.priceHistory.create({
          data: {
            orgId,
            goodId: good.id,
            oldPrice: oldSalePrice,
            newPrice: newSalePrice,
            costPrice,
            reason: 'List pricing import',
          },
        }),
      ]);

      details.push({ goodId: good.id, goodName: good.name, sku: good.sku, costPrice, oldSalePrice, newSalePrice });
    }

    return {
      found: details.length,
      updated: details.filter(d => Math.abs(d.oldSalePrice - d.newSalePrice) >= 0.001).length,
      notFound,
      details,
    };
  }

  private parseNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
}
