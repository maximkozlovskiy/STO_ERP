import { renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { useLiftMechanics } from '../useLiftMechanics';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

describe('useLiftMechanics — механіки підйомника для BR-WO-030', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-WO-030
  it('без підйомника — null і жодного запиту', async () => {
    const { result } = renderHook(() => useLiftMechanics(''), { wrapper: createQueryWrapper() });
    await new Promise(r => setTimeout(r, 10));
    expect(result.current).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  // guards: BR-WO-030
  it('механіки підйомника — лише id, статус і категорії (без телефону й e-mail)', async () => {
    apiFetchMock.mockResolvedValue({
      items: [
        {
          id: 'm-1',
          firstName: 'Іван',
          lastName: 'Петров',
          phone: '+380501112233',
          email: 'i@x.ua',
          status: 'ACTIVE',
          workCategoryIds: ['c-1'],
        },
        { id: 'm-2', firstName: 'Олег', lastName: 'Сидоренко' },
      ],
    });
    const { result } = renderHook(() => useLiftMechanics('lift 1'), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/employees?liftId=lift%201&role=MECHANIC&limit=200',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result.current).toEqual([
      { id: 'm-1', status: 'ACTIVE', workCategoryIds: ['c-1'] },
      { id: 'm-2' },
    ]);
  });

  it('збій запиту — null (правило не бачить «єдиного механіка»)', async () => {
    apiFetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLiftMechanics('lift-1'), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 10));
    expect(result.current).toBeNull();
  });
});
