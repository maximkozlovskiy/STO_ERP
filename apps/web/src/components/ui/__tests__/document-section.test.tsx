import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Wrench } from 'lucide-react';
import i18n from '@/i18n/config';
import { DocumentSection, DocumentSectionEmpty, SectionActionButton } from '../document-section';
import { CollapsibleHeader } from '../collapsible-header';

/**
 * Секція картки документа — варіант A «Картки секцій» (рішення власника 2026-10-22). На заголовок
 * секції спираються тести наряду (`getByText(/Роботи/)` — рівно один збіг), тож назва — одна, в
 * `h3`, а секція підписана нею для читача екрана.
 */
describe('DocumentSection', () => {
  it('назва — заголовок h3, секція — регіон із цією назвою', () => {
    render(
      <DocumentSection icon={Wrench} title="Роботи">
        <p>вміст</p>
      </DocumentSection>,
    );
    const heading = screen.getByRole('heading', { level: 3, name: 'Роботи' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Роботи' })).toContainElement(heading);
    expect(screen.getByText('вміст')).toBeInTheDocument();
  });

  it('лічильник рядків — пігулка з числом, і нуль теж; без count пігулки немає', () => {
    const { rerender } = render(<DocumentSection icon={Wrench} title="Роботи" count={0} />);
    expect(screen.getByTestId('document-section-count')).toHaveTextContent('0');
    rerender(<DocumentSection icon={Wrench} title="Роботи" count={3} />);
    expect(screen.getByTestId('document-section-count')).toHaveTextContent('3');
    rerender(<DocumentSection icon={Wrench} title="Роботи" />);
    expect(screen.queryByTestId('document-section-count')).not.toBeInTheDocument();
  });

  it('лічильник і пояснення — поза заголовком: назва регіону лишається чистою', () => {
    render(
      <DocumentSection icon={Wrench} title="Планування" subtitle="Підйомник і час" count={2} />,
    );
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(/^Планування$/);
    expect(screen.getByText('Підйомник і час')).toBeInTheDocument();
  });

  it('іконка декоративна (aria-hidden), не потрапляє в доступну назву', () => {
    const { container } = render(<DocumentSection icon={Wrench} title="Роботи" />);
    const svg = container.querySelector('svg')!;
    expect(svg.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('дії — праворуч у заголовку, кнопки клікаються; кнопка дії типово type=button', () => {
    const onAdd = vi.fn();
    render(
      <form onSubmit={e => e.preventDefault()}>
        <DocumentSection
          icon={Wrench}
          title="Роботи"
          actions={
            <SectionActionButton variant="accent" onClick={onAdd}>
              Додати
            </SectionActionButton>
          }
        />
      </form>,
    );
    const btn = screen.getByRole('button', { name: 'Додати' });
    expect(btn).toHaveAttribute('type', 'button');
    fireEvent.click(btn);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('flush — вміст без внутрішніх відступів (таблиця на всю ширину картки)', () => {
    const { rerender } = render(
      <DocumentSection icon={Wrench} title="Роботи" flush>
        <table data-testid="t" />
      </DocumentSection>,
    );
    expect(screen.getByTestId('t').parentElement!.className).toBe('');
    rerender(
      <DocumentSection icon={Wrench} title="Роботи">
        <table data-testid="t" />
      </DocumentSection>,
    );
    expect(screen.getByTestId('t').parentElement!.className).toContain('px-5');
  });

  it('порожній стан — пунктирна рамка з підказкою', () => {
    render(<DocumentSectionEmpty>Натисніть «Додати» щоб додати роботу</DocumentSectionEmpty>);
    const box = screen.getByText('Натисніть «Додати» щоб додати роботу');
    expect(box.className).toContain('border-dashed');
  });
});

describe('CollapsibleHeader variant="card" — картка-зведення згорнутої шапки', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('розгорнуто — нічого не рендерить (згортає дія в заголовку секції)', () => {
    const { container } = render(
      <CollapsibleHeader variant="card" collapsed={false} onToggle={vi.fn()} chips={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('згорнуто — чипи і «Розгорнути»; клік розгортає; aria-expanded=false', () => {
    const onToggle = vi.fn();
    render(
      <CollapsibleHeader
        variant="card"
        collapsed
        onToggle={onToggle}
        chips={[{ label: 'Іван Петренко', primary: true }, { label: null }, { label: 'Пост 1' }]}
      />,
    );
    const btn = screen.getByRole('button', { name: /Розгорнути/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Іван Петренко')).toBeInTheDocument();
    expect(screen.getByText('Пост 1')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('en — «Expand»; без чипів — «Expand header»', async () => {
    await i18n.changeLanguage('en');
    render(<CollapsibleHeader variant="card" collapsed onToggle={vi.fn()} chips={[]} />);
    expect(screen.getByText('Expand')).toBeInTheDocument();
    expect(screen.getByText('Expand header')).toBeInTheDocument();
  });
});
