import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Input } from '../input';
import { Select } from '../select';
import { DateTimePickerInput } from '../datetime-picker-input';
import { DatePickerInput } from '../date-picker-input';
import { EntityPickerField } from '../entity-picker-field';
import { SearchCombobox } from '../search-combobox';

/**
 * Рамка поля — окремий токен `--color-input` (рішення власника 2026-10-22: «темніші рамки полів у
 * всьому застосунку»): ≥ 3:1 проти білого за WCAG 1.4.11. Розділювачі таблиць і карток лишаються на
 * `border-border`, тож поле, що повернулось на `border-border`, знову «зливається» з карткою.
 * Темна тема — блок `.dark input/select/textarea` у globals.css (той самий токен).
 */
function expectInputBorder(el: Element) {
  const cls = el.getAttribute('class') ?? '';
  expect(cls).toMatch(/(^|\s)border-input(\s|$)/);
  expect(cls).not.toMatch(/(^|\s)border-border(\s|$)/);
}

describe('рамка спільних полів — токен border-input', () => {
  it('Input', () => {
    render(<Input aria-label="Назва" />);
    expectInputBorder(screen.getByLabelText('Назва'));
  });

  it('Select', () => {
    render(
      <Select aria-label="Склад">
        <option value="">—</option>
      </Select>,
    );
    expectInputBorder(screen.getByLabelText('Склад'));
  });

  it('Input з помилкою — рамка помилки замінює токен поля', () => {
    render(<Input aria-label="Назва" errorMessage="Вкажіть назву" />);
    const cls = screen.getByLabelText('Назва').getAttribute('class') ?? '';
    expect(cls).toMatch(/(^|\s)border-destructive(\s|$)/);
    expect(cls).not.toMatch(/(^|\s)border-input(\s|$)/);
  });

  it('DateTimePickerInput', () => {
    const { container } = render(
      <DateTimePickerInput label="Дата та час початку" value="" onChange={vi.fn()} />,
    );
    expectInputBorder(container.querySelector('input')!);
  });

  it('DatePickerInput', () => {
    render(<DatePickerInput ariaLabel="Дата документа" value="" onChange={vi.fn()} />);
    expectInputBorder(screen.getByLabelText('Дата документа'));
  });

  it('EntityPickerField — рамка на обгортці поля', () => {
    render(
      <EntityPickerField
        ariaLabel="Клієнт"
        display=""
        onClear={vi.fn()}
        onSearch={() => Promise.resolve([])}
      />,
    );
    const field = screen.getByLabelText('Клієнт').closest('.rounded')!;
    expectInputBorder(field);
  });

  it('SearchCombobox', () => {
    render(
      <SearchCombobox
        placeholder="Пошук"
        value=""
        onSelect={vi.fn()}
        fetchItems={() => Promise.resolve([])}
      />,
    );
    expectInputBorder(screen.getByRole('combobox'));
  });
});
