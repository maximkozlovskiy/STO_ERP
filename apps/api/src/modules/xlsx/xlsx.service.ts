import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';
import { TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT } from '@sto/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from '../inventory/pricing.service';
import { deduplicateBy } from '../../common/utils/array';
import { roundMoney } from '../../common/utils/math';

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

  /**
   * Перетворити Buffer/Uint8Array у незалежний ArrayBuffer для ExcelJS.
   * Buffer.allocUnsafe використовує спільний пул → buffer.buffer може бути
   * більший за фактичні дані, з byteOffset > 0. Прямий cast (buffer.buffer
   * as ArrayBuffer) → ExcelJS читає чужі дані з пулу. slice(byteOffset, +length)
   * гарантує копію саме нашого зрізу.
   */
  private toArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

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

    sheet.columns = [{ header: 'Назва бренду', key: 'name', width: 30 }];

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
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Товари') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Товари" не знайдено');

    const rows: GoodRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return; // Skip header
      rowNum = idx;
      try {
        const values = row.values as unknown[];
        const salePrice = this.parseNumber(values[5]);
        if (!salePrice) throw new Error("Ціна продажу обов'язкова");
        rows.push({
          sku: String(values[1] || '').trim() || undefined,
          name: String(values[2] || '').trim(),
          unit: String(values[3] || '').trim() || undefined,
          purchasePrice: this.parseNumber(values[4]),
          salePrice,
          category: String(values[6] || '').trim() || undefined,
        });
      } catch (e: unknown) {
        throw new BadRequestException(
          `Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`,
        );
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parseWorks(buffer: Buffer | Uint8Array): Promise<WorkRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Роботи') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Роботи" не знайдено');

    const rows: WorkRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as unknown[];
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
        throw new BadRequestException(
          `Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`,
        );
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parseBrands(buffer: Buffer | Uint8Array): Promise<BrandRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Бренди') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Бренди" не знайдено');

    const rows: BrandRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as unknown[];
        const name = String(values[1] || '').trim();
        if (name) rows.push({ name });
      } catch (e: unknown) {
        throw new BadRequestException(
          `Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`,
        );
      }
    });

    if (rows.length === 0) throw new BadRequestException('Таблиця не містить жодного рядка даних');
    return rows;
  }

  async parseUnits(buffer: Buffer | Uint8Array): Promise<UnitRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Одиниці') || workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Аркуш "Одиниці" не знайдено');

    const rows: UnitRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as unknown[];
        const name = String(values[1] || '').trim();
        const shortName = String(values[2] || '').trim();
        if (name && shortName) rows.push({ name, shortName });
      } catch (e: unknown) {
        throw new BadRequestException(
          `Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`,
        );
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

  /**
   * Bulk lookup goods by SKU OR name in a single query — уникає N+1 у line importers.
   * Повертає Map<key, good> де key = `sku:lower` або `name:lower`. Резолвер resolveGood
   * має той самий пріоритет що й оригінальний findFirst (SKU > name).
   */
  private async lookupGoodsBulk(
    orgId: string,
    rows: Array<{ sku?: string; name: string }>,
  ): Promise<Map<string, { id: string }>> {
    const skus = Array.from(new Set(rows.map(r => r.sku).filter((s): s is string => !!s)));
    const names = Array.from(new Set(rows.map(r => r.name).filter(Boolean)));
    if (skus.length === 0 && names.length === 0) return new Map();

    const orConditions: Array<Record<string, unknown>> = [];
    if (skus.length) orConditions.push({ sku: { in: skus } });
    if (names.length) orConditions.push({ name: { in: names } });

    const goods = await this.prisma.good.findMany({
      where: { orgId, deletedAt: null, OR: orConditions },
      select: { id: true, sku: true, name: true },
      take: 10000,
    });

    const byKey = new Map<string, { id: string }>();
    for (const g of goods) {
      if (g.sku) byKey.set(`sku:${g.sku.toLowerCase()}`, { id: g.id });
      byKey.set(`name:${g.name.toLowerCase()}`, { id: g.id });
    }
    return byKey;
  }

  private resolveGood(byKey: Map<string, { id: string }>, row: { sku?: string; name: string }) {
    if (row.sku) {
      const bySku = byKey.get(`sku:${row.sku.toLowerCase()}`);
      if (bySku) return bySku;
    }
    return byKey.get(`name:${row.name.toLowerCase()}`) ?? null;
  }

  async importPOLines(
    orgId: string,
    poId: string,
    buffer: Buffer | Uint8Array,
  ): Promise<ImportResult> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, orgId, deletedAt: null },
    });
    if (!po) throw new NotFoundException('Замовлення постачальника не знайдено');
    if (po.status !== 'DRAFT') throw new ForbiddenException('Замовлення не в статусі DRAFT');

    const rows = await this.parsePOLines(buffer);
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    // Bulk prefetch goods + existing lines — раніше N rows × 2 queries (3000 RTT на 1000 рядків).
    // Тепер 2 батч-запити + N локальних lookup у Map.
    const goodsByKey = await this.lookupGoodsBulk(orgId, rows);
    const goodIds = Array.from(
      new Set(
        rows.map(r => this.resolveGood(goodsByKey, r)?.id).filter((id): id is string => !!id),
      ),
    );
    const existingLines = goodIds.length
      ? await this.prisma.purchaseOrderLine.findMany({
          where: { purchaseOrderId: poId, goodId: { in: goodIds }, orgId, deletedAt: null },
          select: { id: true, goodId: true },
          // Safety cap — bounded by goodIds (xlsx rows) but cap prevents OOM
          // if a single PO ever has >1000 line items.
          take: MAX_QUERY_LIMIT,
        })
      : [];
    const existingByGoodId = new Map(existingLines.map(l => [l.goodId, l.id]));

    // sto-optimize: розділяємо updates і creates — updates паралель через Promise.all
    // (unique where: { id }, no contention), creates батч'имо у createMany (1 INSERT vs N).
    // Раніше: N sequential queries (по 30-50ms RTT кожен) → 30-50s для 1000 рядків.
    // Дедуплікація по goodId — якщо xlsx має дублікати, лишаємо ПЕРШИЙ рядок (last-write-wins
    // сценарій раніше теж не гарантувався порядком — користувач має чистити вхід сам).
    const updatesPlan: { id: string; quantity: number; price: number; label: string }[] = [];
    const createsPlan: Prisma.PurchaseOrderLineCreateManyInput[] = [];
    const seenGoodIds = new Set<string>();
    for (const row of rows) {
      try {
        const good = this.resolveGood(goodsByKey, row);
        if (!good) {
          result.errors.push(`Товар не знайдено: ${row.sku ?? row.name}`);
          continue;
        }
        if (seenGoodIds.has(good.id)) {
          result.errors.push(`Дублікат товару у файлі: ${row.sku ?? row.name}`);
          continue;
        }
        seenGoodIds.add(good.id);

        const existingId = existingByGoodId.get(good.id);
        if (existingId) {
          updatesPlan.push({
            id: existingId,
            quantity: row.quantity,
            price: row.price,
            label: row.sku ?? row.name,
          });
        } else {
          createsPlan.push({
            orgId,
            purchaseOrderId: poId,
            goodId: good.id,
            quantity: row.quantity,
            price: row.price,
          });
        }
      } catch (e: unknown) {
        result.errors.push(`${row.sku ?? row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    // Updates паралель — кожен унікальний by id, ніяких конфліктів.
    const updateResults = await Promise.allSettled(
      updatesPlan.map(u =>
        this.prisma.purchaseOrderLine.update({
          where: { id: u.id, orgId },
          data: { quantity: u.quantity, price: u.price },
        }),
      ),
    );
    for (let i = 0; i < updateResults.length; i++) {
      const r = updateResults[i];
      const u = updatesPlan[i];
      if (!r || !u) continue;
      if (r.status === 'fulfilled') {
        result.updated++;
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : 'помилка';
        result.errors.push(`${u.label}: ${reason}`);
      }
    }

    // Creates батчем — один INSERT з усіма рядками.
    if (createsPlan.length > 0) {
      try {
        await this.prisma.purchaseOrderLine.createMany({ data: createsPlan });
        result.created += createsPlan.length;
      } catch (e: unknown) {
        result.errors.push(
          `Помилка масового створення: ${e instanceof Error ? e.message : 'помилка'}`,
        );
      }
    }

    return result;
  }

  async importSDLines(
    orgId: string,
    docId: string,
    buffer: Buffer | Uint8Array,
  ): Promise<ImportResult> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id: docId, orgId, deletedAt: null },
    });
    if (!doc) throw new NotFoundException('Складський документ не знайдено');
    if (doc.status !== 'DRAFT') throw new ForbiddenException('Документ не в статусі DRAFT');

    const rows = await this.parsePOLines(buffer);
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    // Bulk prefetch — уникає N+1 (раніше 2 RTT × N rows).
    const goodsByKey = await this.lookupGoodsBulk(orgId, rows);
    const goodIds = Array.from(
      new Set(
        rows.map(r => this.resolveGood(goodsByKey, r)?.id).filter((id): id is string => !!id),
      ),
    );
    const existingLines = goodIds.length
      ? await this.prisma.stockDocumentLine.findMany({
          where: { stockDocumentId: docId, goodId: { in: goodIds }, orgId, deletedAt: null },
          select: { id: true, goodId: true },
          // Safety cap — bounded by goodIds (xlsx rows); see importPOLines.
          take: MAX_QUERY_LIMIT,
        })
      : [];
    const existingByGoodId = new Map(existingLines.map(l => [l.goodId, l.id]));

    // sto-optimize: дивись importPOLines — той самий патерн (updates паралель + creates createMany).
    const updatesPlan: { id: string; quantity: number; price: number; label: string }[] = [];
    const createsPlan: Prisma.StockDocumentLineCreateManyInput[] = [];
    const seenGoodIds = new Set<string>();
    for (const row of rows) {
      try {
        const good = this.resolveGood(goodsByKey, row);
        if (!good) {
          result.errors.push(`Товар не знайдено: ${row.sku ?? row.name}`);
          continue;
        }
        if (seenGoodIds.has(good.id)) {
          result.errors.push(`Дублікат товару у файлі: ${row.sku ?? row.name}`);
          continue;
        }
        seenGoodIds.add(good.id);

        const existingId = existingByGoodId.get(good.id);
        if (existingId) {
          updatesPlan.push({
            id: existingId,
            quantity: row.quantity,
            price: row.price,
            label: row.sku ?? row.name,
          });
        } else {
          createsPlan.push({
            orgId,
            stockDocumentId: docId,
            goodId: good.id,
            quantity: row.quantity,
            price: row.price,
          });
        }
      } catch (e: unknown) {
        result.errors.push(`${row.sku ?? row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    const updateResults = await Promise.allSettled(
      updatesPlan.map(u =>
        this.prisma.stockDocumentLine.update({
          where: { id: u.id, orgId },
          data: { quantity: u.quantity, price: u.price },
        }),
      ),
    );
    for (let i = 0; i < updateResults.length; i++) {
      const r = updateResults[i];
      const u = updatesPlan[i];
      if (!r || !u) continue;
      if (r.status === 'fulfilled') {
        result.updated++;
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : 'помилка';
        result.errors.push(`${u.label}: ${reason}`);
      }
    }

    if (createsPlan.length > 0) {
      try {
        await this.prisma.stockDocumentLine.createMany({ data: createsPlan });
        result.created += createsPlan.length;
      } catch (e: unknown) {
        result.errors.push(
          `Помилка масового створення: ${e instanceof Error ? e.message : 'помилка'}`,
        );
      }
    }

    return result;
  }

  async importWOParts(
    orgId: string,
    woId: string,
    buffer: Buffer | Uint8Array,
  ): Promise<ImportResult> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: woId, orgId, deletedAt: null },
    });
    if (!wo) throw new NotFoundException('Наряд-замовлення не знайдено');
    if (!['DRAFT', 'ESTIMATE'].includes(wo.status))
      throw new ForbiddenException('Наряд не в статусі DRAFT або ESTIMATE');

    const rows = await this.parsePOLines(buffer);
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    // Bulk prefetch — уникає N+1 (раніше 2 RTT × N rows + 1 warehouse find per insert).
    // Default warehouse теж prefetch-имо один раз (для нових WorkOrderPart).
    const [goodsByKey, existingParts, defaultWarehouse] = await Promise.all([
      this.lookupGoodsBulk(orgId, rows),
      this.prisma.workOrderPart.findMany({
        where: { workOrderId: woId, orgId, deletedAt: null },
        select: { id: true, goodId: true },
        // Safety cap — work-order rarely has >100 parts; cap protects against
        // OOM if xlsx import targets a corrupted/test WO with many lines.
        take: MAX_QUERY_LIMIT,
      }),
      this.prisma.warehouse.findFirst({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const existingByGoodId = new Map(existingParts.map(p => [p.goodId, p.id]));

    // sto-optimize: дивись importPOLines — той самий патерн (updates паралель + creates createMany).
    const updatesPlan: {
      id: string;
      quantity: number;
      price: number;
      amount: number;
      label: string;
    }[] = [];
    const createsPlan: Prisma.WorkOrderPartCreateManyInput[] = [];
    const seenGoodIds = new Set<string>();
    for (const row of rows) {
      try {
        const good = this.resolveGood(goodsByKey, row);
        if (!good) {
          result.errors.push(`Товар не знайдено: ${row.sku ?? row.name}`);
          continue;
        }
        if (seenGoodIds.has(good.id)) {
          result.errors.push(`Дублікат товару у файлі: ${row.sku ?? row.name}`);
          continue;
        }
        seenGoodIds.add(good.id);

        const existingId = existingByGoodId.get(good.id);
        const amount = roundMoney(row.quantity * row.price);

        if (existingId) {
          updatesPlan.push({
            id: existingId,
            quantity: row.quantity,
            price: row.price,
            amount,
            label: row.sku ?? row.name,
          });
        } else {
          if (!defaultWarehouse) {
            result.errors.push(`${row.sku ?? row.name}: склад не знайдено для організації`);
            continue;
          }
          createsPlan.push({
            orgId,
            workOrderId: woId,
            goodId: good.id,
            warehouseId: defaultWarehouse.id,
            quantity: row.quantity,
            price: row.price,
            amount,
          });
        }
      } catch (e: unknown) {
        result.errors.push(`${row.sku ?? row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    const updateResults = await Promise.allSettled(
      updatesPlan.map(u =>
        this.prisma.workOrderPart.update({
          where: { id: u.id, orgId },
          data: { quantity: u.quantity, price: u.price, amount: u.amount },
        }),
      ),
    );
    for (let i = 0; i < updateResults.length; i++) {
      const r = updateResults[i];
      const u = updatesPlan[i];
      if (!r || !u) continue;
      if (r.status === 'fulfilled') {
        result.updated++;
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : 'помилка';
        result.errors.push(`${u.label}: ${reason}`);
      }
    }

    if (createsPlan.length > 0) {
      try {
        await this.prisma.workOrderPart.createMany({ data: createsPlan });
        result.created += createsPlan.length;
      } catch (e: unknown) {
        result.errors.push(
          `Помилка масового створення: ${e instanceof Error ? e.message : 'помилка'}`,
        );
      }
    }

    return result;
  }

  async parsePOLines(buffer: Buffer | Uint8Array): Promise<POLineRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.worksheets[0];

    if (!sheet) throw new BadRequestException('Таблиця не знайдена');

    const rows: POLineRow[] = [];
    let rowNum = 0;

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      rowNum = idx;
      try {
        const values = row.values as unknown[];
        const qty = this.parseNumber(values[3]);
        const price = this.parseNumber(values[4]);
        if (!qty || !price) throw new Error("К-ть і ціна обов'язкові");
        rows.push({
          sku: String(values[1] || '').trim() || undefined,
          name: String(values[2] || '').trim(),
          quantity: qty,
          price,
        });
      } catch (e: unknown) {
        throw new BadRequestException(
          `Помилка в рядку ${rowNum}: ${e instanceof Error ? e.message : 'невідома помилка'}`,
        );
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
    details: {
      goodId: string;
      goodName: string;
      sku: string | null;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[];
  }> {
    let items: Array<{ sku?: string; barcode?: string }>;

    if (fileType === 'csv') {
      const text = buffer.toString('utf-8').replace(/^﻿/, ''); // strip BOM
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- parseCSV повертає unknown[]; каст потрібен tsc (ESLint хибно вважає зайвим)
      const records = parseCSV(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];
      items = records
        .map(r => ({
          sku: r['sku'] || r['SKU'] || r['Артикул'] || undefined,
          barcode: r['barcode'] || r['Штрихкод'] || undefined,
        }))
        .filter(r => r.sku || r.barcode);
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(this.toArrayBuffer(buffer));
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
    const details: {
      goodId: string;
      goodName: string;
      sku: string | null;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[] = [];

    // Bulk prefetch: усі goods за всіма SKU + barcodes ОДНИМ запитом + усі правила org один раз.
    // Раніше: per-item good.findFirst + per-item calculateSalePrice (який сам фетчить правила) → 2N+ RTT.
    // Тепер: 2 RTT (goods + rules) + N локальних lookup + 1 транзакція per actual price change.
    const skus = Array.from(new Set(items.map(i => i.sku).filter((s): s is string => !!s)));
    const barcodes = Array.from(new Set(items.map(i => i.barcode).filter((b): b is string => !!b)));
    const orConditions: Array<Record<string, unknown>> = [];
    if (skus.length) orConditions.push({ sku: { in: skus } });
    if (barcodes.length) orConditions.push({ barcodes: { some: { barcode: { in: barcodes } } } });

    // Perf: select narrow projection for pricing — Brand record entirely unused
    // (computePriceFromRules reads only good.brandId scalar), Good's heavy columns
    // (description, customFields, photoUrl) likewise unused.
    const [goods, rules] = await Promise.all([
      orConditions.length
        ? this.prisma.good.findMany({
            where: { orgId, deletedAt: null, OR: orConditions },
            select: {
              id: true,
              name: true,
              sku: true,
              salePrice: true,
              purchasePrice: true,
              category: true,
              goodType: true,
              brandId: true,
              barcodes: { select: { barcode: true } },
            },
            take: 10000,
          })
        : Promise.resolve([]),
      this.pricingService.getActiveRulesForOrg(orgId),
    ]);

    // Build lookup maps: SKU → good (case-insensitive) + barcode → good
    const goodBySku = new Map<string, (typeof goods)[number]>();
    const goodByBarcode = new Map<string, (typeof goods)[number]>();
    for (const g of goods) {
      if (g.sku) goodBySku.set(g.sku.toLowerCase(), g);
      for (const bc of g.barcodes ?? []) {
        goodByBarcode.set(bc.barcode, g);
      }
    }

    // sto-optimize: batch плани змін у пам'яті, потім chunk'ами по 100
    // у $transaction. Раніше — per-item $transaction (1000 items × BEGIN/COMMIT
    // sequentially). Тепер: 1000 items → 10 transactions × 100 ops; -90% RTT і
    // суттєво швидше через amortized tx overhead. Pattern узгоджений з
    // pricing.applyRuleToGoods + purchase-orders.applyPricing.
    type Plan = {
      goodId: string;
      goodName: string;
      sku: string | null;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    };
    const plan: Plan[] = [];

    for (const item of items) {
      let good: (typeof goods)[number] | undefined;
      if (item.sku) good = goodBySku.get(item.sku.toLowerCase());
      if (!good && item.barcode) good = goodByBarcode.get(item.barcode);

      if (!good) {
        notFound.push(item.sku ?? item.barcode ?? '?');
        continue;
      }

      // Data-corruption guard: if the good has no `purchasePrice`,
      // PERCENT/COMPETITOR_PLUS/COST_TIER rules return newSalePrice=0 → salePrice wiped.
      // Skip such goods and report them to the user via notFound.
      if (good.purchasePrice == null || Number(good.purchasePrice) <= 0) {
        notFound.push(`${good.sku ?? item.sku ?? item.barcode ?? good.name} (без собівартості)`);
        continue;
      }

      const costPrice = Number(good.purchasePrice);
      const oldSalePrice = Number(good.salePrice);
      const newSalePrice = this.pricingService.computePriceFromRules(
        rules,
        good.id,
        good.category ?? undefined,
        good.goodType ?? undefined,
        good.brandId ?? undefined,
        costPrice,
      );

      details.push({
        goodId: good.id,
        goodName: good.name,
        sku: good.sku,
        costPrice,
        oldSalePrice,
        newSalePrice,
      });

      if (Math.abs(newSalePrice - oldSalePrice) < 0.001) continue;

      plan.push({
        goodId: good.id,
        goodName: good.name,
        sku: good.sku,
        costPrice,
        oldSalePrice,
        newSalePrice,
      });
    }

    // sto-optimize: xlsx-імпорт може мати дублікати по goodId (різні SKU/barcode на той
    // самий товар). Старий for-loop sequential мав last-write-wins семантику — зберігаємо
    // через dedup по goodId (Map last-wins) ДО Promise.all, щоб два write на той самий
    // PK не гонилися всередині chunk.
    const dedupedPlan = deduplicateBy(plan, u => u.goodId);

    // Batch у chunks по 100 — короткі транзакції, менше lock contention.
    // updateMany includes orgId in where — defense-in-depth tenant guard.
    const CHUNK = 100;
    for (let i = 0; i < dedupedPlan.length; i += CHUNK) {
      const chunk = dedupedPlan.slice(i, i + CHUNK);
      await this.prisma.$transaction(
        async tx => {
          // sto-optimize: chunk вже дедуплікований по goodId → disjoint PK writes, race-safe.
          // У $transaction Prisma serializes на pinned connection — Promise.all дає
          // JS-overhead-economy без втрати safety. Tenant guard (orgId) збережений у where.
          await Promise.all(
            chunk.map(u =>
              tx.good.updateMany({
                where: { id: u.goodId, orgId, deletedAt: null },
                data: { salePrice: u.newSalePrice },
              }),
            ),
          );
          await tx.priceHistory.createMany({
            data: chunk.map(u => ({
              orgId,
              goodId: u.goodId,
              oldPrice: u.oldSalePrice,
              newPrice: u.newSalePrice,
              costPrice: u.costPrice,
              reason: 'List pricing import',
            })),
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
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
