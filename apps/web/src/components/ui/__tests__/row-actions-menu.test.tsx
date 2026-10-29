// Меню «⋯» рядка (UX-огляд 2026-10-29, частина 4): сторно й зняття рознесення в банку й касі
// перейшли з кнопки в кожному рядку сюди. Вимоги: дія виконується й меню закривається; клік у меню
// (воно в порталі) не спливає до рядка таблиці; Escape знімає лише меню, а вікно під ним лишається;
// без дій — ні кнопки, ні меню.
//
// Mutation-verify (2026-10-29): прибрати `stopPropagation` на меню → падає «не спливає до рядка»;
// прибрати useEscapeLayer → падає «Escape»; не закривати перед onSelect → падає «дія закриває меню».
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '@/components/ui/modal';
import { RowActionsMenu } from '../row-actions-menu';

const renderInRow = (onRow = vi.fn(), onSelect = vi.fn()) => {
  render(
    <table>
      <tbody>
        <tr onClick={onRow}>
          <td>
            <RowActionsMenu
              actions={[{ key: 'rev', label: 'Сторнувати', destructive: true, onSelect }]}
            />
          </td>
        </tr>
      </tbody>
    </table>,
  );
  return { onRow, onSelect };
};

describe('RowActionsMenu', () => {
  it('«⋯» відкриває меню; дія виконується й закриває меню; рядок кліку не отримує', () => {
    const { onRow, onSelect } = renderInRow();
    const trigger = screen.getByRole('button', { name: 'Дії рядка' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const item = screen.getByRole('menuitem', { name: 'Сторнувати' });
    expect(item).toHaveFocus();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onRow).not.toHaveBeenCalled();
  });

  it('клік у меню (портал) не спливає до рядка таблиці', () => {
    const { onRow } = renderInRow();
    fireEvent.click(screen.getByRole('button', { name: 'Дії рядка' }));
    fireEvent.click(screen.getByRole('menu'));
    expect(onRow).not.toHaveBeenCalled();
  });

  it('клік поза меню закриває його', () => {
    renderInRow();
    fireEvent.click(screen.getByRole('button', { name: 'Дії рядка' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape закриває лише меню — вікно під ним лишається', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Вікно">
        <RowActionsMenu actions={[{ key: 'a', label: 'Дія', onSelect: vi.fn() }]} />
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Дії рядка' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('без дій — ні кнопки, ні меню', () => {
    render(<RowActionsMenu actions={[]} />);
    expect(screen.queryByRole('button', { name: 'Дії рядка' })).toBeNull();
  });
});
