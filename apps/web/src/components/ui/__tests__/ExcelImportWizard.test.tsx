import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExcelImportWizard } from '../ExcelImportWizard';
import type { PreviewResponse, RawPreviewResponse } from '@/hooks/api/useExcelImport';

// Preview-рядки для кроку 2: matched + ambiguous + notFound.
const previewResponse: PreviewResponse = {
  rows: [
    {
      rowIndex: 2,
      rawArticle: 'ABC-12',
      rawBrand: 'BOSCH',
      rawName: 'Прокладка',
      quantity: 4,
      price: 100,
      status: 'matched',
      matchedGoodId: 'good-1',
      candidates: [{ id: 'good-1', sku: 'ABC-12', name: 'Прокладка', brandName: 'BOSCH' }],
    },
    {
      rowIndex: 3,
      rawArticle: 'XY-9',
      rawBrand: 'SKF',
      rawName: 'Сальник',
      quantity: 2,
      price: 50,
      status: 'notFound',
      matchedGoodId: null,
      candidates: [],
    },
  ],
};

// Захоплюємо аргументи apply, щоб перевірити який набір рядків імпортується.
const applySpy = vi.fn();

// Override preview-відповіді для edge-case тестів (null → базовий previewResponse).
const previewOverride: { current: PreviewResponse | null } = { current: null };

// Керовані моки хуків імпорту — щоб детерміновано керувати сирим передпереглядом
// без реального apiFetch/парсингу Excel. useRawPreview.mutate синхронно кличе onSuccess.
const rawPreviewData: { current: RawPreviewResponse } = {
  current: {
    totalRows: 250,
    columnCount: 4,
    rows: [
      ['Код', 'Артикул', 'Бренд', 'К-сть'],
      ['1001', 'ABC-12', 'BOSCH', '4'],
      ['1002', 'XY-9', 'SKF', '2'],
    ],
  },
};

vi.mock('@/hooks/api/useExcelImport', () => ({
  useRawPreview: () => ({
    isPending: false,
    mutate: (_file: File, opts?: { onSuccess?: (d: RawPreviewResponse) => void }) => {
      opts?.onSuccess?.(rawPreviewData.current);
    },
  }),
  usePreviewImport: () => ({
    isPending: false,
    mutateAsync: () => Promise.resolve(previewOverride.current ?? previewResponse),
  }),
  useApplyImport: () => ({
    isPending: false,
    mutateAsync: (vars: unknown) => {
      applySpy(vars);
      return Promise.resolve({});
    },
  }),
  useCounterpartyImportMapping: () => ({ data: undefined }),
  useUpsertImportMapping: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function selectFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'goods.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ExcelImportWizard — сирий передперегляд', () => {
  beforeEach(() => {
    rawPreviewData.current = {
      totalRows: 250,
      columnCount: 4,
      rows: [
        ['Код', 'Артикул', 'Бренд', 'К-сть'],
        ['1001', 'ABC-12', 'BOSCH', '4'],
        ['1002', 'XY-9', 'SKF', '2'],
      ],
    };
  });

  it('після вибору файлу показує таблицю передперегляду з даними файлу', () => {
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        counterpartyName="АвтоДеталь ТОВ"
        onImportComplete={vi.fn()}
      />,
    );
    expect(screen.queryByText('Передперегляд файлу')).toBeNull();
    selectFile();
    expect(screen.getByText('Передперегляд файлу')).toBeInTheDocument();
    // Вміст файлу відрендерено
    expect(screen.getByText('ABC-12')).toBeInTheDocument();
    expect(screen.getByText('BOSCH')).toBeInTheDocument();
  });

  it('підпис показує скільки рядків показано з загальної кількості', () => {
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        onImportComplete={vi.fn()}
      />,
    );
    selectFile();
    // 3 показаних рядки з 250 усього
    expect(screen.getByText(/показано 3 з 250 рядків/)).toBeInTheDocument();
  });

  it('показує номер документа у шапці модалки', () => {
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        docNumber="ЗАМ-2026-000780"
        onImportComplete={vi.fn()}
      />,
    );
    expect(screen.getByText(/Завантаження товарів з Excel · ЗАМ-2026-000780/)).toBeInTheDocument();
  });

  it('шапка передперегляду має літери колонок Excel (A, B, C, D)', () => {
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        onImportComplete={vi.fn()}
      />,
    );
    selectFile();
    // Колонки не змаплені → голі літери у шапці
    const headers = document.querySelectorAll('thead th');
    const texts = Array.from(headers).map(h => h.textContent);
    expect(texts).toContain('A');
    expect(texts).toContain('B');
    expect(texts).toContain('D');
  });
});

describe('ExcelImportWizard — крок 2: масовий вибір рядків', () => {
  beforeEach(() => {
    applySpy.mockClear();
    previewOverride.current = null;
  });

  // Довести майстер до кроку 2 (таблиця ідентифікованих рядків).
  async function gotoStep2() {
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        onImportComplete={vi.fn()}
      />,
    );
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: /Ідентифікувати товари/ }));
    // Дочекатись рендеру кнопок масового вибору кроку 2.
    await screen.findByRole('button', { name: /Вибрати всі/ });
  }

  it('за замовчуванням matched включено, notFound — ні (Обрано 1 / 2)', async () => {
    await gotoStep2();
    expect(screen.getByText(/Обрано: 1 \/ 2/)).toBeInTheDocument();
  });

  it('«Вибрати всі» позначає всі рядки, «Забрати всі» — знімає', async () => {
    await gotoStep2();
    fireEvent.click(screen.getByRole('button', { name: /Вибрати всі/ }));
    expect(screen.getByText(/Обрано: 2 \/ 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Забрати всі/ }));
    expect(screen.getByText(/Обрано: 0 \/ 2/)).toBeInTheDocument();
  });

  it('«Інвертувати вибір» міняє стан кожного рядка (1/2 → 1/2 з іншим набором)', async () => {
    await gotoStep2();
    // Стартово: matched(вкл) + notFound(викл) = 1/2. Після інверсії: matched(викл) + notFound(вкл) = 1/2.
    fireEvent.click(screen.getByRole('button', { name: /Інвертувати вибір/ }));
    expect(screen.getByText(/Обрано: 1 \/ 2/)).toBeInTheDocument();
    // Тепер у документ піде notFound-рядок як create.
    fireEvent.click(screen.getByRole('button', { name: /Заповнити товарами/ }));
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    const vars = applySpy.mock.calls[0][0] as { rows: { action: string; rowIndex: number }[] };
    expect(vars.rows).toHaveLength(1);
    expect(vars.rows[0]).toMatchObject({ action: 'create', rowIndex: 3 });
  });

  it('кнопка «Заповнити товарами» вимкнена коли нічого не обрано', async () => {
    await gotoStep2();
    fireEvent.click(screen.getByRole('button', { name: /Забрати всі/ }));
    const applyBtn = screen.getByRole('button', { name: /Заповнити товарами/ });
    expect(applyBtn).toBeDisabled();
  });
});

// Edge-cases handleApply: notFound з порожніми name+article не має слати битий create-рядок.
describe('ExcelImportWizard — крок 2: edge-cases apply', () => {
  beforeEach(() => {
    applySpy.mockClear();
  });

  async function gotoStep2With(rows: PreviewResponse['rows']) {
    previewOverride.current = { rows };
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        onImportComplete={vi.fn()}
      />,
    );
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: /Ідентифікувати товари/ }));
    await screen.findByRole('button', { name: /Вибрати всі/ });
  }

  it('notFound з порожніми rawName І rawArticle, інвертований у included → тихо пропускається (без биттого create)', async () => {
    await gotoStep2With([
      {
        rowIndex: 2,
        rawArticle: 'ABC-12',
        rawBrand: 'BOSCH',
        rawName: 'Прокладка',
        quantity: 4,
        price: 100,
        status: 'matched',
        matchedGoodId: 'good-1',
        candidates: [{ id: 'good-1', sku: 'ABC-12', name: 'Прокладка', brandName: 'BOSCH' }],
      },
      {
        rowIndex: 3,
        rawArticle: '',
        rawBrand: '',
        rawName: '',
        quantity: 2,
        price: 50,
        status: 'notFound',
        matchedGoodId: null,
        candidates: [],
      },
    ]);
    // Інверсія: matched(вкл→викл), notFound-порожній(викл→вкл). includedCount=1, readyCount=0.
    fireEvent.click(screen.getByRole('button', { name: /Інвертувати вибір/ }));
    expect(screen.getByText(/Обрано: 1 \/ 2 · до імпорту: 0/)).toBeInTheDocument();
    // Bug #752: readyCount=0 → кнопка вимкнена (не шле битий create). Форсуємо клік → без POST.
    const applyBtn = screen.getByRole('button', { name: /Заповнити товарами/ });
    expect(applyBtn).toBeDisabled();
    fireEvent.click(applyBtn);
    await new Promise(r => setTimeout(r, 0));
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('усі notFound з порожніми name + «Вибрати всі» → включено є, але apply порожній (без POST)', async () => {
    await gotoStep2With([
      {
        rowIndex: 2,
        rawArticle: '',
        rawBrand: '',
        rawName: '',
        quantity: 1,
        price: 10,
        status: 'notFound',
        matchedGoodId: null,
        candidates: [],
      },
      {
        rowIndex: 3,
        rawArticle: '',
        rawBrand: '',
        rawName: '',
        quantity: 2,
        price: 20,
        status: 'notFound',
        matchedGoodId: null,
        candidates: [],
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Вибрати всі/ }));
    expect(screen.getByText(/Обрано: 2 \/ 2 · до імпорту: 0/)).toBeInTheDocument();
    const applyBtn = screen.getByRole('button', { name: /Заповнити товарами/ });
    expect(applyBtn).toBeDisabled();
    fireEvent.click(applyBtn);
    await new Promise(r => setTimeout(r, 0));
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('ambiguous included без обраного candidate → пропуск у apply (лічильник «Обрано» рахує include, не готовність)', async () => {
    await gotoStep2With([
      {
        rowIndex: 2,
        rawArticle: 'MULTI',
        rawBrand: 'X',
        rawName: 'Фільтр',
        quantity: 1,
        price: 30,
        status: 'ambiguous',
        matchedGoodId: null,
        candidates: [
          { id: 'g-a', sku: 'A', name: 'Фільтр A', brandName: 'X' },
          { id: 'g-b', sku: 'B', name: 'Фільтр B', brandName: 'X' },
        ],
      },
    ]);
    // ambiguous стартово included=true, selectedGoodId=candidates[0]='g-a'.
    // Скидаємо вибір товару на порожній → included лишається, але apply має пропустити.
    const select = document.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    // includedCount=1, readyCount=0 (товар не обрано) → лічильник чесно показує «до імпорту: 0».
    expect(screen.getByText(/Обрано: 1 \/ 1 · до імпорту: 0/)).toBeInTheDocument();
    const applyBtn = screen.getByRole('button', { name: /Заповнити товарами/ });
    expect(applyBtn).toBeDisabled();
    fireEvent.click(applyBtn);
    await new Promise(r => setTimeout(r, 0));
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('інвертувати двічі → повернення до початкового набору (Обрано 1 / 2)', async () => {
    await gotoStep2With([
      {
        rowIndex: 2,
        rawArticle: 'ABC-12',
        rawBrand: 'BOSCH',
        rawName: 'Прокладка',
        quantity: 4,
        price: 100,
        status: 'matched',
        matchedGoodId: 'good-1',
        candidates: [{ id: 'good-1', sku: 'ABC-12', name: 'Прокладка', brandName: 'BOSCH' }],
      },
      {
        rowIndex: 3,
        rawArticle: 'XY-9',
        rawBrand: 'SKF',
        rawName: 'Сальник',
        quantity: 2,
        price: 50,
        status: 'notFound',
        matchedGoodId: null,
        candidates: [],
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Інвертувати вибір/ }));
    fireEvent.click(screen.getByRole('button', { name: /Інвертувати вибір/ }));
    expect(screen.getByText(/Обрано: 1 \/ 2/)).toBeInTheDocument();
    // Початковий набір: matched(вкл). Apply має піти matched, не notFound.
    fireEvent.click(screen.getByRole('button', { name: /Заповнити товарами/ }));
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    const vars = applySpy.mock.calls[0][0] as { rows: { action: string; rowIndex: number }[] };
    expect(vars.rows).toHaveLength(1);
    expect(vars.rows[0]).toMatchObject({ action: 'use', rowIndex: 2 });
  });
});
