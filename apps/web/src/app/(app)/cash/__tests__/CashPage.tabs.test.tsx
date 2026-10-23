// Regression-guard для рядка вкладок сторінки /cash.
//
// Рішення власника 2026-10-23: «Операції» | роздільник | довідники до них («Каси», «Статті руху
// коштів») — як на «Каталозі» й «Банківських платежах». Приймальня бачить лише «Операції» — без
// роздільника, бо довідників за ним немає.

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let role = 'ADMIN';
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
  useAuth: () => ({ employee: { role } }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// Дочірні вкладки — стуби (dynamic(() => import('./X')) резолвить ці модулі).
vi.mock('../CashOperationsTab', () => ({ default: () => <div>OPERATIONS</div> }));
vi.mock('../CashRegistersTab', () => ({ default: () => <div>REGISTERS</div> }));
vi.mock('../ExpenseCategoriesTab', () => ({ default: () => <div>EXPENSES</div> }));

import CashPage from '../page';

describe('CashPage — рядок вкладок', () => {
  beforeEach(() => {
    role = 'ADMIN';
  });

  it('роздільник одразу перед «Каси»: «Операції» | «Каси», «Статті руху коштів»', async () => {
    render(<CashPage />);
    const operations = await screen.findByRole('button', { name: 'Операції' });
    const registers = screen.getByRole('button', { name: 'Каси' });
    expect(registers.previousElementSibling).toBe(screen.getByTestId('tabs-divider'));
    expect(screen.getByTestId('tabs-divider').previousElementSibling).toBe(operations);
    expect(registers.nextElementSibling).toBe(
      screen.getByRole('button', { name: 'Статті руху коштів' }),
    );
  });

  it('приймальня бачить лише «Операції» — без роздільника', async () => {
    role = 'RECEPTIONIST';
    render(<CashPage />);
    await screen.findByRole('button', { name: 'Операції' });
    expect(screen.queryByRole('button', { name: 'Каси' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('tabs-divider')).not.toBeInTheDocument();
  });
});
