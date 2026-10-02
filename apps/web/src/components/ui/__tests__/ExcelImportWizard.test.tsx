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

// Керована помилка raw-preview (PDF-скан, битий файл) — null означає успіх.
const rawPreviewError: { current: Error | null } = { current: null };
// Керований збережений мапінг контрагента. ВАЖЛИВО: сервіс при відсутності запису віддає
// дефолтну «пустушку» з усіма null, а не undefined — саме це й перевіряємо окремим тестом.
const savedMappingData: { current: Record<string, number | null> | undefined } = {
  current: undefined,
};

vi.mock('@/hooks/api/useExcelImport', () => ({
  useRawPreview: () => ({
    isPending: false,
    mutate: (
      _file: File,
      opts?: { onSuccess?: (d: RawPreviewResponse) => void; onError?: (e: Error) => void },
    ) => {
      if (rawPreviewError.current) opts?.onError?.(rawPreviewError.current);
      else opts?.onSuccess?.(rawPreviewData.current);
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
  useCounterpartyImportMapping: () => ({ data: savedMappingData.current }),
  useUpsertImportMapping: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function selectFile(
  name = 'goods.xlsx',
  type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ExcelImportWizard — сирий передперегляд', () => {
  beforeEach(() => {
    rawPreviewError.current = null;
    savedMappingData.current = undefined;
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
    expect(screen.getByText(/Завантаження товарів з файлу · ЗАМ-2026-000780/)).toBeInTheDocument();
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
    // Автодетект підписує розпізнані колонки роллю («A · Код»), тому перевіряємо префікс.
    expect(texts.some(t => t?.startsWith('A'))).toBe(true);
    expect(texts.some(t => t?.startsWith('B'))).toBe(true);
    expect(texts.some(t => t?.startsWith('D'))).toBe(true);
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

  it('на кроці 2 заголовок «Ідентифікація товарів»', async () => {
    await gotoStep2();
    expect(screen.getByText(/Ідентифікація товарів/)).toBeInTheDocument();
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

describe('ExcelImportWizard — автодетект колонок, PDF-скан, режим запису', () => {
  beforeEach(() => {
    rawPreviewError.current = null;
    savedMappingData.current = undefined;
    applySpy.mockClear();
    previewOverride.current = null;
    rawPreviewData.current = {
      totalRows: 3,
      columnCount: 4,
      rows: [
        ['Код', 'Артикул', 'Бренд', 'К-сть'],
        ['1001', 'ABC-12', 'BOSCH', '4'],
        ['1002', 'XY-9', 'SKF', '2'],
      ],
    };
  });

  const renderWizard = (props: Record<string, unknown> = {}) =>
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        counterpartyName="АвтоДеталь ТОВ"
        onImportComplete={vi.fn()}
        {...props}
      />,
    );

  const colInput = (label: string) => screen.getByLabelText(new RegExp(label)) as HTMLInputElement;

  it('колонки визначаються автоматично після вибору файлу', () => {
    renderWizard();
    selectFile();
    expect(colInput('Колонка коду').value).toBe('1');
    expect(colInput('Колонка артикулу').value).toBe('2');
    expect(colInput('Колонка бренду').value).toBe('3');
    expect(colInput('Колонка кількості').value).toBe('4');
    expect(screen.getByText(/Колонки визначено автоматично/)).toBeInTheDocument();
  });

  it('поля лишаються редагованими після автодетекту', () => {
    renderWizard();
    selectFile();
    fireEvent.change(colInput('Колонка коду'), { target: { value: '5' } });
    expect(colInput('Колонка коду').value).toBe('5');
  });

  it('ручна правка «Перший рядок даних» ПЕРЕМАГАЄ повторний автодетект', () => {
    renderWizard();
    selectFile(); // автодетект #1 → startRow з шапки
    fireEvent.change(colInput('Перший рядок даних'), { target: { value: '7' } });
    expect(colInput('Перший рядок даних').value).toBe('7');
    // Другий файл запускає автодетект ЗНОВУ. Ручне число мусить вистояти — як і для решти
    // колонок. Регресія: startRow писався напряму у setMapping, оминаючи позначку 'manual',
    // тож цей автодетект тихо повертав визначений рядок і користувач губив введене.
    selectFile();
    expect(colInput('Перший рядок даних').value).toBe('7');
  });

  it('збережений мапінг контрагента ПЕРЕМАГАЄ автодетект', () => {
    savedMappingData.current = {
      startRow: 3,
      codeCol: null,
      articleCol: 7,
      brandCol: null,
      nameCol: null,
      quantityCol: null,
      priceCol: null,
    };
    renderWizard({ counterpartyId: '22222222-2222-2222-2222-222222222222' });
    selectFile();
    expect(colInput('Колонка артикулу').value).toBe('7'); // saved, не автодетект (2)
    expect(screen.getByText(/Застосовано збережені колонки/)).toBeInTheDocument();
  });

  it('дефолтна пустушка савед-мапінгу НЕ затирає автодетект', () => {
    // Сервіс при відсутності запису віддає всі колонки null — такий «мапінг» не має
    // перебивати автовизначення (інакше колонки мовчки обнулялись би).
    savedMappingData.current = {
      startRow: 2,
      codeCol: null,
      articleCol: null,
      brandCol: null,
      nameCol: null,
      quantityCol: null,
      priceCol: null,
    };
    renderWizard({ counterpartyId: '22222222-2222-2222-2222-222222222222' });
    selectFile();
    expect(colInput('Колонка артикулу').value).toBe('2'); // автодетект спрацював
  });

  it('невпізнані заголовки → підказка ввести вручну, мапінг не змінено', () => {
    rawPreviewData.current = {
      totalRows: 2,
      columnCount: 3,
      rows: [
        ['Склад', 'Примітка', 'Дата'],
        ['А', 'Б', 'В'],
      ],
    };
    renderWizard();
    selectFile();
    expect(screen.getByText(/Не вдалося автоматично визначити колонки/)).toBeInTheDocument();
    expect(colInput('Колонка артикулу').value).toBe('');
  });

  it('PDF-скан → зрозуміле повідомлення, кнопка переходу заблокована', () => {
    rawPreviewError.current = new Error(
      'Цей PDF — скан або фото без текстового шару, тому розпізнати позиції автоматично не вдалося.',
    );
    renderWizard();
    selectFile('scan.pdf', 'application/pdf');
    expect(screen.getByText(/скан або фото без текстового шару/)).toBeInTheDocument();
    expect(screen.queryByText('Передперегляд файлу')).toBeNull();
    expect(screen.getByRole('button', { name: /Ідентифікувати товари/ })).toBeDisabled();
  });

  it('input приймає .csv і .pdf, не лише .xlsx', () => {
    renderWizard();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('.csv');
    expect(input.accept).toContain('.pdf');
    expect(input.accept).toContain('.xlsx');
  });

  it('документ без позицій → блоку режиму немає, apply йде з mode=replace', async () => {
    renderWizard({ existingLineCount: 0 });
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: /Ідентифікувати товари/ }));
    await screen.findByText(/Обрано:/);
    expect(screen.queryByText(/Замінити наявні позиції/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Заповнити товарами/ }));
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect((applySpy.mock.calls[0][0] as { mode: string }).mode).toBe('replace');
  });

  it('документ з позиціями → вибір режиму; «Додати» надсилає mode=append', async () => {
    renderWizard({ existingLineCount: 3 });
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: /Ідентифікувати товари/ }));
    await screen.findByText(/Обрано:/);

    expect(screen.getByText(/Замінити наявні позиції \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/Наявні позиції \(3\) буде видалено/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Додати до наявних/));
    fireEvent.click(screen.getByRole('button', { name: /Заповнити товарами/ }));
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect((applySpy.mock.calls[0][0] as { mode: string }).mode).toBe('append');
  });
});

describe('ExcelImportWizard — OCR (фото та скани)', () => {
  beforeEach(() => {
    rawPreviewError.current = null;
    savedMappingData.current = undefined;
    applySpy.mockClear();
    previewOverride.current = null;
    rawPreviewData.current = {
      totalRows: 3,
      columnCount: 4,
      rows: [
        ['Артикул', 'Найменування', 'К-сть', 'Ціна'],
        ['A1', 'Фільтр', 'BOSCH', '4'],
      ],
    };
  });

  const renderWizard = (props: Record<string, unknown> = {}) =>
    render(
      <ExcelImportWizard
        open
        onClose={vi.fn()}
        docType="PURCHASE_ORDER"
        docId="11111111-1111-1111-1111-111111111111"
        counterpartyName="АвтоДеталь ТОВ"
        onImportComplete={vi.fn()}
        {...props}
      />,
    );

  it('input приймає .jpg і .png на додачу до .xlsx/.csv/.pdf', () => {
    renderWizard();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    for (const ext of ['.xlsx', '.csv', '.pdf', '.jpg', '.png']) {
      expect(input.accept).toContain(ext);
    }
  });

  it('підказка попереджає про HEIC ДО вибору файлу', () => {
    renderWizard();
    expect(screen.getByText(/не HEIC/)).toBeInTheDocument();
  });

  it('OCR-результат → попередження звірити з паперовою накладною', async () => {
    rawPreviewData.current = { ...rawPreviewData.current, kind: 'image', ocr: true };
    renderWizard();
    selectFile('nakladna.jpg', 'image/jpeg');
    fireEvent.click(screen.getByRole('button', { name: /Ідентифікувати товари/ }));
    await screen.findByText(/Обрано:/);
    expect(screen.getByText(/Текст розпізнано автоматично/)).toBeInTheDocument();
  });

  it('звичайний файл (без ocr) → попередження НЕ показується', async () => {
    rawPreviewData.current = { ...rawPreviewData.current, kind: 'xlsx', ocr: false };
    renderWizard();
    selectFile();
    fireEvent.click(screen.getByRole('button', { name: /Ідентифікувати товари/ }));
    await screen.findByText(/Обрано:/);
    expect(screen.queryByText(/Текст розпізнано автоматично/)).toBeNull();
  });

  it('файл понад 25 МБ відхиляється ДО відправки на сервер', () => {
    renderWizard();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 30 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });

    expect(screen.getByText(/Файл завеликий/)).toBeInTheDocument();
    expect(screen.queryByText('Передперегляд файлу')).toBeNull();
    expect(screen.getByRole('button', { name: /Ідентифікувати товари/ })).toBeDisabled();
  });
});
