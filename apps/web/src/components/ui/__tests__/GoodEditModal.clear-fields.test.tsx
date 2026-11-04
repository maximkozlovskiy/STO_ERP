// Очищення полів у картці товару (TECH-DEBT (а) 2026-11-01): очищене поле → PATCH 200 → у БД
// старе значення. Форма парситься `goodFormSchema` ('' → undefined), і JSON.stringify ключ
// викидав. Тепер тіло PATCH будує `patchBodyWithClears(payload, good, GOOD_CLEARABLE_FIELDS)`:
// поле, що мало значення і стало порожнім, — `null`; поле, якого в товарі не було, — відсутнє.
// Мутація: повернути `JSON.stringify(payload)` → кейс «артикул → null» червоніє.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { GoodEditModal, type GoodForModal } from '../GoodEditModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

const GOOD: GoodForModal = {
  id: 'g-1',
  sku: 'OIL-1',
  name: 'Масло',
  unit: 'шт',
  unitId: null,
  purchasePrice: null,
  salePrice: 100,
  category: null,
  barcode: '4820000000001',
  brandId: null,
  notes: 'Старі нотатки',
};

const patchBody = (): Record<string, unknown> => {
  const call = apiFetchMock.mock.calls.find(
    c => c[0] === '/goods/g-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
};

describe('GoodEditModal — очищення полів у PATCH', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) =>
      Promise.resolve(path === '/goods/g-1' && init?.method === 'PATCH' ? GOOD : { items: [] }),
    );
  });

  const renderCard = () =>
    render(
      <GoodEditModal
        open
        good={GOOD}
        onClose={() => {}}
        onSaved={() => {}}
        brands={[]}
        units={[]}
        goodCatTree={[]}
      />,
    );

  it('очищені артикул і нотатки → null; категорія, якої не було, і штрихкод — відсутні', async () => {
    renderCard();
    const sku = await screen.findByDisplayValue('OIL-1');
    fireEvent.change(sku, { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('Старі нотатки'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some(c => c[0] === '/goods/g-1')).toBe(true),
    );
    const body = patchBody();
    expect(body).toHaveProperty('sku', null);
    expect(body).toHaveProperty('notes', null);
    expect('category' in body).toBe(false);
    // barcode при редагуванні не шлеться (своя вкладка) — і не очищається.
    expect('barcode' in body).toBe(false);
  });

  it('нічого не очищали → жодного null у тілі, значення як були', async () => {
    renderCard();
    await screen.findByDisplayValue('OIL-1');
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some(c => c[0] === '/goods/g-1')).toBe(true),
    );
    const body = patchBody();
    expect(body).toMatchObject({ sku: 'OIL-1', notes: 'Старі нотатки' });
    expect(Object.values(body)).not.toContain(null);
  });
});
