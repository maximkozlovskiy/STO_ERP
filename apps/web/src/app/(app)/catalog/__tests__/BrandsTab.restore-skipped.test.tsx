// Відновлення бренду (BR-GOOD-007, блок 4 №10): синоніми, зняті разом із брендом, повертаються,
// а зайняті іншим брендом сервер перелічує у `skippedSynonyms` — сторінка показує їх банером
// (не лише тостом, що зникає за кілька секунд).
//
// Мутація: прибрати `onRestored: noteSkipped` з виклику відновлення → кейс «перелік пропущених» падає;
// не скидати банер, коли пропущених немає (`: ''`), → кейс «повторне відновлення» падає.

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));

import BrandsTab from '../BrandsTab';

const DELETED = {
  id: 'b-mann',
  orgId: 'org-1',
  name: 'Mann',
  synonyms: [],
  deletedAt: '2026-11-01T10:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

function serve(restoreResponses: Array<Record<string, unknown>>) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST' && url.endsWith('/restore'))
      return Promise.resolve(restoreResponses.shift());
    return Promise.resolve({ items: [DELETED], total: 1 });
  });
}

async function clickRestore() {
  const row = (await screen.findByText('Mann')).closest('tr')!;
  fireEvent.click(within(row).getByTitle('Відновити'));
}

// guards: BR-GOOD-007
describe('BrandsTab — відновлення бренду з синонімами', () => {
  beforeEach(() => serve([]));

  it('зайняті синоніми — банер із назвою бренду і переліком пропущених', async () => {
    serve([{ ...DELETED, deletedAt: null, synonyms: ['Ман'], skippedSynonyms: ['MF', 'MANN'] }]);
    render(<BrandsTab />);

    await clickRestore();

    expect(
      await screen.findByText(
        'Бренд «Mann» відновлено без синонімів, які вже має інший бренд: MF, MANN',
      ),
    ).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/brands/b-mann/restore', { method: 'POST' });
  });

  it('усі синоніми повернулись — банера немає; повторне відновлення прибирає старий банер', async () => {
    serve([
      { ...DELETED, deletedAt: null, skippedSynonyms: ['MF'] },
      { ...DELETED, deletedAt: null, skippedSynonyms: [] },
    ]);
    render(<BrandsTab />);

    await clickRestore();
    await screen.findByRole('status');
    await clickRestore();

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
