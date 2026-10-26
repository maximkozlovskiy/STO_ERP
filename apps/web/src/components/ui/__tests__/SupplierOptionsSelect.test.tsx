// Спільний вибір постачальника (TECH-DEBT §15 п.13): «Позиції» (фільтр і діалог) і картка
// підключення до API постачальника. У рядку фільтрів місце пошуку тримається до першої відповіді,
// а «Нічого не знайдено» стоїть біля пошуку (поверх, без зсуву рядка), не підказкою списку.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { SupplierOption } from '@/hooks/api/useCounterparties';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { SupplierOptionsSelect } from '../SupplierOptionsSelect';

const PAGE_URL = '/counterparties?types=SUPPLIER&types=BOTH&limit=200';

function Harness(props: {
  layout?: 'row' | 'stack';
  initial?: string;
  extraSelected?: SupplierOption | null;
  id?: string;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  const [selected, setSelected] = useState<SupplierOption | null>(null);
  return (
    <SupplierOptionsSelect
      layout={props.layout ?? 'stack'}
      value={value}
      selected={selected}
      extraSelected={props.extraSelected ?? null}
      onChange={(id, option) => {
        setValue(id);
        setSelected(option);
      }}
      {...(props.id ? { id: props.id, label: 'Контрагент' } : { ariaLabel: 'Постачальник' })}
      enabled
      leading={<option value="">Усі</option>}
    />
  );
}

function renderSelect(props: Parameters<typeof Harness>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('SupplierOptionsSelect — рядок фільтрів', () => {
  it('місце пошуку зарезервоване до першої відповіді: поле з’являється в ньому, список не зсувається', async () => {
    let resolvePage: (v: unknown) => void = () => undefined;
    apiFetch.mockImplementation(
      () =>
        new Promise(r => {
          resolvePage = r;
        }),
    );
    const { container } = renderSelect({ layout: 'row' });
    const row = container.firstElementChild!;
    // Відповіді ще немає: перша клітинка — порожнє місце пошуку, список — друга.
    expect(row.children).toHaveLength(2);
    expect(row.children[1]!.contains(screen.getByRole('combobox'))).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();

    resolvePage({ items: [{ id: 's-1', companyName: 'ТОВ Запчастини' }], total: 250 });
    const search = await screen.findByRole('textbox', { name: 'Пошук постачальника' });
    expect(row.children[0]!.contains(search)).toBe(true);
    expect(row.children[1]!.contains(screen.getByRole('combobox'))).toBe(true);
  });

  it('«Нічого не знайдено» — біля пошуку, поверх рядка, а не підказка під списком', async () => {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path === PAGE_URL
          ? { items: [{ id: 's-1', companyName: 'ТОВ Запчастини' }], total: 250 }
          : { items: [], total: 0 },
      ),
    );
    const { container } = renderSelect({ layout: 'row' });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук постачальника' }), {
      target: { value: 'Жодного' },
    });
    const hint = await screen.findByRole('status');
    expect(hint).toHaveTextContent('Нічого не знайдено');
    expect(hint).toHaveClass('absolute');
    expect(hint.parentElement).toBe(container.firstElementChild);
    const select = screen.getByRole('combobox');
    expect(select.closest('.w-52')!.contains(hint)).toBe(false);
    expect(select).toHaveAttribute('aria-describedby', hint.id);
  });
});

describe('SupplierOptionsSelect — діалог', () => {
  it('extraSelected (власний контрагент) лишається варіантом, коли його немає серед перших 200', async () => {
    apiFetch.mockResolvedValue({ items: [{ id: 's-2', companyName: 'Інший ТОВ' }], total: 250 });
    renderSelect({ initial: 'cp-1', extraSelected: { id: 'cp-1', name: 'Свій ТОВ' }, id: 'x' });
    const select = screen.getByRole('combobox', { name: 'Контрагент' });
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Інший ТОВ' })).toBeInTheDocument(),
    );
    expect(within(select).getByRole('option', { name: 'Свій ТОВ' })).toBeInTheDocument();
    expect(select).toHaveValue('cp-1');
    expect(select).toHaveAttribute('id', 'x');
    expect(screen.getByLabelText('Пошук постачальника')).toHaveAttribute('id', 'x-search');

    // Обрано інший — власний більше не поточне значення, у списку не тримається.
    fireEvent.change(select, { target: { value: 's-2' } });
    expect(within(select).queryByRole('option', { name: 'Свій ТОВ' })).toBeNull();
  });
});
