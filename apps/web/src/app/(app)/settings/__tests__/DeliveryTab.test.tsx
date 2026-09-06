// DeliveryTab — панель служби доставки (Нова Пошта) + інтервал опитування (org-рівень).
//   1. монтує ProviderRegistryPanel (картка Нова Пошта) + поле інтервалу.
//   2. завантажує deliveryPollIntervalMinutes з /settings/organisation.
//   3. save інтервалу → PATCH /settings/organisation; валідація [5,1440].

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import DeliveryTab from '../DeliveryTab';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: () => undefined }));

const BRANCHES = [{ id: 'br-1', name: 'Філія 1' }];

function mock(interval = 30) {
  apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (typeof path !== 'string') return Promise.resolve({});
    if (path === '/branches') return Promise.resolve(BRANCHES);
    if (path === '/settings/organisation') {
      if (opts?.method === 'PATCH') return Promise.resolve({});
      return Promise.resolve({ deliveryPollIntervalMinutes: interval });
    }
    if (path.includes('/delivery-providers')) return Promise.resolve([]);
    return Promise.resolve({});
  });
}

function findCall(match: (p: string, o?: { method?: string }) => boolean) {
  return apiFetchMock.mock.calls.find(c => match(c[0] as string, c[1]));
}

describe('DeliveryTab', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('монтує панель служби доставки (Нова Пошта) + поле інтервалу', async () => {
    mock();
    render(<DeliveryTab />);
    expect(await screen.findByText('Служба доставки')).toBeInTheDocument();
    expect(screen.getByText('Нова Пошта')).toBeInTheDocument();
    expect(screen.getByLabelText('Інтервал (хв)')).toBeInTheDocument();
  });

  it('завантажує інтервал з /settings/organisation', async () => {
    mock(45);
    render(<DeliveryTab />);
    const input = (await screen.findByLabelText('Інтервал (хв)')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('45'));
  });

  it('save → PATCH /settings/organisation {deliveryPollIntervalMinutes}', async () => {
    mock(30);
    const user = userEvent.setup();
    render(<DeliveryTab />);
    const input = (await screen.findByLabelText('Інтервал (хв)')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('30'));
    await user.clear(input);
    await user.type(input, '60');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => {
      const patch = findCall((p, o) => p === '/settings/organisation' && o?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as { body: string }).body);
      expect(body.deliveryPollIntervalMinutes).toBe(60);
    });
  });

  it('валідація: інтервал < 5 → помилка, НЕ PATCH', async () => {
    mock(30);
    const user = userEvent.setup();
    render(<DeliveryTab />);
    const input = (await screen.findByLabelText('Інтервал (хв)')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('30'));
    await user.clear(input);
    await user.type(input, '2');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(screen.getByText(/від 5 до 1440/)).toBeInTheDocument());
    const patch = findCall((p, o) => p === '/settings/organisation' && o?.method === 'PATCH');
    expect(patch).toBeUndefined();
  });
});
