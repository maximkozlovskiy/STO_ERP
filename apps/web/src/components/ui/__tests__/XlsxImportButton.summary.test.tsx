// Підсумок імпорту з XLSX показує правдиві лічильники: довідникові імпорти (товари, бренди,
// одиниці) повертають «пропущено» для рядків, що вже є в каталозі. Раніше такі рядки приходили як
// «оновлено», а кнопка завжди писала «створено N, оновлено M».

import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiMultipartFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  apiMultipartFetch: (...args: unknown[]) => apiMultipartFetchMock(...args),
}));

import { XlsxImportButton } from '../xlsx-import-button';

function upload() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'goods.xlsx');
  fireEvent.change(input, { target: { files: [file] } });
}

describe('XlsxImportButton — підсумок імпорту', () => {
  beforeEach(() => apiMultipartFetchMock.mockReset());

  it('кнопки мають назви «Шаблон XLSX» і «Імпорт XLSX»', () => {
    render(<XlsxImportButton templateType="goods" importUrl="/xlsx/import/goods" />);
    expect(screen.getByRole('button', { name: /Шаблон XLSX/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Імпорт XLSX/ })).toBeTruthy();
  });

  it('пропущені показано окремо, нульове «оновлено» не показано', async () => {
    apiMultipartFetchMock.mockResolvedValue({
      created: 2,
      updated: 0,
      skipped: 3,
      errors: ['Без ціни: немає ціни продажу — рядок не імпортовано'],
    });
    render(<XlsxImportButton templateType="goods" importUrl="/xlsx/import/goods" />);
    upload();
    const summary = await screen.findByTestId('xlsx-import-summary');
    expect(summary.textContent).toBe('Імпорт: створено 2, пропущено (вже є) 3');
    expect(screen.getByText('Помилки: 1')).toBeTruthy();
  });

  it('документні імпорти без «пропущено» — «оновлено» показано, коли воно є', async () => {
    apiMultipartFetchMock.mockResolvedValue({ created: 1, updated: 4, errors: [] });
    render(<XlsxImportButton templateType="works" importUrl="/xlsx/import/works" />);
    upload();
    const summary = await screen.findByTestId('xlsx-import-summary');
    expect(summary.textContent).toBe('Імпорт: створено 1, оновлено 4');
  });
});
