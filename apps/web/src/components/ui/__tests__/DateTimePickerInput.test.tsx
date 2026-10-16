import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, afterEach, beforeEach } from 'vitest';
import { DateTimePickerInput } from '../datetime-picker-input';

// Попап рендериться порталом у document.body, а <Modal> слухає Escape на document
// (bubble). До правки Escape з відкритим попапом закривав усю модалку-батька.
describe('DateTimePickerInput — Escape закриває лише попап', () => {
  const calendar = () => document.querySelector('.rdp-root');
  const modalEscape = vi.fn();
  // Імітація Modal: той самий document-level bubble-listener, що у modal.tsx.
  const modalListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') modalEscape();
  };

  afterEach(() => {
    document.removeEventListener('keydown', modalListener);
    modalEscape.mockClear();
  });

  it('перший Escape закриває попап і не доходить до Modal; другий — доходить', async () => {
    const user = userEvent.setup();
    document.addEventListener('keydown', modalListener);
    render(<DateTimePickerInput value="" onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ');
    await user.click(input);
    expect(calendar()).not.toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(modalEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(modalEscape).toHaveBeenCalledTimes(1);
  });

  it('Escape з фокусом у <select> попапа (поза інпутом) теж закриває лише попап', async () => {
    const user = userEvent.setup();
    document.addEventListener('keydown', modalListener);
    render(<DateTimePickerInput value="" onChange={vi.fn()} />);
    await user.click(screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ'));
    const select = document.querySelector('select');
    expect(select).not.toBeNull();

    fireEvent.keyDown(select as HTMLSelectElement, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(modalEscape).not.toHaveBeenCalled();
  });

  it('інші клавіші не перехоплюються', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    document.addEventListener('keydown', onKey);
    render(<DateTimePickerInput value="" onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ');
    await user.click(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calendar()).not.toBeNull();
    expect(onKey).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', onKey);
  });
});

// BR-WO-019: планові дати наряду — не в минулому і в робочих годинах філії. Пікер не дає
// обрати минулий день, минулу годину сьогодні й години поза робочими; вибір дня ставить першу
// доступну годину. «Зараз» — 20.05.2026 14:20 Києва (11:20Z, +03).
describe('DateTimePickerInput — мінімальний момент і робочі години (BR-WO-019)', () => {
  const NOW = new Date('2026-05-20T11:20:00Z');
  const day = (iso: string) => document.querySelector(`[data-day="${iso}"]`);
  const hourOptions = () =>
    Array.from(
      (screen.getByLabelText('Година') as HTMLSelectElement).querySelectorAll('option'),
    ).map(o => (o.disabled ? `(${o.value})` : o.value));
  const minuteOptions = () =>
    Array.from(
      (screen.getByLabelText('Хвилини') as HTMLSelectElement).querySelectorAll('option'),
    ).map(o => (o.disabled ? `(${o.value})` : o.value));

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function openPicker(props: Partial<Parameters<typeof DateTimePickerInput>[0]> = {}) {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DateTimePickerInput
        value=""
        onChange={onChange}
        minDateTime={NOW}
        minHour={9}
        maxHour={17}
        {...props}
      />,
    );
    await user.click(screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ'));
    return { onChange, user };
  }

  // guards: BR-WO-019
  it('минулі дні недоступні, сьогодні й далі — доступні', async () => {
    await openPicker();
    expect(day('2026-05-19')).toHaveAttribute('data-disabled', 'true');
    expect(day('2026-05-19')?.querySelector('button')).toBeDisabled();
    expect(day('2026-05-20')).not.toHaveAttribute('data-disabled');
    expect(day('2026-05-21')).not.toHaveAttribute('data-disabled');
  });

  // guards: BR-WO-019
  it('сьогодні — години від поточної до кінця вікна; у поточній годині — хвилини від «зараз»', async () => {
    await openPicker();
    expect(hourOptions()).toEqual(['14', '15', '16', '17']);
    expect(minuteOptions()).toEqual(['30', '45']);
  });

  // guards: BR-WO-019
  it('інший день — увесь робочий день філії, без годин поза ним', async () => {
    await openPicker({ value: '2026-05-22T10:00' });
    expect(hourOptions()).toEqual(['09', '10', '11', '12', '13', '14', '15', '16', '17']);
    expect(minuteOptions()).toEqual(['00', '15', '30', '45']);
  });

  // guards: BR-WO-019
  it('вибір дня без часу → перша доступна година цього дня', async () => {
    const { onChange, user } = await openPicker();
    await user.click(day('2026-05-22')!.querySelector('button')!);
    expect(onChange).toHaveBeenLastCalledWith('2026-05-22T09:00');
  });

  // guards: BR-WO-019
  it('вибір сьогоднішнього дня з уже минулим часом → перший доступний час сьогодні', async () => {
    const { onChange, user } = await openPicker({ value: '2026-05-22T10:00' });
    await user.click(day('2026-05-20')!.querySelector('button')!);
    expect(onChange).toHaveBeenLastCalledWith('2026-05-20T14:30');
  });

  // guards: BR-WO-019
  it('зміна години: хвилини, яких у новій годині немає, → перша доступна', async () => {
    const { onChange, user } = await openPicker({ value: '2026-05-20T15:00' });
    await user.selectOptions(screen.getByLabelText('Година'), '14');
    expect(onChange).toHaveBeenLastCalledWith('2026-05-20T14:30');
  });

  // guards: BR-WO-019
  it('після закриття сьогодні вже нічого обрати — недоступний і сьогоднішній день', async () => {
    vi.setSystemTime(new Date('2026-05-20T15:10:00Z')); // 18:10 Києва
    await openPicker({ minDateTime: new Date('2026-05-20T15:10:00Z') });
    expect(day('2026-05-20')).toHaveAttribute('data-disabled', 'true');
    expect(day('2026-05-21')).not.toHaveAttribute('data-disabled');
  });

  // guards: BR-WO-019
  it('closeHour (час завершення): година закриття доступна лише як :00', async () => {
    await openPicker({ value: '2026-05-22T18:00', maxHour: undefined, closeHour: 18 });
    expect(hourOptions()).toContain('18');
    expect(minuteOptions()).toEqual(['00']);
  });

  // guards: BR-WO-019
  it('збережене значення поза обмеженнями показується недоступною опцією, не підміняється', async () => {
    await openPicker({ value: '2026-05-18T19:00' });
    expect(hourOptions()).toContain('(19)');
    expect((screen.getByLabelText('Година') as HTMLSelectElement).value).toBe('19');
  });

  // guards: BR-WO-019
  it('відкривається на місяці значення (завершення через місяць — не поточний місяць)', async () => {
    await openPicker({ value: '2026-07-10T10:00' });
    expect(day('2026-07-10')).not.toBeNull();
    expect(day('2026-05-20')).toBeNull();
  });

  it('без minDateTime — поведінка як раніше: минулі дні доступні', async () => {
    await openPicker({ minDateTime: undefined });
    expect(day('2026-05-19')).not.toHaveAttribute('data-disabled');
  });
});

// BR-WO-020: стерті планові дати прибирають запис календаря наряду — стерти їх можна з картки.
describe('DateTimePickerInput — очищення (clearable)', () => {
  // guards: BR-WO-020
  it('кнопка «Очистити дату: <поле>» → значення стає порожнім', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateTimePickerInput
        label="Дата та час початку"
        value="2026-05-22T10:00"
        onChange={onChange}
        clearable
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Очистити дату: Дата та час початку' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('порожнє чи недоступне поле — кнопки немає', () => {
    const { rerender } = render(
      <DateTimePickerInput label="Початок" value="" onChange={vi.fn()} clearable />,
    );
    expect(screen.queryByRole('button', { name: /Очистити дату/ })).toBeNull();
    rerender(
      <DateTimePickerInput
        label="Початок"
        value="2026-05-22T10:00"
        onChange={vi.fn()}
        disabled
        clearable
      />,
    );
    expect(screen.queryByRole('button', { name: /Очистити дату/ })).toBeNull();
  });
});
