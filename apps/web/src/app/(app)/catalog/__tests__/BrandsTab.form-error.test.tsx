// Форма бренду: текст помилки сервера зникає, щойно поле виправляють (TECH-DEBT §8, review
// BR-GOOD-007 2026-10-12). До цього банер 409 «синонім уже зайнятий» висів над виправленим
// полем до наступного «Зберегти».
//
// Мутація: прибрати `setError('')` з обробника, названого в кейсі (onChange назви, onChange
// синоніма, addSynonym, removeSynonym), → падає рівно цей кейс.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));

import BrandsTab from '../BrandsTab';

const BRAND = {
  id: 'b-1',
  orgId: 'org-1',
  name: 'ASAM',
  synonyms: ['abas'],
  deletedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const CONFLICT = 'Синонім «abas» уже належить бренду «ABS»';

async function openEditWithConflict() {
  render(<BrandsTab />);
  const row = (await screen.findByText('ASAM')).closest('tr')!;
  fireEvent.click(within(row).getAllByRole('button')[0]!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }));
  await within(dialog).findByText(CONFLICT);
  return dialog;
}

const synonymInput = (dialog: HTMLElement) =>
  within(dialog).getByPlaceholderText(/Введіть синонім/) as HTMLInputElement;

describe('BrandsTab — помилка форми зникає після правки поля', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method
        ? Promise.reject(new Error(CONFLICT))
        : Promise.resolve({ items: [BRAND], total: 1 }),
    );
  });

  it.each<[string, (dialog: HTMLElement) => void]>([
    [
      'назва',
      d => fireEvent.change(within(d).getByDisplayValue('ASAM'), { target: { value: 'ASAM2' } }),
    ],
    ['набір синоніма', d => fireEvent.change(synonymInput(d), { target: { value: 'x' } })],
    // Enter у полі синоніма — той самий addSynonym, що й кнопка «+».
    ['додавання синоніма', d => fireEvent.keyDown(synonymInput(d), { key: 'Enter' })],
    ['видалення синоніма', d => fireEvent.click(within(d).getByRole('button', { name: /abas/ }))],
  ])('правка «%s» прибирає банер 409', async (_name, edit) => {
    const dialog = await openEditWithConflict();

    edit(dialog);

    expect(within(dialog).queryByText(CONFLICT)).not.toBeInTheDocument();
  });
});
