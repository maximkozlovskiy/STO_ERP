// Підтвердження над карткою-вікном: Escape закриває лише підтвердження (воно верхній шар Escape),
// картка лишається. Раніше це тримав прапорець `useConfirm().openRef`, знятий таймером, і гонка
// «відповіли на A й одразу відкрили B» (code-review 2026-10-21) знімала прапорець B.

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '../useConfirm';

let api: ReturnType<typeof useConfirm>;

function Card({ onClose }: { onClose: () => void }) {
  api = useConfirm();
  return (
    <Modal open onClose={onClose} title="Картка">
      Вміст
      <ConfirmDialog {...api.dialogProps} />
    </Modal>
  );
}

describe('useConfirm — підтвердження над карткою', () => {
  it('Escape у підтвердженні: відповідь «ні», картка лишається', async () => {
    const onClose = vi.fn();
    render(<Card onClose={onClose} />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = api.confirm({ title: 'Видалити?' });
    });
    expect(screen.getByRole('dialog', { name: 'Видалити?' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect(answer).resolves.toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('відповіли на A й одразу відкрили B: Escape над B закриває лише B', async () => {
    const onClose = vi.fn();
    render(<Card onClose={onClose} />);
    let first!: Promise<boolean>;
    act(() => {
      first = api.confirm({ title: 'A' });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Так' }));
    let second!: Promise<boolean>;
    await act(async () => {
      await first;
      second = api.confirm({ title: 'B' });
    });
    await userEvent.keyboard('{Escape}');
    await expect(second).resolves.toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('choose(): Escape — null (жодна з двох дій), картка лишається', async () => {
    const onClose = vi.fn();
    render(<Card onClose={onClose} />);
    let answer!: Promise<boolean | null>;
    act(() => {
      answer = api.choose({ title: 'Створити рахунок?', cancelLabel: 'Тільки статус' });
    });
    await userEvent.keyboard('{Escape}');
    await expect(answer).resolves.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
