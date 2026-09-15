import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExcelImportWizard } from '../ExcelImportWizard';
import type { RawPreviewResponse } from '@/hooks/api/useExcelImport';

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
  usePreviewImport: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useApplyImport: () => ({ isPending: false, mutateAsync: vi.fn() }),
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
