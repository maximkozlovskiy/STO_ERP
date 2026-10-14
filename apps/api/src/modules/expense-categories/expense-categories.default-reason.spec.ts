/**
 * «Привід за замовчуванням» у статті руху коштів (BR-CASH-022).
 *
 * Стаття може мати один `defaultReason`; у межах організації привід закріплений щонайбільше за
 * однією НЕВИДАЛЕНОЮ статтею: друга спроба — 409 із назвою статті, що його тримає. Напрям
 * приводу відповідає типу статті (внесення ↔ INCOME, видача ↔ EXPENSE). `null` знімає привід.
 * Видалення статті звільняє привід; відновлення статті, чий привід уже зайнятий, знімає привід
 * із відновленої.
 *
 * Довідник — таблиця в пам'яті, що справді застосовує `where` сервісу: написано з правила, до
 * появи коду, тож порядок і кількість запитів сервісу спеку невідомі.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CASH_REASON_RULES, CASH_REASON_VALUES } from '@sto/shared';
import { ExpenseCategoriesService } from './expense-categories.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const RENT = 'd0000001-0000-4000-8000-000000000001';
const BANK = 'd0000002-0000-4000-8000-000000000002';
const SALES = 'd0000003-0000-4000-8000-000000000003';
const GONE = 'd0000004-0000-4000-8000-000000000004';
const FOREIGN = 'd0000005-0000-4000-8000-000000000005';

const row = (id: string, name: string, over: MemRow = {}): MemRow => ({
  id,
  orgId: ORG,
  parentId: null,
  name,
  type: 'EXPENSE',
  sortOrder: 0,
  isActive: true,
  defaultReason: null,
  deletedAt: null,
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-01T08:00:00.000Z'),
  ...over,
});

function setup(rows: MemRow[]) {
  const expenseCategory = memoryTable(rows, () => ({
    parentId: null,
    type: 'EXPENSE',
    sortOrder: 0,
    isActive: true,
    defaultReason: null,
    deletedAt: null,
    createdAt: new Date('2026-10-14T09:00:00.000Z'),
    updatedAt: new Date('2026-10-14T09:00:00.000Z'),
  }));
  const prisma = {
    expenseCategory,
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (client: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ExpenseCategoriesService(
    prisma as unknown as PrismaService,
    cache as unknown as CacheService,
  );
  const byId = (id: string): MemRow => {
    const hit = rows.find(r => r.id === id);
    if (!hit) throw new Error(`у таблиці немає статті ${id}`);
    return hit;
  };
  const byName = (name: string): MemRow | undefined => rows.find(r => r.name === name);
  return { service, prisma, rows, cache, byId, byName };
}

const MANUAL = CASH_REASON_VALUES.filter(r => CASH_REASON_RULES[r].manual);
const IN_REASONS = MANUAL.filter(r => CASH_REASON_RULES[r].direction === 'IN');
const OUT_REASONS = MANUAL.filter(r => CASH_REASON_RULES[r].direction === 'OUT');

describe('ExpenseCategoriesService — закріплення приводу за статтею', () => {
  // guards: BR-CASH-022
  it('create: стаття витрат із приводом видачі → привід записано й віддано у відповіді', async () => {
    const { service, byName, cache } = setup([]);
    const res = await service.create(ORG, {
      name: 'Здача виручки',
      type: 'EXPENSE',
      defaultReason: 'BANK_DEPOSIT',
    });
    expect(byName('Здача виручки')).toMatchObject({ orgId: ORG, defaultReason: 'BANK_DEPOSIT' });
    expect(res).toMatchObject({ name: 'Здача виручки', defaultReason: 'BANK_DEPOSIT' });
    expect(cache.del).toHaveBeenCalled();
  });

  // guards: BR-CASH-022
  it('create без приводу → defaultReason порожній (стаття нічого не «захоплює»)', async () => {
    const { service, byName } = setup([]);
    await service.create(ORG, { name: 'Оренда' });
    expect(byName('Оренда')?.defaultReason ?? null).toBeNull();
  });

  // guards: BR-CASH-022
  it('update: закріпити привід за наявною статтею', async () => {
    const { service, byId } = setup([row(RENT, 'Оренда')]);
    const res = await service.update(ORG, RENT, { defaultReason: 'OWNER_OUT' });
    expect(byId(RENT).defaultReason).toBe('OWNER_OUT');
    expect(res).toMatchObject({ id: RENT, defaultReason: 'OWNER_OUT' });
  });

  // guards: BR-CASH-022
  it('update: null знімає привід', async () => {
    const { service, byId } = setup([row(RENT, 'Оренда', { defaultReason: 'OWNER_OUT' })]);
    await service.update(ORG, RENT, { defaultReason: null });
    expect(byId(RENT).defaultReason).toBeNull();
  });

  // guards: BR-CASH-022
  it('update без поля defaultReason привід не чіпає', async () => {
    const { service, byId } = setup([row(RENT, 'Оренда', { defaultReason: 'OWNER_OUT' })]);
    await service.update(ORG, RENT, { sortOrder: 5 });
    expect(byId(RENT)).toMatchObject({ defaultReason: 'OWNER_OUT', sortOrder: 5 });
  });

  // guards: BR-CASH-022
  it('update тим самим приводом, який стаття вже тримає, — не конфлікт із самою собою', async () => {
    const { service, byId } = setup([row(RENT, 'Оренда', { defaultReason: 'OWNER_OUT' })]);
    await service.update(ORG, RENT, { defaultReason: 'OWNER_OUT', name: 'Оренда боксу' });
    expect(byId(RENT)).toMatchObject({ defaultReason: 'OWNER_OUT', name: 'Оренда боксу' });
  });

  // guards: BR-CASH-022
  it('update: змінити привід статті на інший вільний', async () => {
    const { service, byId } = setup([row(RENT, 'Оренда', { defaultReason: 'OWNER_OUT' })]);
    await service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' });
    expect(byId(RENT).defaultReason).toBe('BANK_DEPOSIT');
  });
});

describe('ExpenseCategoriesService — привід зайнятий', () => {
  // guards: BR-CASH-022
  it('create з приводом, який тримає інша стаття → 409 із її назвою; статтю не створено', async () => {
    const { service, rows, byId } = setup([
      row(BANK, 'Здача в банк', { defaultReason: 'BANK_DEPOSIT' }),
    ]);
    const call = service.create(ORG, { name: 'Інкасація виручки', defaultReason: 'BANK_DEPOSIT' });
    await expect(call).rejects.toThrow(ConflictException);
    await expect(call).rejects.toThrow(/Здача в банк/);
    expect(rows.filter(r => r.deletedAt === null)).toHaveLength(1);
    expect(byId(BANK).defaultReason).toBe('BANK_DEPOSIT');
  });

  // guards: BR-CASH-022
  it('update з приводом, який тримає інша стаття → 409 із її назвою; обидві статті без змін', async () => {
    const { service, byId } = setup([
      row(BANK, 'Здача в банк', { defaultReason: 'BANK_DEPOSIT' }),
      row(RENT, 'Оренда', { defaultReason: 'OWNER_OUT' }),
    ]);
    const call = service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' });
    await expect(call).rejects.toThrow(ConflictException);
    await expect(call).rejects.toThrow(/Здача в банк/);
    expect(byId(BANK).defaultReason).toBe('BANK_DEPOSIT');
    expect(byId(RENT).defaultReason).toBe('OWNER_OUT');
  });

  // guards: BR-CASH-022, BR-CASH-003
  it('той самий привід у ЧУЖІЙ організації закріпленню не заважає', async () => {
    const { service, byId } = setup([
      row(FOREIGN, 'Чужа стаття', { orgId: OTHER_ORG, defaultReason: 'BANK_DEPOSIT' }),
      row(RENT, 'Оренда'),
    ]);
    await service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' });
    expect(byId(RENT).defaultReason).toBe('BANK_DEPOSIT');
    expect(byId(FOREIGN).defaultReason).toBe('BANK_DEPOSIT');
  });

  // guards: BR-CASH-022
  it('привід видаленої статті вільний: його можна закріпити за іншою', async () => {
    const { service, byId } = setup([
      row(GONE, 'Стара стаття', {
        defaultReason: 'BANK_DEPOSIT',
        deletedAt: new Date('2026-10-02T10:00:00.000Z'),
      }),
      row(RENT, 'Оренда'),
    ]);
    await service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' });
    expect(byId(RENT).defaultReason).toBe('BANK_DEPOSIT');
  });

  // guards: BR-CASH-022
  it('видалення статті (remove) звільняє привід: одразу після нього привід бере інша стаття', async () => {
    const { service, byId } = setup([
      row(BANK, 'Здача в банк', { defaultReason: 'BANK_DEPOSIT' }),
      row(RENT, 'Оренда'),
    ]);
    await expect(service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' })).rejects.toThrow(
      ConflictException,
    );

    await service.remove(ORG, BANK);
    expect(byId(BANK).deletedAt).toBeInstanceOf(Date);

    await service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' });
    expect(byId(RENT).defaultReason).toBe('BANK_DEPOSIT');
  });
});

describe('ExpenseCategoriesService — напрям приводу ↔ тип статті', () => {
  // guards: BR-CASH-022
  it.each(OUT_REASONS)('привід видачі %s підходить статті витрат (EXPENSE)', async reason => {
    const { service, byId } = setup([row(RENT, 'Оренда', { type: 'EXPENSE' })]);
    await service.update(ORG, RENT, { defaultReason: reason });
    expect(byId(RENT).defaultReason).toBe(reason);
  });

  // guards: BR-CASH-022
  it.each(IN_REASONS)(
    'привід внесення %s підходить статті оприбуткування (INCOME)',
    async reason => {
      const { service, byId } = setup([row(SALES, 'Продажі', { type: 'INCOME' })]);
      await service.update(ORG, SALES, { defaultReason: reason });
      expect(byId(SALES).defaultReason).toBe(reason);
    },
  );

  // guards: BR-CASH-022
  it.each(IN_REASONS)(
    'update: привід внесення %s для статті ВИТРАТ → 400 «не відповідає типу статті»',
    async reason => {
      const { service, byId } = setup([row(RENT, 'Оренда', { type: 'EXPENSE' })]);
      const call = service.update(ORG, RENT, { defaultReason: reason });
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/не відповідає типу статті/);
      expect(byId(RENT).defaultReason).toBeNull();
    },
  );

  // guards: BR-CASH-022
  it.each(OUT_REASONS)(
    'update: привід видачі %s для статті ОПРИБУТКУВАННЯ → 400 «не відповідає типу статті»',
    async reason => {
      const { service, byId } = setup([row(SALES, 'Продажі', { type: 'INCOME' })]);
      const call = service.update(ORG, SALES, { defaultReason: reason });
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/не відповідає типу статті/);
      expect(byId(SALES).defaultReason).toBeNull();
    },
  );

  // guards: BR-CASH-022
  it.each([
    ['EXPENSE', 'OWNER_IN'],
    ['INCOME', 'OWNER_OUT'],
  ] as const)(
    'create: стаття %s із приводом протилежного напряму %s → 400, статтю не створено',
    async (type, defaultReason) => {
      const { service, rows } = setup([]);
      const call = service.create(ORG, { name: 'Нова стаття', type, defaultReason });
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/не відповідає типу статті/);
      expect(rows).toEqual([]);
    },
  );

  // guards: BR-CASH-022
  it('create: стаття оприбуткування з приводом внесення → створено з приводом', async () => {
    const { service, byName } = setup([]);
    await service.create(ORG, {
      name: 'Отримання з банку',
      type: 'INCOME',
      defaultReason: 'BANK_WITHDRAWAL',
    });
    expect(byName('Отримання з банку')).toMatchObject({
      type: 'INCOME',
      defaultReason: 'BANK_WITHDRAWAL',
    });
  });

  // guards: BR-CASH-022
  it('по сім ручних приводів на напрям — цикли вище не порожні', () => {
    expect(IN_REASONS).toHaveLength(7);
    expect(OUT_REASONS).toHaveLength(7);
  });
});

// Перевірка «привід вільний» і запис — не одна атомарна дія: між ними привід може зайняти
// паралельний запит. Тоді відмовляє частковий unique-індекс (P2002), і це має бути та сама
// відповідь, що й без гонки, а не безіменна 500.
describe('ExpenseCategoriesService — привід зайняли між перевіркою і записом (P2002 індексу)', () => {
  const deletedAt = new Date('2026-10-02T10:00:00.000Z');
  const indexConflict = () =>
    Object.assign(Object.create(Prisma.PrismaClientKnownRequestError.prototype) as Error, {
      code: 'P2002',
      meta: { target: 'expense_categories_default_reason_uq' },
    });

  // guards: BR-CASH-022
  it('update: індекс відмовив → 409 з назвою статті-власника', async () => {
    const { service, prisma, rows } = setup([row(RENT, 'Оренда'), row(BANK, 'Здача в банк')]);
    prisma.expenseCategory.update.mockImplementationOnce(() => {
      // Паралельний запит устиг першим.
      rows.find(r => r.id === BANK)!.defaultReason = 'BANK_DEPOSIT';
      return Promise.reject(indexConflict());
    });
    const call = service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' });
    await expect(call).rejects.toThrow(ConflictException);
    await expect(call).rejects.toThrow(/Здача в банк/);
  });

  // guards: BR-CASH-022
  it('create: індекс відмовив → 409, а не 500', async () => {
    const { service, prisma } = setup([row(BANK, 'Здача в банк')]);
    prisma.expenseCategory.create.mockRejectedValueOnce(indexConflict());
    await expect(
      service.create(ORG, { name: 'Інкасація до банку', defaultReason: 'BANK_DEPOSIT' }),
    ).rejects.toThrow(ConflictException);
  });

  // guards: BR-CASH-022
  it('інша помилка запису не маскується під 409', async () => {
    const { service, prisma } = setup([row(RENT, 'Оренда')]);
    const boom = new Error('connection lost');
    prisma.expenseCategory.update.mockRejectedValueOnce(boom);
    await expect(service.update(ORG, RENT, { defaultReason: 'BANK_DEPOSIT' })).rejects.toBe(boom);
  });

  // guards: BR-CASH-022
  it('restore: індекс відмовив → стаття відновлюється БЕЗ приводу другою спробою', async () => {
    const { service, prisma, byId } = setup([
      row(GONE, 'Стара здача в банк', { defaultReason: 'BANK_DEPOSIT', deletedAt }),
    ]);
    prisma.expenseCategory.updateMany.mockRejectedValueOnce(indexConflict());
    await service.restore(ORG, GONE);
    expect(byId(GONE)).toMatchObject({ deletedAt: null, defaultReason: null });
  });

  // guards: BR-CASH-022
  it('створення з назвою видаленої статті відновлює її з приводом ІЗ ЗАПИТУ, старий не повертається', async () => {
    const { service, byId } = setup([
      row(GONE, 'Стара здача в банк', { defaultReason: 'BANK_DEPOSIT', deletedAt }),
      row(BANK, 'Здача в банк', { defaultReason: 'BANK_DEPOSIT' }),
    ]);
    await service.create(ORG, { name: 'Стара здача в банк' });
    expect(byId(GONE)).toMatchObject({ deletedAt: null, defaultReason: null });
    expect(byId(BANK).defaultReason).toBe('BANK_DEPOSIT');
  });
});

describe('ExpenseCategoriesService.restore — привід відновленої статті', () => {
  const deletedAt = new Date('2026-10-02T10:00:00.000Z');

  // guards: BR-CASH-022
  it('привід уже зайнятий живою статтею → відновлена стаття повертається БЕЗ приводу, власник лишається', async () => {
    const { service, byId } = setup([
      row(GONE, 'Стара здача в банк', { defaultReason: 'BANK_DEPOSIT', deletedAt }),
      row(BANK, 'Здача в банк', { defaultReason: 'BANK_DEPOSIT' }),
    ]);
    await service.restore(ORG, GONE);
    expect(byId(GONE).deletedAt).toBeNull();
    expect(byId(GONE).defaultReason).toBeNull();
    expect(byId(BANK).defaultReason).toBe('BANK_DEPOSIT');
  });

  // guards: BR-CASH-022
  it('привід вільний → відновлена стаття зберігає свій привід', async () => {
    const { service, byId } = setup([
      row(GONE, 'Стара здача в банк', { defaultReason: 'BANK_DEPOSIT', deletedAt }),
      row(RENT, 'Оренда', { defaultReason: 'OWNER_OUT' }),
    ]);
    await service.restore(ORG, GONE);
    expect(byId(GONE)).toMatchObject({ deletedAt: null, defaultReason: 'BANK_DEPOSIT' });
  });

  // guards: BR-CASH-022, BR-CASH-003
  it('привід зайнятий лише в ЧУЖІЙ організації → відновлена стаття привід зберігає', async () => {
    const { service, byId } = setup([
      row(GONE, 'Стара здача в банк', { defaultReason: 'BANK_DEPOSIT', deletedAt }),
      row(FOREIGN, 'Чужа стаття', { orgId: OTHER_ORG, defaultReason: 'BANK_DEPOSIT' }),
    ]);
    await service.restore(ORG, GONE);
    expect(byId(GONE)).toMatchObject({ deletedAt: null, defaultReason: 'BANK_DEPOSIT' });
  });

  // guards: BR-CASH-022
  it('після відновлення в організації привід тримає рівно одна жива стаття', async () => {
    const { service, rows } = setup([
      row(GONE, 'Стара здача в банк', { defaultReason: 'BANK_DEPOSIT', deletedAt }),
      row(BANK, 'Здача в банк', { defaultReason: 'BANK_DEPOSIT' }),
    ]);
    await service.restore(ORG, GONE);
    const holders = rows.filter(
      r => r.orgId === ORG && r.deletedAt === null && r.defaultReason === 'BANK_DEPOSIT',
    );
    expect(holders.map(r => r.id)).toEqual([BANK]);
  });
});
