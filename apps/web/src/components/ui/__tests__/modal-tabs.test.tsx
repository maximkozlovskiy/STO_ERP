import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, describe } from 'vitest';
import { ModalTabs } from '../modal-tabs';

/**
 * Bug #174: component-coverage для ModalTabs (CRM/Employees edit-modal child-collections).
 * Перевіряє базовий контракт: рендер табів, перемикання активного табу по кліку,
 * count badge, defaultTab, fallback при невідомому defaultTab, null при порожньому масиві.
 */
describe('ModalTabs', () => {
  const tabs = [
    { key: 'vehicles', label: 'Авто', count: 3, content: <div>Список авто</div> },
    { key: 'history', label: 'Історія', count: 0, content: <div>Історія візитів</div> },
    { key: 'notes', label: 'Нотатки', content: <div>Текст нотаток</div> },
  ];

  it('рендерить усі таби з їх label', () => {
    render(<ModalTabs tabs={tabs} />);
    expect(screen.getByRole('button', { name: /Авто/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Історія/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Нотатки/ })).toBeInTheDocument();
  });

  it('за замовчуванням показує контент першого табу', () => {
    render(<ModalTabs tabs={tabs} />);
    expect(screen.getByText('Список авто')).toBeInTheDocument();
    expect(screen.queryByText('Історія візитів')).not.toBeInTheDocument();
  });

  it('клік по табу перемикає активний контент', async () => {
    render(<ModalTabs tabs={tabs} />);
    await userEvent.click(screen.getByRole('button', { name: /Історія/ }));
    expect(screen.getByText('Історія візитів')).toBeInTheDocument();
    expect(screen.queryByText('Список авто')).not.toBeInTheDocument();
  });

  it('відображає count badge для табів з count (включно з 0)', () => {
    render(<ModalTabs tabs={tabs} />);
    // count=3 у табі "Авто" та count=0 у "Історія" — обидва рендеряться (0 теж валідний)
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('не рендерить badge для табу без count (notes)', () => {
    render(<ModalTabs tabs={[{ key: 'notes', label: 'Нотатки', content: <div>Текст</div> }]} />);
    const btn = screen.getByRole('button', { name: 'Нотатки' });
    // у кнопці лише label, без числового badge
    expect(btn.querySelector('span')).toBeNull();
  });

  it('defaultTab відкриває вказаний таб, а не перший', () => {
    render(<ModalTabs tabs={tabs} defaultTab="notes" />);
    expect(screen.getByText('Текст нотаток')).toBeInTheDocument();
    expect(screen.queryByText('Список авто')).not.toBeInTheDocument();
  });

  it('невідомий defaultTab → fallback на перший таб', () => {
    render(<ModalTabs tabs={tabs} defaultTab="does-not-exist" />);
    expect(screen.getByText('Список авто')).toBeInTheDocument();
  });

  it('порожній масив табів → нічого не рендерить (null)', () => {
    const { container } = render(<ModalTabs tabs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('перемикання назад на перший таб після кліку на інший', async () => {
    render(<ModalTabs tabs={tabs} />);
    await userEvent.click(screen.getByRole('button', { name: /Історія/ }));
    expect(screen.getByText('Історія візитів')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Авто/ }));
    expect(screen.getByText('Список авто')).toBeInTheDocument();
    expect(screen.queryByText('Історія візитів')).not.toBeInTheDocument();
  });

  // Картка сталої висоти (Modal fixedHeight): вкладки стоять унизу прокручуваного тіла. Якщо
  // область вмісту стискається під коротшу вкладку, браузер підтягує scrollTop і смуга вкладок
  // «стрибає» під курсором (заміряно: 498 → 526 → 580px у картці співробітника).
  // Mutation-verify: прибрати `style={minHeight ? …}` у modal-tabs.tsx → кейс падає.
  it('перемикання вкладки зберігає видиму частину висоти вмісту, але не більше', async () => {
    const rect = (top: number, height: number) =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      // тіло модалки: видима область закінчується на 600px
      if (this.dataset.scroller) return rect(100, 500);
      // область вмісту вкладки: починається на 400px; «Авто» — довга (900px), решта — короткі
      if (this.classList.contains('pt-4'))
        return rect(400, this.textContent === 'Список авто' ? 900 : 120);
      return rect(0, 0);
    };
    try {
      render(
        <div data-scroller="1" style={{ overflowY: 'auto' }}>
          <ModalTabs tabs={tabs} />
        </div>,
      );
      const content = () => screen.getByText(/Список авто|Історія візитів/).parentElement!;
      expect(content().style.minHeight).toBe('');
      // з довгої вкладки: тримаємо лише видимі 600 − 400 = 200px, а не всі 900
      await userEvent.click(screen.getByRole('button', { name: /Історія/ }));
      expect(content().style.minHeight).toBe('200px');
      // з короткої (120px, уся видима): більше за її власну висоту не тримаємо
      await userEvent.click(screen.getByRole('button', { name: /Авто/ }));
      expect(content().style.minHeight).toBe('120px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
