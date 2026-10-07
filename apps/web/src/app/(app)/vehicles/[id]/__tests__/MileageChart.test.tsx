// MileageChart — РЕАЛЬНИЙ рендер recharts (у MileageHistory.test.tsx графік — стаб).
// ResponsiveContainer у jsdom має нульовий розмір і нічого не малює, тому підміняємо лише
// його: дитині (LineChart) напряму задаємо 600×220. Усе інше — справжній recharts.
// Стереже те, чого не видно з tsc:
//   - вісь X часова: відстань між точками пропорційна часу, а не порядковому номеру;
//   - підпис осі — дата за Києвом, а не за UTC чи поясом машини;
//   - точка відкату (isRollback) більша й попереджувального кольору;
//   - підказка бере фон і колір тексту з токенів теми (типовий білий ламає темну тему).
import { cloneElement, type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import type { VehicleMileagePoint } from '@sto/shared';

vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>;
    }) => cloneElement(children, { width: 600, height: 220 }),
  };
});

import MileageChart from '../MileageChart';

// Перший запис — 22:30 UTC 10 січня = 00:30 11 січня за Києвом (UTC+2 узимку).
const points: VehicleMileagePoint[] = [
  {
    workOrderId: 'a',
    workOrderNumber: 'НРД-1',
    date: '2026-01-10T22:30:00.000Z',
    mileage: 80000,
    isRollback: false,
  },
  {
    workOrderId: 'b',
    workOrderNumber: 'НРД-2',
    date: '2026-03-01T10:00:00.000Z',
    mileage: 85000,
    isRollback: false,
  },
  {
    workOrderId: 'c',
    workOrderNumber: 'НРД-3',
    date: '2026-03-02T10:00:00.000Z',
    mileage: 84000,
    isRollback: true,
  },
  {
    workOrderId: 'd',
    workOrderNumber: 'НРД-4',
    date: '2026-09-20T10:00:00.000Z',
    mileage: 99000,
    isRollback: false,
  },
];

function attr(el: Element | undefined, name: string): string | null {
  return el ? el.getAttribute(name) : null;
}

function renderChart(data: VehicleMileagePoint[] = points) {
  const { container } = render(<MileageChart points={data} />);
  const dots = [...container.querySelectorAll('.recharts-line-dots circle')];
  const xs = dots.map(d => Number(d.getAttribute('cx')));
  const ys = dots.map(d => Number(d.getAttribute('cy')));
  return { container, dots, xs, ys };
}

describe('MileageChart — реальний рендер recharts', () => {
  it('малює по точці на кожен запис, зліва направо в порядку записів', () => {
    const { dots, xs } = renderChart();
    expect(dots).toHaveLength(points.length);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('вісь X часова: день між записами — крихта ширини, а не рівний крок', () => {
    const { xs } = renderChart();
    const sevenWeeks = Number(xs[1]) - Number(xs[0]);
    const oneDay = Number(xs[2]) - Number(xs[1]);
    const halfYear = Number(xs[3]) - Number(xs[2]);
    expect(oneDay).toBeGreaterThan(0);
    // На категоріальній осі всі три проміжки були б рівні.
    expect(sevenWeeks).toBeGreaterThan(oneDay * 20);
    expect(halfYear).toBeGreaterThan(sevenWeeks * 2);
  });

  it('більший пробіг — вище на графіку (менший cy), відкат — нижче за попередню точку', () => {
    const { ys } = renderChart();
    expect(Number(ys[1])).toBeLessThan(Number(ys[0]));
    expect(Number(ys[2])).toBeGreaterThan(Number(ys[1])); // 84 000 після 85 000
    expect(Number(ys[3])).toBeLessThan(Number(ys[2]));
  });

  it('точка відкату — більша й попереджувального кольору, решта — основного', () => {
    const { dots } = renderChart();
    expect(attr(dots[2], 'fill')).toBe('var(--color-warning)');
    expect(attr(dots[2], 'r')).toBe('5');
    for (const i of [0, 1, 3]) {
      expect(attr(dots[i], 'fill')).toBe('var(--color-primary)');
      expect(attr(dots[i], 'r')).toBe('3');
    }
  });

  it('Bug #798: записи одного дня з датою, що «йде назад», не малюють лінію справа наліво', () => {
    // Порядок бекенду в межах дня — за номером наряду: спершу завершений (17:23Z), потім
    // відкритий того ж дня (дата без часу → 00:00Z). X другої точки не може бути лівіше.
    const sameDay: VehicleMileagePoint[] = [
      { ...points[0]!, date: '2026-10-01T09:00:00.000Z', mileage: 50000 },
      { ...points[1]!, date: '2026-10-07T17:23:57.000Z', mileage: 50100 },
      { ...points[3]!, date: '2026-10-07T00:00:00.000Z', mileage: 50200 },
    ];
    const { dots, xs, ys } = renderChart(sameDay);
    expect(dots).toHaveLength(3);
    expect(Number(xs[2])).toBeGreaterThanOrEqual(Number(xs[1]));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(Number(ys[2])).toBeLessThan(Number(ys[1])); // 50 200 вище за 50 100
  });

  it('підпис осі X — дата за Києвом: 22:30 UTC 10.01 показано як 11.01', () => {
    const { container } = renderChart();
    const labels = [...container.querySelectorAll('.recharts-xAxis-tick-labels text')].map(
      el => el.textContent,
    );
    expect(labels).toContain('11.01.2026');
    expect(labels).not.toContain('10.01.2026');
  });

  it('підказка бере фон і колір тексту з токенів теми, а не типовий білий recharts', () => {
    const { container } = renderChart();
    const tooltip = container.querySelector<HTMLElement>('.recharts-default-tooltip');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.style.backgroundColor).toBe('var(--color-surface-raised)');
    expect(tooltip?.style.color).toBe('var(--color-foreground)');
  });
});
