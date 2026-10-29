// Спільні примітиви списків за UX-оглядом 2026-10-29: комірка грошей (праворуч, без переносу «₴»),
// порожній стан «за фільтрами» з кнопкою «Скинути фільтри», нейтральний тренд KPI для нуля.
//
// Mutation-verify (2026-10-29): прибрати `whitespace-nowrap` з MoneyCell → падає «комірка грошей»;
// повернути «Створіть перший…» при filtered → падає «з фільтрами»; трактувати `up: undefined` як
// false → падає «нейтральний тренд».
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Table, TableBody, TableRow, MoneyCell, MONEY_HEAD_CLASS } from '../table';
import { ListEmptyState } from '../empty-state';
import { KpiCard } from '../card';

describe('MoneyCell', () => {
  it('комірка грошей — праворуч, однакова ширина цифр, без переносу «₴»', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <MoneyCell className="font-semibold">1 250,00 ₴</MoneyCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cell = screen.getByText('1 250,00 ₴');
    expect(cell.tagName).toBe('TD');
    expect(cell).toHaveClass('text-right', 'tabular-nums', 'whitespace-nowrap', 'font-semibold');
    expect(MONEY_HEAD_CLASS).toBe('text-right');
  });
});

describe('ListEmptyState', () => {
  it('без фільтрів — власний заголовок і підказка списку, кнопки скидання немає', () => {
    render(
      <ListEmptyState
        title="Нарядів не знайдено"
        description="Створіть перший наряд"
        filtered={false}
        onResetFilters={vi.fn()}
      />,
    );
    expect(screen.getByText('Нарядів не знайдено')).toBeInTheDocument();
    expect(screen.getByText('Створіть перший наряд')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-reset-filters')).toBeNull();
  });

  it('з фільтрами (зокрема датою) — «За фільтрами нічого не знайдено» і «Скинути фільтри»', () => {
    const reset = vi.fn();
    render(
      <ListEmptyState
        title="Нарядів не знайдено"
        description="Створіть перший наряд"
        filtered
        onResetFilters={reset}
      />,
    );
    expect(screen.getByText('За фільтрами нічого не знайдено')).toBeInTheDocument();
    expect(screen.queryByText('Створіть перший наряд')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Скинути фільтри' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('KpiCard — тренд', () => {
  it('up не задано — нейтральний підпис без стрілки; true / false — зелений ↑ / червоний ↓', () => {
    const { rerender } = render(
      <KpiCard label="В роботі" value={3} icon={null} trend={{ value: '0 завершено сьогодні' }} />,
    );
    const trend = screen.getByTestId('kpi-trend');
    expect(trend).toHaveTextContent(/^0 завершено сьогодні$/);
    expect(trend).toHaveClass('text-muted-foreground');
    expect(trend).not.toHaveClass('text-destructive');

    rerender(<KpiCard label="В роботі" value={3} icon={null} trend={{ value: '2', up: true }} />);
    expect(screen.getByTestId('kpi-trend')).toHaveTextContent('↑ 2');
    expect(screen.getByTestId('kpi-trend')).toHaveClass('text-success');

    rerender(<KpiCard label="В роботі" value={3} icon={null} trend={{ value: '2', up: false }} />);
    expect(screen.getByTestId('kpi-trend')).toHaveTextContent('↓ 2');
    expect(screen.getByTestId('kpi-trend')).toHaveClass('text-destructive');
  });

  it('значення KPI не переносить «₴» на новий рядок', () => {
    render(<KpiCard label="Виручка" value="197 763,09 ₴" icon={null} />);
    expect(screen.getByText('197 763,09 ₴')).toHaveClass('whitespace-nowrap');
  });
});
