/**
 * Bug #930: «Редагування товару» → «Основний постачальник» → «Відкрити картку» → Escape у картці
 * постачальника. Обидва <Modal> слухають Escape на document: картка товару має пропустити цей Escape,
 * закривається лише картка постачальника.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { Modal } from '@/components/ui/modal';
import { GoodEditModal, type GoodForModal } from '../GoodEditModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
// Картка постачальника тут — лише шар зі своїм Escape.
vi.mock('@/components/ui/CounterpartyEditModal', () => ({
  CounterpartyEditModal: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <Modal open={open} onClose={onClose} title="Редагування контрагента">
      <p>картка постачальника</p>
    </Modal>
  ),
}));

const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const GOOD = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'TST Фільтр',
  preferredSupplierId: SUPPLIER,
  preferredSupplierName: 'TST Постачальник',
} as GoodForModal;

describe('GoodEditModal — Escape у картці постачальника (Bug #930)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === `/counterparties/${SUPPLIER}`) {
        return Promise.resolve({ id: SUPPLIER, type: 'SUPPLIER', companyName: 'TST Постачальник' });
      }
      return Promise.resolve({ items: [] });
    });
  });

  it('закриває лише картку постачальника, картка товару лишається', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <GoodEditModal
        open
        good={GOOD}
        onClose={onClose}
        onSaved={vi.fn()}
        brands={[]}
        units={[]}
        suppliers={[]}
        goodCatTree={[]}
      />,
    );
    const detail = (await screen.findAllByRole('button', { name: 'Відкрити картку' })).find(
      b => !(b as HTMLButtonElement).disabled,
    );
    await user.click(detail!);
    await screen.findByRole('dialog', { name: 'Редагування контрагента' });

    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Редагування контрагента' })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
