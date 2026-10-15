// Кнопка «?» календаря: легенда іконок і кольорів категорій та типів записів (BR-CAL-009 —
// «кнопка "?" у шапці календаря пояснює іконки й кольори категорій і типи записів»).

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CalendarLegend } from '../CalendarLegend';

const BUTTON = 'Пояснення іконок календаря';
const PANEL = 'Що означають іконки';

describe('CalendarLegend — «?» з поясненням іконок', () => {
  // guards: BR-CAL-009
  it('кнопка відкриває легенду: усі категорії з поясненням і всі типи записів', () => {
    render(<CalendarLegend />);
    const button = screen.getByRole('button', { name: BUTTON });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: PANEL })).toBeNull();

    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: PANEL });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', panel.id);
    for (const name of [
      'Прострочено',
      'В роботі',
      'Заплановано',
      'Чернетка',
      'Виконано',
      'Скасовано',
      'Без наряду',
    ]) {
      expect(within(panel).getByText(name)).toBeInTheDocument();
    }
    expect(
      within(panel).getByText(
        'Запис закінчився (з продовженням наступного дня), а наряд не завершено',
      ),
    ).toBeInTheDocument();
    for (const type of ['Робота', 'Обслуговування', 'Перерва', 'Нарада']) {
      expect(within(panel).getByText(type)).toBeInTheDocument();
    }
  });

  it('Escape закриває легенду й повертає фокус на кнопку', () => {
    render(<CalendarLegend />);
    const button = screen.getByRole('button', { name: BUTTON });
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: PANEL })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: PANEL })).toBeNull();
    expect(button).toHaveFocus();
  });

  it('клік поза легендою закриває її, клік усередині — ні', () => {
    render(
      <>
        <CalendarLegend />
        <p>поза</p>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    const panel = screen.getByRole('dialog', { name: PANEL });
    fireEvent.mouseDown(within(panel).getByText('Прострочено'));
    expect(screen.getByRole('dialog', { name: PANEL })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('поза'));
    expect(screen.queryByRole('dialog', { name: PANEL })).toBeNull();
  });

  it('фокус переходить у легенду; вихід фокусу за її межі закриває її', () => {
    render(
      <>
        <CalendarLegend />
        <button type="button">картка місяця</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    const panel = screen.getByRole('dialog', { name: PANEL });
    expect(panel).toHaveFocus();
    // Фокус нікуди (клік по тексту, перемикання вікна ОС) — легенда лишається.
    fireEvent.blur(panel, { relatedTarget: null });
    expect(screen.getByRole('dialog', { name: PANEL })).toBeInTheDocument();
    // Tab на елемент сторінки поза легендою — закривається.
    const outside = screen.getByRole('button', { name: 'картка місяця' });
    fireEvent.blur(panel, { relatedTarget: outside });
    expect(screen.queryByRole('dialog', { name: PANEL })).toBeNull();
  });

  it('повторний клік по кнопці закриває легенду; інші клавіші — ні', () => {
    render(<CalendarLegend />);
    const button = screen.getByRole('button', { name: BUTTON });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: PANEL })).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: PANEL })).toBeNull();
  });
});
