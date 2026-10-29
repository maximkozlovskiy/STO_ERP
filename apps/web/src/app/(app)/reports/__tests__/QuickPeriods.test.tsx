// Швидкі періоди звітів (огляд звітів 2026-10-29): «Цей місяць · Минулий місяць · Квартал · Рік»
// біля «З / По». Межі — київські календарні дати від `kyivToday()`; кнопка періоду, що збігається з
// обраними датами, підсвічена.
//
// Mutation-verify (2026-10-29): минулий місяць січня без переходу року → падає «січень»; кінець
// минулого місяця 30 замість останнього дня → падає «лютий високосного року»; квартал від поточного
// місяця → падає «квартал»; `aria-pressed` завжди false → падає «підсвічена кнопка».
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, afterEach } from 'vitest';
import { activeQuickPeriod, quickPeriodRange } from '../report-periods';

const today = vi.hoisted(() => ({ value: '2026-10-29' }));
vi.mock('@/lib/format', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/format')>()),
  kyivToday: () => today.value,
}));

import { QuickPeriods } from '../QuickPeriods';

describe('quickPeriodRange — межі швидких періодів', () => {
  it('цей місяць — з першого числа до сьогодні', () => {
    expect(quickPeriodRange('month', '2026-10-29')).toEqual({
      from: '2026-10-01',
      to: '2026-10-29',
    });
  });

  it('минулий місяць — повністю; у січні — грудень минулого року', () => {
    expect(quickPeriodRange('prevMonth', '2026-10-29')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(quickPeriodRange('prevMonth', '2027-01-05')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });

  it('минулий місяць — лютий високосного й звичайного року', () => {
    expect(quickPeriodRange('prevMonth', '2028-03-10').to).toBe('2028-02-29');
    expect(quickPeriodRange('prevMonth', '2026-03-10').to).toBe('2026-02-28');
  });

  it('квартал — з першого дня поточного кварталу; рік — з 1 січня', () => {
    expect(quickPeriodRange('quarter', '2026-11-15')).toEqual({
      from: '2026-10-01',
      to: '2026-11-15',
    });
    expect(quickPeriodRange('quarter', '2026-03-31').from).toBe('2026-01-01');
    expect(quickPeriodRange('quarter', '2026-06-01').from).toBe('2026-04-01');
    expect(quickPeriodRange('year', '2026-10-29')).toEqual({
      from: '2026-01-01',
      to: '2026-10-29',
    });
  });

  it('activeQuickPeriod — період, що збігається з датами, або null', () => {
    expect(activeQuickPeriod('2026-09-01', '2026-09-30', '2026-10-29')).toBe('prevMonth');
    expect(activeQuickPeriod('2026-01-01', '2026-10-29', '2026-10-29')).toBe('year');
    expect(activeQuickPeriod('2026-09-02', '2026-09-30', '2026-10-29')).toBeNull();
  });
});

describe('QuickPeriods — кнопки біля «З / По»', () => {
  afterEach(() => {
    today.value = '2026-10-29';
  });

  it('клік ставить межі періоду; кнопка обраного періоду підсвічена', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <QuickPeriods from="2026-01-01" to="2026-10-29" onChange={onChange} />,
    );
    expect(screen.getByRole('button', { name: 'Рік' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Минулий місяць' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Минулий місяць' }));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-09-30' });

    rerender(<QuickPeriods from="2026-09-01" to="2026-09-30" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Минулий місяць' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Рік' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('довільні дати — жодна кнопка не підсвічена; «Квартал» і «Цей місяць» — від київського сьогодні', () => {
    today.value = '2026-11-15';
    const onChange = vi.fn();
    render(<QuickPeriods from="2026-05-03" to="2026-05-20" onChange={onChange} />);
    for (const b of screen.getAllByRole('button'))
      expect(b).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Квартал' }));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-11-15' });
    fireEvent.click(screen.getByRole('button', { name: 'Цей місяць' }));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-15' });
  });
});
