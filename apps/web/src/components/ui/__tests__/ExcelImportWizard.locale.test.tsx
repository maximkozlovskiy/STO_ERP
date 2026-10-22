import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, describe, afterEach, vi } from 'vitest';
import i18n from '@/i18n/config';
import { ExcelImportWizard } from '../ExcelImportWizard';
import type { PreviewResponse, RawPreviewResponse } from '@/hooks/api/useExcelImport';

/**
 * Майстер Excel-імпорту вбудований у картки замовлення постачальнику і складського документа:
 * картки переводяться на t() (батч C), тож і дитина мусить говорити мовою інтерфейсу (клас
 * InvoiceConflictDialog, review d63c80d7). uk-тексти — ті самі, що до перекладу. Дані файлу
 * латиницею, щоб у en перевірка «жодної кирилиці» стосувалась лише інтерфейсу.
 */

const rawPreview: RawPreviewResponse = {
  totalRows: 250,
  columnCount: 3,
  rows: [
    ['Code', 'Brand', 'Qty'],
    ['1001', 'BOSCH', '4'],
    ['1002', 'SKF', '2'],
  ],
};

const preview: PreviewResponse = {
  rows: [
    {
      rowIndex: 2,
      rawArticle: 'ABC-12',
      rawBarcode: '4820000000017',
      rawBrand: 'BOSCH',
      rawName: 'Gasket',
      quantity: 4,
      price: 100,
      status: 'matched',
      matchedGoodId: 'good-1',
      candidates: [{ id: 'good-1', sku: 'ABC-12', name: 'Gasket', brandName: 'BOSCH' }],
    },
    {
      rowIndex: 3,
      rawArticle: 'QQ-1',
      rawBrand: 'MANN',
      rawName: 'Filter',
      quantity: 1,
      price: 10,
      status: 'ambiguous',
      matchedGoodId: null,
      candidates: [{ id: 'good-2', sku: 'QQ-1', name: 'Filter A', brandName: 'MANN' }],
    },
    {
      rowIndex: 4,
      rawArticle: 'XY-9',
      rawBrand: 'SKF',
      rawName: 'Seal',
      quantity: 2,
      price: 50,
      status: 'notFound',
      matchedGoodId: null,
      candidates: [],
    },
  ],
};

// Збережений мапінг контрагента — щоб передперегляд підсвітив ролі колонок.
const savedMapping = {
  startRow: 2,
  codeCol: 1,
  articleCol: null,
  brandCol: 2,
  barcodeCol: null,
  nameCol: null,
  quantityCol: 3,
  priceCol: null,
};

vi.mock('@/hooks/api/useExcelImport', () => ({
  useRawPreview: () => ({
    isPending: false,
    mutate: (_file: File, opts?: { onSuccess?: (d: RawPreviewResponse) => void }) =>
      opts?.onSuccess?.(rawPreview),
  }),
  usePreviewImport: () => ({ isPending: false, mutateAsync: () => Promise.resolve(preview) }),
  useApplyImport: () => ({ isPending: false, mutateAsync: () => Promise.resolve({}) }),
  useCounterpartyImportMapping: () => ({ data: savedMapping }),
  useUpsertImportMapping: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function renderWizard() {
  return render(
    <ExcelImportWizard
      open
      onClose={vi.fn()}
      docType="PURCHASE_ORDER"
      docId="11111111-1111-4111-8111-111111111111"
      docNumber="PO-2026-000780"
      counterpartyId="22222222-2222-4222-8222-222222222222"
      counterpartyName="AutoParts LLC"
      existingLineCount={2}
      onImportComplete={vi.fn()}
    />,
  );
}

function selectFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'goods.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

describe('ExcelImportWizard — тексти за мовою інтерфейсу', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk — обидва кроки без змін', async () => {
    renderWizard();
    expect(screen.getByText('Завантаження товарів з файлу · PO-2026-000780')).toBeInTheDocument();
    expect(screen.getByText('Контрагент')).toBeInTheDocument();
    expect(screen.getByLabelText('Перший рядок даних')).toBeInTheDocument();
    expect(screen.getByLabelText('Колонка найменування')).toBeInTheDocument();
    selectFile();
    expect(screen.getByText('Передперегляд файлу')).toBeInTheDocument();
    expect(screen.getByText('показано 3 з 250 рядків')).toBeInTheDocument();
    expect(screen.getByTitle('Колонка B → Бренд')).toBeInTheDocument();
    expect(
      screen.getByText('Застосовано збережені колонки цього постачальника.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ідентифікувати товари' }));
    await waitFor(() =>
      expect(screen.getByText('Ідентифікація товарів · PO-2026-000780')).toBeInTheDocument(),
    );
    expect(screen.getByText('Знайдено: 1')).toBeInTheDocument();
    expect(screen.getByText('Уточнити: 1')).toBeInTheDocument();
    expect(screen.getByText('Не знайдено: 1')).toBeInTheDocument();
    expect(screen.getByText('Замінити наявні позиції (2)')).toBeInTheDocument();
    expect(screen.getByText('Наявні позиції (2) буде видалено')).toBeInTheDocument();
    expect(screen.getByText('Штрихкод: 4820000000017')).toBeInTheDocument();
    expect(screen.getByText('Не знайдено — оберіть, щоб створити')).toBeInTheDocument();
    expect(screen.getByLabelText('Включити рядок 4 в імпорт')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Вибрати всі' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Назад' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Заповнити товарами' })).toBeInTheDocument();
  });

  it('en — англійські тексти, жодного українського на обох кроках', async () => {
    await i18n.changeLanguage('en');
    renderWizard();
    expect(screen.getByText('Load goods from a file · PO-2026-000780')).toBeInTheDocument();
    expect(screen.getByLabelText('First data row')).toBeInTheDocument();
    selectFile();
    expect(screen.getByText('File preview')).toBeInTheDocument();
    expect(screen.getByText('showing 3 of 250 rows')).toBeInTheDocument();
    expect(screen.getByTitle('Column B → Brand')).toBeInTheDocument();
    expect(screen.getByRole('dialog').textContent).not.toMatch(CYRILLIC);

    fireEvent.click(screen.getByRole('button', { name: 'Identify goods' }));
    await waitFor(() =>
      expect(screen.getByText('Identify goods · PO-2026-000780')).toBeInTheDocument(),
    );
    expect(screen.getByText('Found: 1')).toBeInTheDocument();
    expect(screen.getByText('Replace existing lines (2)')).toBeInTheDocument();
    expect(screen.getByText('Not found — select to create')).toBeInTheDocument();
    expect(screen.getByLabelText('Include row 4 in the import')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill with goods' })).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).not.toMatch(CYRILLIC);
    for (const el of dialog.querySelectorAll('[title],[aria-label]')) {
      expect(`${el.getAttribute('title') ?? ''}${el.getAttribute('aria-label') ?? ''}`).not.toMatch(
        CYRILLIC,
      );
    }
  });
});
