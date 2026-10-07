// MileageHistory — секція «Історія пробігу» картки авто.
// Стереже поведінку, яку легко зламати рефактором:
//   - стани loading (skeleton) / error / empty — кожен окремо, без «порожньої таблиці» замість помилки;
//   - графік лише для ≥2 записів (один запис — тільки таблиця);
//   - приріст рахується від ПОПЕРЕДНЬОГО запису, перший рядок — «—»;
//   - isRollback підсвічує саме свій рядок попередженням (ознаку дає бекенд, UI її не вгадує);
//   - номер наряду — посилання на /work-orders/<id>.
import { render, screen, within, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { VehicleMileagePoint } from '@sto/shared';

interface HookState {
  data: VehicleMileagePoint[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}
const refetchMock = vi.fn(() => Promise.resolve());
let hookState: HookState;
const hookArgs: Array<string | null> = [];

vi.mock('@/hooks/api/useVehicleMileage', () => ({
  useVehicleMileage: (vehicleId: string | null) => {
    hookArgs.push(vehicleId);
    return hookState;
  },
}));

// next/dynamic → синхронний стаб: графік recharts у jsdom має нульовий розмір і нічого не
// малює, а тест перевіряє лише РІШЕННЯ «показувати графік чи ні» та які точки йому передано.
vi.mock('next/dynamic', () => ({
  default: () =>
    function MileageChartStub({ points }: { points: VehicleMileagePoint[] }) {
      return <div data-testid="mileage-chart" data-count={points.length} />;
    },
}));

import { MileageHistory } from '../MileageHistory';

function point(over: Partial<VehicleMileagePoint> = {}): VehicleMileagePoint {
  return {
    workOrderId: 'wo-1',
    workOrderNumber: 'НРД-2026-0001',
    date: '2026-03-01T10:00:00.000Z',
    mileage: 85000,
    isRollback: false,
    ...over,
  };
}

function setHook(over: Partial<HookState>) {
  hookState = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: refetchMock,
    ...over,
  };
}

// fmtInt дає нерозривний/вузький пробіл між тисячами — нормалізуємо до звичайного.
const norm = (s: string | null) => (s ?? '').replace(/[  ]/g, ' ');

describe('MileageHistory', () => {
  beforeEach(() => {
    refetchMock.mockClear();
    hookArgs.length = 0;
    setHook({});
  });

  it('передає vehicleId у хук і показує заголовок секції', () => {
    setHook({ data: [] });
    render(<MileageHistory vehicleId="v-42" />);

    expect(hookArgs).toContain('v-42');
    expect(screen.getByRole('heading', { name: 'Історія пробігу' })).toBeInTheDocument();
  });

  it('завантаження → skeleton, без таблиці й без порожнього стану', () => {
    setHook({ isLoading: true });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByTestId('mileage-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Ще немає нарядів із зафіксованим пробігом')).not.toBeInTheDocument();
  });

  it('помилка → текст помилки бекенду + «Повторити» викликає refetch; порожній стан не показано', () => {
    setHook({ isError: true, error: new Error('Автомобіль не знайдено') });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Автомобіль не знайдено');
    expect(screen.queryByText('Ще немає нарядів із зафіксованим пробігом')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('помилка без повідомлення → загальний текст «Помилка завантаження»', () => {
    setHook({ isError: true, error: new Error('') });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Помилка завантаження');
  });

  it('порожній масив → «Ще немає нарядів із зафіксованим пробігом», без графіка й таблиці', () => {
    setHook({ data: [] });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByText('Ще немає нарядів із зафіксованим пробігом')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mileage-chart')).not.toBeInTheDocument();
  });

  it('один запис → лише таблиця, графіка немає; приріст першого рядка — «—»', () => {
    setHook({ data: [point()] });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.queryByTestId('mileage-chart')).not.toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(2); // заголовок + 1 запис
    const cells = within(rows[1]!).getAllByRole('cell');
    expect(norm(cells[2]!.textContent)).toBe('85 000');
    expect(cells[3]!.textContent).toBe('—');
  });

  it('два й більше записів → графік з усіма точками + приріст від попереднього запису', () => {
    setHook({
      data: [
        point({ workOrderId: 'wo-1', workOrderNumber: 'НРД-2026-0001', mileage: 85000 }),
        point({
          workOrderId: 'wo-2',
          workOrderNumber: 'НРД-2026-0002',
          date: '2026-06-01T10:00:00.000Z',
          mileage: 91250,
        }),
        point({
          workOrderId: 'wo-3',
          workOrderNumber: 'НРД-2026-0003',
          date: '2026-09-01T10:00:00.000Z',
          mileage: 91250,
        }),
      ],
    });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByTestId('mileage-chart')).toHaveAttribute('data-count', '3');

    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(4);
    // Порядок контракту (від старішого до новішого) збережено — UI не пересортовує.
    expect(rows[1]).toHaveTextContent('НРД-2026-0001');
    expect(rows[3]).toHaveTextContent('НРД-2026-0003');
    expect(norm(within(rows[2]!).getAllByRole('cell')[3]!.textContent)).toBe('+6 250');
    expect(within(rows[3]!).getAllByRole('cell')[3]!.textContent).toBe('0');
  });

  it('дата у форматі DD.MM.YYYY за Києвом: 22:30Z 31.05 → 01.06 (не день UTC)', () => {
    setHook({ data: [point({ date: '2026-05-31T22:30:00.000Z' })] });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByText('01.06.2026')).toBeInTheDocument();
  });

  it('номер наряду — посилання на /work-orders/<id>', () => {
    setHook({ data: [point({ workOrderId: 'wo-77', workOrderNumber: 'НРД-2026-0077' })] });
    render(<MileageHistory vehicleId="v-1" />);

    expect(screen.getByRole('link', { name: 'НРД-2026-0077' })).toHaveAttribute(
      'href',
      '/work-orders/wo-77',
    );
  });

  it('isRollback → попередження лише у своєму рядку + від’ємний приріст', () => {
    setHook({
      data: [
        point({ workOrderId: 'wo-1', workOrderNumber: 'НРД-2026-0001', mileage: 85000 }),
        point({
          workOrderId: 'wo-2',
          workOrderNumber: 'НРД-2026-0002',
          date: '2026-06-01T10:00:00.000Z',
          mileage: 84200,
          isRollback: true,
        }),
      ],
    });
    render(<MileageHistory vehicleId="v-1" />);

    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).not.toHaveAttribute('data-rollback');
    expect(rows[1]).not.toHaveTextContent('Пробіг менший за попередній');
    expect(rows[2]).toHaveAttribute('data-rollback', 'true');
    expect(rows[2]).toHaveTextContent('Пробіг менший за попередній');
    expect(norm(within(rows[2]!).getAllByRole('cell')[3]!.textContent)).toBe('−800');
  });

  it('попередження керується прапорцем бекенду, а не власним порівнянням пробігу', () => {
    // Пробіг зріс, але бекенд позначив запис як відкат (напр. попередній запис поза вікном 200).
    setHook({
      data: [
        point({ workOrderId: 'wo-1', mileage: 85000 }),
        point({
          workOrderId: 'wo-2',
          workOrderNumber: 'НРД-2026-0002',
          mileage: 86000,
          isRollback: true,
        }),
        // …і навпаки: менший пробіг без прапорця попередженням НЕ підсвічується.
        point({ workOrderId: 'wo-3', workOrderNumber: 'НРД-2026-0003', mileage: 85500 }),
      ],
    });
    render(<MileageHistory vehicleId="v-1" />);

    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[2]).toHaveAttribute('data-rollback', 'true');
    expect(rows[3]).not.toHaveAttribute('data-rollback');
    expect(screen.getAllByText('Пробіг менший за попередній')).toHaveLength(1);
  });
});
