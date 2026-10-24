// Bug #966 (регресія security Stage 2): /auth/refresh тепер throttled (30/хв, @SkipThrottle
// прибрано — рішення власника 2026-10-24). AuthProvider на mount робить фоновий refresh, щоб
// підтвердити сесію. Якщо той refresh ловить 429 (кількапотоковий прогін вичерпав ліміт з
// одного IP), а в сесії вже є валідний токен + кешований employee — це НЕ мертва сесія, і
// користувача (щойно залогіненого) НЕ можна кидати на /login. Чотири рольові E2E падали саме
// так: loginAs входив формою, навігація перемонтовувала AuthProvider, refresh-on-mount давав
// 429 → LOGOUT → bounce на /login.
//
// Мутаційна перевірка: приберіть у context.tsx гілку `if (res.status === 429) { … return
// stillValid; }` — тоді 429 падає в `if (!res.ok) return false`, mount-handler робить
// dispatch(LOGOUT), employee стає null, і перша асерція («employee лишився») валиться.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth, TOKEN_KEY } from './context';

const fetchMock = vi.fn();

function Probe() {
  const { employee, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="employee">{employee ? employee.firstName : 'NONE'}</span>
      <span data-testid="loading">{isLoading ? 'LOADING' : 'READY'}</span>
    </div>
  );
}

describe('AuthProvider — refresh-on-mount 429 не вивалює живу сесію (Bug #966)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem(TOKEN_KEY, 'valid-access-token');
    localStorage.setItem(
      'sto_employee_cache',
      JSON.stringify({
        id: 'e1',
        orgId: 'o1',
        firstName: 'Адмін',
        lastName: 'СТО',
        role: 'OWNER',
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('refresh повертає 429 → employee лишається, токен не стертий', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ message: 'ThrottlerException: Too Many Requests' }),
    } as unknown as Response);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // Фоновий refresh мусить відстрілятись (один POST /auth/refresh).
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/auth/refresh'))).toBe(true);
    });

    // Сесія жива попри 429: employee лишився (оптимістичний init), токен на місці.
    await waitFor(() => {
      expect(screen.getByTestId('employee').textContent).toBe('Адмін');
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('valid-access-token');
  });

  it('refresh повертає 401 → сесія справді мертва, LOGOUT (контроль)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ message: 'Unauthorized' }),
    } as unknown as Response);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // 401 — це справжня недійсна сесія: employee скидається, токен стирається.
    await waitFor(() => {
      expect(screen.getByTestId('employee').textContent).toBe('NONE');
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
