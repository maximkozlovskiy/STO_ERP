// Бокова панель списку тримає копію вибраного документа. Коли документ змінили в картці,
// відновленій із вкладки, список перечитувався, а панель показувала старий статус і старі дії
// (перевірено наживо 2026-10-14: рядок «Надіслано», у панелі «Чернетка» і кнопка «Надіслати»).
//
// Мутації (перевірено): прибрати `seen.signature !== signature` → падає «той самий рядок»;
// прибрати `seen.id === selectedId` → падає «вибрали інший рядок»; прибрати оновлення
// `seenRef.current` → падає «друга зміна».

import { renderHook } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import { useSelectedRowRefresh } from './useSelectedRowRefresh';

interface Row {
  id: string;
  status: string;
}

const rows = (...list: [string, string][]): Row[] => list.map(([id, status]) => ({ id, status }));

function setup(initialRows: Row[], selectedId: string | null) {
  const onChanged = vi.fn();
  const view = renderHook(
    ({ r, id }: { r: Row[]; id: string | null }) => useSelectedRowRefresh(r, id, onChanged),
    { initialProps: { r: initialRows, id: selectedId } },
  );
  return { onChanged, rerender: (r: Row[], id: string | null) => view.rerender({ r, id }) };
}

describe('useSelectedRowRefresh', () => {
  it('рядок вибраного документа змінився у списку → onChanged із новим рядком', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT'], ['b', 'DRAFT']), 'a');
    expect(onChanged).not.toHaveBeenCalled();

    rerender(rows(['a', 'SENT'], ['b', 'DRAFT']), 'a');

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith({ id: 'a', status: 'SENT' });
  });

  it('той самий рядок у новому масиві (перечитали без змін) → onChanged не кличеться', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT']), 'a');

    rerender(rows(['a', 'DRAFT']), 'a');
    rerender(rows(['a', 'DRAFT'], ['c', 'PAID']), 'a');

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('змінився ІНШИЙ рядок → onChanged не кличеться', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT'], ['b', 'DRAFT']), 'a');

    rerender(rows(['a', 'DRAFT'], ['b', 'SENT']), 'a');

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('вибрали інший рядок → це не «зміна»: панель щойно сама його довантажила', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT'], ['b', 'SENT']), 'a');

    rerender(rows(['a', 'DRAFT'], ['b', 'SENT']), 'b');
    expect(onChanged).not.toHaveBeenCalled();

    // Контроль: новий вибір відстежується далі.
    rerender(rows(['a', 'DRAFT'], ['b', 'PAID']), 'b');
    expect(onChanged).toHaveBeenCalledWith({ id: 'b', status: 'PAID' });
  });

  it('друга зміна того самого рядка теж доходить до панелі', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT']), 'a');

    rerender(rows(['a', 'SENT']), 'a');
    rerender(rows(['a', 'SENT']), 'a');
    rerender(rows(['a', 'PAID']), 'a');

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenLastCalledWith({ id: 'a', status: 'PAID' });
  });

  it('вибір зняли й поставили знову → старий відбиток забуто', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT']), 'a');

    rerender(rows(['a', 'DRAFT']), null);
    rerender(rows(['a', 'SENT']), null);
    rerender(rows(['a', 'SENT']), 'a');

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('рядок тимчасово зник зі сторінки списку → без падіння і без виклику', () => {
    const { onChanged, rerender } = setup(rows(['a', 'DRAFT']), 'a');

    rerender(rows(['b', 'DRAFT']), 'a');

    expect(onChanged).not.toHaveBeenCalled();
  });
});
