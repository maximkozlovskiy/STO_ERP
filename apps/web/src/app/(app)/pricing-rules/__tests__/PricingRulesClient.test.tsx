// Сторінка правил ціноутворення: кнопки за роллю, назви кнопок рядка, підпис області.
//
// Що стережуть ці тести:
//  - комірник (STOREKEEPER) бачить правила й «Розцінити список», але не «+ Правило»,
//    «Перерахувати» / «Редагувати» / «Видалити» і не шаблон списку розцінки — сервер на все це
//    дає 403 (рішення власника №19, TECH-DEBT §8 L667);
//  - кнопки рядка мають доступну назву (aria-label), а не лише title (L678);
//  - правило, чий список складається лише з видалених товарів, не підписане як
//    «Весь асортимент» (L635, BR-GOOD-009).

import { screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import type { PricingRule } from '../types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiMultipartFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
// Форма правила — окремий chunk із власними тестами (RuleFormModal.test.tsx).
vi.mock('next/dynamic', () => ({ default: () => () => null }));
let role = 'OWNER';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role } }),
  useRequireAuth: () => undefined,
}));

import PricingRulesClient from '../PricingRulesClient';

const rule = (patch: Partial<PricingRule>): PricingRule => ({
  id: 'r-1',
  name: 'Правило',
  type: 'PERCENT',
  priority: 10,
  goodsCount: 0,
  hasGoodsList: false,
  goodsPreview: [],
  goodCategoryId: null,
  goodCategoryName: null,
  goodCategory: null,
  goodType: null,
  brandId: null,
  brandName: null,
  supplierId: null,
  supplierName: null,
  percentValue: 30,
  fixedAmount: null,
  fixedPrice: null,
  roundTo: null,
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  tiers: [],
  ...patch,
});

const RULES = [
  rule({ id: 'r-all', name: 'Загальне +30%' }),
  rule({ id: 'r-dead', name: 'Список видалених', hasGoodsList: true }),
  rule({ id: 'r-list', name: 'Список +20%', goodsCount: 2, hasGoodsList: true }),
];

beforeEach(() => {
  role = 'OWNER';
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/pricing-rules') return Promise.resolve({ items: RULES, total: RULES.length });
    if (path === '/brands') return Promise.resolve({ items: [], total: 0 });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

const rowOf = async (name: string) => {
  const cell = await screen.findByText(name);
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`рядок ${name} не знайдено`);
  return within(tr);
};

describe('PricingRulesClient — кнопки за роллю', () => {
  it('власник: «Правило», шаблон списку розцінки і кнопки рядка з доступними назвами', async () => {
    renderWithQueryClient(<PricingRulesClient />);
    const row = await rowOf('Загальне +30%');

    expect(
      row.getByRole('button', {
        name: 'Перерахувати ціни всіх відповідних товарів зараз: Загальне +30%',
      }),
    ).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Редагувати: Загальне +30%' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Видалити: Загальне +30%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Правило' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Розцінити список' }));
    expect(screen.getByRole('button', { name: 'Завантажити шаблон CSV' })).toBeInTheDocument();
  });

  it('комірник: бачить правила й «Розцінити список», але жодної кнопки, що дала б 403', async () => {
    role = 'STOREKEEPER';
    renderWithQueryClient(<PricingRulesClient />);
    const row = await rowOf('Загальне +30%');

    expect(row.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Правило' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Редагувати/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Видалити/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Перерахувати/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Розцінити список' }));
    expect(screen.getByRole('button', { name: 'Розцінити' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Завантажити шаблон CSV' }),
    ).not.toBeInTheDocument();
  });
});

describe('PricingRulesClient — колонка «Область»', () => {
  // guards: BR-GOOD-009
  it('список лише з видалених товарів підписано окремо, а не «Весь асортимент»', async () => {
    renderWithQueryClient(<PricingRulesClient />);

    expect(
      (await rowOf('Список видалених')).getByText('Перелік: лише видалені товари (не діє)'),
    ).toBeInTheDocument();
    // Колонка «Постачальник» теж пише «Весь асортимент» — тому шукаємо в клітинці області.
    expect((await rowOf('Загальне +30%')).getAllByText('Весь асортимент')).toHaveLength(2);
    expect((await rowOf('Список видалених')).getAllByText('Весь асортимент')).toHaveLength(1);
    expect((await rowOf('Список +20%')).getByText('Товари: 2')).toBeInTheDocument();
  });
});
