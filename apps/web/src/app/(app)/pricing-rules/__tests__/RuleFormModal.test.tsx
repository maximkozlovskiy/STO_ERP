// Форма правила ціноутворення: категорія з довідника, СПИСОК товарів, завантаження з Excel.
//
// Що стережуть ці тести (рішення власника 2026-10-12):
//  - категорія обирається з дерева довідника, а не вводиться текстом;
//  - PATCH надсилає область ЯВНО І ЦІЛКОМ: зняте значення йде як null / [], інакше воно
//    лишалось би на сервері (стара вада `|| undefined` у buildPayload);
//  - старе правило з ТЕКСТОВОЮ категорією не шле `goodCategoryId`, доки категорію не чіпали
//    (null стер би текстову категорію);
//  - «Зберегти» вимкнено, доки повний список товарів правила не довантажено — інакше порожній
//    локальний список затер би справжній;
//  - імпорт із файла: «додати» не дублює, «замінити» заміщує, ліміт 5000 не перевищується.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { PRICING_RULE_MAX_GOODS } from '@sto/shared';

const apiFetchMock = vi.fn();
const apiMultipartFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiMultipartFetch: (...a: unknown[]) => apiMultipartFetchMock(...a),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/CounterpartyEditModal', () => ({ CounterpartyEditModal: () => null }));
vi.mock('@/components/ui/search-picker-modal', () => ({ SearchPickerModal: () => null }));

// Модалка вибору товару має власні тести (GoodPickerModal.test.tsx). Тут — заглушка з двома
// товарами, яка, як і справжня у режимі `multiple`, не закривається після вибору.
const PICKER_GOODS = [
  { id: 'g-1', name: 'Фільтр масляний', sku: 'OC90', brandName: 'Knecht', salePrice: 100 },
  { id: 'g-2', name: 'Колодки гальмівні', sku: 'GDB1330', brandName: 'TRW', salePrice: 900 },
];
vi.mock('@/components/ui/GoodPickerModal', () => ({
  GoodPickerModal: ({
    open,
    onSelect,
    onClose,
    multiple,
    onDeselect,
    onSelectMany,
    onDeselectMany,
  }: {
    open: boolean;
    onSelect: (item: unknown) => void;
    onClose: () => void;
    multiple?: boolean;
    onDeselect?: (id: string) => void;
    onSelectMany?: (items: unknown[]) => void;
    onDeselectMany?: (ids: string[]) => void;
  }) =>
    open ? (
      <div data-testid="picker" data-multiple={String(!!multiple)}>
        {PICKER_GOODS.map(g => (
          <button key={g.id} type="button" onClick={() => onSelect({ ...g, primary: g.name })}>
            pick {g.id}
          </button>
        ))}
        <button type="button" onClick={() => onDeselect?.('g-1')}>
          unpick g-1
        </button>
        <button
          type="button"
          onClick={() => onSelectMany?.(PICKER_GOODS.map(g => ({ ...g, primary: g.name })))}
        >
          pick all
        </button>
        <button type="button" onClick={() => onDeselectMany?.(PICKER_GOODS.map(g => g.id))}>
          unpick all
        </button>
        {/* Два виклики в ОДНОМУ обробнику — до того, як React перемалює форму. */}
        <button
          type="button"
          onClick={() => PICKER_GOODS.forEach(g => onSelect({ ...g, primary: g.name }))}
        >
          pick both at once
        </button>
        <button
          type="button"
          onClick={() => {
            onSelect({ ...PICKER_GOODS[0], primary: PICKER_GOODS[0]!.name });
            onDeselect?.('g-1');
            onSelectMany?.([{ ...PICKER_GOODS[1], primary: PICKER_GOODS[1]!.name }]);
          }}
        >
          pick unpick pick-many at once
        </button>
        <button type="button" onClick={onClose}>
          picker-done
        </button>
      </div>
    ) : null,
}));

import RuleFormModal from '../RuleFormModal';
import {
  EMPTY_FORM,
  buildCreatePayload,
  buildUpdatePayload,
  ruleToForm,
  type PricingRule,
  type ResolveGoodsFileResult,
  type RuleForm,
  type RuleGood,
} from '../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TREE = [
  {
    id: 'cat-brakes',
    name: 'Гальмівна система',
    isActive: true,
    children: [
      { id: 'cat-pads', name: 'Колодки', isActive: true, children: [] },
      { id: 'cat-old', name: 'Застаріле', isActive: false, children: [] },
    ],
  },
  { id: 'cat-oil', name: 'Мастила', isActive: true, children: [] },
];

const BRANDS = [{ id: 'b-1', name: 'Bosch' }];

const good = (n: number): RuleGood => ({
  id: `g-${n}`,
  internalCode: `C${n}`,
  name: `Товар ${n}`,
  sku: `SKU-${n}`,
  brandName: null,
});

const RULE: PricingRule = {
  id: 'r-1',
  name: 'Bosch +30%',
  type: 'PERCENT',
  priority: 10,
  goodsCount: 0,
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
};

/** apiFetch: довідник категорій + (за потреби) список товарів правила. */
function mockApi(ruleGoods?: () => Promise<{ items: RuleGood[]; total: number }>) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/good-categories') return Promise.resolve(TREE);
    // Список товарів форма читає при КОЖНОМУ відкритті редагування; типово він порожній.
    if (path === '/pricing-rules/r-1/goods')
      return ruleGoods ? ruleGoods() : Promise.resolve({ items: [], total: 0 });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderCreate() {
  const onSave = vi.fn<(form: RuleForm) => Promise<void>>().mockResolvedValue(undefined);
  render(
    <RuleFormModal open onClose={vi.fn()} onSave={onSave} initial={EMPTY_FORM} brands={BRANDS} />,
  );
  return onSave;
}

function renderEdit(rule: PricingRule) {
  const onSave = vi.fn<(form: RuleForm) => Promise<void>>().mockResolvedValue(undefined);
  render(
    <RuleFormModal
      open
      onClose={vi.fn()}
      onSave={onSave}
      initial={ruleToForm(rule)}
      initialCreatedAt={rule.createdAt}
      ruleId={rule.id}
      brands={BRANDS}
    />,
  );
  return onSave;
}

const categorySelect = () =>
  screen.getByLabelText("Категорія (необов'язково)") as HTMLSelectElement;
const brandSelect = () => screen.getByLabelText("Бренд (необов'язково)") as HTMLSelectElement;
const typeSelect = () => screen.getByLabelText("Тип товару (необов'язково)") as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: 'Зберегти' });

/** Натискає «Зберегти» і повертає форму, яку модалка віддала в onSave. */
async function saveAndGetForm(onSave: ReturnType<typeof renderCreate>): Promise<RuleForm> {
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0]![0];
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/Назва правила/), { target: { value: 'Тест' } });
  fireEvent.change(screen.getByLabelText(/Надбавка, %/), { target: { value: '25' } });
}

async function uploadFile(result: ResolveGoodsFileResult) {
  apiMultipartFetchMock.mockResolvedValueOnce(result);
  const input = screen.getByLabelText('Файл зі списком товарів (.xlsx або .csv)');
  const file = new File(['x'], 'goods.xlsx');
  fireEvent.change(input, { target: { files: [file] } });
  return screen.findByRole('region', { name: 'Результат розпізнавання файла' });
}

const ref = (n: number) => ({ ...good(n), brandId: null });
const RAW_EMPTY = { code: null, article: null, brand: null, barcode: null, name: null };

beforeEach(() => {
  apiFetchMock.mockReset();
  apiMultipartFetchMock.mockReset();
  mockApi();
});

// ─── Категорія ───────────────────────────────────────────────────────────────

describe('RuleFormModal — категорія з довідника', () => {
  it('опції беруться з дерева /good-categories, підкатегорії — з відступом, вимкнені сховано', async () => {
    renderCreate();
    await waitFor(() => expect(categorySelect().options.length).toBeGreaterThan(1));

    const options = [...categorySelect().options];
    expect(options.map(o => o.value)).toEqual(['', 'cat-brakes', 'cat-pads', 'cat-oil']);
    expect(options[0]!.textContent).toBe('— Будь-яка —');
    expect(options[1]!.textContent).toBe('Гальмівна система');
    // Рівень 1 → два нерозривні пробіли перед назвою.
    expect(options[2]!.textContent).toBe('  Колодки');
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/good-categories',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('довідник не завантажився → видима помилка і «Повторити», а не порожній список мовчки', async () => {
    let fail = true;
    apiFetchMock.mockImplementation((path: string) => {
      if (path !== '/good-categories') return Promise.reject(new Error('unexpected'));
      return fail ? Promise.reject(new Error('boom')) : Promise.resolve(TREE);
    });
    renderCreate();

    expect(
      await screen.findByText(/Не вдалося завантажити довідник категорій/),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    await waitFor(() => expect(categorySelect().options.length).toBe(4));
    expect(screen.queryByText(/Не вдалося завантажити довідник категорій/)).not.toBeInTheDocument();
  });

  it('обрано бренд → категорія і тип вимкнені; обрано категорію → вимкнено тип', async () => {
    renderCreate();
    await waitFor(() => expect(categorySelect().options.length).toBe(4));

    fireEvent.change(categorySelect(), { target: { value: 'cat-oil' } });
    expect(typeSelect()).toBeDisabled();
    expect(categorySelect()).toBeEnabled();

    fireEvent.change(brandSelect(), { target: { value: 'b-1' } });
    expect(categorySelect()).toBeDisabled();
    expect(typeSelect()).toBeDisabled();
  });
});

// ─── Payload ─────────────────────────────────────────────────────────────────

describe('RuleFormModal — payload створення', () => {
  it('категорія з довідника → goodCategoryId; порожні поля області не надсилаються', async () => {
    const onSave = renderCreate();
    await waitFor(() => expect(categorySelect().options.length).toBe(4));
    fillRequired();
    fireEvent.change(categorySelect(), { target: { value: 'cat-pads' } });

    const payload = buildCreatePayload(await saveAndGetForm(onSave));

    expect(payload).toMatchObject({
      name: 'Тест',
      type: 'PERCENT',
      percentValue: 25,
      goodCategoryId: 'cat-pads',
    });
    // JSON.stringify відкидає undefined — саме так тіло і піде на сервер.
    const sent = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('goodIds');
    expect(Object.keys(sent)).not.toContain('brandId');
    expect(Object.keys(sent)).not.toContain('goodType');
    expect(Object.keys(sent)).not.toContain('supplierId');
    // Полів старого контракту немає: сервер відповів би 400 (forbidNonWhitelisted).
    expect(Object.keys(sent)).not.toContain('goodId');
    expect(Object.keys(sent)).not.toContain('goodCategory');
  });

  it('список товарів через «Додати товар» → goodIds; бренд/категорія/тип сховані й не йдуть', async () => {
    const onSave = renderCreate();
    await waitFor(() => expect(categorySelect().options.length).toBe(4));
    fillRequired();
    fireEvent.change(brandSelect(), { target: { value: 'b-1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Додати товар' }));
    expect(screen.getByTestId('picker')).toHaveAttribute('data-multiple', 'true');
    fireEvent.click(screen.getByText('pick g-1'));
    fireEvent.click(screen.getByText('pick g-2'));
    // Повторний вибір того самого товару список не дублює.
    fireEvent.click(screen.getByText('pick g-1'));
    fireEvent.click(screen.getByText('picker-done'));

    expect(screen.getByText('Товари (2)')).toBeInTheDocument();
    expect(screen.queryByLabelText("Бренд (необов'язково)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Категорія (необов'язково)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Тип товару (необов'язково)")).not.toBeInTheDocument();

    const sent = JSON.parse(
      JSON.stringify(buildCreatePayload(await saveAndGetForm(onSave))),
    ) as Record<string, unknown>;
    expect(sent.goodIds).toEqual(['g-1', 'g-2']);
    // Область має один вимір: список товарів сильніший за бренд, обраний раніше.
    expect(Object.keys(sent)).not.toContain('brandId');
  });
});

describe('RuleFormModal — payload редагування', () => {
  it('зняті у формі поля йдуть ЯВНО: brandId null, goodType null, supplierId null; список не чіпали — goodIds немає', async () => {
    const onSave = renderEdit({ ...RULE, brandId: 'b-1', brandName: 'Bosch' });
    await waitFor(() => expect(categorySelect().options.length).toBe(4));
    expect(brandSelect().value).toBe('b-1');

    fireEvent.change(brandSelect(), { target: { value: '' } });
    const payload = buildUpdatePayload(await saveAndGetForm(onSave));

    // toEqual на об'єкті з undefined не відрізнив би «ключа немає» від «ключ = undefined» —
    // тому порівнюємо те, що реально піде в тіло запиту.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      name: 'Bosch +30%',
      type: 'PERCENT',
      priority: 10,
      percentValue: 30,
      brandId: null,
      goodCategoryId: null,
      goodType: null,
      supplierId: null,
      isActive: true,
    });
  });

  it('список не чіпали → goodIds у PATCH немає; додали або очистили → іде цілий список', async () => {
    mockApi(() => Promise.resolve({ items: [good(1)], total: 1 }));
    const onSave = renderEdit({ ...RULE, goodsCount: 1, goodsPreview: [good(1)] });
    expect(await screen.findByText('Товар 1')).toBeInTheDocument();

    // Лише перейменували: «той самий список назад» стер би зв'язки з видаленими товарами,
    // яких форма не показує, і правило стало б загальним.
    const untouched = buildUpdatePayload(await saveAndGetForm(onSave));
    expect(Object.keys(untouched)).not.toContain('goodIds');

    fireEvent.click(screen.getByRole('button', { name: 'Додати товар' }));
    fireEvent.click(screen.getByText('pick g-2'));
    fireEvent.click(screen.getByText('picker-done'));
    onSave.mockClear();
    const touched = buildUpdatePayload(await saveAndGetForm(onSave));
    expect(touched.goodIds).toEqual(['g-1', 'g-2']);
  });

  it('обрана категорія йде як id, а тип під нею — null (один вимір області)', async () => {
    const onSave = renderEdit({ ...RULE, goodType: 'SPARE_PART' });
    await waitFor(() => expect(categorySelect().options.length).toBe(4));

    fireEvent.change(categorySelect(), { target: { value: 'cat-brakes' } });
    const payload = buildUpdatePayload(await saveAndGetForm(onSave));

    expect(payload.goodCategoryId).toBe('cat-brakes');
    expect(payload.goodType).toBeNull();
    expect(payload.brandId).toBeNull();
  });

  it('грейди йдуть без `id` (сервер його не приймає), costMax=null не надсилається', () => {
    const form: RuleForm = {
      ...ruleToForm(RULE),
      type: 'COST_TIER',
      tiers: [
        { id: 't-1', costMin: 0, costMax: 100, percentValue: 40, sortOrder: 0 },
        { id: 't-2', costMin: 100, costMax: null, percentValue: 20, sortOrder: 5 },
      ],
    };
    expect(buildUpdatePayload(form).tiers).toEqual([
      { costMin: 0, costMax: 100, percentValue: 40, sortOrder: 0 },
      { costMin: 100, percentValue: 20, sortOrder: 1 },
    ]);
  });
});

describe('RuleFormModal — старе правило з текстовою категорією', () => {
  const LEGACY: PricingRule = { ...RULE, goodCategory: 'Гальма (стара)' };

  it('категорію не чіпали → пояснення видно, goodCategoryId у запиті НЕМАЄ', async () => {
    const onSave = renderEdit(LEGACY);
    await waitFor(() => expect(categorySelect().options.length).toBe(4));

    expect(
      screen.getByText(
        'Стара текстова категорія «Гальма (стара)»: оберіть категорію зі списку, щоб правило діяло на категорію з підкатегоріями',
      ),
    ).toBeInTheDocument();
    expect(categorySelect().value).toBe('');

    const payload = buildUpdatePayload(await saveAndGetForm(onSave));
    expect(Object.keys(payload)).not.toContain('goodCategoryId');
    // Решта області однаково йде явно (список не чіпали — його в запиті немає).
    expect(payload.brandId).toBeNull();
  });

  it('обрали категорію → goodCategoryId надсилається, пояснення зникає', async () => {
    const onSave = renderEdit(LEGACY);
    await waitFor(() => expect(categorySelect().options.length).toBe(4));

    fireEvent.change(categorySelect(), { target: { value: 'cat-brakes' } });
    expect(screen.queryByText(/Стара текстова категорія/)).not.toBeInTheDocument();

    expect(buildUpdatePayload(await saveAndGetForm(onSave)).goodCategoryId).toBe('cat-brakes');
  });

  it('обрали й зняли категорію (явне зняття) → goodCategoryId: null', async () => {
    const onSave = renderEdit(LEGACY);
    await waitFor(() => expect(categorySelect().options.length).toBe(4));

    fireEvent.change(categorySelect(), { target: { value: 'cat-brakes' } });
    fireEvent.change(categorySelect(), { target: { value: '' } });

    const payload = buildUpdatePayload(await saveAndGetForm(onSave));
    expect(Object.keys(payload)).toContain('goodCategoryId');
    expect(payload.goodCategoryId).toBeNull();
  });
});

// ─── Список товарів ──────────────────────────────────────────────────────────

describe('RuleFormModal — список товарів правила', () => {
  it('редагування з goodsCount > 0: «Зберегти» вимкнено, доки список не довантажено', async () => {
    let resolveGoods!: (v: { items: RuleGood[]; total: number }) => void;
    mockApi(() => new Promise(r => (resolveGoods = r)));
    const onSave = renderEdit({ ...RULE, goodsCount: 2, goodsPreview: [good(1), good(2)] });

    expect(await screen.findByText('Завантаження списку товарів…')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Додати товар' })).toBeDisabled();
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/pricing-rules/r-1/goods',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    resolveGoods({ items: [good(1), good(2)], total: 2 });

    expect(await screen.findByText('Товари (2)')).toBeInTheDocument();
    expect(screen.getByText('Товар 1')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    // Прибираємо один товар — у запит іде решта.
    fireEvent.click(screen.getByRole('button', { name: 'Прибрати «Товар 1» зі списку' }));
    expect(buildUpdatePayload(await saveAndGetForm(onSave)).goodIds).toEqual(['g-2']);
  });

  it('помилка довантаження → текст сервера і «Повторити»; «Зберегти» лишається вимкненим', async () => {
    let fail = true;
    mockApi(() =>
      fail
        ? Promise.reject(new Error('Сервер недоступний'))
        : Promise.resolve({ items: [good(7)], total: 1 }),
    );
    renderEdit({ ...RULE, goodsCount: 1, goodsPreview: [good(7)] });

    expect(await screen.findByText('Сервер недоступний')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    // Порожній стан не показуємо: список не порожній, він не завантажився.
    expect(screen.queryByText(/Товари не вказано/)).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(await screen.findByText('Товар 7')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('goodsCount у рядку таблиці 0, а на сервері товари є (знімок застарів) → список запитано й показано', async () => {
    // Рядок таблиці — знімок: щойно збережене правило, інша вкладка, невдалий refetch.
    // Форма з хибно порожнім списком після «Додати товар» замінила б ним справжній.
    mockApi(() => Promise.resolve({ items: [good(1), good(2)], total: 2 }));
    renderEdit(RULE);

    expect(saveButton()).toBeDisabled();
    expect(await screen.findByText('Товари (2)')).toBeInTheDocument();
    expect(screen.getByText('Товар 2')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('правило без товарів: після відповіді сервера показано порожній стан', async () => {
    renderEdit(RULE);
    await waitFor(() => expect(categorySelect().options.length).toBe(4));

    expect(
      await screen.findByText(
        'Товари не вказано — правило діє за брендом, категорією, типом або на весь асортимент',
      ),
    ).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.some(c => String(c[0]) === '/pricing-rules/r-1/goods')).toBe(
      true,
    );
    expect(saveButton()).toBeEnabled();
  });

  it('довгий список: рендериться 100 рядків і підказка; пошук звужує', async () => {
    const items = Array.from({ length: 250 }, (_, i) => good(i + 1));
    mockApi(() => Promise.resolve({ items, total: items.length }));
    renderEdit({ ...RULE, goodsCount: 250, goodsPreview: items.slice(0, 3) });

    expect(await screen.findByText('Товари (250)')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Товари правила' });
    expect(within(table).getAllByRole('row')).toHaveLength(101); // заголовок + 100
    expect(screen.getByText('Показано 100 з 250 — уточніть пошук')).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('Пошук у списку товарів правила'), {
      target: { value: 'SKU-250' },
    });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Товар 250')).toBeInTheDocument();
    expect(screen.queryByText(/уточніть пошук/)).not.toBeInTheDocument();
  });

  it('«Очистити» питає підтвердження і лише після нього спорожнює список', async () => {
    mockApi(() => Promise.resolve({ items: [good(1), good(2)], total: 2 }));
    renderEdit({ ...RULE, goodsCount: 2, goodsPreview: [good(1), good(2)] });
    expect(await screen.findByText('Товари (2)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Очистити' }));
    const dialog = await screen.findByRole('dialog', { name: 'Очистити список товарів правила?' });
    expect(screen.getByText('Товари (2)')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Очистити' }));
    expect(await screen.findByText('Товари (0)')).toBeInTheDocument();
  });
});

// ─── Імпорт із файла ─────────────────────────────────────────────────────────

describe('RuleFormModal — завантаження списку з файла', () => {
  /** Форма редагування з двома товарами у списку (g-1, g-2). */
  async function openWithTwoGoods() {
    mockApi(() => Promise.resolve({ items: [good(1), good(2)], total: 2 }));
    const onSave = renderEdit({ ...RULE, goodsCount: 2, goodsPreview: [good(1), good(2)] });
    expect(await screen.findByText('Товари (2)')).toBeInTheDocument();
    return onSave;
  }

  const RESULT: ResolveGoodsFileResult = {
    total: 5,
    matched: [
      { rowIndex: 2, matchedBy: 'code', good: ref(2) }, // уже у списку
      { rowIndex: 3, matchedBy: 'article', good: ref(3) },
    ],
    ambiguous: [
      {
        rowIndex: 4,
        raw: { ...RAW_EMPTY, article: 'OC90', brand: 'Knecht' },
        candidates: [ref(10), ref(11)],
      },
    ],
    notFound: [
      { rowIndex: 5, raw: { ...RAW_EMPTY, code: 'ZZZ', name: 'Невідомий товар' } },
      { rowIndex: 6, raw: RAW_EMPTY },
    ],
  };

  it('файл іде multipart-запитом на /xlsx/pricing-rule-goods/resolve у полі file', async () => {
    await openWithTwoGoods();
    await uploadFile(RESULT);

    expect(apiMultipartFetchMock).toHaveBeenCalledTimes(1);
    const [path, fd] = apiMultipartFetchMock.mock.calls[0] as [string, FormData];
    expect(path).toBe('/xlsx/pricing-rule-goods/resolve');
    expect((fd.get('file') as File).name).toBe('goods.xlsx');
  });

  it('підсумок, не знайдені рядки, типовий режим «Додати до списку»', async () => {
    await openWithTwoGoods();
    const panel = await uploadFile(RESULT);

    expect(within(panel).getByRole('radio', { name: 'Додати до списку' })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: 'Замінити список' })).not.toBeChecked();

    const term = (label: string) =>
      within(panel).getByText(label).parentElement!.querySelector('dd')!.textContent;
    expect(term('Рядків у файлі:')).toBe('5');
    expect(term('Знайдено:')).toBe('2');
    expect(term('уже у списку:')).toBe('1');
    expect(term('Не знайдено:')).toBe('2');
    expect(term('Потребують вибору:')).toBe('1');

    expect(within(panel).getByText('рядок 5: код ZZZ · назва Невідомий товар')).toBeInTheDocument();
    expect(within(panel).getByText('рядок 6: порожній рядок')).toBeInTheDocument();
    expect(within(panel).getByText('рядок 4: артикул OC90 · бренд Knecht')).toBeInTheDocument();
    // Неоднозначний рядок типово пропускається.
    expect((within(panel).getByLabelText('Товар для рядка 4') as HTMLSelectElement).value).toBe('');
  });

  it('«додати»: уже наявний товар не дублюється, обраний кандидат потрапляє у список', async () => {
    const onSave = await openWithTwoGoods();
    const panel = await uploadFile(RESULT);

    fireEvent.change(within(panel).getByLabelText('Товар для рядка 4'), {
      target: { value: 'g-11' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }));

    expect(await screen.findByText('Товари (4)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Додано товарів: 2');
    expect(
      screen.queryByRole('region', { name: 'Результат розпізнавання файла' }),
    ).not.toBeInTheDocument();

    expect(buildUpdatePayload(await saveAndGetForm(onSave)).goodIds).toEqual([
      'g-1',
      'g-2',
      'g-3',
      'g-11',
    ]);
  });

  it('«замінити»: список заміщується товарами з файла', async () => {
    const onSave = await openWithTwoGoods();
    const panel = await uploadFile(RESULT);

    fireEvent.click(within(panel).getByRole('radio', { name: 'Замінити список' }));
    // У режимі заміни «уже у списку» не має сенсу — не показуємо.
    expect(within(panel).queryByText('уже у списку:')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }));

    expect(await screen.findByText('Товари (2)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Список замінено, товарів: 2');
    expect(buildUpdatePayload(await saveAndGetForm(onSave)).goodIds).toEqual(['g-2', 'g-3']);
  });

  it('«Скасувати» лишає список без змін; наступний файл знову питає режим із «Додати»', async () => {
    await openWithTwoGoods();
    let panel = await uploadFile(RESULT);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Замінити список' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Скасувати' }));

    expect(screen.getByText('Товари (2)')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Результат розпізнавання файла' }),
    ).not.toBeInTheDocument();

    panel = await uploadFile(RESULT);
    expect(within(panel).getByRole('radio', { name: 'Додати до списку' })).toBeChecked();
  });

  it('більше 10 не знайдених → згорнутий список', async () => {
    await openWithTwoGoods();
    const notFound = Array.from({ length: 11 }, (_, i) => ({
      rowIndex: i + 2,
      raw: { ...RAW_EMPTY, code: `X${i}` },
    }));
    const panel = await uploadFile({ total: 11, matched: [], ambiguous: [], notFound });

    const details = panel.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(/Не знайдено у довіднику товарів \(11\)/)).toBeInTheDocument();
    expect(within(details).getAllByRole('listitem', { hidden: true })).toHaveLength(11);
    // Застосовувати нічого: перемикача режиму немає, «Застосувати» вимкнено.
    expect(within(panel).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Застосувати' })).toBeDisabled();
  });

  it('помилка сервера (порожній файл / понад 5000 рядків) показується його текстом', async () => {
    await openWithTwoGoods();
    apiMultipartFetchMock.mockRejectedValueOnce(new Error('У файлі більше 5000 рядків'));
    fireEvent.change(screen.getByLabelText('Файл зі списком товарів (.xlsx або .csv)'), {
      target: { files: [new File(['x'], 'big.csv')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('У файлі більше 5000 рядків');
    expect(screen.getByText('Товари (2)')).toBeInTheDocument();
  });

  it('перевищення ліміту не застосовується: пояснення з числами, список без змін', async () => {
    const items = Array.from({ length: PRICING_RULE_MAX_GOODS - 1 }, (_, i) => good(i + 1));
    mockApi(() => Promise.resolve({ items, total: items.length }));
    renderEdit({ ...RULE, goodsCount: items.length, goodsPreview: items.slice(0, 3) });
    const title = `Товари (${PRICING_RULE_MAX_GOODS - 1})`;
    expect(await screen.findByText(title)).toBeInTheDocument();

    const panel = await uploadFile({
      total: 2,
      matched: [
        { rowIndex: 2, matchedBy: 'code', good: ref(900001) },
        { rowIndex: 3, matchedBy: 'code', good: ref(900002) },
      ],
      ambiguous: [],
      notFound: [],
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }));

    expect(within(panel).getByRole('alert')).toHaveTextContent(
      `Після застосування у списку було б ${PRICING_RULE_MAX_GOODS + 1} товарів, а максимум — ${PRICING_RULE_MAX_GOODS}. Список не змінено.`,
    );
    expect(screen.getByText(title)).toBeInTheDocument();
    // Панель лишається відкритою — можна перемкнути на «Замінити» і застосувати.
    fireEvent.click(within(panel).getByRole('radio', { name: 'Замінити список' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Застосувати' }));
    expect(await screen.findByText('Товари (2)')).toBeInTheDocument();
  });

  it('вікно вибору: зняти один товар, «відмітити всі», «зняти всі» змінюють список форми', async () => {
    const onSave = renderCreate();
    await waitFor(() => expect(categorySelect().options.length).toBe(4));
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Додати товар' }));

    fireEvent.click(screen.getByText('pick g-1'));
    expect(screen.getByText('Товари (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByText('unpick g-1'));
    expect(screen.getByText('Товари (0)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('pick g-2'));
    // «Відмітити всі» додає лише відсутні: g-2 уже є і не дублюється.
    fireEvent.click(screen.getByText('pick all'));
    expect(screen.getByText('Товари (2)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('unpick all'));
    expect(screen.getByText('Товари (0)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('pick all'));
    fireEvent.click(screen.getByText('picker-done'));
    const sent = JSON.parse(
      JSON.stringify(buildCreatePayload(await saveAndGetForm(onSave))),
    ) as Record<string, unknown>;
    expect(sent.goodIds).toEqual(['g-1', 'g-2']);
  });

  it('два вибори до наступного рендера не затирають один одного (список не із замикання)', () => {
    renderCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Додати товар' }));

    fireEvent.click(screen.getByText('pick both at once'));
    expect(screen.getByText('Товари (2)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('unpick all'));
    // додати g-1 → зняти g-1 → додати g-2 одним обробником: лишається рівно g-2.
    fireEvent.click(screen.getByText('pick unpick pick-many at once'));
    expect(screen.getByText('Товари (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByText('picker-done'));
    expect(screen.getByRole('cell', { name: 'Колодки гальмівні' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Фільтр масляний' })).not.toBeInTheDocument();
  });

  it('«відмітити всі» біля ліміту: додається лише те, що вміщується, решта — з поясненням', async () => {
    // Товари списку мають id g-3…g-N, у вікні вибору — g-1 і g-2: обидва нові, місце одне.
    const items = Array.from({ length: PRICING_RULE_MAX_GOODS - 1 }, (_, i) => good(i + 3));
    mockApi(() => Promise.resolve({ items, total: items.length }));
    renderEdit({ ...RULE, goodsCount: items.length, goodsPreview: items.slice(0, 3) });
    expect(await screen.findByText(`Товари (${PRICING_RULE_MAX_GOODS - 1})`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Додати товар' }));
    fireEvent.click(screen.getByText('pick all'));

    expect(screen.getByText(`Товари (${PRICING_RULE_MAX_GOODS})`)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      `У списку вже ${PRICING_RULE_MAX_GOODS} товарів — це максимум для одного правила`,
    );
  });

  it('у списку вже максимум → «Додати товар» пояснює, а не відкриває вибір мовчки', async () => {
    const items = Array.from({ length: PRICING_RULE_MAX_GOODS }, (_, i) => good(i + 1));
    mockApi(() => Promise.resolve({ items, total: items.length }));
    renderEdit({ ...RULE, goodsCount: items.length, goodsPreview: items.slice(0, 3) });
    expect(await screen.findByText(`Товари (${PRICING_RULE_MAX_GOODS})`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Додати товар' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      `У списку вже ${PRICING_RULE_MAX_GOODS} товарів — це максимум для одного правила`,
    );
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
  });
});
