// Regression-guard для GoodEditModal.
//
// Bug guarded (audit 2026-09-05, Bug #634 / WEB-H3, клас Bug #630):
//   Модалка НЕ мала синхронного savingRef — `<Button loading={saving} disabled={!form.name}>`
//   вимикається лише ПІСЛЯ re-render React між кліками. Два click-и в одному tick обидва
//   входили до save() → 2 POST /goods (дублікат товару). Тепер `if (savingRef.current) return`
//   першим рядком save() + ref фліпається синхронно у setSavingBoth.
//
// ⚠️ ТЕСТ-ІНТЕГРІТІ: native HTMLElement.click() ×2 СИНХРОННО (без await/act між ними),
// щоб обидва click-и потрапили в один tick ДО re-render React. userEvent.click (навіть void)
// І fireEvent.click обгортають кожен клік у власний act()/pointer-чергу → React встигає
// re-renderнути й виставити disabled={loading} між кліками → другий клік блокується БЕЗ
// ref-guard теж → хибно-зелений тест. Native .click()×2 відтворює реальну race, яку лікує
// саме синхронний savingRef. Дискримінацію доведено: revert guard → «expected 2 to be 1».

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { GoodEditModal } from '../GoodEditModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

vi.mock('@/hooks/useDirtyForm', () => ({
  useDirtyForm: () => ({
    isDirty: false,
    markDirty: vi.fn(),
    resetDirty: vi.fn(),
    confirmClose: () => Promise.resolve(true),
  }),
}));

// CounterpartyEditModal (вкладений supplier-detail) використовує useRouter.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

describe('GoodEditModal — double-submit guard (Bug #634 / WEB-H3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('подвійний синхронний клік «Зберегти та продовжити» шле POST /goods лише один раз', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/goods' && init?.method === 'POST') {
        return new Promise(resolve => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve({ items: [] });
    });

    render(
      <GoodEditModal
        open
        good={null}
        onClose={() => {}}
        onSaved={() => {}}
        brands={[]}
        units={[]}
        suppliers={[]}
        goodCatTree={[]}
      />,
    );

    // Ввести назву — кнопка disabled={!form.name}. fireEvent.change синхронний.
    const nameInput = screen.getByPlaceholderText('Масло моторне 5W-40');
    fireEvent.change(nameInput, { target: { value: 'Тестовий товар' } });

    const saveBtn = screen.getByRole('button', {
      name: 'Зберегти та продовжити',
    }) as HTMLButtonElement;

    // Два синхронних native-кліки в ОДНОМУ tick через HTMLElement.click() (НЕ fireEvent —
    // fireEvent обгортає кожен клік у act() і флашить setSaving(true) МІЖ кліками, роблячи
    // disabled={loading} гейтом і тест хибно-зеленим). Native .click() ×2 у одному
    // синхронному блоці: React batch-ить state → re-render лише ПІСЛЯ обох → саме
    // savingRef (синхронний) блокує другий вхід. Це відтворює реальну race.
    saveBtn.click();
    saveBtn.click();

    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        c => c[0] === '/goods' && (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });

    // Розрулити in-flight POST у act() — прибирає act()-warning від фінального setSaving(false).
    await act(async () => {
      resolveCreate({ id: 'g1', name: 'Тестовий товар', unit: 'шт', salePrice: 0 });
    });
  });
});
