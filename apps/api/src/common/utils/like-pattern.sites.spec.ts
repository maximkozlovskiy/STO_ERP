/**
 * Пошук у списках — буквальний: `%` / `_` у тексті користувача не працюють як символи підстановки
 * (TECH-DEBT §8 L521(3)). Prisma на PostgreSQL будує для `contains` і для `equals` +
 * `mode: 'insensitive'` вираз `ILIKE` і значення не екранує — тож «50%» знаходив «500».
 *
 * Фейкова Prisma тут нічого не «повертає за заготовкою»: умову `where`, яку побудував справжній
 * сервіс, виконує емулятор `ILIKE` / `LIKE` з правилами PostgreSQL (екранування `\`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { containsInsensitive, equalsInsensitive, escapeLike } from './like-pattern';
import { PrismaService } from '../../prisma/prisma.service';
import { EmployeesService } from '../../modules/employees/employees.service';
import { CounterpartiesService } from '../../modules/counterparties/counterparties.service';
import { DocumentNumberService } from '../../modules/document-number/document-number.service';
import { AuditService } from '../../modules/audit/audit.service';
import { statusesProvider } from '../../modules/counterparties/counterparties.spec-fixture';
import type { CounterpartyQueryDto } from '../../modules/counterparties/counterparties.dto';

/** `text LIKE pattern` за правилами PostgreSQL: `%` — будь-що, `_` — один символ, `\x` — буквально x. */
function like(text: string, pattern: string, insensitive: boolean): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, insensitive ? 'i' : '').test(text);
}

type Cond = { contains?: string; equals?: string; mode?: 'insensitive' };
type Row = Record<string, string | null>;

/** Виконати умову поля так, як її виконає PostgreSQL. */
function fieldMatches(value: string | null | undefined, cond: Cond): boolean {
  if (value == null) return false;
  const insensitive = cond.mode === 'insensitive';
  if (cond.contains !== undefined) return like(value, `%${cond.contains}%`, insensitive);
  if (cond.equals !== undefined) {
    return insensitive ? like(value, cond.equals, true) : value === cond.equals;
  }
  return false;
}

/** `where.OR` пошуку над плоскими полями рядка; вкладені зв'язки рядок у тесті не має → не збіг. */
function matchesSearch(row: Row, or: Array<Record<string, unknown>>): boolean {
  return or.some(branch =>
    Object.entries(branch).some(
      ([field, cond]) =>
        typeof cond === 'object' &&
        cond !== null &&
        ('contains' in cond || 'equals' in cond) &&
        fieldMatches(row[field], cond as Cond),
    ),
  );
}

describe('емулятор ILIKE — контроль: без екранування «50%» справді знаходить «500»', () => {
  it('сирий шаблон — діра, яку закриває екранування', () => {
    expect(like('500', '%50%%', true)).toBe(true);
    expect(like('ABX12', '%AB_12%', true)).toBe(true);
  });
});

describe('containsInsensitive / equalsInsensitive — буквальний збіг', () => {
  // guards: BR-CP-017
  it('«50%» не знаходить «500», але знаходить «знижка 50%»', () => {
    const cond = containsInsensitive('50%');
    expect(fieldMatches('500', cond)).toBe(false);
    expect(fieldMatches('знижка 50%', cond)).toBe(true);
  });

  // guards: BR-CP-017
  it('«ab_12» не знаходить «ABX12», регістр не важить', () => {
    const cond = containsInsensitive('ab_12');
    expect(fieldMatches('ABX12', cond)).toBe(false);
    expect(fieldMatches('xAB_12y', cond)).toBe(true);
  });

  // guards: BR-CP-017
  it('equalsInsensitive: «A_C» дорівнює «a_c», але не «AXC»; «%» — лише «%»', () => {
    expect(fieldMatches('a_c', equalsInsensitive('A_C'))).toBe(true);
    expect(fieldMatches('AXC', equalsInsensitive('A_C'))).toBe(false);
    expect(fieldMatches('Bosch', equalsInsensitive('%'))).toBe(false);
  });
});

describe('CounterpartiesService.findAll — ?q= з % / _ шукає буквально', () => {
  async function whereFor(q: string) {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      counterparty: { findMany, count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: AuditService, useValue: { record: vi.fn() } },
        statusesProvider(),
      ],
    }).compile();
    await module
      .get(CounterpartiesService)
      .findAll('org-1', { page: 1, limit: 20, q } as CounterpartyQueryDto);
    return findMany.mock.calls[0]![0].where as { OR: Array<Record<string, unknown>> };
  }

  const rows: Row[] = [
    { companyName: 'ТОВ Знижка 50%', phone: '0501112233', edrpou: '12345678' },
    { companyName: 'ТОВ 500 коліс', phone: '0505000000', edrpou: '50012345' },
    { firstName: 'Іван', lastName: 'Петренко', phone: '050_7778899', edrpou: null },
    { firstName: 'Петро', lastName: 'Іваненко', phone: '0501778899', edrpou: null },
  ];

  // guards: BR-CP-017
  it('«50%» → лише «Знижка 50%», не «500 коліс» (назва) і не телефон із «50»', async () => {
    const where = await whereFor('50%');
    expect(rows.filter(r => matchesSearch(r, where.OR))).toEqual([rows[0]]);
  });

  // guards: BR-CP-017
  it('телефон «050_» — буквальне підкреслення, не «будь-яка цифра»', async () => {
    const where = await whereFor('050_');
    expect(rows.filter(r => matchesSearch(r, where.OR))).toEqual([rows[2]]);
  });
});

describe('EmployeesService.findAll — ?q= з _ шукає буквально', () => {
  // guards: BR-EMP-003
  it('«a_b» знаходить «a_b@sto.ua», не «axb@sto.ua»', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { employee: { findMany, count: vi.fn().mockResolvedValue(0) } };
    const module = await Test.createTestingModule({
      providers: [EmployeesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    await module.get(EmployeesService).findAll('org-1', { q: 'a_b' });
    const where = findMany.mock.calls[0]![0].where as { OR: Array<Record<string, unknown>> };
    const rows: Row[] = [
      { firstName: 'Олег', lastName: 'Коваль', email: 'a_b@sto.ua', phone: null },
      { firstName: 'Ольга', lastName: 'Кравець', email: 'axb@sto.ua', phone: null },
    ];
    expect(rows.filter(r => matchesSearch(r, where.OR))).toEqual([rows[0]]);
  });
});

/**
 * Решту сервісів (товари, наряди, замовлення й оплати постачальникам, повернення, послуги, рухи
 * складу, роботи, бренди) стереже сканер: сирий `{ contains: x, mode: 'insensitive' }` чи
 * `{ equals: x, mode: 'insensitive' }` — та сама діра; значення має пройти `escapeLike`
 * (через `searchContains` / `containsInsensitive` / `equalsInsensitive`).
 */
describe('сервіси api — без сирих ILIKE-умов', () => {
  const SRC = join(__dirname, '..', '..');

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.ts$/.test(name) && !/\.(spec|spec-fixture|integration\.spec)\.ts$/.test(name)
        ? [p]
        : [];
    });
  }

  /** Поле-умова з `mode: 'insensitive'`, де значення — не виклик `escapeLike(...)`. */
  const RAW = /\{\s*(contains|equals):\s*(?!\s|escapeLike\()[^,{}]+,\s*mode:\s*'insensitive'/g;
  /** Чутливий до регістру `contains` на тексті запиту користувача (`q`, `query.q`, `search`). */
  const RAW_CS = /\{\s*contains:\s*(query\.q|q|search)\s*\}/g;

  /**
   * Свідомі винятки: сам модуль утиліти (згадка в документації) і конструктор звітів — значення
   * умови `contains` там уже екрановане в `report-condition.ts` (`escapeLike`, BR-RPT-003).
   */
  const ALLOWED = new Set([
    'common/utils/like-pattern.ts',
    'modules/report-builder/report-query.builder.ts',
  ]);

  // guards: BR-CP-017, BR-EMP-003
  it('жодної умови contains / equals + insensitive без escapeLike', () => {
    const files = sources(SRC).filter(f => !ALLOWED.has(relative(SRC, f).replace(/\\/g, '/')));
    const offenders = files.flatMap(f => {
      const text = readFileSync(f, 'utf8');
      return [...text.matchAll(RAW), ...text.matchAll(RAW_CS)].map(
        m => `${relative(SRC, f).replace(/\\/g, '/')}: ${m[0]}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it('контроль сканера: сирий шаблон він бачить, екранований — ні', () => {
    expect("{ name: { contains: q, mode: 'insensitive' } }".match(RAW)).not.toBeNull();
    expect("{ contains: escapeLike(q), mode: 'insensitive' }".match(RAW)).toBeNull();
    expect('{ phone: { contains: query.q } }'.match(RAW_CS)).not.toBeNull();
    expect(escapeLike('50%')).toBe('50\\%');
  });
});
