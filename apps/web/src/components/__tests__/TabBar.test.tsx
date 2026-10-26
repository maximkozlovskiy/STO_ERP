// Вкладки згорнутих карток з клавіатури (TECH-DEBT §9 п.2): назва вкладки — кнопка, тож Tab її
// фокусує, а Enter відкриває картку; закриття — окрема сусідня кнопка (не вкладена). Те саме в меню
// переповнення (вкладки понад 10), де кнопка закриття має доступну назву.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { Tab } from '@/contexts/TabBarContext';

const activateTab = vi.fn();
const closeTab = vi.fn();
let tabs: Tab[] = [];
vi.mock('@/hooks/useTabBar', () => ({
  useTabBar: () => ({ tabs, activateTab, closeTab }),
}));

import { TabBar } from '../TabBar';

const tab = (n: number) => ({ id: `t-${n}`, label: `Наряд НР-${n}` }) as unknown as Tab;

beforeEach(() => {
  activateTab.mockReset();
  closeTab.mockReset();
  tabs = [tab(1), tab(2)];
});

describe('TabBar — клавіатура', () => {
  it('Tab фокусує вкладку, Enter відкриває її', async () => {
    const user = userEvent.setup();
    render(<TabBar />);
    await user.tab();
    const first = screen.getByRole('button', { name: 'Наряд НР-1' });
    expect(first).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(activateTab).toHaveBeenCalledWith('t-1');
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('закриття — сусідня кнопка, не вкладена: Enter на ній закриває, а не відкриває', async () => {
    const user = userEvent.setup();
    render(<TabBar />);
    const close = screen.getAllByRole('button', { name: 'Закрити вкладку' })[0]!;
    expect(close.closest('button')).toBe(close);
    expect(close.parentElement?.closest('button')).toBeNull();
    await user.tab();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(closeTab).toHaveBeenCalledWith('t-1');
    expect(activateTab).not.toHaveBeenCalled();
  });

  it('меню переповнення: пункт — кнопка, Enter відкриває вкладку; закриття має доступну назву', async () => {
    tabs = Array.from({ length: 11 }, (_, i) => tab(i + 1));
    const user = userEvent.setup();
    render(<TabBar />);
    await user.click(screen.getByRole('button', { name: '1' }));
    const hidden = screen.getByRole('button', { name: 'Наряд НР-11' });
    hidden.focus();
    await user.keyboard('{Enter}');
    expect(activateTab).toHaveBeenCalledWith('t-11');

    await user.click(screen.getByRole('button', { name: '1' }));
    const closes = screen.getAllByRole('button', { name: 'Закрити вкладку' });
    // 10 видимих + 1 у меню (кнопка меню показує, скільки вкладок сховано).
    expect(closes).toHaveLength(11);
    await user.click(closes[10]!);
    expect(closeTab).toHaveBeenCalledWith('t-11');
  });
});
