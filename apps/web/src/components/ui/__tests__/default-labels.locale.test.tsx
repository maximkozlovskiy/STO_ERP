import { render, screen } from '@testing-library/react';
import { it, expect, describe, afterEach, vi } from 'vitest';
import i18n from '@/i18n/config';
import { CollapsibleHeader } from '../collapsible-header';
import { ExpiryBadge } from '../expiry-badge';

/**
 * Типові підписи спільних компонентів — з локалі, як у ConfirmDialog (Bug #911).
 * Без пропа англійський інтерфейс показував «Розгорнути шапку», «Шапка документа»,
 * «Закінчується» (страховка й техогляд у картці авто передають лише expiredLabel).
 */
describe('типові підписи за мовою інтерфейсу', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('CollapsibleHeader: згорнута шапка без чипів — «Expand header» / «Expand»', async () => {
    await i18n.changeLanguage('en');
    render(<CollapsibleHeader collapsed onToggle={vi.fn()} chips={[{ label: null }]} />);
    expect(screen.getByText('Expand header')).toBeInTheDocument();
    expect(screen.getByText('Expand')).toBeInTheDocument();
  });

  it('CollapsibleHeader: розгорнута — «Document header» / «Collapse»', async () => {
    await i18n.changeLanguage('en');
    render(<CollapsibleHeader collapsed={false} onToggle={vi.fn()} chips={[]} />);
    expect(screen.getByText('Document header')).toBeInTheDocument();
    expect(screen.getByText('Collapse')).toBeInTheDocument();
  });

  it('CollapsibleHeader: uk — українські підписи, emptyLabel з пропа має перевагу', () => {
    const { rerender } = render(
      <CollapsibleHeader collapsed={false} onToggle={vi.fn()} chips={[]} />,
    );
    expect(screen.getByText('Шапка документа')).toBeInTheDocument();
    expect(screen.getByText('Згорнути')).toBeInTheDocument();
    rerender(<CollapsibleHeader collapsed onToggle={vi.fn()} chips={[]} emptyLabel="Свій" />);
    expect(screen.getByText('Свій')).toBeInTheDocument();
    expect(screen.queryByText('Розгорнути шапку')).not.toBeInTheDocument();
  });

  it('ExpiryBadge: «скоро» без soonLabel — «Expiring soon» в en, «Закінчується» в uk', async () => {
    const now = Date.UTC(2026, 9, 19, 12);
    const in10Days = new Date(now + 10 * 86_400_000).toISOString();
    await i18n.changeLanguage('en');
    const { rerender } = render(<ExpiryBadge date={in10Days} nowMs={now} expiredLabel="Expired" />);
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    await i18n.changeLanguage('uk');
    rerender(<ExpiryBadge date={in10Days} nowMs={now} expiredLabel="Прострочено" />);
    expect(screen.getByText('Закінчується')).toBeInTheDocument();
  });
});
