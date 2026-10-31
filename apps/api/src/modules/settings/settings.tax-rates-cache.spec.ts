/**
 * Ставки ПДВ — серверний кеш `GET /settings/tax-rates` (TECH-DEBT §8 L604).
 *
 * Аспект: список ставок читають картки документів при кожному відкритті, тож він лежить у Redis
 * (`settings:tax-rates:<orgId>`, TTL 300 с) за патерном `getWorkHours`. Інваріанти:
 *   - друге читання не йде в БД;
 *   - створення, зміна (і звичайна, і «за замовчуванням» у транзакції) та видалення ставки
 *     скидають кеш — наступне читання бачить свіжі дані;
 *   - кеш окремий для кожної організації;
 *   - Redis недоступний — ставки читаються з БД без помилки (офлайн-незалежність).
 *
 * Redis — словник у пам'яті з тими самими get / set / del, Prisma — рядки в масиві.
 */
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { BankStatementPullScheduler } from '../bank-statements/bank-statement-pull.scheduler';
import { AuditService } from '../audit/audit.service';
import { HOST_LOOKUP } from '../../common/utils/host-lookup.token';
import { publicHostLookup } from '../../common/testing/host-lookup';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

type Row = {
  id: string;
  orgId: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isActive: boolean;
};

let rows: Row[];
const store = new Map<string, string>();

const matches = (r: Row, where: { id?: string; orgId?: string; isDefault?: boolean }) =>
  (where.id === undefined || r.id === where.id) &&
  (where.orgId === undefined || r.orgId === where.orgId) &&
  (where.isDefault === undefined || r.isDefault === where.isDefault);

const taxRate = {
  findMany: vi.fn(({ where }: { where: { orgId: string } }) =>
    Promise.resolve(rows.filter(r => r.orgId === where.orgId).map(r => ({ ...r }))),
  ),
  findFirst: vi.fn(({ where }: { where: { id: string; orgId: string } }) =>
    Promise.resolve(rows.find(r => matches(r, where)) ?? null),
  ),
  findFirstOrThrow: vi.fn(({ where }: { where: { id: string; orgId: string } }) =>
    Promise.resolve(rows.find(r => matches(r, where))!),
  ),
  create: vi.fn(({ data }: { data: Omit<Row, 'id'> }) => {
    const row = { id: `tax-${rows.length + 1}`, ...data };
    rows.push(row);
    return Promise.resolve(row);
  }),
  updateMany: vi.fn(
    ({
      where,
      data,
    }: {
      where: { id?: string; orgId?: string; isDefault?: boolean; NOT?: { id: string } };
      data: Partial<Row>;
    }) => {
      const hit = rows.filter(r => matches(r, where) && r.id !== where.NOT?.id);
      // Prisma: `undefined` у data — «не чіпати поле».
      const defined = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      hit.forEach(r => Object.assign(r, defined));
      return Promise.resolve({ count: hit.length });
    },
  ),
};

const prisma = {
  taxRate,
  $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ taxRate })),
  // BR-INV-027: ставки не застосовано в документах — число змінювати можна.
  $queryRaw: vi.fn(() => Promise.resolve([])),
};

const redis = {
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
  set: vi.fn((key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve('OK');
  }),
  del: vi.fn((...keys: string[]) => {
    keys.forEach(k => store.delete(k));
    return Promise.resolve(keys.length);
  }),
};

describe('SettingsService — кеш ставок ПДВ', () => {
  let service: SettingsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    store.clear();
    rows = [
      { id: 'tax-vat20', orgId: ORG, name: 'ПДВ 20%', rate: 20, isDefault: true, isActive: true },
      { id: 'tax-vat7', orgId: ORG, name: 'ПДВ 7%', rate: 7, isDefault: false, isActive: true },
      { id: 'tax-o2', orgId: OTHER_ORG, name: 'ПДВ 0%', rate: 0, isDefault: true, isActive: true },
    ];
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: NbuFetchScheduler, useValue: {} },
        { provide: BankStatementPullScheduler, useValue: {} },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  const rateOf = async (id: string, orgId = ORG) =>
    (await service.getTaxRates(orgId)).find(r => r.id === id);

  it('друге читання — з кешу: у БД один запит, ключ settings:tax-rates:<orgId> на 300 с', async () => {
    const first = await service.getTaxRates(ORG);
    const second = await service.getTaxRates(ORG);

    expect(second).toEqual(first);
    expect(first.map(r => r.name)).toEqual(['ПДВ 20%', 'ПДВ 7%']);
    expect(taxRate.findMany).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      `settings:tax-rates:${ORG}`,
      JSON.stringify(first),
      'EX',
      300,
    );
  });

  it('кеш окремий для кожної організації: чужі ставки не віддаються', async () => {
    await service.getTaxRates(ORG);

    const other = await service.getTaxRates(OTHER_ORG);

    expect(other.map(r => r.id)).toEqual(['tax-o2']);
    expect(taxRate.findMany).toHaveBeenCalledTimes(2);
  });

  it('після створення ставки наступне читання бачить її', async () => {
    await service.getTaxRates(ORG);

    const created = await service.createTaxRate(ORG, { name: 'ПДВ 14%', rate: 14 });

    expect(await rateOf(created.id)).toMatchObject({ name: 'ПДВ 14%', rate: 14 });
  });

  it('після створення ставки «за замовчуванням» (транзакція) — нова за замовчуванням, стара ні', async () => {
    await service.getTaxRates(ORG);

    const created = await service.createTaxRate(ORG, {
      name: 'ПДВ 14%',
      rate: 14,
      isDefault: true,
    });

    expect((await rateOf(created.id))?.isDefault).toBe(true);
    expect((await rateOf('tax-vat20'))?.isDefault).toBe(false);
  });

  it('після зміни ставки наступне читання бачить нове значення', async () => {
    await service.getTaxRates(ORG);

    await service.updateTaxRate(ORG, 'tax-vat7', { rate: 8, name: 'ПДВ 8%' });

    expect(await rateOf('tax-vat7')).toMatchObject({ rate: 8, name: 'ПДВ 8%' });
  });

  it('після зміни «за замовчуванням» (транзакція) наступне читання бачить новий прапорець', async () => {
    await service.getTaxRates(ORG);

    await service.updateTaxRate(ORG, 'tax-vat7', { isDefault: true });

    expect((await rateOf('tax-vat7'))?.isDefault).toBe(true);
    expect((await rateOf('tax-vat20'))?.isDefault).toBe(false);
  });

  it('після видалення (деактивації) ставки наступне читання бачить isActive=false', async () => {
    await service.getTaxRates(ORG);

    await service.deleteTaxRate(ORG, 'tax-vat7');

    expect((await rateOf('tax-vat7'))?.isActive).toBe(false);
  });

  it('скидання кешу ставок не чіпає кеш іншої організації', async () => {
    await service.getTaxRates(OTHER_ORG);

    await service.updateTaxRate(ORG, 'tax-vat7', { rate: 8 });

    expect(redis.del).toHaveBeenCalledWith(`settings:tax-rates:${ORG}`);
    expect(store.has(`settings:tax-rates:${OTHER_ORG}`)).toBe(true);
  });

  it('Redis недоступний → ставки з БД, без помилки', async () => {
    redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const rates = await service.getTaxRates(ORG);

    expect(rates.map(r => r.id)).toEqual(['tax-vat20', 'tax-vat7']);
    expect(taxRate.findMany).toHaveBeenCalledTimes(1);
  });

  it('Redis недоступний під час запису ставки → ставка зберігається, без помилки', async () => {
    redis.del.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(service.updateTaxRate(ORG, 'tax-vat7', { rate: 8 })).resolves.toMatchObject({
      rate: 8,
    });
  });
});
