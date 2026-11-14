// Кеш `cache:brands` (вибір бренду в картці товару) тримає лише АКТИВНІ бренди. У режимі
// «Показати видалені» список вкладки містить і видалені, тож load() кеш не пише — і до рев'ю
// блоку 4 після видалення чи відновлення в цьому режимі кеш лишався старим: відновлений бренд
// не з'являвся у виборі, видалений — не зникав (до закриття вкладки браузера).
//
// Мутація: прибрати окремий запит активного списку з `reload()` у `useDeletableRefList`
// (гілка `if (showDeleted)`) → обидва кейси падають.

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
const setCacheMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
}));
vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: (...a: unknown[]) => setCacheMock(...a),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));

import BrandsTab from '../BrandsTab';

const BOSCH = { id: 'b-bosch', name: 'Bosch', synonyms: [], deletedAt: null };
const MANN = { id: 'b-mann', name: 'Mann', synonyms: [], deletedAt: '2026-11-01T10:00:00.000Z' };

let active = [BOSCH];

beforeEach(() => {
  active = [BOSCH];
  setCacheMock.mockReset();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST' && url === '/brands/b-mann/restore') {
      active = [BOSCH, { ...MANN, deletedAt: null }];
      return Promise.resolve({ ...MANN, deletedAt: null });
    }
    if (init?.method === 'DELETE' && url === '/brands/b-bosch') {
      active = [];
      return Promise.resolve(undefined);
    }
    if (url === '/brands?limit=200&showDeleted=true')
      return Promise.resolve({ items: [...active, MANN], total: active.length + 1 });
    if (url === '/brands?limit=200')
      return Promise.resolve({ items: active, total: active.length });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});

async function openDeletedMode() {
  render(<BrandsTab />);
  await screen.findByText('Bosch');
  fireEvent.click(screen.getByTitle('Показати видалені'));
  await screen.findByText('Mann');
  setCacheMock.mockClear();
}

describe('BrandsTab — кеш брендів у режимі «Показати видалені»', () => {
  it('відновлення оновлює кеш активних брендів (відновлений бренд у ньому є)', async () => {
    await openDeletedMode();

    fireEvent.click(within(screen.getByText('Mann').closest('tr')!).getByTitle('Відновити'));

    await waitFor(() =>
      expect(setCacheMock).toHaveBeenCalledWith('cache:brands', [
        BOSCH,
        { ...MANN, deletedAt: null },
      ]),
    );
  });

  it('видалення оновлює кеш активних брендів (видаленого бренду в ньому немає)', async () => {
    await openDeletedMode();

    fireEvent.click(
      within(screen.getByText('Bosch').closest('tr')!).getByTitle('Помітити на видалення'),
    );
    fireEvent.click(await screen.findByRole('button', { name: /видалити|так|підтвердити/i }));

    await waitFor(() => expect(setCacheMock).toHaveBeenCalledWith('cache:brands', []));
  });
});
