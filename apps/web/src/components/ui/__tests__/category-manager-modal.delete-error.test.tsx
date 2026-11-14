// Видалення категорії товарів, яку використовують правила ціни (BR-GOOD-010, блок 4 №14): сервер
// відмовляє 400 із назвами правил, і вікно категорій показує саме його текст — тостом, а коли тости
// вимкнено, банером у вікні. До 2026-11-14 без тостів відмова губилась без жодного сліду.
//
// Мутація: у `handleDelete` повернути `if (features.toastEnabled) toast.error(...)` замість
// `onError(e)` → кейс «тости вимкнено» падає; передати вузлам `onChanged` замість `handleChanged`
// → кейс «успішна дія знімає банер» падає.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
}));
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));
const features = { toastEnabled: false };
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => features }));

import { CategoryManagerModal } from '../category-manager-modal';

const REFUSAL =
  'Категорію не видалити: її використовують правила ціни — «Оливи +20%». Спершу змініть категорію в правилах';
const TREE = [
  {
    id: 'c-oils',
    name: 'Оливи',
    parentId: null,
    isActive: true,
    isSystem: false,
    children: [],
  },
];

async function deleteCategory() {
  render(
    <CategoryManagerModal
      open
      onClose={vi.fn()}
      type="good"
      tree={TREE as never}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByTitle('Видалити'));
  fireEvent.click(await screen.findByRole('button', { name: 'Так' }));
}

// guards: BR-GOOD-010
describe('CategoryManagerModal — відмова видалити категорію з правилами ціни', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockRejectedValue(new Error(REFUSAL));
    toastError.mockReset();
  });

  it('тости вимкнено — текст сервера банером у вікні', async () => {
    features.toastEnabled = false;
    await deleteCategory();

    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSAL);
    expect(apiFetchMock).toHaveBeenCalledWith('/good-categories/c-oils', { method: 'DELETE' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('тости увімкнено — той самий текст тостом, без банера', async () => {
    features.toastEnabled = true;
    await deleteCategory();

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(REFUSAL));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('успішна наступна дія знімає банер попередньої відмови', async () => {
    features.toastEnabled = false;
    await deleteCategory();
    await screen.findByRole('alert');

    // Правила вже змінили — повторне видалення проходить.
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTitle('Видалити'));
    fireEvent.click(await screen.findByRole('button', { name: 'Так' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
