// LoyaltyTab — налаштування лояльності. Покриваємо: рендер зі значень GET, умовний рендер числових
// полів за toggle, PATCH лише 4 loyalty-полів.
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import LoyaltyTab from '../LoyaltyTab';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BASE = {
  loyaltyEnabled: true,
  loyaltyEarnPer: 100,
  loyaltyEarnPoints: 1,
  loyaltyRedeemRate: 1,
};

describe('LoyaltyTab', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(BASE); // GET
  });

  it('enabled=true → показує числові поля earnPer/earnPoints/redeemRate', async () => {
    await act(async () => {
      render(<LoyaltyTab />);
    });
    await waitFor(() => expect(screen.getByText('Нараховувати бали')).toBeInTheDocument());
    expect(screen.getByText('За кожні (грн оплати)')).toBeInTheDocument();
    expect(screen.getByText('Нараховувати (балів)')).toBeInTheDocument();
    expect(screen.getByText('Курс списання (грн за 1 бал)')).toBeInTheDocument();
  });

  it('enabled=false → числові поля приховані (умовний рендер)', async () => {
    apiFetchMock.mockResolvedValue({ ...BASE, loyaltyEnabled: false });
    await act(async () => {
      render(<LoyaltyTab />);
    });
    await waitFor(() => expect(screen.getByText('Нараховувати бали')).toBeInTheDocument());
    expect(screen.queryByText('За кожні (грн оплати)')).not.toBeInTheDocument();
  });

  it('Зберегти → PATCH лише 4 loyalty-полів', async () => {
    apiFetchMock.mockResolvedValueOnce(BASE).mockResolvedValueOnce(BASE); // GET, PATCH
    await act(async () => {
      render(<LoyaltyTab />);
    });
    await waitFor(() => expect(screen.getByText('Зберегти')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Зберегти'));
    });
    const patchCall = apiFetchMock.mock.calls.find(c => c[1]?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall![0]).toBe('/settings/organisation');
    const body = JSON.parse(patchCall![1].body);
    // Патчить РІВНО 4 loyalty-поля (не весь OrgSettings).
    expect(Object.keys(body).sort()).toEqual([
      'loyaltyEarnPer',
      'loyaltyEarnPoints',
      'loyaltyEnabled',
      'loyaltyRedeemRate',
    ]);
  });
});
