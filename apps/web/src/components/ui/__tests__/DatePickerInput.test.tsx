import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { vi, it, expect, describe } from 'vitest';
import { DatePickerInput } from '../date-picker-input';

// Календар відкривається на focus і раніше закривався ЛИШЕ кліком поза ним: після
// введення дати з клавіатури попап лишався поверх таблиці (знайдено E2E status-tooltip).
describe('DatePickerInput — закриття календаря з клавіатури', () => {
  const calendar = () => document.querySelector('.rdp-root');

  it('Enter після введення дати закриває календар', async () => {
    const user = userEvent.setup();
    render(<DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    await user.click(input);
    expect(calendar()).not.toBeNull();
    await user.keyboard('{Enter}');
    expect(calendar()).toBeNull();
  });

  it('Escape закриває календар і не спливає до батька (модалка лишається)', async () => {
    const user = userEvent.setup();
    const parentKeyDown = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={parentKeyDown}>
        <DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />
      </div>,
    );
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    await user.click(input);
    expect(calendar()).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    // Календар уже закритий → наступний Escape належить батькові.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });

  // Справжня <Modal> слухає Escape нативно на document (bubble), а не через React-батька.
  // Календар можна відкрити кнопкою-іконкою — тоді фокус на ній, а не в полі.
  it('Escape при фокусі на кнопці-іконці закриває календар і не доходить до document', async () => {
    const user = userEvent.setup();
    const documentKeyDown = vi.fn();
    document.addEventListener('keydown', documentKeyDown);
    try {
      render(<DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />);
      const iconButton = screen.getByRole('button', { name: 'Відкрити календар' });
      await user.click(iconButton);
      expect(calendar()).not.toBeNull();
      expect(document.activeElement).toBe(iconButton);
      fireEvent.keyDown(iconButton, { key: 'Escape' });
      expect(calendar()).toBeNull();
      expect(documentKeyDown).not.toHaveBeenCalled();
      // Календар закритий → наступний Escape вже належить модалці.
      fireEvent.keyDown(iconButton, { key: 'Escape' });
      expect(documentKeyDown).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', documentKeyDown);
    }
  });

  it('клік по вже сфокусованому полю після Escape знову відкриває календар', async () => {
    const user = userEvent.setup();
    render(<DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    await user.click(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(document.activeElement).toBe(input);
    await user.click(input);
    expect(calendar()).not.toBeNull();
  });
});

// Bug #815: дата, яку поле не прийняло (поза межами min/max або недописана), до батька не
// доходить. Раніше вона лишалась у полі назавжди — на екрані стояла одна дата, а застосована
// була інша.
describe('DatePickerInput — поле показує лише застосовану дату', () => {
  it('дата поза межами: onChange не кличеться, після виходу з поля повертається застосована', () => {
    const onChange = vi.fn();
    render(<DatePickerInput value="2026-03-09" onChange={onChange} max="2026-03-09" />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    fireEvent.change(input, { target: { value: '11.03.2026' } });
    expect(onChange).not.toHaveBeenCalled();
    // поки поле у фокусі — користувач бачить, що ввів
    expect(input).toHaveValue('11.03.2026');
    fireEvent.blur(input);
    expect(input).toHaveValue('09.03.2026');
  });

  it('недописана дата після виходу з поля не лишається', () => {
    const onChange = vi.fn();
    render(<DatePickerInput value="2026-03-09" onChange={onChange} />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    fireEvent.change(input, { target: { value: '11.03' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('09.03.2026');
  });

  it('очищене поле лишається порожнім: «без межі» — теж застосоване значення', () => {
    const Harness = () => {
      const [value, setValue] = useState('2026-03-09');
      return <DatePickerInput value={value} onChange={setValue} />;
    };
    render(<Harness />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('');
  });
});

// Кнопка «×» у фільтрах дат списків (рішення власника 2026-10-13): порожня дата = «без межі»,
// а зняти її можна було лише стерши текст у полі вручну.
//
// Що ловить (мутацію не проганяв): прибрати `&& value` з `showClear` → кейс «без значення кнопки немає» падає;
// прибрати `onChange('')` з handleClear → кейс «очищає» падає.
describe('DatePickerInput — кнопка очищення (clearable)', () => {
  const calendar = () => document.querySelector('.rdp-root');
  // Назва кнопки — «Очистити дату», а для поля з назвою — «Очистити дату: <назва поля>».
  const clearBtn = () => screen.queryByRole('button', { name: /^Очистити дату/ });

  it('без пропа clearable кнопки немає — поле у формах документів не змінилось', () => {
    render(<DatePickerInput value="2026-10-13" onChange={vi.fn()} />);
    expect(clearBtn()).not.toBeInTheDocument();
  });

  it('clearable без значення — кнопки немає; зі значенням — є, з підказкою', () => {
    const { rerender } = render(<DatePickerInput value="" onChange={vi.fn()} clearable />);
    expect(clearBtn()).not.toBeInTheDocument();

    rerender(<DatePickerInput value="2026-10-13" onChange={vi.fn()} clearable />);
    expect(clearBtn()).toBeInTheDocument();
    expect(clearBtn()).toHaveAttribute('title', 'Очистити дату');
    expect(clearBtn()).toHaveAttribute('type', 'button');
    // Іконка календаря лишається поруч.
    expect(screen.getByRole('button', { name: 'Відкрити календар' })).toBeInTheDocument();
  });

  it('disabled — кнопки немає навіть зі значенням', () => {
    render(<DatePickerInput value="2026-10-13" onChange={vi.fn()} clearable disabled />);
    expect(clearBtn()).not.toBeInTheDocument();
  });

  it('натискання очищає значення, закриває календар і повертає фокус у поле', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const Harness = () => {
      const [value, setValue] = useState('2026-10-13');
      return (
        <DatePickerInput
          value={value}
          onChange={v => {
            onChange(v);
            setValue(v);
          }}
          ariaLabel="З"
          clearable
        />
      );
    };
    render(<Harness />);
    const input = screen.getByLabelText('З');
    await user.click(input);
    expect(calendar()).not.toBeNull();

    await user.click(clearBtn()!);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
    expect(input).toHaveValue('');
    expect(calendar()).toBeNull();
    expect(input).toHaveFocus();
    // Значення немає → кнопка зникла.
    expect(clearBtn()).not.toBeInTheDocument();
  });

  it('кнопка досяжна з клавіатури: Tab із поля → «Очистити дату», Enter очищає', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePickerInput value="2026-10-13" onChange={onChange} ariaLabel="З" clearable />);
    screen.getByLabelText('З').focus();

    await user.tab();
    expect(clearBtn()).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('');
  });
});
