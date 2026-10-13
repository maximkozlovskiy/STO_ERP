import { describe, it, expect, vi } from 'vitest';
import { activateRow } from '../row-activation';

// Стандарт кліку по рядку списку з боковою панеллю (рішення власника 2026-10-13).
describe('activateRow', () => {
  const setup = (panelEnabled: boolean, isSelected: boolean, withOpen = true) => {
    const select = vi.fn();
    const deselect = vi.fn();
    const open = vi.fn();
    activateRow({ panelEnabled, isSelected, select, deselect, open: withOpen ? open : undefined });
    return { select, deselect, open };
  };

  it('панель увімкнена, рядок не вибраний → вибирає; документ не відкривається', () => {
    const { select, deselect, open } = setup(true, false);
    expect(select).toHaveBeenCalledTimes(1);
    expect(deselect).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('панель увімкнена, рядок уже вибраний → знімає вибір; документ не відкривається', () => {
    const { select, deselect, open } = setup(true, true);
    expect(deselect).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('панель вимкнена → відкриває документ; вибір не чіпається', () => {
    const { select, deselect, open } = setup(false, false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(deselect).not.toHaveBeenCalled();
  });

  it('панель вимкнена, рядок лишився «вибраним» у стані → однаково відкриває документ', () => {
    const { deselect, open } = setup(false, true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(deselect).not.toHaveBeenCalled();
  });

  it('панель вимкнена, картки у списку немає → нічого не робить і не падає', () => {
    const { select, deselect } = setup(false, false, false);
    expect(select).not.toHaveBeenCalled();
    expect(deselect).not.toHaveBeenCalled();
  });
});
