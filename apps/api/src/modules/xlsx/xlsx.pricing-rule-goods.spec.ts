/**
 * Перелік товарів із файла для списку правила ціноутворення (BR-GOOD-009): шаблон і розбір.
 * Сам пошук товару — `good-matcher.spec.ts`, читання файла — `good-ref-rows.parser.spec.ts`.
 *
 * Mutation-verify:
 *  · прибрати перевірку `rows.length > PRICING_RULE_MAX_GOODS` → кейс про довгий файл падає;
 *  · прибрати перевірку порожнього файла → відповідний кейс падає;
 *  · `ambiguous` класти в `notFound` → кейс про розкладання за станами падає.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PRICING_RULE_MAX_GOODS } from '@sto/shared';
import { XlsxService } from './xlsx.service';
import type { GoodMatchResult, GoodMatcherService } from '../goods/good-matcher.service';

const ORG = '11111111-1111-4111-8111-111111111111';

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Товари');
  rows.forEach(r => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const candidate = (id: string, name: string) => ({
  id,
  internalCode: null,
  sku: 'A1',
  name,
  brandId: null,
  brandName: null,
});

describe('XlsxService — перелік товарів для правила ціноутворення', () => {
  let matchMany: ReturnType<typeof vi.fn>;
  let service: XlsxService;

  beforeEach(() => {
    matchMany = vi.fn();
    const unused = {} as never;
    service = new XlsxService(
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      { matchMany } as unknown as GoodMatcherService,
      unused, // workOrderStock — імпорт товарів наряду (BR-WO-021) тут не задіяний
    );
  });

  // guards: BR-GOOD-009
  it('розкладає рядки на знайдені, неоднозначні й не знайдені; у базу нічого не пише', async () => {
    const results: GoodMatchResult[] = [
      {
        status: 'matched',
        good: candidate('g1', 'Фільтр'),
        matchedBy: 'articleBrand',
        candidates: [],
      },
      {
        status: 'ambiguous',
        good: null,
        matchedBy: 'article',
        candidates: [candidate('g2', 'Колодки A'), candidate('g3', 'Колодки B')],
      },
      { status: 'notFound', good: null, matchedBy: null, candidates: [] },
    ];
    matchMany.mockResolvedValueOnce(results);
    const buf = await xlsx([
      ['Артикул', 'Бренд'],
      ['OC 90', 'Knecht'],
      ['A1', ''],
      ['НЕМА', 'Bosch'],
    ]);

    const res = await service.resolvePricingRuleGoods(ORG, buf, 'xlsx');

    expect(matchMany).toHaveBeenCalledWith(ORG, [
      expect.objectContaining({ rowIndex: 2, article: 'OC 90', brand: 'Knecht' }),
      expect.objectContaining({ rowIndex: 3, article: 'A1', brand: null }),
      expect.objectContaining({ rowIndex: 4, article: 'НЕМА', brand: 'Bosch' }),
    ]);
    expect(res.total).toBe(3);
    expect(res.matched).toEqual([
      { rowIndex: 2, matchedBy: 'articleBrand', good: candidate('g1', 'Фільтр') },
    ]);
    expect(res.ambiguous).toEqual([
      {
        rowIndex: 3,
        raw: { code: null, article: 'A1', brand: null, barcode: null, name: null },
        candidates: [candidate('g2', 'Колодки A'), candidate('g3', 'Колодки B')],
      },
    ]);
    expect(res.notFound).toEqual([
      {
        rowIndex: 4,
        raw: { code: null, article: 'НЕМА', brand: 'Bosch', barcode: null, name: null },
      },
    ]);
  });

  // guards: BR-GOOD-009
  it('файл без рядків даних → 400, пошук не запускається', async () => {
    await expect(
      service.resolvePricingRuleGoods(ORG, await xlsx([['Артикул']]), 'xlsx'),
    ).rejects.toThrow(BadRequestException);
    expect(matchMany).not.toHaveBeenCalled();
  });

  // guards: BR-GOOD-009
  it('рядків більше, ніж вміщує список правила → 400 з обома числами', async () => {
    const lines = ['Артикул'];
    for (let i = 0; i <= PRICING_RULE_MAX_GOODS; i++) lines.push(`A${i}`);
    const csv = Buffer.from(lines.join('\n'), 'utf-8');
    await expect(service.resolvePricingRuleGoods(ORG, csv, 'csv')).rejects.toThrow(
      new RegExp(`${PRICING_RULE_MAX_GOODS + 1}.*${PRICING_RULE_MAX_GOODS}`),
    );
    expect(matchMany).not.toHaveBeenCalled();
  });

  // guards: BR-GOOD-009
  it('шаблон читається власним розбором: заголовки впізнано, приклади мають ключ товару', async () => {
    const template = await service.generatePricingRuleGoodsTemplate();
    matchMany.mockImplementationOnce((_org: string, rows: unknown[]) =>
      Promise.resolve(
        rows.map(() => ({ status: 'notFound', good: null, matchedBy: null, candidates: [] })),
      ),
    );
    const res = await service.resolvePricingRuleGoods(ORG, template, 'xlsx');
    expect(res.total).toBe(2);
    expect(res.notFound.map(r => r.raw)).toEqual([
      expect.objectContaining({ article: 'OC 90', brand: 'Knecht', barcode: null }),
      expect.objectContaining({ article: null, barcode: '4820123456789' }),
    ]);
  });
});
