import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WorkPickerModal } from '../WorkPickerModal';
import type { CategoryNode } from '../category-tree';

// ─── apiFetch mock ────────────────────────────────────────────────────────────

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Tree:
//   ТО (parent)
//     ├── ТО двигуна
//     └── ТО трансмісії (inactive)
//   Кузов (inactive root)
//     └── Фарбування (active child — but parent inactive → hidden)
const mockCategories: CategoryNode[] = [
  {
    id: 'cat-to',
    name: 'ТО',
    isActive: true,
    children: [
      { id: 'cat-engine', name: 'ТО двигуна', isActive: true, children: [] },
      { id: 'cat-trans', name: 'ТО трансмісії', isActive: false, children: [] },
    ],
  },
  {
    id: 'cat-body',
    name: 'Кузов',
    isActive: false,
    children: [{ id: 'cat-paint', name: 'Фарбування', isActive: true, children: [] }],
  },
];

const mockWorks = [
  {
    id: 'w1',
    primary: 'Заміна масла',
    name: 'Заміна масла',
    normoHours: 0.5,
    price: 200,
    categoryId: 'cat-engine',
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkPickerModal — regression guards (Bugs #387, #388, #389)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    // Clear localStorage so CategoryTree starts collapsed every test
    if (typeof localStorage !== 'undefined') localStorage.clear();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/work-categories') return Promise.resolve(mockCategories);
      if (path.startsWith('/works')) return Promise.resolve({ items: mockWorks });
      return Promise.resolve({ items: [] });
    });
  });

  it('рендерить дерево категорій після відкриття (тест 1: tree renders without crashing)', async () => {
    render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-categories'));
    // CategoryTree sidebar label
    await waitFor(() => {
      expect(screen.getByText('Категорії робіт')).toBeInTheDocument();
    });
    // Root active category visible
    expect(screen.getByText('ТО')).toBeInTheDocument();
    // "Всі" item visible
    expect(screen.getByText('Всі')).toBeInTheDocument();
  });

  it('вимкнені категорії (isActive=false) приховані (тест 3: hideInactive)', async () => {
    render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-categories'));
    await waitFor(() => expect(screen.getByText('ТО')).toBeInTheDocument());

    // Inactive root "Кузов" must NOT render (hideInactive cascades).
    expect(screen.queryByText('Кузов')).not.toBeInTheDocument();
    // Child of inactive root also hidden.
    expect(screen.queryByText('Фарбування')).not.toBeInTheDocument();
  });

  it('вибір батьківської категорії → categoryIds[] включає parent + всі активні нащадки (тест 2: collectDescendantIds)', async () => {
    const user = userEvent.setup();
    render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-categories'));
    await waitFor(() => expect(screen.getByText('ТО')).toBeInTheDocument());

    // Clear apiFetch history of /works calls so far so we assert on the next one.
    const callsBefore = apiFetchMock.mock.calls.length;

    // Click on the parent "ТО"
    await user.click(screen.getByText('ТО'));

    // After click, fetchWorks fires immediately (q='' → timeout 0).
    // Advance microtasks.
    await waitFor(() => {
      const newCalls = apiFetchMock.mock.calls.slice(callsBefore);
      const worksCall = newCalls.find(c => typeof c[0] === 'string' && c[0].startsWith('/works'));
      expect(worksCall).toBeDefined();
    });

    // The URL must include repeated categoryIds= params (no [] suffix — fast-querystring aggregates
    // repeated keys correctly, while categoryIds[]= would become a different key in Fastify).
    // (cat-trans is inactive but collectDescendantIds doesn't filter inactive — it walks raw tree.
    //  hideInactive prop only hides them in the tree UI.)
    const worksCall = apiFetchMock.mock.calls
      .slice(callsBefore)
      .find(c => typeof c[0] === 'string' && c[0].startsWith('/works'));
    const url = worksCall![0] as string;
    expect(url).toContain('categoryIds=cat-to');
    expect(url).toContain('categoryIds=cat-engine');
    // Must NOT use bracketed form (regression guard for 37bc3ef9 — fast-querystring would
    // treat "categoryIds[]" as the literal key name, not as array syntax).
    expect(url).not.toContain('categoryIds%5B%5D');
    // Must NOT use legacy "categoryId=" (singular)
    expect(url).not.toMatch(/[?&]categoryId=[^&]/);
  });

  it('закрити і знову відкрити → query і selectedCatId скинуто (тест 4: state reset on close)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-categories'));
    await waitFor(() => expect(screen.getByText('ТО')).toBeInTheDocument());

    // Type query
    const input = screen.getByPlaceholderText('Пошук роботи...');
    await user.type(input, 'фільтр');
    expect(input).toHaveValue('фільтр');

    // Select category
    await user.click(screen.getByText('ТО'));

    // Close
    rerender(<WorkPickerModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);

    // Re-open: state must be cleared.
    rerender(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => {
      const newInput = screen.getByPlaceholderText('Пошук роботи...');
      expect(newInput).toHaveValue('');
    });

    // After re-open, fetchWorks fires with NO category filter (selectedCatId reset to null).
    // The latest /works call must NOT have categoryIds= param.
    await waitFor(() => {
      const worksCalls = apiFetchMock.mock.calls.filter(
        c => typeof c[0] === 'string' && (c[0] as string).startsWith('/works'),
      );
      const latest = worksCalls[worksCalls.length - 1]![0] as string;
      expect(latest).not.toContain('categoryIds=');
    });
  });

  it('Bug #387: помилка /work-categories на першому відкритті → друге відкриття робить retry', async () => {
    let categoriesCallCount = 0;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/work-categories') {
        categoriesCallCount += 1;
        if (categoriesCallCount === 1) return Promise.reject(new Error('network'));
        return Promise.resolve(mockCategories);
      }
      if (path.startsWith('/works')) return Promise.resolve({ items: mockWorks });
      return Promise.resolve({ items: [] });
    });

    const { rerender } = render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    // First fetch fired and failed
    await waitFor(() => {
      expect(categoriesCallCount).toBe(1);
    });

    // After failure: tree shows empty state
    await waitFor(() => {
      expect(screen.getByText('Категорій не знайдено')).toBeInTheDocument();
    });

    // Close
    rerender(<WorkPickerModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    // Re-open
    rerender(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    // Second fetch should fire (retry after failure — Bug #387 fix)
    await waitFor(() => {
      expect(categoriesCallCount).toBe(2);
    });

    // Categories now load successfully
    await waitFor(() => {
      expect(screen.getByText('ТО')).toBeInTheDocument();
    });
  });

  it('Bug #388: backend повертає { items: [...] } envelope → tree рендериться (defensive parsing)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/work-categories')
        return Promise.resolve({ items: mockCategories, total: mockCategories.length });
      if (path.startsWith('/works')) return Promise.resolve({ items: mockWorks });
      return Promise.resolve({ items: [] });
    });

    render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-categories'));
    await waitFor(() => {
      expect(screen.getByText('ТО')).toBeInTheDocument();
    });
  });

  it('передає категорії як hideInactive=true до CategoryTree (по labels)', async () => {
    render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-categories'));
    await waitFor(() => {
      // Header label
      expect(screen.getByText('Категорії робіт')).toBeInTheDocument();
    });
  });

  it('початковий fetch /works НЕ містить categoryIds[] (selectedCatId=null)', async () => {
    render(<WorkPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => {
      const worksCalls = apiFetchMock.mock.calls.filter(
        c => typeof c[0] === 'string' && (c[0] as string).startsWith('/works'),
      );
      expect(worksCalls.length).toBeGreaterThan(0);
    });

    const worksCalls = apiFetchMock.mock.calls.filter(
      c => typeof c[0] === 'string' && (c[0] as string).startsWith('/works'),
    );
    const first = worksCalls[0]![0] as string;
    expect(first).not.toContain('categoryIds');
    expect(first).toContain('limit=50');
  });
});
