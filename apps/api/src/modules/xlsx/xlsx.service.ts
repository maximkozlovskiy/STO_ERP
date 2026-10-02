import { createHash } from 'node:crypto';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';
import { TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT, translateError } from '@sto/shared';
import { Prisma } from '@prisma/client';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  DocumentGridParserService,
  type GridSourceKind,
  type ParsedGrid,
} from './document-grid-parser.service';
import { PricingService } from '../inventory/pricing.service';
import { GoodsService } from '../goods/goods.service';
import { BrandsService } from '../brands/brands.service';
import { deduplicateBy } from '../../common/utils/array';
import { roundMoney } from '../../common/utils/math';
import { normalizeArticle } from '../../common/utils/normalize-article';
import {
  DocumentLineImportAdapterRegistry,
  type ImportDocType,
  type ImportLineInput,
} from './document-line-import.adapter';
import type {
  ApplyImportRowDto,
  ImportApplyMode,
  PreviewCandidate,
  PreviewRowDto,
  PreviewRowStatus,
} from './import.dto';

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
    private readonly goodsService: GoodsService,
    private readonly brandsService: BrandsService,
    private readonly importAdapters: DocumentLineImportAdapterRegistry,
    private readonly gridParser: DocumentGridParserService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Парсинг файлу в сітку з кешем за ХЕШЕМ ВМІСТУ — лише для OCR-каналів (pdf/image).
   *
   * НАВІЩО: майстер імпорту читає ОДИН і той самий файл двічі — rawPreview (показати вміст)
   * і потім previewImport→parseMappedRows (резолв товарів за мапінгом). Для xlsx/csv повторний
   * розбір коштує мілісекунди, а для скана/фото — ОКРЕМИЙ OCR-прогін 1-5 с × сторінку. Ключ —
   * sha256 вмісту (≈1-13 мс навіть на 25 МБ), тож другий прогін читає готову сітку з Redis.
   *
   * Безпека: сітка — ЧИСТА функція байтів файлу (parseGrid не бачить orgId і нічого в БД не пише),
   * тож ключ лише за хешем вмісту не змішує дані орендарів. Мапінг колонок застосовується ПІСЛЯ
   * (parseMappedRows), на вже довіреній серверній сітці — клієнт сітку не постачає.
   *
   * Офлайн-стійкість: CacheService мовчки деградує при недоступному Redis (get→null, set→no-op),
   * тож без Redis поведінка = поточна (OCR двічі) — нульовий ризик регресії. xlsx/csv не кешуємо:
   * повторний розбір і так дешевий, а зайвий серіалайз сітки у Redis не виправданий.
   */
  private async parseGridCached(
    buffer: Buffer | Uint8Array,
    filename: string,
  ): Promise<ParsedGrid> {
    const kind = this.gridParser.detectKind(filename);
    // Не-OCR канали (xlsx/csv) або невідомий формат — прямий розбір (parseGrid сам кине 400).
    if (kind !== 'pdf' && kind !== 'image') {
      return this.gridParser.parseGrid(buffer, filename);
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    const key = `xlsx:ocr-grid:${kind}:${hash}`;
    const cached = await this.cache.get<ParsedGrid>(key);
    if (cached) return cached;
    const grid = await this.gridParser.parseGrid(buffer, filename);
    // TTL 300 с — із запасом покриває крок ручного мапінгу колонок між двома запитами.
    await this.cache.set(key, grid, 300);
    return grid;
  }

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

    if (!sheet)
      throw new BadRequestException(translateError('err.xlsx.sheetGoodsNotFound', getLocale()));

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
          translateError('err.xlsx.rowError', getLocale(), {
            row: rowNum,
            detail:
              e instanceof Error
                ? e.message
                : translateError('err.xlsx.rowErrorUnknown', getLocale()),
          }),
        );
      }
    });

    if (rows.length === 0)
      throw new BadRequestException(translateError('err.xlsx.tableNoDataRows', getLocale()));
    return rows;
  }

  async parseWorks(buffer: Buffer | Uint8Array): Promise<WorkRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Роботи') || workbook.worksheets[0];

    if (!sheet)
      throw new BadRequestException(translateError('err.xlsx.sheetWorksNotFound', getLocale()));

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
          translateError('err.xlsx.rowError', getLocale(), {
            row: rowNum,
            detail:
              e instanceof Error
                ? e.message
                : translateError('err.xlsx.rowErrorUnknown', getLocale()),
          }),
        );
      }
    });

    if (rows.length === 0)
      throw new BadRequestException(translateError('err.xlsx.tableNoDataRows', getLocale()));
    return rows;
  }

  async parseBrands(buffer: Buffer | Uint8Array): Promise<BrandRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Бренди') || workbook.worksheets[0];

    if (!sheet)
      throw new BadRequestException(translateError('err.xlsx.sheetBrandsNotFound', getLocale()));

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
          translateError('err.xlsx.rowError', getLocale(), {
            row: rowNum,
            detail:
              e instanceof Error
                ? e.message
                : translateError('err.xlsx.rowErrorUnknown', getLocale()),
          }),
        );
      }
    });

    if (rows.length === 0)
      throw new BadRequestException(translateError('err.xlsx.tableNoDataRows', getLocale()));
    return rows;
  }

  async parseUnits(buffer: Buffer | Uint8Array): Promise<UnitRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(this.toArrayBuffer(buffer));
    const sheet = workbook.getWorksheet('Одиниці') || workbook.worksheets[0];

    if (!sheet)
      throw new BadRequestException(translateError('err.xlsx.sheetUnitsNotFound', getLocale()));

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
          translateError('err.xlsx.rowError', getLocale(), {
            row: rowNum,
            detail:
              e instanceof Error
                ? e.message
                : translateError('err.xlsx.rowErrorUnknown', getLocale()),
          }),
        );
      }
    });

    if (rows.length === 0)
      throw new BadRequestException(translateError('err.xlsx.tableNoDataRows', getLocale()));
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
    if (!po)
      throw new NotFoundException(translateError('err.xlsx.purchaseOrderNotFound', getLocale()));
    if (po.status !== 'DRAFT')
      throw new ForbiddenException(translateError('err.xlsx.orderNotDraft', getLocale()));

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
    if (!doc)
      throw new NotFoundException(translateError('err.xlsx.stockDocumentNotFound', getLocale()));
    if (doc.status !== 'DRAFT')
      throw new ForbiddenException(translateError('err.xlsx.documentNotDraft', getLocale()));

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
    if (!wo) throw new NotFoundException(translateError('err.xlsx.workOrderNotFound', getLocale()));
    if (!['DRAFT', 'ESTIMATE'].includes(wo.status))
      throw new ForbiddenException(
        translateError('err.xlsx.workOrderNotDraftOrEstimate', getLocale()),
      );

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

    if (!sheet)
      throw new BadRequestException(translateError('err.xlsx.tableNotFound', getLocale()));

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
          translateError('err.xlsx.rowError', getLocale(), {
            row: rowNum,
            detail:
              e instanceof Error
                ? e.message
                : translateError('err.xlsx.rowErrorUnknown', getLocale()),
          }),
        );
      }
    });

    if (rows.length === 0)
      throw new BadRequestException(translateError('err.xlsx.tableNoDataRows', getLocale()));
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
      if (!sheet)
        throw new BadRequestException(translateError('err.xlsx.tableNotFound', getLocale()));
      items = [];
      sheet.eachRow((row, idx) => {
        if (idx === 1) return; // skip header
        const values = row.values as unknown[];
        const sku = String(values[1] ?? '').trim() || undefined;
        const barcode = String(values[2] ?? '').trim() || undefined;
        if (sku || barcode) items.push({ sku, barcode });
      });
    }

    if (items.length === 0)
      throw new BadRequestException(translateError('err.xlsx.fileNoDataRows', getLocale()));

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

  // ─── Generic import: preview + apply ─────────────────────────────────────────

  /**
   * Прев'ю generic-імпорту товарів у документ (PO/StockDocument). НІЧОГО не пише.
   * Читає файл за мапінгом колонок, для кожного рядка резолвить Good:
   *  1) exact skuNormalized (+ бренд якщо задано і резолвиться) → matched;
   *  2) exact skuNormalized без бренду → 1 кандидат=matched, кілька=ambiguous;
   *  3) substring (skuNormalized contains norm АБО name ILIKE) → candidates (take 10);
   *  4) нічого → notFound.
   * Bulk: один findMany по всіх normArticles уникає N+1; substring — лише для нерозвʼязаних.
   */
  async previewImport(
    orgId: string,
    docType: ImportDocType,
    docId: string,
    buffer: Buffer | Uint8Array,
    filename: string,
    mapping: ImportMapping,
  ): Promise<PreviewRowDto[]> {
    const adapter = this.importAdapters.get(docType);
    const doc = await adapter.loadDoc(orgId, docId);
    if (!doc) throw new NotFoundException(translateError('err.xlsx.documentNotFound', getLocale()));
    adapter.assertDraft(doc.status);

    const parsed = await this.parseMappedRows(buffer, filename, mapping);

    // Bulk-резолв брендів (за rawBrand) — зберемо унікальні непорожні бренди й резолвимо кожен раз.
    const brandCache = new Map<string, string | null>(); // normBrand → brandId|null
    const resolveBrandId = async (rawBrand?: string | null): Promise<string | null> => {
      const norm = normalizeArticle(rawBrand);
      if (!norm) return null;
      if (brandCache.has(norm)) return brandCache.get(norm) ?? null;
      const brand = await this.brandsService.resolveByNameOrSynonym(orgId, rawBrand);
      brandCache.set(norm, brand?.id ?? null);
      return brand?.id ?? null;
    };

    // Bulk exact-lookup: усі непорожні normArticles одним findMany (уникнення N+1).
    const normArticles = Array.from(
      new Set(parsed.map(r => normalizeArticle(r.rawArticle)).filter(n => n.length > 0)),
    );
    const exactGoods = normArticles.length
      ? await this.prisma.good.findMany({
          where: { orgId, deletedAt: null, skuNormalized: { in: normArticles } },
          select: {
            id: true,
            sku: true,
            name: true,
            brandId: true,
            brand: { select: { name: true } },
          },
          take: MAX_QUERY_LIMIT,
        })
      : [];
    const exactByNorm = new Map<string, typeof exactGoods>();
    for (const g of exactGoods) {
      const key = normalizeArticle(g.sku);
      if (!key) continue;
      const arr = exactByNorm.get(key);
      if (arr) arr.push(g);
      else exactByNorm.set(key, [g]);
    }

    const rows: PreviewRowDto[] = [];
    for (const r of parsed) {
      const norm = normalizeArticle(r.rawArticle);
      const brandId = await resolveBrandId(r.rawBrand);

      let status: PreviewRowStatus = 'notFound';
      let matchedGoodId: string | null = null;
      let candidates: PreviewCandidate[] = [];

      const exact = norm ? (exactByNorm.get(norm) ?? []) : [];
      if (exact.length > 0) {
        // Якщо бренд задано і резолвиться — намагаємось звузити до нього.
        const byBrand = brandId ? exact.filter(g => g.brandId === brandId) : [];
        if (byBrand.length === 1) {
          status = 'matched';
          matchedGoodId = byBrand[0]!.id;
        } else if (byBrand.length > 1) {
          status = 'ambiguous';
          candidates = byBrand.map(g => this.toCandidate(g));
        } else if (exact.length === 1) {
          status = 'matched';
          matchedGoodId = exact[0]!.id;
        } else {
          status = 'ambiguous';
          candidates = exact.map(g => this.toCandidate(g));
        }
      } else {
        // Substring/ILIKE fallback — лише для нерозвʼязаних (не в bulk, кількість notFound мала).
        const or: Prisma.GoodWhereInput[] = [];
        if (norm) or.push({ skuNormalized: { contains: norm } });
        if (r.rawName && r.rawName.trim())
          or.push({ name: { contains: r.rawName.trim(), mode: 'insensitive' } });
        if (or.length) {
          const found = await this.prisma.good.findMany({
            where: { orgId, deletedAt: null, OR: or },
            select: {
              id: true,
              sku: true,
              name: true,
              brandId: true,
              brand: { select: { name: true } },
            },
            take: 10,
          });
          if (found.length) {
            status = 'ambiguous';
            candidates = found.map(g => this.toCandidate(g));
          }
        }
      }

      rows.push({
        rowIndex: r.rowIndex,
        rawCode: r.rawCode ?? null,
        rawArticle: r.rawArticle ?? null,
        rawBrand: r.rawBrand ?? null,
        rawName: r.rawName ?? null,
        quantity: r.quantity,
        price: r.price,
        status,
        matchedGoodId,
        candidates,
      });
    }

    return rows;
  }

  /**
   * Застосувати вирішені рядки прев'ю: для action='create' — резолв/створення бренду + Good,
   * для action='use' — валідація goodId у org. Зібрані рядки → adapter.replaceLines у $transaction.
   * Guard DRAFT + tenant orgId скрізь. Повертає нічого (контролер віддасть оновлений документ).
   */
  async applyImport(
    orgId: string,
    docType: ImportDocType,
    docId: string,
    resolvedRows: ApplyImportRowDto[],
    createdBy?: string,
    // Останнім параметром із дефолтом: backward-compat для наявних викликів і тестів.
    mode: ImportApplyMode = 'replace',
  ): Promise<void> {
    const adapter = this.importAdapters.get(docType);
    const doc = await adapter.loadDoc(orgId, docId);
    if (!doc) throw new NotFoundException(translateError('err.xlsx.documentNotFound', getLocale()));
    adapter.assertDraft(doc.status);

    const lines: ImportLineInput[] = [];
    // Дедуплікація по goodId у межах одного імпорту (Bug #748): PurchaseOrderLine /
    // StockDocumentLine НЕ мають @@unique(docId, goodId) → два рядки файлу, що резолвляться
    // у той самий товар (дублікат артикулу; кілька ambiguous → один вибір; use+create того ж
    // товару), інакше створили б ДВА рядки документа → задвоєна кількість і totalAmount.
    // Дзеркалить guard легасі-імпортерів (importPOLines: «Дублікат товару у файлі»): лишаємо
    // ПЕРШЕ входження, наступні пропускаємо. Для action='create' дедуп після резолву goodId —
    // повторний create того ж SKU і так впав би на ConflictException.
    const seenGoodIds = new Set<string>();
    for (const row of resolvedRows) {
      let goodId: string;
      if (row.action === 'create') {
        if (!row.createData?.name) {
          throw new BadRequestException(
            translateError('err.xlsx.rowGoodNameRequired', getLocale(), { row: row.rowIndex }),
          );
        }
        // Резолв або створення бренду (якщо rawBrand задано).
        let brandId: string | undefined;
        if (row.createData.rawBrand && row.createData.rawBrand.trim()) {
          const existing = await this.brandsService.resolveByNameOrSynonym(
            orgId,
            row.createData.rawBrand,
          );
          brandId = existing
            ? existing.id
            : (await this.brandsService.create(orgId, { name: row.createData.rawBrand.trim() })).id;
        }
        const created = await this.goodsService.create(orgId, {
          name: row.createData.name.trim(),
          sku: row.createData.sku?.trim() || undefined,
          brandId,
          purchasePrice: row.price,
        });
        goodId = created.id;
      } else {
        if (!row.goodId) {
          throw new BadRequestException(
            translateError('err.xlsx.rowGoodMissing', getLocale(), { row: row.rowIndex }),
          );
        }
        const good = await this.prisma.good.findFirst({
          where: { id: row.goodId, orgId, deletedAt: null },
          select: { id: true },
        });
        if (!good)
          throw new NotFoundException(
            translateError('err.xlsx.rowGoodNotFound', getLocale(), { row: row.rowIndex }),
          );
        goodId = good.id;
      }
      // Дублікат goodId у межах імпорту → пропускаємо (лишається перше входження).
      // Робимо ПІСЛЯ резолву: два різні артикули можуть вказувати на один товар.
      if (seenGoodIds.has(goodId)) continue;
      seenGoodIds.add(goodId);
      lines.push({ goodId, quantity: row.quantity, price: row.price });
    }

    await this.prisma.$transaction(
      async tx => {
        if (mode === 'append') await adapter.appendLines(tx, orgId, docId, lines, createdBy);
        else await adapter.replaceLines(tx, orgId, docId, lines, createdBy);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private toCandidate(g: {
    id: string;
    sku: string | null;
    name: string;
    brand?: { name: string } | null;
  }): PreviewCandidate {
    return { id: g.id, sku: g.sku, name: g.name, brandName: g.brand?.name ?? null };
  }

  /**
   * Сирий передперегляд файлу (mapping-незалежний): повертає перші `limit` рядків аркуша як
   * текстову сітку 1-based-колонок + загальну кількість рядків аркуша й максимальну ширину.
   * Використовується UI-майстром, щоб показати вміст файлу ДО налаштування колонок — користувач
   * бачить структуру й вписує номери колонок. Нічого не резолвить і не пише в БД.
   */
  async rawPreview(
    buffer: Buffer | Uint8Array,
    filename: string,
    limit = 20,
  ): Promise<{
    totalRows: number;
    columnCount: number;
    rows: string[][];
    kind: GridSourceKind;
    /** Текст отримано розпізнаванням (а не з текстового шару/комірок) → UI попереджає про звірку. */
    ocr?: boolean;
  }> {
    // Диспатч за розширенням (.xlsx/.csv/.pdf) — усередині дружні 400 замість сирих 500
    // (клас Bug #751: передперегляд запускається одразу після вибору БУДЬ-ЯКОГО файлу).
    // Кеш за хешем вмісту: OCR-канали не розпізнаються вдруге у наступному previewImport.
    const grid = await this.parseGridCached(buffer, filename);

    const cap = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    // Bug #750: обмеження накладаємо на кількість ЗІБРАНИХ рядків, а не на абсолютний номер —
    // файл із порожніми провідними рядками (дані з рядка 30) інакше дав би порожній
    // передперегляд. parseGrid уже віддає щільну сітку, тож достатньо зрізу.
    const rows = grid.rows.slice(0, cap);
    const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);

    return { totalRows: grid.totalRows, columnCount, rows, kind: grid.kind, ocr: grid.ocr };
  }

  /**
   * Надійне текстове представлення значення комірки ExcelJS. `row.values` може містити не лише
   * примітиви, а й обʼєкти: rich-text ({ richText: [...] }), формули ({ result }), гіперлінки
   * ({ text/hyperlink }), помилки ({ error }), дати (Date). Прямий String(obj) → «[object Object]».
   */
  private cellText(v: unknown): string {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return v.toLocaleDateString('uk-UA');
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.richText)) {
        return o.richText
          .map(rt => String((rt as { text?: unknown }).text ?? ''))
          .join('')
          .trim();
      }
      if ('text' in o && o.text != null) return String(o.text).trim();
      if ('error' in o && o.error != null) return String(o.error);
      // Формула: result може бути примітивом АБО обʼєктом ({ error: '#REF!' }, rich-text) →
      // рекурсуємо через cellText, інакше String({error}) знову дав би «[object Object]».
      if ('result' in o && o.result != null) return this.cellText(o.result);
      if ('hyperlink' in o && o.hyperlink != null) return String(o.hyperlink).trim();
    }
    return String(v).trim();
  }

  /**
   * Парсить рядки файлу за мапінгом колонок (1-based). startRow — рядок першого товару.
   * Кількість/ціна коерсяться через parseNumber (0 якщо порожньо). Порожні рядки (без коду,
   * артикулу і назви) пропускаються.
   */
  private async parseMappedRows(
    buffer: Buffer | Uint8Array,
    filename: string,
    mapping: ImportMapping,
  ): Promise<MappedRow[]> {
    // Кеш за хешем вмісту: той самий файл уже пройшов OCR у rawPreview → читаємо готову сітку.
    const grid = await this.parseGridCached(buffer, filename);

    const startRow = mapping.startRow && mapping.startRow >= 1 ? mapping.startRow : 2;
    // Мапінг 1-based (як у передперегляді з літерами A/B/C), сітка 0-based → зсув col-1.
    const cell = (cells: string[], col?: number): string | null =>
      col && col >= 1 ? (cells[col - 1] ?? '').trim() || null : null;

    const rows: MappedRow[] = [];
    grid.rows.forEach((cells, i) => {
      const rowNo = i + 1; // 1-based номер рядка, як його бачить користувач у передперегляді
      if (rowNo < startRow) return;
      const rawCode = cell(cells, mapping.codeCol);
      const rawArticle = cell(cells, mapping.articleCol);
      const rawBrand = cell(cells, mapping.brandCol);
      const rawName = cell(cells, mapping.nameCol);
      if (!rawCode && !rawArticle && !rawName) return; // порожній рядок / підсумки
      rows.push({
        rowIndex: rowNo,
        rawCode,
        rawArticle,
        rawBrand,
        rawName,
        quantity:
          this.parseNumber(mapping.quantityCol ? cells[mapping.quantityCol - 1] : undefined) ?? 0,
        price: this.parseNumber(mapping.priceCol ? cells[mapping.priceCol - 1] : undefined) ?? 0,
      });
    });

    if (rows.length === 0)
      throw new BadRequestException(translateError('err.xlsx.fileNoGoodRows', getLocale()));
    return rows;
  }

  private parseNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    // UA-локаль: у Excel-комірках кількість/ціна часто з КОМОЮ як десятковим роздільником ("1,5").
    // Number('1,5')=NaN → раніше ціну відкидало ("Ціна обов'язкова") / кількість → undefined.
    // ExcelJS числову комірку віддає як number (тут не-рядок → пряма коерція), текстову — як string.
    // Для рядка: прибираємо пробіли-роздільники тисяч, кому → крапку. Крапку-як-роздільник теж лишаємо.
    let normalized: unknown = value;
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/\s+/g, '');
      // Лише кома як десятковий ("1,5"→"1.5"). Якщо є І крапка, І кома (mixed-separator, напр. EU
      // "1.234,56" чи US "1,234.56") — НЕ вгадуємо формат: лишаємо as-is → Number()=NaN → undefined
      // (безпечніше відкинути неоднозначний рядок, ніж хибно розпарсити). Excel рядком такого рідко дає.
      normalized =
        trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed;
    }
    const num = Number(normalized);
    return Number.isFinite(num) ? num : undefined;
  }
}

/** Мапінг колонок Excel (1-based) для generic-імпорту товарів. */
export interface ImportMapping {
  startRow: number;
  codeCol?: number;
  articleCol?: number;
  brandCol?: number;
  nameCol?: number;
  quantityCol?: number;
  priceCol?: number;
}

interface MappedRow {
  rowIndex: number;
  rawCode: string | null;
  rawArticle: string | null;
  rawBrand: string | null;
  rawName: string | null;
  quantity: number;
  price: number;
}
