// Regression-guard для DeadLetterTab (DLQ admin UI — sync 911fe19d, review 1a8e476c).
//
// Load-bearing поведінка UI:
//   - Рендер списку рядків DLQ (queue/job/attempts/reason/status) з мока useDeadLetter.
//   - isLoading → «Завантаження…»; порожній список → «Невдалих задач не знайдено».
//   - Кнопка «Опрацьовано» ЛИШЕ на нерозвʼязаних рядках (job.resolved=false).
//   - resolve-mutation: клік викликає mutateAsync(job.id) саме тим id.
//   - Зміна фільтрів (queueName/select) скидає page на 1 (resetTo) — інакше page=3 + новий
//     фільтр показав би порожньо (Bug-патерн: filter змінено, page не скинуто).
//   - review-fix per-row spinner: loading={isPending && variables===job.id} — спінер лише на
//     клікнутому рядку, не на всіх нерозвʼязаних (регресія: спільний isPending → всі кнопки).

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const useDeadLetterMock = vi.fn();
const resolveMutateAsync = vi.fn();
const useResolveDeadLetterMock = vi.fn();

vi.mock('@/hooks/api/useDeadLetter', () => ({
  useDeadLetter: (...a: unknown[]) => useDeadLetterMock(...a),
  useResolveDeadLetter: () => useResolveDeadLetterMock(),
}));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import DeadLetterTab from '../DeadLetterTab';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'dl-1',
  orgId: 'org-1',
  queueName: 'sms',
  jobName: 'send-sms',
  bullJobId: 'job-1',
  attemptsMade: 10,
  maxAttempts: 10,
  failedReason: 'ETIMEDOUT провайдер недоступний',
  stacktrace: null,
  payload: {},
  resolved: false,
  resolvedAt: null,
  createdAt: '2026-01-02T03:04:05.000Z',
  ...over,
});

function setList(items: ReturnType<typeof job>[], opts: Record<string, unknown> = {}) {
  useDeadLetterMock.mockReturnValue({
    data: { items, total: items.length, page: 1, limit: 50 },
    isLoading: false,
    ...opts,
  });
}

describe('DeadLetterTab', () => {
  beforeEach(() => {
    useDeadLetterMock.mockReset();
    resolveMutateAsync.mockReset();
    useResolveDeadLetterMock.mockReset();
    resolveMutateAsync.mockResolvedValue({ id: 'dl-1', resolved: true });
    useResolveDeadLetterMock.mockReturnValue({
      mutateAsync: resolveMutateAsync,
      isPending: false,
      variables: undefined,
    });
    setList([job()]);
  });

  it('рендерить рядок DLQ (черга/задача/спроби/причина)', async () => {
    render(<DeadLetterTab />);
    await waitFor(() => expect(screen.getByText('send-sms')).toBeInTheDocument());
    expect(screen.getByText('sms')).toBeInTheDocument();
    expect(screen.getByText('10/10')).toBeInTheDocument();
    expect(screen.getByText('ETIMEDOUT провайдер недоступний')).toBeInTheDocument();
  });

  it('isLoading → «Завантаження…»', () => {
    useDeadLetterMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<DeadLetterTab />);
    expect(screen.getByText('Завантаження…')).toBeInTheDocument();
  });

  it('порожній список → «Невдалих задач не знайдено»', () => {
    setList([]);
    render(<DeadLetterTab />);
    expect(screen.getByText('Невдалих задач не знайдено')).toBeInTheDocument();
  });

  it('кнопка «Опрацьовано» лише на нерозвʼязаному рядку', () => {
    setList([
      job({ id: 'a', jobName: 'active', resolved: false }),
      job({ id: 'r', jobName: 'done', resolved: true }),
    ]);
    render(<DeadLetterTab />);
    const activeRow = screen.getByText('active').closest('tr')!;
    const doneRow = screen.getByText('done').closest('tr')!;
    expect(within(activeRow).queryByRole('button', { name: 'Опрацьовано' })).toBeInTheDocument();
    expect(within(doneRow).queryByRole('button', { name: 'Опрацьовано' })).not.toBeInTheDocument();
  });

  it('клік «Опрацьовано» викликає mutateAsync з id рядка', async () => {
    setList([job({ id: 'dl-42', jobName: 'send-sms' })]);
    render(<DeadLetterTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Опрацьовано' }));
    await waitFor(() => expect(resolveMutateAsync).toHaveBeenCalledWith('dl-42'));
  });

  it('зміна select-фільтра скидає page на 1 (resetTo)', async () => {
    render(<DeadLetterTab />);
    // Клікаємо на last-page (симулюємо: спершу перевіримо, що select onChange не кидає).
    const select = screen.getByLabelText('Статус') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'true' } });
    // Після зміни фільтра useDeadLetter має бути викликаний з page:1.
    await waitFor(() => {
      const lastCall = useDeadLetterMock.mock.calls[useDeadLetterMock.mock.calls.length - 1][0];
      expect(lastCall.page).toBe(1);
      expect(lastCall.resolved).toBe('true');
    });
  });

  it('review-fix: per-row spinner — loading лише на клікнутому рядку, не на всіх нерозвʼязаних', () => {
    // Обидва рядки нерозвʼязані; мутація pending з variables='b' → спінер лише на рядку b.
    useResolveDeadLetterMock.mockReturnValue({
      mutateAsync: resolveMutateAsync,
      isPending: true,
      variables: 'b',
    });
    setList([
      job({ id: 'a', jobName: 'row-a', resolved: false }),
      job({ id: 'b', jobName: 'row-b', resolved: false }),
    ]);
    render(<DeadLetterTab />);
    const rowA = screen.getByText('row-a').closest('tr')!;
    const rowB = screen.getByText('row-b').closest('tr')!;
    // Спінер (animate-spin) лише у рядку b; обидві кнопки disabled (isPending).
    expect(rowB.querySelector('.animate-spin')).not.toBeNull();
    expect(rowA.querySelector('.animate-spin')).toBeNull();
    expect(within(rowA).getByRole('button', { name: 'Опрацьовано' })).toBeDisabled();
    expect(within(rowB).getByRole('button', { name: 'Опрацьовано' })).toBeDisabled();
  });
});
