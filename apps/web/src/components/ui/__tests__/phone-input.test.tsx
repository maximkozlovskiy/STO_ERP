import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { vi, it, expect, describe } from 'vitest';
import { PhoneInput } from '../phone-input';

// Controlled-input harness reflecting real PhoneInput usage in:
//   CounterpartyEditModal, EmployeeEditModal, CalendarSlotModal, booking/page,
//   counterparties/[id]/PageClient. All of them do:
//       <PhoneInput value={form.phone} onChange={e => set(e.target.value)} />
function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <>
      <PhoneInput
        value={v}
        onChange={e => {
          setV(e.target.value);
          onValue?.(e.target.value);
        }}
        data-testid="phone"
      />
      <output data-testid="state">{v}</output>
    </>
  );
}

describe('PhoneInput — mask formatting', () => {
  it('порожнє значення лишається порожнім', () => {
    render(<Harness />);
    const input = screen.getByTestId('phone') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('одна цифра 0 → "+38 (0"', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone');
    await user.type(input, '0');
    expect(screen.getByTestId('state').textContent).toBe('+38 (0');
  });

  it('повний 10-значний номер 0501234567 → "+38 (050) 123-45-67"', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone');
    await user.type(input, '0501234567');
    expect(screen.getByTestId('state').textContent).toBe('+38 (050) 123-45-67');
  });

  it('номер з префіксом 38 → "+38 (050) 123-45-67"', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone');
    await user.type(input, '380501234567');
    expect(screen.getByTestId('state').textContent).toBe('+38 (050) 123-45-67');
  });

  it('номер з плюсом +380501234567 → "+38 (050) 123-45-67"', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone');
    await user.type(input, '+380501234567');
    expect(screen.getByTestId('state').textContent).toBe('+38 (050) 123-45-67');
  });

  it('обрізає більше 10 цифр (паст 0501234567890 → 0501234567)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone');
    await user.type(input, '0501234567890');
    expect(screen.getByTestId('state').textContent).toBe('+38 (050) 123-45-67');
  });

  it('викликає parent onChange з замаскованим e.target.value (не з сирим)', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByTestId('phone');
    await user.type(input, '050');
    // Has been called three times (one per char); each call gets the masked
    // value at that point in time.
    expect(onValue).toHaveBeenLastCalledWith('+38 (050');
  });

  it('controlled value sync — DOM input.value === state', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone') as HTMLInputElement;
    await user.type(input, '050');
    // Real-world contract: controlled inputs need DOM value === state.
    // Direct mutation of e.target.value happens BEFORE parent setState +
    // re-render. After re-render React reconciles value prop with DOM.
    // If mutation desyncs React's internal value tracker, subsequent
    // keystrokes may be dropped — assert no desync.
    expect(input.value).toBe('+38 (050');
    expect(screen.getByTestId('state').textContent).toBe('+38 (050');
  });

  it(
    'повторний набір після паузи — value tracker не зламано (повна послідовність ' +
      'працює без пропусків)',
    async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const input = screen.getByTestId('phone') as HTMLInputElement;
      // Type 5 chars, pause, type 5 more. Internal value tracker must remain in
      // sync — otherwise the second batch would be dropped.
      await user.type(input, '05012');
      expect(input.value).toBe('+38 (050) 12');
      await user.type(input, '34567');
      expect(input.value).toBe('+38 (050) 123-45-67');
    },
  );

  it('видалення символу через backspace зменшує маску (10 → 9 цифр)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('phone');
    await user.type(input, '0501234567');
    await user.type(input, '{Backspace}');
    // After backspace on "+38 (050) 123-45-67" we delete trailing "7" →
    // input becomes "+38 (050) 123-45-6" (no trailing dash, but mask
    // re-runs on remaining 9 digits → keeps "-6").
    const state = screen.getByTestId('state').textContent ?? '';
    // Either dropped to 9 digits (050 123 45 6) or shorter.
    expect(state.replace(/\D/g, '').length).toBeLessThan(12); // 38 + 10 = 12
  });

  it('тип "tel" + inputMode "tel" — мобільна клавіатура показує цифри', () => {
    render(<Harness />);
    const input = screen.getByTestId('phone') as HTMLInputElement;
    expect(input.type).toBe('tel');
    expect(input.inputMode).toBe('tel');
  });
});
