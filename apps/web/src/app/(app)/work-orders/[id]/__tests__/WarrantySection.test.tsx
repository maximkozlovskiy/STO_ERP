// WarrantySection — гарантії у картці наряду. Покриваємо: гейт за статусом, 3-стан бейджі,
// кнопка «Пред'явити» лише на активній, claim викликає хук з claimWoId=поточний наряд.
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WarrantySection } from '../WarrantySection';

const claimMutateAsync = vi.fn().mockResolvedValue({});
const refetch = vi.fn().mockResolvedValue({});
let warrantiesData: { items: unknown[] } | undefined = { items: [] };

vi.mock('@/hooks/api/useWarranties', () => ({
  useWarrantiesByWorkOrder: () => ({ data: warrantiesData, isLoading: false, refetch }),
  useClaimWarranty: () => ({ mutateAsync: claimMutateAsync }),
}));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// WarrantyCreateModal тягне багато залежностей — стабаємо (тестуємо секцію, не модалку).
vi.mock('@/components/ui/WarrantyCreateModal', () => ({
  WarrantyCreateModal: () => null,
}));

const WO = 'wo-1';
const CP = 'cp-1';
const active = {
  id: 'w-active',
  workOrderId: WO,
  counterpartyId: CP,
  expiresAt: '2027-01-01T00:00:00.000Z',
  description: 'Активна гарантія',
  claimedAt: null,
  isActive: true,
};
const claimed = {
  ...active,
  id: 'w-claimed',
  claimedAt: '2026-01-01T00:00:00.000Z',
  isActive: false,
};
const expired = { ...active, id: 'w-expired', claimedAt: null, isActive: false };

describe('WarrantySection', () => {
  beforeEach(() => {
    claimMutateAsync.mockClear();
    refetch.mockClear();
    warrantiesData = { items: [] };
  });

  it('гейт: DRAFT-наряд → секція не рендериться', () => {
    const { container } = render(
      <WarrantySection workOrderId={WO} counterpartyId={CP} workOrderStatus="DRAFT" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('COMPLETED + порожньо → показує empty-state', () => {
    render(<WarrantySection workOrderId={WO} counterpartyId={CP} workOrderStatus="COMPLETED" />);
    expect(screen.getByText('Гарантій за нарядом немає')).toBeInTheDocument();
  });

  it('3 стани → правильні бейджі; «Пред’явити» лише на активній', () => {
    warrantiesData = { items: [active, claimed, expired] };
    render(<WarrantySection workOrderId={WO} counterpartyId={CP} workOrderStatus="COMPLETED" />);
    expect(screen.getByText('Активна')).toBeInTheDocument();
    expect(screen.getByText("Пред'явлена")).toBeInTheDocument();
    expect(screen.getByText('Закінчилась')).toBeInTheDocument();
    // Рівно ОДНА кнопка «Пред'явити» — на активній гарантії.
    expect(screen.getAllByText('Пред’явити')).toHaveLength(1);
    // MUTATION-VERIFY: якщо прибрати `w.isActive &&` гейт кнопки — буде 3 кнопки → assert впаде.
  });

  it('«Пред’явити» → claim з claimWoId=поточний наряд', async () => {
    warrantiesData = { items: [active] };
    render(<WarrantySection workOrderId={WO} counterpartyId={CP} workOrderStatus="COMPLETED" />);
    await act(async () => {
      fireEvent.click(screen.getByText('Пред’явити'));
    });
    await waitFor(() =>
      expect(claimMutateAsync).toHaveBeenCalledWith({ id: 'w-active', claimWoId: WO }),
    );
  });
});
