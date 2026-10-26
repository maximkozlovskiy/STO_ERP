import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryWrapper, makeTestQueryClient } from '@/__tests__/query-utils';
import { vehicleMakesKeys } from '@/hooks/api/useVehicleMakes';
import VehicleMakesTab from '../VehicleMakesTab';

/**
 * Вкладка «Марки авто» (BR-VEH-009, 010, 013): кнопки за ролями, відмова видалити марку з авто
 * (текст сервера + злиття), злиття з підтвердженням. Мережа — таблиця маршрутів поверх `apiFetch`.
 */
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
let role = 'ADMIN';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role } }),
  useRequireAuth: () => undefined,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/counterparties',
}));

const TOYOTA = { id: 'mk-1', name: 'Toyota', vehicleCount: 3, modelCount: 1, deletedAt: null };
const TYPO = { id: 'mk-2', name: 'Тойота', vehicleCount: 1, modelCount: 0, deletedAt: null };
const CAMRY = { id: 'md-1', makeId: 'mk-1', name: 'Camry', vehicleCount: 3, deletedAt: null };

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}
let calls: Call[];
let deleteFails: boolean;

beforeEach(() => {
  role = 'ADMIN';
  calls = [];
  deleteFails = false;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/vehicle-makes/mk-1/models'))
      return Promise.resolve({ items: [CAMRY], total: 1 });
    if (method === 'GET' && path.startsWith('/vehicle-makes/'))
      return Promise.resolve({ items: [], total: 0 });
    if (method === 'GET' && path.startsWith('/vehicle-makes'))
      return Promise.resolve({ items: [TOYOTA, TYPO], total: 2 });
    if (method === 'DELETE') {
      return deleteFails
        ? Promise.reject(
            new Error('Марку мають авто — видалити не можна. Злийте її з іншою маркою'),
          )
        : Promise.resolve(undefined);
    }
    if (method === 'POST' && path.endsWith('/merge')) return Promise.resolve(TOYOTA);
    if (method === 'POST' || method === 'PATCH') return Promise.resolve(TOYOTA);
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
});

const renderTab = () => render(<VehicleMakesTab />, { wrapper: createQueryWrapper() });
const makeRow = (name: string) => {
  const tr = screen.getByRole('button', { name }).closest('tr');
  if (!tr) throw new Error(`рядок ${name} не знайдено`);
  return tr;
};
const mutations = () => calls.filter(c => c.method !== 'GET');

describe('VehicleMakesTab', () => {
  // guards: BR-VEH-013
  it('адмін: додати, перейменувати, злити, видалити, показ видалених', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    const row = within(makeRow('Toyota'));
    expect(row.getByRole('button', { name: 'Перейменувати: Toyota' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Злити в…: Toyota' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Видалити: Toyota' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Марка' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Показати видалені' })).toBeInTheDocument();
  });

  // guards: BR-VEH-013
  it('приймальник: додати й перейменувати — так; видалити, злити, видалені — ні', async () => {
    role = 'RECEPTIONIST';
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    const row = within(makeRow('Toyota'));
    expect(row.getByRole('button', { name: 'Перейменувати: Toyota' })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /Злити в/ })).toBeNull();
    expect(row.queryByRole('button', { name: /Видалити/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Марка' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показати видалені' })).toBeNull();
  });

  // guards: BR-VEH-013
  it('бухгалтер: лише перегляд — жодної кнопки запису', async () => {
    role = 'ACCOUNTANT';
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    expect(within(makeRow('Toyota')).queryAllByRole('button', { name: /:/ })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Марка' })).toBeNull();
  });

  it('клік по рядку марки (не лише по назві) показує її моделі', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    fireEvent.click(within(makeRow('Toyota')).getAllByRole('cell')[1]);
    expect(await screen.findByText('Camry')).toBeInTheDocument();
    expect(screen.getByText('Моделі Toyota')).toBeInTheDocument();
  });

  it('клік по марці показує її моделі праворуч', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Toyota' }));
    expect(await screen.findByText('Camry')).toBeInTheDocument();
    expect(screen.getByText('Моделі Toyota')).toBeInTheDocument();
  });

  // guards: BR-VEH-009
  it('видалення марки з авто: 400 — текст сервера і кнопка злиття, що відкриває злиття', async () => {
    deleteFails = true;
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    fireEvent.click(within(makeRow('Тойота')).getByRole('button', { name: 'Видалити: Тойота' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Так' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Злийте її з іншою маркою');
    fireEvent.click(within(alert).getByRole('button', { name: 'Злити в…' }));
    expect(await screen.findByRole('dialog', { name: 'Злити марку' })).toBeInTheDocument();
  });

  // guards: BR-VEH-010
  it('злиття: ціль — інша жива марка; після підтвердження POST /merge з targetId', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    fireEvent.click(within(makeRow('Тойота')).getByRole('button', { name: 'Злити в…: Тойота' }));
    const dialog = await screen.findByRole('dialog', { name: 'Злити марку' });
    const target = within(dialog).getByLabelText(/^Марка, у яку злити/) as HTMLSelectElement;
    expect(
      Array.from(target.options)
        .filter(o => o.value)
        .map(o => o.text),
    ).toEqual(['Toyota']);
    const mergeButton = within(dialog).getByRole('button', { name: 'Злити' });
    expect(mergeButton).toBeDisabled();

    fireEvent.change(target, { target: { value: 'mk-1' } });
    fireEvent.click(mergeButton);
    // Без підтвердження нічого не шлеться.
    const confirm = await screen.findByRole('dialog', { name: 'Злити марки?' });
    expect(mutations()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Злити' }));

    await waitFor(() =>
      expect(mutations()).toEqual([
        { method: 'POST', path: '/vehicle-makes/mk-2/merge', body: { targetId: 'mk-1' } },
      ]),
    );
  });

  // guards: BR-VEH-006
  it('додати марку: POST /vehicle-makes з назвою; 409 сервера — у вікні', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    apiFetchMock.mockImplementationOnce(() =>
      Promise.reject(new Error('Марка з такою назвою вже є')),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Марка' }));
    const dialog = await screen.findByRole('dialog', { name: 'Нова марка' });
    fireEvent.change(within(dialog).getByLabelText(/^Назва марки/), {
      target: { value: 'toyota' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('вже є');
  });

  // guards: BR-VEH-006
  it('Enter двічі, поки збереження йде, — один POST (друга марка дала б 409)', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Toyota' });
    let finish: (v: unknown) => void = () => undefined;
    apiFetchMock.mockImplementationOnce((path: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', path });
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Марка' }));
    const dialog = await screen.findByRole('dialog', { name: 'Нова марка' });
    const input = within(dialog).getByLabelText(/^Назва марки/);
    fireEvent.change(input, { target: { value: 'Skoda' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mutations()).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }));
    finish({ ...TOYOTA, id: 'mk-9', name: 'Skoda' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Нова марка' })).toBeNull());
    expect(mutations()).toHaveLength(1);
  });
  // guards: BR-VEH-009
  it('кількість авто — свіжа при кожному відкритті, а не з 5-хв кешу форми авто (Bug #957)', async () => {
    // Форма авто щойно завантажила довідник (ще 0 авто), потім зберегла авто цієї марки.
    const qc = makeTestQueryClient();
    qc.setQueryData(vehicleMakesKeys.list(false), [{ ...TOYOTA, vehicleCount: 0 }]);
    qc.setQueryData(vehicleMakesKeys.modelList('mk-1', false), [{ ...CAMRY, vehicleCount: 0 }]);
    render(
      <QueryClientProvider client={qc}>
        <VehicleMakesTab />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(within(makeRow('Toyota')).getByText('3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Toyota' }));
    const camryRow = (await screen.findByText('Camry')).closest('tr');
    if (!camryRow) throw new Error('рядок Camry не знайдено');
    await waitFor(() => expect(within(camryRow).getByText('3')).toBeInTheDocument());
  });
});
