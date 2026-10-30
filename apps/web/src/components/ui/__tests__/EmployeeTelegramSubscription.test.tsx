// Підписка працівника на Telegram-бот (docs/objects/automation.md, BR-AUT-041, 022): своя — у
// профілі будь-якої ролі; чужа — у картці працівника, яку зі «Співробітників» відкриває й
// RECEPTIONIST. Посилання й відписку чужої підписки сервер дозволяє лише OWNER / ADMIN
// (`telegram-bot.controller`), тож іншим ролям блок показує лише статус — без кнопок, що дали б 403.

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let role = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'me', role } }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { EmployeeTelegramSubscription } from '../TelegramSubscriptionBlock';

const EMP = '55555555-5555-4555-8555-000000000001';
const SUB = { active: true, subscribedAt: '2026-10-28T09:00:00.000Z' };

beforeEach(() => {
  role = 'RECEPTIONIST';
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === `/employees/${EMP}`)
      return Promise.resolve({ id: EMP, telegramSubscription: SUB });
    if (path === '/employees/me/telegram-subscription') return Promise.resolve(SUB);
    return Promise.resolve({});
  });
});

function renderBlock(employeeId: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmployeeTelegramSubscription employeeId={employeeId} canManage />
    </QueryClientProvider>,
  );
}

describe('EmployeeTelegramSubscription — хто керує підпискою', () => {
  // guards: BR-AUT-041
  it('чужа підписка, RECEPTIONIST: статус видно, кнопок посилання й відписки немає', async () => {
    renderBlock(EMP);

    expect(await screen.findByTestId('telegram-status')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  // guards: BR-AUT-041
  it('чужа підписка, ADMIN: є «Отримати посилання» і «Відписати»', async () => {
    role = 'ADMIN';
    renderBlock(EMP);

    await screen.findByTestId('telegram-status');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2));
  });

  // guards: BR-AUT-022
  it('своя підписка (профіль), MECHANIC: кнопки є — `/employees/me/*` дозволено всім працівникам', async () => {
    role = 'MECHANIC';
    renderBlock(null);

    await screen.findByTestId('telegram-status');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2));
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/employees/me/telegram-subscription',
      expect.anything(),
    );
  });
});
