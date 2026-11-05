// Одиниці виміру: рядок, клік по якому відкриває редагування, доступний з клавіатури (TableRow,
// TECH-DEBT (б) №27); системна одиниця не редагується — її рядок без дії не стає зупинкою Tab
// (Bug #1045). Мутація: повернути безумовний `onClick` у UnitsTab.tsx → кейс червоний.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { tableRow } from '@/__tests__/row-click-standard';

const UNITS = [
  { id: 'u-sys', name: 'Штука', shortName: 'шт', isSystem: true, coefficient: 1 },
  { id: 'u-own', name: 'Упаковка', shortName: 'Пак', isSystem: false, coefficient: 10 },
];

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(UNITS)),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

import UnitsTab from '../UnitsTab';

describe('Одиниці виміру — рядок з клавіатури', () => {
  it('системна одиниця — рядок без дії поза порядком Tab; власна — у ньому, Enter відкриває редагування', async () => {
    render(<UnitsTab />);
    await screen.findByText('Пак');

    const sys = tableRow('Штука');
    expect(sys).not.toHaveAttribute('tabindex');
    expect(sys).not.toHaveClass('cursor-pointer');

    const own = tableRow('Упаковка');
    expect(own).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(own, { key: 'Enter' });
    expect(await screen.findByDisplayValue('Упаковка')).toBeInTheDocument();
  });
});
