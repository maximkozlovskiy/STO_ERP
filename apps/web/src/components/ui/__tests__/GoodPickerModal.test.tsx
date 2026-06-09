import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { GoodPickerModal } from '../GoodPickerModal';
import type { CategoryNode } from '../category-tree';

// ─── apiFetch mock ────────────────────────────────────────────────────────────

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockCategories: CategoryNode[] = [
  {
    id: 'cat-oil',
    name: 'Мастила',
    isActive: true,
    children: [
      { id: 'cat-motor-oil', name: 'Моторні мастила', isActive: true, children: [] },
      { id: 'cat-trans-oil', name: 'Трансмісійні мастила', isActive: false, children: [] },
    ],
  },
  {
    id: 'cat-tire',
    name: 'Шини',
    isActive: false,
    children: [{ id: 'cat-summer', name: 'Літні', isActive: true, children: [] }],
  },
];

const mockGoods = [
  {
    id: 'g1',
    primary: 'Mobil 5W-30',
    name: 'Mobil 5W-30',
    sku: 'MOB-5W30',
    salePrice: 450,
    category: 'Моторні мастила',
    unit: 'л',
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GoodPickerModal — regression guards (Bugs #387, #388, #389)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/good-categories') return Promise.resolve(mockCategories);
      if (path.startsWith('/goods')) return Promise.resolve({ items: mockGoods });
      return Promise.resolve({ items: [] });
    });
  });

  it('рендерить дерево категорій (тест 1)', async () => {
    render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/good-categories'));
    await waitFor(() => {
      expect(screen.getByText('Категорії товарів')).toBeInTheDocument();
    });
    expect(screen.getByText('Мастила')).toBeInTheDocument();
    expect(screen.getByText('Всі')).toBeInTheDocument();
  });

  it('вимкнені категорії приховані (тест 3: hideInactive cascades)', async () => {
    render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/good-categories'));
    await waitFor(() => expect(screen.getByText('Мастила')).toBeInTheDocument());

    // Inactive root "Шини" hidden, child "Літні" also hidden via cascade.
    expect(screen.queryByText('Шини')).not.toBeInTheDocument();
    expect(screen.queryByText('Літні')).not.toBeInTheDocument();
  });

  it('вибір категорії → goodCategoryIds[] включає parent + descendants (тест 2)', async () => {
    const user = userEvent.setup();
    render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/good-categories'));
    await waitFor(() => expect(screen.getByText('Мастила')).toBeInTheDocument());

    const callsBefore = apiFetchMock.mock.calls.length;
    await user.click(screen.getByText('Мастила'));

    await waitFor(() => {
      const newCalls = apiFetchMock.mock.calls.slice(callsBefore);
      const goodsCall = newCalls.find(c => typeof c[0] === 'string' && c[0].startsWith('/goods'));
      expect(goodsCall).toBeDefined();
    });

    const goodsCall = apiFetchMock.mock.calls
      .slice(callsBefore)
      .find(c => typeof c[0] === 'string' && c[0].startsWith('/goods'));
    const url = goodsCall![0] as string;
    // Use repeated keys (goodCategoryIds=a&goodCategoryIds=b) — fast-querystring aggregates
    // them into an array. The bracketed form goodCategoryIds[]= would become a different key.
    expect(url).toContain('goodCategoryIds=cat-oil');
    expect(url).toContain('goodCategoryIds=cat-motor-oil');
    // Regression guard for 37bc3ef9 — must NOT use bracketed PHP-style syntax.
    expect(url).not.toContain('goodCategoryIds%5B%5D');
    // Must NOT use legacy categoryId=
    expect(url).not.toMatch(/[?&]categoryId=/);
  });

  it('закрити → перевідкрити → query та selectedCatId скинуто (тест 4)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/good-categories'));
    await waitFor(() => expect(screen.getByText('Мастила')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Пошук товару...');
    await user.type(input, 'олива');
    expect(input).toHaveValue('олива');

    await user.click(screen.getByText('Мастила'));

    rerender(<GoodPickerModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    rerender(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => {
      const newInput = screen.getByPlaceholderText('Пошук товару...');
      expect(newInput).toHaveValue('');
    });

    await waitFor(() => {
      const goodsCalls = apiFetchMock.mock.calls.filter(
        c => typeof c[0] === 'string' && (c[0] as string).startsWith('/goods'),
      );
      const latest = goodsCalls[goodsCalls.length - 1]![0] as string;
      expect(latest).not.toContain('goodCategoryIds');
    });
  });

  it('Bug #387: помилка /good-categories → retry при наступному відкритті', async () => {
    let count = 0;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/good-categories') {
        count += 1;
        if (count === 1) return Promise.reject(new Error('network'));
        return Promise.resolve(mockCategories);
      }
      if (path.startsWith('/goods')) return Promise.resolve({ items: mockGoods });
      return Promise.resolve({ items: [] });
    });

    const { rerender } = render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(count).toBe(1));
    await waitFor(() => {
      expect(screen.getByText('Категорій не знайдено')).toBeInTheDocument();
    });

    rerender(<GoodPickerModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    rerender(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(count).toBe(2));
    await waitFor(() => expect(screen.getByText('Мастила')).toBeInTheDocument());
  });

  it('Bug #388: backend повертає { items: [...] } envelope → tree рендериться', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/good-categories')
        return Promise.resolve({ items: mockCategories, total: mockCategories.length });
      if (path.startsWith('/goods')) return Promise.resolve({ items: mockGoods });
      return Promise.resolve({ items: [] });
    });

    render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/good-categories'));
    await waitFor(() => expect(screen.getByText('Мастила')).toBeInTheDocument());
  });

  it('перший fetch /goods не має goodCategoryIds[] (selectedCatId=null)', async () => {
    render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => {
      const goodsCalls = apiFetchMock.mock.calls.filter(
        c => typeof c[0] === 'string' && (c[0] as string).startsWith('/goods'),
      );
      expect(goodsCalls.length).toBeGreaterThan(0);
    });

    const goodsCalls = apiFetchMock.mock.calls.filter(
      c => typeof c[0] === 'string' && (c[0] as string).startsWith('/goods'),
    );
    const first = goodsCalls[0]![0] as string;
    expect(first).not.toContain('goodCategoryIds');
    expect(first).toContain('limit=50');
  });
});
