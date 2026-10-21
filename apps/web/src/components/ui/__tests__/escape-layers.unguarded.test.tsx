/**
 * Стек шарів Escape (техборг §15.12) — місця, які прапорцями «вкладене відкрито» так і не прикрили
 * (детектор T1.3-075): тут Escape закривав разом із верхнім шаром і вікно під ним.
 *  - менеджер категорій: перейменування в рядку й підтвердження видалення;
 *  - меню «+ Статус» у картці товару.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { Modal } from '@/components/ui/modal';
import { CategoryManagerModal } from '../category-manager-modal';
import { GoodStatusManager } from '../GoodStatusManager';
import type { CategoryNode } from '@/components/ui/category-tree';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

const TREE = [
  { id: 'c1', name: 'TST Двигун', isActive: true, children: [] },
] as unknown as CategoryNode[];

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ items: [], total: 0 });
});

describe('CategoryManagerModal — Escape', () => {
  const renderManager = () => {
    const onClose = vi.fn();
    render(
      <CategoryManagerModal open onClose={onClose} type="good" tree={TREE} onChanged={vi.fn()} />,
    );
    return onClose;
  };

  it('у полі перейменування скасовує лише редагування, вікно лишається', async () => {
    const onClose = renderManager();
    await userEvent.click(screen.getByTitle('Перейменувати'));
    const input = screen.getByDisplayValue('TST Двигун');
    await userEvent.type(input, ' змінено');
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('TST Двигун змінено')).not.toBeInTheDocument();
    expect(screen.getByText('TST Двигун')).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith('/good-categories/c1', expect.anything());

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('у підтвердженні видалення закриває лише підтвердження, нічого не видаляє', async () => {
    const onClose = renderManager();
    await userEvent.click(screen.getByTitle('Видалити'));
    const confirm = await screen.findByRole('dialog', { name: 'Видалити "TST Двигун"?' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(confirm).toHaveAttribute('data-state', 'closed'));
    expect(onClose).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      '/good-categories/c1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('GoodStatusManager у картці — Escape', () => {
  it('закриває лише меню «+ Статус», картка лишається', async () => {
    apiFetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/good-statuses'
          ? { items: [{ id: 's1', name: 'TST Новинка', color: '#0a0' }], total: 1 }
          : { statuses: [] },
      ),
    );
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Картка товару">
        <GoodStatusManager goodId="g1" assigned={[]} canManage />
      </Modal>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Статус/ }));
    await screen.findByRole('button', { name: /TST Новинка/ });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /TST Новинка/ })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
