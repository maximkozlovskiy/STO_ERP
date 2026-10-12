// Синоніми бренду у формі (звернення власника 2026-10-12: «не зберігаються синоніми брендів при
// натисненні "Зберегти"»).
//
// Причина була у формі, не на сервері: слово, набране в полі, потрапляло в запит лише після «+»
// або Enter. Якщо одразу натиснути «Зберегти», воно мовчки відкидалось.
//
// Mutation-verify: повернути `synonyms: form.synonyms` у payload → кейси «набране слово йде в
// запит» падають; прибрати порівняння без урахування регістру у `withSynonym` → кейс про дубль
// падає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));

import BrandsTab, { withSynonym } from '../BrandsTab';

const BRAND = {
  id: 'b-1',
  orgId: 'org-1',
  name: 'ASAM',
  synonyms: ['abas'],
  deletedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** Тіло останнього запиту запису (PATCH / POST) до /brands. */
const lastWrite = () => {
  const call = [...apiFetchMock.mock.calls]
    .reverse()
    .find(c => (c[1] as { method?: string } | undefined)?.method);
  expect(call, 'запит запису має піти').toBeTruthy();
  const [url, init] = call as [string, { method: string; body: string }];
  return { url, method: init.method, body: JSON.parse(init.body) as { synonyms: string[] } };
};

async function openEdit() {
  render(<BrandsTab />);
  const row = (await screen.findByText('ASAM')).closest('tr')!;
  fireEvent.click(within(row).getAllByRole('button')[0]!);
  return screen.findByRole('dialog');
}

const synonymInput = (dialog: HTMLElement) =>
  within(dialog).getByPlaceholderText(/Введіть синонім/) as HTMLInputElement;
const save = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }));

describe('withSynonym', () => {
  it('додає обрізане слово; порожнє й самі пробіли — список без змін (той самий масив)', () => {
    const list = ['abas'];
    expect(withSynonym(list, '  BOSCH ')).toEqual(['abas', 'BOSCH']);
    expect(withSynonym(list, '')).toBe(list);
    expect(withSynonym(list, '   ')).toBe(list);
  });

  it('дубль без урахування регістру не додається', () => {
    const list = ['Bosch'];
    expect(withSynonym(list, 'BOSCH')).toBe(list);
    expect(withSynonym(list, ' bosch ')).toBe(list);
  });
});

describe('BrandsTab — синоніми при збереженні', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(init?.method ? BRAND : { items: [BRAND], total: 1 }),
    );
  });

  it('набране слово йде в запит і без «+»: «Зберегти» одразу після набору', async () => {
    const dialog = await openEdit();
    fireEvent.change(synonymInput(dialog), { target: { value: '  fff ' } });
    save(dialog);
    await waitFor(() => expect(lastWrite().method).toBe('PATCH'));
    expect(lastWrite().url).toBe('/brands/b-1');
    expect(lastWrite().body.synonyms).toEqual(['abas', 'fff']);
  });

  it('набране слово, що вже є серед синонімів (інший регістр), не дублюється', async () => {
    const dialog = await openEdit();
    fireEvent.change(synonymInput(dialog), { target: { value: 'ABAS' } });
    save(dialog);
    await waitFor(() => expect(lastWrite().body.synonyms).toEqual(['abas']));
  });

  it('додане через «+» і ще одне набране — у запиті обидва, у порядку введення', async () => {
    const dialog = await openEdit();
    fireEvent.change(synonymInput(dialog), { target: { value: 'перше' } });
    fireEvent.keyDown(synonymInput(dialog), { key: 'Enter' });
    expect(synonymInput(dialog)).toHaveValue('');
    fireEvent.change(synonymInput(dialog), { target: { value: 'друге' } });
    save(dialog);
    await waitFor(() => expect(lastWrite().body.synonyms).toEqual(['abas', 'перше', 'друге']));
  });

  it('порожнє поле: у запит ідуть лише наявні синоніми; прибраний чип не повертається', async () => {
    const dialog = await openEdit();
    fireEvent.click(within(dialog).getByRole('button', { name: /abas/ }));
    save(dialog);
    await waitFor(() => expect(lastWrite().body.synonyms).toEqual([]));
  });
});
