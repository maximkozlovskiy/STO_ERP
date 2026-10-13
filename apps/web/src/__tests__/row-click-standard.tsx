// Спільний набір кейсів «стандарт кліку по рядку» для списків з боковою панеллю
// (рішення власника 2026-10-13, правило — `lib/row-activation.ts`):
//
//   панель УВІМКНЕНА → клік по рядку показує панель, повторний клік по тому самому рядку її ховає,
//                      картка НЕ відкривається;
//   панель ВИМКНЕНА  → клік відкриває картку;
//   олівець          → картка в обох режимах, рядок при цьому не вибирається;
//   кнопка в панелі  → картка;
//   вимкнули панель  → вибір скинуто (після вмикання клік знову ПОКАЗУЄ панель, а не ховає).
//
// Кожен список підключає набір своїм тестом: дає власні моки й каже, як знайти рядок, олівець
// і картку. Так стандарт перевіряється однаково всюди, а не дев'ятьма різними формулюваннями.
//
// Що ловить (мутацію не проганяв): у будь-якому списку замінити `open:` у activateRow на `undefined`
// → падає «панель вимкнена: клік відкриває картку»; повернути `detailPanel.enabled && select()`
// без deselect → падає «повторний клік ховає».

import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { it, expect } from 'vitest';

export interface RowClickStandardConfig {
  /** Рендерить сторінку (моки вже стоять). */
  renderPage: () => void;
  /** Суфікс ключа localStorage тоглу панелі: `sto_detail_panel_<key>`. */
  panelKey: string;
  /** Текст, за яким знаходиться рядок таблиці, і заголовок панелі цього рядка. */
  rowText: string;
  panelTitle: string;
  /** Олівець у рядку. */
  pencil: (row: HTMLElement) => HTMLElement;
  /** Назва кнопки «Відкрити …» у панелі; `null` — картки у списку немає. */
  panelButton: string | null;
  /** Чи відкрита картка першого рядка. `null` — картки у списку немає. */
  isCardOpen: (() => boolean) | null;
}

/** Рядок таблиці за текстом у ньому (текст може стояти ще й у заголовку панелі). */
export const tableRow = (text: string): HTMLElement =>
  screen
    .getAllByText(text)
    .map(el => el.closest('tr'))
    .find((tr): tr is HTMLTableRowElement => tr !== null)!;

/** Панель показує рядок, коли її заголовок (<h2>) — назва цього рядка. */
export const panelShows = (title: string): boolean =>
  screen.queryAllByRole('heading', { level: 2 }).some(h => h.textContent === title);

export function itFollowsRowClickStandard(cfg: RowClickStandardConfig) {
  const lsKey = `sto_detail_panel_${cfg.panelKey}`;
  const row = () => tableRow(cfg.rowText);
  const cardOpen = () => (cfg.isCardOpen ? cfg.isCardOpen() : false);

  const renderWithPanel = async (enabled: boolean) => {
    if (!enabled) localStorage.setItem(lsKey, 'false');
    cfg.renderPage();
    await screen.findAllByText(cfg.rowText);
    // Тогл читає localStorage після монтування — чекаємо, доки стан панелі застосується.
    await screen.findByRole('button', {
      name: enabled ? 'Сховати бокову панель' : 'Показати бокову панель',
    });
  };

  it('панель увімкнена: клік показує панель, повторний клік по тому самому рядку ховає; картка не відкривається', async () => {
    await renderWithPanel(true);
    expect(panelShows(cfg.panelTitle)).toBe(false);

    fireEvent.click(row());
    await waitFor(() => expect(panelShows(cfg.panelTitle)).toBe(true));
    expect(cardOpen()).toBe(false);

    fireEvent.click(row());
    await waitFor(() => expect(panelShows(cfg.panelTitle)).toBe(false));
    expect(cardOpen()).toBe(false);
  });

  if (cfg.isCardOpen) {
    it('панель вимкнена: клік по рядку відкриває картку, панель не з’являється', async () => {
      await renderWithPanel(false);

      fireEvent.click(row());

      await waitFor(() => expect(cardOpen()).toBe(true));
      expect(panelShows(cfg.panelTitle)).toBe(false);
    });

    it.each([
      ['увімкнена', true],
      ['вимкнена', false],
    ])('олівець (панель %s) відкриває картку і рядок не вибирає', async (_n, enabled) => {
      await renderWithPanel(enabled);

      fireEvent.click(cfg.pencil(row()));

      await waitFor(() => expect(cardOpen()).toBe(true));
      expect(panelShows(cfg.panelTitle)).toBe(false);
    });
  } else {
    it('панель вимкнена: картки у списку немає — клік нічого не відкриває', async () => {
      await renderWithPanel(false);

      fireEvent.click(row());

      expect(panelShows(cfg.panelTitle)).toBe(false);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  }

  if (cfg.panelButton && cfg.isCardOpen) {
    const name = cfg.panelButton;
    it(`кнопка «${name}» у панелі відкриває картку`, async () => {
      await renderWithPanel(true);
      fireEvent.click(row());
      await waitFor(() => expect(panelShows(cfg.panelTitle)).toBe(true));
      expect(cardOpen()).toBe(false);

      // Кнопка панелі — з видимим текстом; олівець у рядку має лише title.
      const heading = screen
        .getAllByRole('heading', { level: 2 })
        .find(h => h.textContent === cfg.panelTitle)!;
      // Корінь DetailPanel — найближчий блок-картка довкола заголовка.
      const panel = heading.closest<HTMLElement>('.rounded-xl')!;
      fireEvent.click(within(panel).getByText(name));

      await waitFor(() => expect(cardOpen()).toBe(true));
    });
  }

  it('вимкнули панель тоглом → вибір скинуто: після вмикання клік по тому ж рядку ПОКАЗУЄ панель', async () => {
    await renderWithPanel(true);
    fireEvent.click(row());
    await waitFor(() => expect(panelShows(cfg.panelTitle)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Сховати бокову панель' }));
    await waitFor(() => expect(panelShows(cfg.panelTitle)).toBe(false));
    expect(localStorage.getItem(lsKey)).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Показати бокову панель' }));
    // Сам собою рядок у панель не повертається…
    expect(panelShows(cfg.panelTitle)).toBe(false);
    // …а клік його показує (якби вибір «залип», клік сховав би панель).
    fireEvent.click(row());
    await waitFor(() => expect(panelShows(cfg.panelTitle)).toBe(true));
    expect(cardOpen()).toBe(false);
  });
}
