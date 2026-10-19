import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import i18n from '@/i18n/config';
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

    const input = screen.getByPlaceholderText('Пошук товару / штрих-код...');
    await user.type(input, 'олива');
    expect(input).toHaveValue('олива');

    await user.click(screen.getByText('Мастила'));

    rerender(<GoodPickerModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    rerender(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />);

    await waitFor(() => {
      const newInput = screen.getByPlaceholderText('Пошук товару / штрих-код...');
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

// ─── Множинний вибір (список товарів правила ціноутворення) ───────────────────
//
// Режим вмикається ЛИШЕ пропом `multiple`. Модалку вживають наряди, закупівлі й складські
// документи — без пропа вона мусить поводитись як раніше: вибір → onSelect → закриття.

describe('GoodPickerModal — множинний вибір', () => {
  const twoGoods = [
    ...mockGoods,
    {
      id: 'g2',
      primary: 'Castrol 5W-40',
      name: 'Castrol 5W-40',
      sku: 'CAS-5W40',
      salePrice: 520,
      category: 'Моторні мастила',
      unit: 'л',
    },
  ];

  beforeEach(() => {
    apiFetchMock.mockReset();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/good-categories') return Promise.resolve(mockCategories);
      if (path.startsWith('/goods/stock-totals')) return Promise.resolve([]);
      if (path.startsWith('/goods')) return Promise.resolve({ items: twoGoods });
      return Promise.resolve({ items: [] });
    });
  });

  it('без `multiple`: вибір викликає onSelect і ЗАКРИВАЄ модалку; «Готово» й позначок немає', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GoodPickerModal open onClose={onClose} onSelect={onSelect} selectedId="g2" />);

    const row = await screen.findByRole('button', { name: /Mobil 5W-30/ });
    expect(row).not.toHaveAttribute('aria-pressed');
    expect(screen.queryByRole('button', { name: 'Готово' })).not.toBeInTheDocument();
    expect(screen.queryByText(/додано/)).not.toBeInTheDocument();

    await user.click(row);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g1', primary: 'Mobil 5W-30', secondary: 'MOB-5W30 · 450 ₴' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('без `multiple`: `selectedIds` ігнорується — рядок можна вибрати, як і раніше', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GoodPickerModal open onClose={onClose} onSelect={onSelect} selectedIds={['g1']} />);

    await user.click(await screen.findByRole('button', { name: /Mobil 5W-30/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('`multiple`: вибір НЕ закриває модалку, можна обрати кілька товарів поспіль', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <GoodPickerModal open onClose={onClose} onSelect={onSelect} multiple selectedIds={[]} />,
    );

    await user.click(await screen.findByRole('button', { name: /Mobil 5W-30/ }));
    await user.click(screen.getByRole('button', { name: /Castrol 5W-40/ }));

    expect(onSelect.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual(['g1', 'g2']);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Castrol 5W-40/ })).toBeInTheDocument();
  });

  it('`multiple`: уже додані позначено, повторний клік по них нічого не дублює', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <GoodPickerModal open onClose={vi.fn()} onSelect={onSelect} multiple selectedIds={['g1']} />,
    );

    const added = await screen.findByRole('button', { name: /Mobil 5W-30/ });
    expect(added).toHaveAttribute('aria-pressed', 'true');
    expect(added).toHaveTextContent('додано');
    const free = screen.getByRole('button', { name: /Castrol 5W-40/ });
    expect(free).toHaveAttribute('aria-pressed', 'false');
    expect(free).not.toHaveTextContent('додано');

    await user.click(added);
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(free);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'g2' }));
  });

  it('`multiple`: кнопка «Готово» закриває модалку; підписи можна передати пропами', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <GoodPickerModal
        open
        onClose={onClose}
        onSelect={vi.fn()}
        multiple
        selectedIds={['g1']}
        doneLabel="Done"
        addedLabel="added"
      />,
    );

    expect(await screen.findByRole('button', { name: /Mobil 5W-30/ })).toHaveTextContent('added');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Зняти вибір, «Відмітити всі», «Зняти всі» (запит власника 2026-10-13) ───

  it('`multiple` + onDeselect: клік по доданому товару знімає його, модалка лишається відкритою', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDeselect = vi.fn();
    const onClose = vi.fn();
    render(
      <GoodPickerModal
        open
        onClose={onClose}
        onSelect={onSelect}
        onDeselect={onDeselect}
        multiple
        selectedIds={['g1']}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Mobil 5W-30/ }));
    expect(onDeselect).toHaveBeenCalledTimes(1);
    expect(onDeselect).toHaveBeenCalledWith('g1');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('«Відмітити всі» віддає лише показані товари, яких ще немає у списку', async () => {
    const user = userEvent.setup();
    const onSelectMany = vi.fn();
    render(
      <GoodPickerModal
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={onSelectMany}
        onDeselectMany={vi.fn()}
        multiple
        selectedIds={['g1']}
      />,
    );

    await screen.findByRole('button', { name: /Castrol 5W-40/ });
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    // Читач екрана чує зрозумілий рядок, а не «один скісна два».
    expect(screen.getByRole('status')).toHaveTextContent('Додано 1 з 2 показаних');
    await user.click(screen.getByRole('button', { name: 'Відмітити всі' }));
    expect(onSelectMany).toHaveBeenCalledTimes(1);
    const picked = onSelectMany.mock.calls[0]![0] as { id: string; primary: string }[];
    expect(picked.map(p => p.id)).toEqual(['g2']);
    expect(picked[0]!.primary).toBe('Castrol 5W-40');
  });

  it('«Зняти всі» віддає id показаних доданих товарів; товари поза показаним списком не чіпає', async () => {
    const user = userEvent.setup();
    const onDeselectMany = vi.fn();
    render(
      <GoodPickerModal
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={vi.fn()}
        onDeselectMany={onDeselectMany}
        multiple
        selectedIds={['g1', 'g2', 'not-shown']}
      />,
    );

    await screen.findByRole('button', { name: /Castrol 5W-40/ });
    // Усе показане вже додано → відмічати нічого.
    const selectAll = screen.getByRole('button', { name: 'Відмітити всі' });
    expect(selectAll).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Зняти всі' }));
    expect(onDeselectMany).toHaveBeenCalledWith(['g1', 'g2']);
  });

  it('«Зняти всі» недіяльна, коли серед показаних немає доданих; підписи можна передати пропами', async () => {
    const user = userEvent.setup();
    const onDeselectMany = vi.fn();
    render(
      <GoodPickerModal
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={vi.fn()}
        onDeselectMany={onDeselectMany}
        selectAllLabel="Select all shown"
        deselectAllLabel="Deselect all shown"
        countLabel={(added, shown) => `Added ${added} of ${shown} shown`}
        multiple
        selectedIds={[]}
      />,
    );

    await screen.findByRole('button', { name: /Castrol 5W-40/ });
    expect(screen.getByRole('button', { name: 'Select all shown' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    const off = screen.getByRole('button', { name: 'Deselect all shown' });
    expect(off).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Added 0 of 2 shown');

    // Недіяльна кнопка НЕ має атрибута `disabled`: інакше після «Відмітити всі» фокус
    // клавіатури падав би на <body>. Клік по ній нічого не робить, фокус лишається на ній.
    expect(off).toBeEnabled();
    await user.click(off);
    expect(onDeselectMany).not.toHaveBeenCalled();
    expect(off).toHaveFocus();
  });

  it('після «Відмітити всі» кнопка стає недіяльною, але фокус клавіатури лишається на ній', async () => {
    const user = userEvent.setup();
    const onSelectMany = vi.fn();
    const props = {
      open: true,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onSelectMany,
      onDeselectMany: vi.fn(),
      multiple: true,
    };
    const { rerender } = render(<GoodPickerModal {...props} selectedIds={[]} />);

    await screen.findByRole('button', { name: /Castrol 5W-40/ });
    const selectAll = screen.getByRole('button', { name: 'Відмітити всі' });
    selectAll.focus();
    await user.keyboard('{Enter}');
    expect(onSelectMany).toHaveBeenCalledTimes(1);

    // Батько додав обидва товари.
    rerender(<GoodPickerModal {...props} selectedIds={['g1', 'g2']} />);
    expect(selectAll).toHaveAttribute('aria-disabled', 'true');
    expect(selectAll).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelectMany).toHaveBeenCalledTimes(1);
  });

  it('кнопок масового вибору немає без `multiple` і без обробників', async () => {
    const { unmount } = render(
      <GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} onSelectMany={vi.fn()} />,
    );
    await screen.findByRole('button', { name: /Castrol 5W-40/ });
    expect(screen.queryByRole('button', { name: 'Відмітити всі' })).not.toBeInTheDocument();
    unmount();

    render(<GoodPickerModal open onClose={vi.fn()} onSelect={vi.fn()} multiple selectedIds={[]} />);
    await screen.findByRole('button', { name: /Castrol 5W-40/ });
    expect(screen.queryByRole('button', { name: 'Відмітити всі' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Зняти всі' })).not.toBeInTheDocument();
  });

  // Сканер = текст у полі пошуку + Enter. Обидва шляхи обробника Enter мусять іти через
  // selectGood (доданий товар не чіпає), а не через clickGood (знімає): інакше повторне
  // сканування тієї самої упаковки прибирало б її зі списку.
  describe('сканер (Enter у полі пошуку)', () => {
    const scanSetup = () => {
      // Пошук за кодом повертає рівно один товар — pickScannedGood обирає його автоматично.
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/good-categories') return Promise.resolve(mockCategories);
        if (path.startsWith('/goods/stock-totals')) return Promise.resolve([]);
        if (path.startsWith('/goods') && path.includes('q=MOB'))
          return Promise.resolve({ items: [twoGoods[0]] });
        if (path.startsWith('/goods')) return Promise.resolve({ items: twoGoods });
        return Promise.resolve({ items: [] });
      });
      const onSelect = vi.fn();
      const onDeselect = vi.fn();
      const props = { open: true, onClose: vi.fn(), onSelect, onDeselect, multiple: true };
      return { onSelect, onDeselect, props };
    };
    const searchCalls = () =>
      apiFetchMock.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('q=MOB'));

    it('ще не доданий товар сканер додає (контроль: шлях сканера справді працює)', async () => {
      const user = userEvent.setup();
      const { onSelect, onDeselect, props } = scanSetup();
      render(<GoodPickerModal {...props} selectedIds={[]} />);

      await screen.findByRole('button', { name: /Castrol 5W-40/ });
      await user.type(screen.getByPlaceholderText(/Пошук товару/), 'MOB{Enter}');

      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }));
      expect(onDeselect).not.toHaveBeenCalled();
    });

    it('уже доданий товар сканер НЕ знімає — Enter одразу після введення (запит ще не пішов)', async () => {
      const user = userEvent.setup();
      const { onSelect, onDeselect, props } = scanSetup();
      render(<GoodPickerModal {...props} selectedIds={['g1']} />);

      await screen.findByRole('button', { name: /Castrol 5W-40/ });
      // Enter швидше за debounce → обробник сам робить запит і обирає товар із відповіді.
      await user.type(screen.getByPlaceholderText(/Пошук товару/), 'MOB{Enter}');

      await waitFor(() => expect(searchCalls().length).toBeGreaterThan(0));
      // Відповідь оброблено: у списку лишився один товар, і він позначений доданим.
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Castrol 5W-40/ })).not.toBeInTheDocument(),
      );
      expect(await screen.findByRole('button', { name: /Mobil 5W-30/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(onDeselect).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('уже доданий товар сканер НЕ знімає — Enter, коли результат пошуку вже показано', async () => {
      const user = userEvent.setup();
      const { onSelect, onDeselect, props } = scanSetup();
      render(<GoodPickerModal {...props} selectedIds={['g1']} />);

      await screen.findByRole('button', { name: /Castrol 5W-40/ });
      const input = screen.getByPlaceholderText(/Пошук товару/);
      await user.type(input, 'MOB');
      // Чекаємо, доки debounce відпрацює і список звузиться до одного товару.
      await waitFor(() => expect(searchCalls().length).toBeGreaterThan(0));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Castrol 5W-40/ })).not.toBeInTheDocument(),
      );
      await screen.findByRole('button', { name: /Mobil 5W-30/ });
      const before = searchCalls().length;

      await user.type(input, '{Enter}');

      // Нового запиту немає — спрацював шлях «обрати з показаного».
      expect(searchCalls().length).toBe(before);
      expect(onDeselect).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});

// Типові підписи — з локалі, як у ConfirmDialog (Bug #911): без пропів англійський інтерфейс
// показував «Оберіть товар», «Готово», «додано», «немає на складі».
describe('GoodPickerModal — типові підписи за мовою інтерфейсу', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/good-categories') return Promise.resolve(mockCategories);
      if (path.startsWith('/goods/stock-totals')) return Promise.resolve([]);
      if (path.startsWith('/goods')) return Promise.resolve({ items: mockGoods });
      return Promise.resolve({ items: [] });
    });
  });

  it('en-локаль: заголовок, пошук, кнопки, позначка й залишок англійською', async () => {
    await i18n.changeLanguage('en');
    try {
      render(
        <GoodPickerModal
          open
          onClose={vi.fn()}
          onSelect={vi.fn()}
          onSelectMany={vi.fn()}
          onDeselectMany={vi.fn()}
          multiple
          selectedIds={['g1']}
        />,
      );

      await screen.findByRole('button', { name: /Mobil 5W-30/ });
      expect(screen.getByText('Select a good')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search good / barcode...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Deselect all' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Added 1 of 1 shown');
      expect(screen.getByText(/added/)).toBeInTheDocument();
      expect(screen.getByText('out of stock')).toBeInTheDocument();
      expect(screen.getByText('Good categories')).toBeInTheDocument();
      // Вбудоване дерево категорій теж за мовою: рядок «Всі» і кнопка «Розгорнути всі».
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByTitle('Expand all')).toBeInTheDocument();
      expect(screen.queryByText('Всі')).not.toBeInTheDocument();
      expect(screen.queryByText('Готово')).not.toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('uk');
    }
  });
});
