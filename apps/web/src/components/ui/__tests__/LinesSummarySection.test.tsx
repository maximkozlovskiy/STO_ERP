// LinesSummarySection — блок «Зведення» / «Виконавці» бокової панелі списків (BR-WO-009/010).
// Стереже: усі чотири стани запиту, українську множину (1 / 2 / 5), правило «N рядків лише
// коли positions ≠ distinct», нормо-години проти одиниць, порожнє ім'я виконавця, «Повторити».
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { LinesSummary, LinesSummaryTable } from '@/hooks/api/useLinesSummary';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { LinesSummarySection } from '../LinesSummarySection';

function renderSection(props: Partial<React.ComponentProps<typeof LinesSummarySection>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LinesSummarySection entity="work-orders" id="wo-1" {...props} />
    </QueryClientProvider>,
  );
}

const table = (over: Partial<LinesSummaryTable>): LinesSummaryTable => ({
  key: 'goods',
  positions: 1,
  distinct: 1,
  quantity: 1,
  quantityUnit: 'units',
  ...over,
});
const summary = (over: Partial<LinesSummary>): LinesSummary => ({
  tables: [],
  executors: [],
  ...over,
});
const rowText = async (key: string) =>
  (await screen.findByTestId(`lines-summary-${key}`)).querySelector('dd')!.textContent;

describe('LinesSummarySection', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  describe('стани запиту', () => {
    it('без id або з enabled=false нічого не рендерить і не питає сервер', () => {
      const a = renderSection({ id: null });
      expect(a.container).toBeEmptyDOMElement();
      a.unmount();
      const b = renderSection({ enabled: false });
      expect(b.container).toBeEmptyDOMElement();
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('завантаження — «Завантаження…» під заголовком «Зведення»', () => {
      apiFetchMock.mockReturnValue(new Promise(() => undefined));
      renderSection();
      expect(screen.getByText('Зведення')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Завантаження…');
    });

    it('документ без рядків — «Рядків немає», без підказки й без «Виконавців»', async () => {
      apiFetchMock.mockResolvedValue(summary({}));
      renderSection();
      expect(await screen.findByText('Рядків немає')).toBeInTheDocument();
      expect(screen.queryByText(/проста сума/)).not.toBeInTheDocument();
      expect(screen.queryByText('Виконавці')).not.toBeInTheDocument();
    });

    it('помилка — текст сервера як alert, а не порожній блок', async () => {
      apiFetchMock.mockRejectedValue(new Error('Наряд не знайдено'));
      renderSection();
      expect(await screen.findByRole('alert')).toHaveTextContent('Наряд не знайдено');
      expect(screen.queryByText('Рядків немає')).not.toBeInTheDocument();
    });

    it('помилка без тексту → загальне повідомлення українською', async () => {
      apiFetchMock.mockRejectedValue({ status: 500 });
      renderSection();
      expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося завантажити зведення');
    });

    it('«Повторити» перезапитує сервер і показує дані', async () => {
      apiFetchMock.mockRejectedValueOnce(new Error('Збій мережі'));
      renderSection();
      await screen.findByRole('alert');
      expect(apiFetchMock).toHaveBeenCalledTimes(1);

      apiFetchMock.mockResolvedValueOnce(
        summary({ tables: [table({ distinct: 3, positions: 3 })] }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));

      expect(await rowText('goods')).toBe('3 найменування · 1 од.');
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('запит іде на ендпоінт своєї сутності', async () => {
      apiFetchMock.mockResolvedValue(summary({}));
      renderSection({ entity: 'supplier-returns', id: 'sr-9' });
      await screen.findByText('Рядків немає');
      expect(apiFetchMock.mock.calls[0]![0]).toBe('/supplier-returns/sr-9/lines-summary');
    });
  });

  describe('текст рядків', () => {
    it('порядок таблиць — як віддав сервер; підписи українською; числа tabular-nums', async () => {
      apiFetchMock.mockResolvedValue(
        summary({
          tables: [
            table({
              key: 'works',
              positions: 5,
              distinct: 5,
              quantity: 7.5,
              quantityUnit: 'hours',
            }),
            table({ key: 'goods', positions: 4, distinct: 3, quantity: 12 }),
            table({ key: 'other', positions: 2, distinct: 2, quantity: 6 }),
          ],
        }),
      );
      renderSection();
      expect(await rowText('works')).toBe('5 позицій · 7,5 н-год');
      expect(await rowText('goods')).toBe('3 найменування · 12 од. · 4 рядки');
      expect(await rowText('other')).toBe('2 рядки · 6 од.');

      const labels = [...document.querySelectorAll('[data-testid="lines-summary"] dt')].map(
        el => el.textContent,
      );
      expect(labels).toEqual(['Роботи', 'Товари', 'Інше']);
      expect(screen.getByTestId('lines-summary-works').querySelector('dd')).toHaveClass(
        'tabular-nums',
      );
      expect(screen.getByText(/проста сума по рядках/)).toBeInTheDocument();
    });

    it.each([
      [1, '1 позиція'],
      [2, '2 позиції'],
      [5, '5 позицій'],
      [21, '21 позиція'],
      [11, '11 позицій'],
    ])('роботи: %i → «%s»', async (n, text) => {
      apiFetchMock.mockResolvedValue(
        summary({
          tables: [
            table({ key: 'works', positions: n, distinct: n, quantity: 1, quantityUnit: 'hours' }),
          ],
        }),
      );
      renderSection();
      expect(await rowText('works')).toBe(`${text} · 1 н-год`);
    });

    it.each([
      [1, '1 найменування'],
      [2, '2 найменування'],
      [5, '5 найменувань'],
    ])('товари: %i → «%s», без «рядків», коли positions = distinct', async (n, text) => {
      apiFetchMock.mockResolvedValue(
        summary({ tables: [table({ positions: n, distinct: n, quantity: 2 })] }),
      );
      renderSection();
      expect(await rowText('goods')).toBe(`${text} · 2 од.`);
    });

    it.each([
      [1, '1 рядок'],
      [2, '2 рядки'],
      [5, '5 рядків'],
    ])('інше: %i → «%s»', async (n, text) => {
      apiFetchMock.mockResolvedValue(
        summary({ tables: [table({ key: 'other', positions: n, distinct: n, quantity: 3 })] }),
      );
      renderSection();
      expect(await rowText('other')).toBe(`${text} · 3 од.`);
    });

    it('товари: той самий товар у двох рядках → «1 найменування · … · 2 рядки»', async () => {
      apiFetchMock.mockResolvedValue(
        summary({ tables: [table({ positions: 2, distinct: 1, quantity: 0.1 + 0.2 })] }),
      );
      renderSection();
      // 0.30000000000000004 з float-суми не має потрапити на екран.
      expect(await rowText('goods')).toBe('1 найменування · 0,3 од. · 2 рядки');
    });

    it('роботи наряду: та сама робота двічі → «(різних робіт: M)»', async () => {
      apiFetchMock.mockResolvedValue(
        summary({
          tables: [
            table({ key: 'works', positions: 3, distinct: 2, quantity: 4, quantityUnit: 'hours' }),
          ],
        }),
      );
      renderSection();
      expect(await rowText('works')).toBe('3 позиції · 4 н-год (різних робіт: 2)');
    });

    it('роботи рахунку (quantityUnit: units) — одиниці, а не нормо-години', async () => {
      apiFetchMock.mockResolvedValue(
        summary({ tables: [table({ key: 'works', positions: 2, distinct: 2, quantity: 2 })] }),
      );
      renderSection({ entity: 'invoices', id: 'inv-1' });
      expect(await rowText('works')).toBe('2 позиції · 2 од.');
    });
  });

  describe('виконавці', () => {
    it('порожній executors — блоку «Виконавці» немає', async () => {
      apiFetchMock.mockResolvedValue(summary({ tables: [table({})] }));
      renderSection();
      await screen.findByTestId('lines-summary-goods');
      expect(screen.queryByText('Виконавці')).not.toBeInTheDocument();
    });

    it('ім’я + роботи й нормо-години, у порядку сервера; множина 1 / 2 / 5', async () => {
      apiFetchMock.mockResolvedValue(
        summary({
          tables: [
            table({ key: 'works', positions: 8, distinct: 8, quantity: 9, quantityUnit: 'hours' }),
          ],
          executors: [
            { employeeId: 'e2', name: 'Сидоренко Олег', works: 5, normoHours: 4.5 },
            { employeeId: 'e1', name: 'Петренко Іван', works: 2, normoHours: 3 },
            { employeeId: 'e3', name: 'Бойко Ганна', works: 1, normoHours: 1.5 },
          ],
        }),
      );
      renderSection();
      const list = await screen.findByTestId('lines-summary-executors');
      expect(screen.getByText('Виконавці')).toBeInTheDocument();
      const rows = [...list.querySelectorAll('div')].map(el => [
        el.querySelector('dt')!.textContent,
        el.querySelector('dd')!.textContent,
      ]);
      expect(rows).toEqual([
        ['Сидоренко Олег', '5 робіт · 4,5 н-год'],
        ['Петренко Іван', '2 роботи · 3 н-год'],
        ['Бойко Ганна', '1 робота · 1,5 н-год'],
      ]);
      expect(list.querySelector('dd')).toHaveClass('tabular-nums');
    });

    it('порожнє ім’я (картку працівника не знайдено) → «Працівника не знайдено»', async () => {
      apiFetchMock.mockResolvedValue(
        summary({
          tables: [
            table({ key: 'works', positions: 1, distinct: 1, quantity: 1, quantityUnit: 'hours' }),
          ],
          executors: [{ employeeId: 'gone', name: '', works: 1, normoHours: 1 }],
        }),
      );
      renderSection();
      const list = await screen.findByTestId('lines-summary-executors');
      expect(within(list).getByText('Працівника не знайдено')).toBeInTheDocument();
    });
  });

  it('зміна id показує зведення іншого документа, а не попереднього', async () => {
    apiFetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        summary({
          tables: [
            table({
              positions: path.includes('wo-2') ? 5 : 1,
              distinct: path.includes('wo-2') ? 5 : 1,
            }),
          ],
        }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (id: string) => (
      <QueryClientProvider client={client}>
        <LinesSummarySection entity="work-orders" id={id} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui('wo-1'));
    expect(await rowText('goods')).toBe('1 найменування · 1 од.');
    rerender(ui('wo-2'));
    await waitFor(async () => expect(await rowText('goods')).toBe('5 найменувань · 1 од.'));
  });
});
