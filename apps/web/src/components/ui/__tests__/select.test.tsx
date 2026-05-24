import { render, screen } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { Select } from '../select';

describe('Select', () => {
  it('рендерить placeholder як disabled option зі значенням ""', () => {
    render(
      <Select placeholder="Оберіть статус">
        <option value="DRAFT">Чернетка</option>
        <option value="ACTIVE">Активний</option>
      </Select>,
    );
    const placeholder = screen.getByRole('option', { name: 'Оберіть статус' }) as HTMLOptionElement;
    expect(placeholder).toBeDisabled();
    expect(placeholder.value).toBe('');
  });

  it('не рендерить placeholder коли пропа placeholder відсутня', () => {
    render(
      <Select>
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.queryByRole('option', { name: /Оберіть/ })).not.toBeInTheDocument();
  });

  it('показує label з htmlFor=id', () => {
    render(
      <Select label="Статус" id="status-select">
        <option value="1">Один</option>
      </Select>,
    );
    const label = screen.getByText('Статус');
    expect(label).toBeInTheDocument();
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', 'status-select');
  });

  it('показує errorMessage і aria-invalid', () => {
    render(
      <Select label="Статус" errorMessage="Поле обов'язкове">
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.getByText("Поле обов'язкове")).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('показує hint коли немає помилки', () => {
    render(
      <Select hint="Оберіть один зі статусів">
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.getByText('Оберіть один зі статусів')).toBeInTheDocument();
  });

  it('помилка має пріоритет над hint (показує тільки error)', () => {
    render(
      <Select hint="Підказка" errorMessage="Помилка">
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.getByText('Помилка')).toBeInTheDocument();
    expect(screen.queryByText('Підказка')).not.toBeInTheDocument();
  });

  it('required додає зірочку до label', () => {
    render(
      <Select label="Статус" required>
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('передає className до select element', () => {
    render(
      <Select className="custom-class">
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toHaveClass('custom-class');
  });

  it('disabled робить select disabled', () => {
    render(
      <Select disabled>
        <option value="1">Один</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
