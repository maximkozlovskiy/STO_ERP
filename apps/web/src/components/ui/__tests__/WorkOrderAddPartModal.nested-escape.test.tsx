/**
 * Bug #927: «Додати запчастину» → обраний товар → «Відкрити картку» → Escape у картці товару.
 * Картка товару — окремий <Modal> поверх вікна запчастини, обидва слухають Escape на document.
 * Escape має закрити лише картку товару: вікно запчастини не питає «Є незбережені зміни» і не
 * закривається, обраний товар лишається.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { Modal } from '@/components/ui/modal';
import { WorkOrderAddPartModal } from '../WorkOrderAddPartModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({
    toastEnabled: false,
    unsavedGuardEnabled: true,
    stockIndicatorEnabled: false,
    keyboardShortcutsEnabled: false,
  }),
}));

// Картка товару тут — лише шар зі своїм Escape; її вміст не предмет тесту.
vi.mock('@/components/ui/GoodEditModal', () => ({
  GoodEditModal: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <Modal open={open} onClose={onClose} title="Редагування товару">
      <p>картка товару</p>
    </Modal>
  ),
}));

const GOOD = { id: 'g1', name: 'TST Масло', sku: 'OIL-1', salePrice: 100 };

async function pressEscape(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('WorkOrderAddPartModal — Escape у картці товару (Bug #927)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/goods?q=')) return Promise.resolve({ items: [GOOD] });
      if (path === `/goods/${GOOD.id}/uoms`) return Promise.resolve([]);
      if (path === `/goods/${GOOD.id}`) return Promise.resolve(GOOD);
      return Promise.resolve({ items: [] });
    });
  });

  it('Escape закриває лише картку товару; вікно запчастини без «Є незбережені зміни»', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkOrderAddPartModal
        open
        workOrderId="wo1"
        warehouses={[{ id: 'w1', name: 'Склад', isMain: true }]}
        onClose={onClose}
        onAdded={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText('Назва, артикул, штрих-код...'), 'TST');
    await user.click(await screen.findByRole('option', { name: /TST Масло/ }));
    await user.click(await screen.findByRole('button', { name: 'Відкрити картку' }));
    await screen.findByRole('dialog', { name: 'Редагування товару' });

    await pressEscape(user);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Редагування товару' })).toBeNull(),
    );
    expect(screen.queryByRole('dialog', { name: 'Є незбережені зміни' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Додати запчастину' }).textContent).toContain(
      'TST Масло',
    );

    // Другий Escape — уже вікну запчастини: товар обрано, тож воно питає про незбережене.
    await pressEscape(user);
    expect(await screen.findByRole('dialog', { name: 'Є незбережені зміни' })).toBeTruthy();
  });
});
