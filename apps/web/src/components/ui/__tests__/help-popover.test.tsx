// Спільна кнопка «?» з поясненням (`HelpPopover`, з легенди календаря BR-CAL-009): вікно
// відкривається й закривається кнопкою, кліком поза ним, виходом фокусу; Escape закриває лише його
// (верхній шар), а модалку під ним — ні; фокус повертається на кнопку; на 390 px вікно не виходить
// за край екрана; розділи з каталогу i18n малюються структуровано.
//
// Mutation-verify (2026-10-29): прибрати `useEscapeLayer` (Escape — лише модалці) → падає
// «Escape у модалці»; прибрати обмеження `maxLeft` → падає «390 px»; прибрати перенесення над
// кнопкою → падає «над кнопкою»; `HelpBlocks` без фільтра `isEntry` → падає «не того вигляду».
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../modal';
import { HelpBlocks, HelpItem, HelpPopover, HelpSection, placeHelpPanel } from '../help-popover';

const LABEL = 'Як рахується звіт';
const TITLE = 'Завантаженість';

function Popover() {
  return (
    <HelpPopover label={LABEL} title={TITLE}>
      <HelpSection title="Місткість">
        <HelpItem term="Робочий день">години філії</HelpItem>
      </HelpSection>
    </HelpPopover>
  );
}

describe('HelpPopover', () => {
  it('кнопка відкриває вікно з заголовком і розділами; фокус — у вікні', () => {
    render(<Popover />);
    const button = screen.getByRole('button', { name: LABEL });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: TITLE });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveFocus();
    expect(within(panel).getByText('Місткість')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Робочий день — години філії');
  });

  it('повторний клік, клік поза вікном і вихід фокусу закривають; клік усередині — ні', () => {
    render(
      <>
        <Popover />
        <button type="button">поза</button>
      </>,
    );
    const button = screen.getByRole('button', { name: LABEL });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByText('Місткість'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'поза' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    const panel = screen.getByRole('dialog');
    fireEvent.blur(panel, { relatedTarget: null });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.blur(panel, { relatedTarget: screen.getByRole('button', { name: 'поза' }) });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape закриває вікно й повертає фокус на кнопку', () => {
    render(<Popover />);
    const button = screen.getByRole('button', { name: LABEL });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull();
    expect(button).toHaveFocus();
  });

  it('Escape у модалці: перший — лише «?», другий — модалка', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Співробітник">
        <Popover />
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('placeHelpPanel — позиція вікна', () => {
  const phone = { width: 390, height: 844 };

  it('390 px: кнопка біля лівого краю, вікно 320 px — не виходить за лівий край', () => {
    const p = placeHelpPanel(
      { top: 100, bottom: 132, left: 20, right: 52 },
      { width: 320, height: 200 },
      phone,
      'end',
    );
    expect(p.left).toBe(16);
    expect(p.top).toBe(138);
  });

  it('390 px: кнопка біля правого краю, align start — не виходить за правий край', () => {
    const p = placeHelpPanel(
      { top: 100, bottom: 132, left: 350, right: 382 },
      { width: 320, height: 200 },
      phone,
      'start',
    );
    expect(p.left + 320).toBeLessThanOrEqual(390 - 16);
  });

  it('знизу не вміщається, зверху місця більше — над кнопкою', () => {
    const p = placeHelpPanel(
      { top: 700, bottom: 732, left: 200, right: 232 },
      { width: 320, height: 400 },
      phone,
      'end',
    );
    expect(p.top + 400).toBeLessThanOrEqual(700);
    expect(p.top).toBeGreaterThanOrEqual(16);
  });
});

describe('HelpBlocks — розділи з каталогу', () => {
  it('рядок — абзац, { term, text } — термін і пояснення; не того вигляду — пропускається', () => {
    render(
      <HelpBlocks
        blocks={[
          {
            title: 'Що рахує',
            items: ['Години записів', { term: 'Місткість', text: 'робочий час' }],
          },
          { items: [42, { term: 'без тексту' }] },
        ]}
      />,
    );
    expect(screen.getByText('Що рахує')).toBeInTheDocument();
    expect(screen.getByText('Години записів')).toBeInTheDocument();
    expect(screen.getByText('Місткість').parentElement).toHaveTextContent(
      'Місткість — робочий час',
    );
    expect(screen.queryByText('без тексту')).toBeNull();
  });

  it('ключ не знайдено (рядок замість масиву) — нічого', () => {
    const { container } = render(<HelpBlocks blocks="help.missing" />);
    expect(container).toBeEmptyDOMElement();
  });
});
