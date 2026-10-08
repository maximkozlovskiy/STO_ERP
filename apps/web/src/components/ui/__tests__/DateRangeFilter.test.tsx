import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { vi, it, expect, describe } from 'vitest';
import { DateRangeFilter } from '../date-range-filter';

// Спільний відбір «З … По …» списків документів (складські документи, оплати, банк, каса).
// Підпис стоїть поруч із полем, а не в <label>, тож доступну назву дає aria-label: без неї
// читач екрана називав обидва поля однаково — «ДД.ММ.РРРР».
describe('DateRangeFilter', () => {
  const setup = (from = '2026-10-01', to = '2026-10-09') => {
    const onFromChange = vi.fn();
    const onToChange = vi.fn();
    render(
      <DateRangeFilter
        from={from}
        to={to}
        onFromChange={onFromChange}
        onToChange={onToChange}
        fromLabel="З"
        toLabel="По"
      />,
    );
    return { onFromChange, onToChange };
  };

  it('кожне поле має власну доступну назву і показує свою межу', () => {
    setup();
    expect(screen.getByLabelText('З')).toHaveValue('01.10.2026');
    expect(screen.getByLabelText('По')).toHaveValue('09.10.2026');
    // видимий підпис лишається — для тих, хто дивиться на екран
    expect(screen.getByText('З')).toBeInTheDocument();
    expect(screen.getByText('По')).toBeInTheDocument();
  });

  it('зміна кожного поля йде у свій обробник, датою YYYY-MM-DD', () => {
    const { onFromChange, onToChange } = setup();
    fireEvent.change(screen.getByLabelText('З'), { target: { value: '05.10.2026' } });
    expect(onFromChange).toHaveBeenCalledWith('2026-10-05');
    expect(onToChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('По'), { target: { value: '07.10.2026' } });
    expect(onToChange).toHaveBeenCalledWith('2026-10-07');
  });

  it('межі обмежують одна одну: «З» пізніше за «По» і «По» раніше за «З» не приймаються', () => {
    const { onFromChange, onToChange } = setup();
    fireEvent.change(screen.getByLabelText('З'), { target: { value: '10.10.2026' } });
    fireEvent.change(screen.getByLabelText('По'), { target: { value: '30.09.2026' } });
    expect(onFromChange).not.toHaveBeenCalled();
    expect(onToChange).not.toHaveBeenCalled();
  });

  it('порожня друга межа першу не обмежує', () => {
    const { onFromChange } = setup('', '');
    fireEvent.change(screen.getByLabelText('З'), { target: { value: '10.10.2026' } });
    expect(onFromChange).toHaveBeenCalledWith('2026-10-10');
  });

  // Bug #815, наживо на «Касі»: період 09.03–09.03, касир хоче 11.03–11.03 і вводить спершу «З».
  // «З 11.03» пізніше за «По» → відхиляється; далі «По 11.03» приймається. Поля показували
  // «11.03 – 11.03», а застосовано було 09.03 – 11.03: список за три дні під періодом в один.
  it('відхилена межа не лишається в полі: показаний період дорівнює застосованому', () => {
    let applied = { from: '', to: '' };
    const Harness = () => {
      const [from, setFrom] = useState('2026-03-09');
      const [to, setTo] = useState('2026-03-09');
      applied = { from, to };
      return (
        <DateRangeFilter
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          fromLabel="З"
          toLabel="По"
        />
      );
    };
    render(<Harness />);
    const fromInput = screen.getByLabelText('З');
    const toInput = screen.getByLabelText('По');

    fireEvent.change(fromInput, { target: { value: '11.03.2026' } });
    fireEvent.blur(fromInput);
    fireEvent.change(toInput, { target: { value: '11.03.2026' } });
    fireEvent.blur(toInput);

    expect(applied).toEqual({ from: '2026-03-09', to: '2026-03-11' });
    expect(fromInput).toHaveValue('09.03.2026');
    expect(toInput).toHaveValue('11.03.2026');
  });
});
