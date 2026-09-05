import { describe, it, expect } from 'vitest';
import { rowStatusTone, rowStatusBorderClass, rowStatusLabel } from './row-status';

// Фіксований «зараз»: 2026-09-05 12:00 локального часу.
const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime();
const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10, 0, 0).toISOString();

describe('rowStatusTone', () => {
  it('overdue — прострочений дедлайн у активному документі', () => {
    expect(rowStatusTone({ dueDate: iso(2026, 9, 1), active: true }, NOW)).toBe('overdue');
  });

  it('today — дедлайн сьогодні у активному документі', () => {
    expect(rowStatusTone({ dueDate: iso(2026, 9, 5), active: true }, NOW)).toBe('today');
  });

  it('none — майбутній дедлайн без боргу', () => {
    expect(rowStatusTone({ dueDate: iso(2026, 9, 20), active: true }, NOW)).toBe('none');
  });

  it('термінальний документ не «горить» навіть з простроченим дедлайном', () => {
    expect(rowStatusTone({ dueDate: iso(2026, 9, 1), active: false }, NOW)).toBe('none');
  });

  it('debt — непогашений залишок пріоритетніший за відсутність дедлайну', () => {
    expect(rowStatusTone({ balanceDue: 150.5, active: false }, NOW)).toBe('debt');
  });

  it('overdue має пріоритет над debt', () => {
    expect(rowStatusTone({ dueDate: iso(2026, 9, 1), active: true, balanceDue: 100 }, NOW)).toBe(
      'overdue',
    );
  });

  it('нульовий/від’ємний баланс → не debt (епсилон 0.005)', () => {
    expect(rowStatusTone({ balanceDue: 0 }, NOW)).toBe('none');
    expect(rowStatusTone({ balanceDue: 0.004 }, NOW)).toBe('none');
    expect(rowStatusTone({ balanceDue: -5 }, NOW)).toBe('none');
  });

  it('без даних → none; active за замовчуванням true', () => {
    expect(rowStatusTone({}, NOW)).toBe('none');
    expect(rowStatusTone({ dueDate: iso(2026, 9, 1) }, NOW)).toBe('overdue');
  });
});

describe('rowStatusBorderClass', () => {
  it('кожен тон → валідний клас; none = прозора рамка (зберігає вирівнювання)', () => {
    expect(rowStatusBorderClass('overdue')).toContain('border-l-destructive');
    expect(rowStatusBorderClass('today')).toContain('border-l-warning');
    expect(rowStatusBorderClass('debt')).toContain('border-l-warning/60');
    expect(rowStatusBorderClass('none')).toContain('border-l-transparent');
  });
});

describe('rowStatusLabel', () => {
  it('none → undefined (без title), інші → текст', () => {
    expect(rowStatusLabel('none')).toBeUndefined();
    expect(rowStatusLabel('overdue')).toBe('Прострочено');
    expect(rowStatusLabel('today')).toBe('Дедлайн сьогодні');
    expect(rowStatusLabel('debt')).toBe('Є непогашений залишок');
  });
});
