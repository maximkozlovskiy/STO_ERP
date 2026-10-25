import { describe, it, expect, vi } from 'vitest';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { XlsxController } from './xlsx.controller';

/**
 * Довідникові імпорти з XLSX (товари, бренди, одиниці) — лічильники результату правдиві.
 * Раніше рядок товару без ціни продажу рахувався «створеним», хоча в каталог не потрапляв, а
 * наявні товари / бренди / одиниці — «оновленими», хоча нічого не оновлювалось; одиниця виміру
 * впізнавалась «наявною» за словом «уже» в тексті відмови.
 */
const ORG = 'org-1';
const uk = (key: string) => translateError(key as never, 'uk');

// BR-SEC-UPLOAD: контролер звіряє розширення й магічні байти .xlsx (zip `PK\x03\x04`) до розбору,
// тож харнес має віддавати валідний xlsx-файл (парсер усе одно замоканий).
const XLSX_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const req = () =>
  ({
    file: async () => ({ filename: 'catalog.xlsx', toBuffer: async () => XLSX_SIG }),
  }) as never;

function build(over: {
  goodRows?: Array<Record<string, unknown>>;
  exists?: boolean[];
  goodCreate?: ReturnType<typeof vi.fn>;
  brandRows?: Array<{ name: string }>;
  brandCreate?: ReturnType<typeof vi.fn>;
  unitRows?: Array<{ name: string; shortName: string }>;
  unitCreate?: ReturnType<typeof vi.fn>;
}) {
  const xlsx = {
    parseGoods: vi.fn(async () => over.goodRows ?? []),
    findExistingGoodRows: vi.fn(async () => over.exists ?? []),
    parseBrands: vi.fn(async () => over.brandRows ?? []),
    parseUnits: vi.fn(async () => over.unitRows ?? []),
  };
  const goods = { create: over.goodCreate ?? vi.fn(async () => ({})) };
  const brands = { create: over.brandCreate ?? vi.fn(async () => ({})) };
  const units = { create: over.unitCreate ?? vi.fn(async () => ({})) };
  const controller = new XlsxController(
    xlsx as never,
    goods as never,
    brands as never,
    units as never,
    {} as never,
  );
  return { controller, goods, brands, units };
}

describe('POST /xlsx/import/goods — лічильники', () => {
  it('наявний — пропущено; новий з ціною — створено; без ціни — помилка рядка, не «створено»', async () => {
    const { controller, goods } = build({
      goodRows: [
        { sku: 'A-1', name: 'Наявний', salePrice: 100 },
        { sku: 'B-2', name: 'Новий', salePrice: 120, purchasePrice: 80 },
        { sku: 'C-3', name: 'Без ціни' },
      ],
      exists: [true, false, false],
    });
    const result = await controller.importGoods(ORG, req());
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 1,
      errors: [`Без ціни: ${uk('err.xlsx.goodNoSalePrice')}`],
    });
    expect(goods.create).toHaveBeenCalledTimes(1);
    expect(goods.create).toHaveBeenCalledWith(ORG, expect.objectContaining({ sku: 'B-2' }));
  });

  it('повтор артикула в межах файла — пропущено, без другого створення', async () => {
    const { controller, goods } = build({
      goodRows: [
        { sku: 'D-4', name: 'Перший', salePrice: 10 },
        { sku: 'd 4', name: 'Повтор', salePrice: 10 },
      ],
      exists: [false, false],
    });
    const result = await controller.importGoods(ORG, req());
    expect(result).toMatchObject({ created: 1, skipped: 1, errors: [] });
    expect(goods.create).toHaveBeenCalledTimes(1);
  });

  it('відмова створення — у помилках рядка з текстом відмови', async () => {
    const { controller } = build({
      goodRows: [{ sku: 'E-5', name: 'Збій', salePrice: 10 }],
      exists: [false],
      goodCreate: vi.fn(async () => {
        throw new BadRequestException('Некоректні дані');
      }),
    });
    const result = await controller.importGoods(ORG, req());
    expect(result).toMatchObject({ created: 0, skipped: 0, errors: ['Збій: Некоректні дані'] });
  });
});

describe('POST /xlsx/import/brands — наявний бренд', () => {
  it('«назва вже є» — пропущено, а не «оновлено»', async () => {
    const { controller } = build({
      brandRows: [{ name: 'Bosch' }, { name: 'Mann' }],
      brandCreate: vi
        .fn()
        .mockRejectedValueOnce(new ConflictException(uk('err.brand.nameExists')))
        .mockResolvedValueOnce({}),
    });
    const result = await controller.importBrands(ORG, req());
    expect(result).toEqual({ created: 1, updated: 0, skipped: 1, errors: [] });
  });
});

describe('POST /xlsx/import/units — наявна одиниця', () => {
  it('скорочення вже є (активна чи будь-яка) — пропущено', async () => {
    const { controller } = build({
      unitRows: [
        { name: 'Штука', shortName: 'шт' },
        { name: 'Літр', shortName: 'л' },
        { name: 'Кілограм', shortName: 'кг' },
      ],
      unitCreate: vi
        .fn()
        .mockRejectedValueOnce(new ConflictException(uk('err.unit.shortNameExists')))
        .mockRejectedValueOnce(new ConflictException(uk('err.unit.activeShortNameExists')))
        .mockResolvedValueOnce({}),
    });
    const result = await controller.importUnits(ORG, req());
    expect(result).toEqual({ created: 1, updated: 0, skipped: 2, errors: [] });
  });

  it('одиниця в архіві — помилка з поясненням, а не «пропущено»; слово «уже» в тексті не вирішує', async () => {
    const { controller } = build({
      unitRows: [
        { name: 'Пара', shortName: 'пар' },
        { name: 'Метр', shortName: 'м' },
      ],
      unitCreate: vi
        .fn()
        .mockRejectedValueOnce(new ConflictException(uk('err.unit.shortNameInArchive')))
        .mockRejectedValueOnce(new BadRequestException('Поле уже заповнене іншим значенням')),
    });
    const result = await controller.importUnits(ORG, req());
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([
      `Пара: ${uk('err.unit.shortNameInArchive')}`,
      'Метр: Поле уже заповнене іншим значенням',
    ]);
  });
});
