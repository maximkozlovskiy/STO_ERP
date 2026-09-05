import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { Receipt } from 'lucide-react';
import { LinkedDocumentsPopup } from '../LinkedDocumentsPopup';
import type { LinkedEntityConfig } from '../LinkedDocumentsPanel';

// Panel робить apiFetch на mount / при зміні entityId — мокаємо.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const config: LinkedEntityConfig = {
  fetchPath: id => `/things/${id}/linked-documents`,
  sections: [
    {
      key: 'invoices',
      title: 'Рахунки',
      icon: Receipt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapRow: (row: any) => ({
        id: row.id,
        primary: `Рахунок ${row.number}`,
        preview: { title: `Рахунок ${row.number}`, rows: [] },
      }),
    },
  ],
};

describe('LinkedDocumentsPopup', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ invoices: [] });
  });

  // Панель фетчить асинхронно на mount → чекаємо поки empty-state зʼявиться,
  // щоб state-update стався в межах act і не було «not wrapped in act».
  const settle = () =>
    waitFor(() => expect(screen.getByText(/Пов'язаних документів немає/)).toBeInTheDocument());

  it('рендерить діалог + backdrop + close-X', async () => {
    render(<LinkedDocumentsPopup entityId={ID_A} config={config} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeInTheDocument();
    await settle();
  });

  it('Escape закриває попап', async () => {
    const onClose = vi.fn();
    render(<LinkedDocumentsPopup entityId={ID_A} config={config} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await settle();
  });

  // ── ДИСКРИМІНАТОР ref-патерну (bind-once b085cf8d) ──
  // Effect біндиться РАЗ на mount з `[]`. Якби handler кликав `onClose` напряму
  // (а не `onCloseRef.current()`), він би замкнув СТАРУ функцію: після ре-рендера
  // батька з новим onClose Escape викликав би СТАРИЙ колбек. Ref гарантує свіжий.
  it('Escape викликає НАЙСВІЖІШИЙ onClose після ре-рендера (не stale)', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <LinkedDocumentsPopup entityId={ID_A} config={config} onClose={first} />,
    );
    // Батько ре-рендериться, передає НОВУ інлайн-стрілку (нова identity).
    rerender(<LinkedDocumentsPopup entityId={ID_A} config={config} onClose={second} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(second).toHaveBeenCalledTimes(1); // свіжий
    expect(first).not.toHaveBeenCalled(); // старий НЕ спрацював
    await settle();
  });

  it('listener знімається на unmount (Escape після unmount нічого не викликає)', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <LinkedDocumentsPopup entityId={ID_A} config={config} onClose={onClose} />,
    );
    await settle();
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('клік по backdrop закриває; клік всередині діалогу — ні', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LinkedDocumentsPopup entityId={ID_A} config={config} onClose={onClose} />);
    await settle();

    // Клік по діалогу — stopPropagation, не закриває.
    await user.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    // Клік по backdrop (presentation-обгортка) — закриває.
    const backdrop = screen.getByRole('presentation');
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close-X викликає onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LinkedDocumentsPopup entityId={ID_A} config={config} onClose={onClose} />);
    await settle();
    await user.click(screen.getByRole('button', { name: 'Закрити' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('зміна entityId → панель робить новий fetch по новому шляху (lifecycle A→B)', async () => {
    const { rerender } = render(
      <LinkedDocumentsPopup entityId={ID_A} config={config} onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(`/things/${ID_A}/linked-documents`),
    );

    rerender(<LinkedDocumentsPopup entityId={ID_B} config={config} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(`/things/${ID_B}/linked-documents`),
    );
  });

  it('aria-label конфігурується через проп', async () => {
    render(
      <LinkedDocumentsPopup
        entityId={ID_A}
        config={config}
        onClose={vi.fn()}
        ariaLabel="Пов'язані з оплатою"
      />,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', "Пов'язані з оплатою");
    await settle();
  });
});
