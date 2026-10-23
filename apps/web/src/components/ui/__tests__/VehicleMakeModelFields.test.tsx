import { useState } from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQueryWrapper } from '@/__tests__/query-utils';
import {
  pickVehicleDirectoryItem,
  vehicleDirectoryField,
  vehicleDirectoryPickButton,
  vehicleDirectorySearch,
} from '@/__tests__/vehicle-directory-picker';
import { Modal } from '../modal';
import { VehicleMakeModelFields } from '../VehicleMakeModelFields';

/**
 * Марка й модель авто — вибір із довідника (BR-VEH-008), як поле клієнта: пошук під час введення
 * і вікно вибору «…» з пошуком і всім списком. Модель — лише моделі обраної марки, без марки поле
 * вимкнене, зміна марки скидає модель; порожній список моделей — підказка, де їх додати
 * (посилання — лише ролям, що ведуть довідник, BR-VEH-013).
 */
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
let role = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role } }),
}));

const MAKES = [
  { id: 'mk-toyota', name: 'Toyota', vehicleCount: 1, modelCount: 2, deletedAt: null },
  { id: 'mk-bmw', name: 'BMW', vehicleCount: 0, modelCount: 1, deletedAt: null },
  { id: 'mk-zaz', name: 'ZAZ', vehicleCount: 0, modelCount: 0, deletedAt: null },
  { id: 'mk-tatra', name: 'Tatra', vehicleCount: 0, modelCount: 0, deletedAt: null },
];
const MODELS: Record<string, { id: string; makeId: string; name: string }[]> = {
  'mk-toyota': [
    { id: 'md-camry', makeId: 'mk-toyota', name: 'Camry' },
    { id: 'md-corolla', makeId: 'mk-toyota', name: 'Corolla' },
  ],
  'mk-bmw': [{ id: 'md-x5', makeId: 'mk-bmw', name: 'X5' }],
  'mk-zaz': [],
  'mk-tatra': [],
};

beforeEach(() => {
  role = 'RECEPTIONIST';
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/vehicle-makes') return Promise.resolve({ items: MAKES, total: MAKES.length });
    const m = /^\/vehicle-makes\/([^/]+)\/models$/.exec(path);
    if (m) return Promise.resolve({ items: MODELS[m[1]!] ?? [], total: 0 });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

type Value = { make: string; model: string };

function Harness({
  initial = { make: '', model: '' },
  onValue,
  onMakeBlur,
  onModelBlur,
  makeError,
}: {
  initial?: Value;
  onValue?: (v: Value) => void;
  onMakeBlur?: () => void;
  onModelBlur?: () => void;
  makeError?: string;
}) {
  const [value, setValue] = useState(initial);
  const update = (patch: Partial<Value>) =>
    setValue(v => {
      const next = { ...v, ...patch };
      onValue?.(next);
      return next;
    });
  return (
    <VehicleMakeModelFields
      makeId={value.make}
      modelId={value.model}
      onMakeChange={make => update({ make })}
      onModelChange={model => update({ model })}
      onMakeBlur={onMakeBlur}
      onModelBlur={onModelBlur}
      makeError={makeError}
      currentMake="Toyota"
      currentModel="Camry"
    />
  );
}

const renderFields = (props: Parameters<typeof Harness>[0] = {}) =>
  render(<Harness {...props} />, { wrapper: createQueryWrapper() });

/** Назви рядків у відкритому вікні вибору. */
async function pickerRows(title: string): Promise<string[]> {
  const dialog = await screen.findByRole('dialog', { name: title });
  const rows = () =>
    within(dialog)
      .getAllByRole('button')
      .map(b => b.textContent ?? '')
      .filter(text => text !== '');
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
  return rows();
}

/** Ввести текст у поле пошуку й дочекатись випадного списку (пошук із затримкою 300 мс). */
async function typeSearch(kind: 'make' | 'model', text: string): Promise<string[]> {
  // Порожній запит закриває список: інакше findByRole знайшов би результати попереднього пошуку.
  fireEvent.change(vehicleDirectorySearch(kind), { target: { value: '' } });
  fireEvent.change(vehicleDirectorySearch(kind), { target: { value: text } });
  const listbox = await within(vehicleDirectoryField(kind)).findByRole('listbox');
  return within(listbox)
    .getAllByRole('option')
    .map(o => o.textContent ?? '');
}

describe('VehicleMakeModelFields', () => {
  // guards: BR-VEH-008
  it('без марки модель вимкнена з підказкою; «…» марки — увесь довідник', async () => {
    renderFields();
    const model = vehicleDirectoryField('model');
    expect(within(model).getByRole('combobox')).toBeDisabled();
    expect(vehicleDirectoryPickButton('model')).toBeDisabled();
    expect(model).toHaveAccessibleDescription('Спершу оберіть марку');

    fireEvent.click(vehicleDirectoryPickButton('make'));
    expect(await pickerRows('Оберіть марку')).toEqual(['Toyota', 'BMW', 'ZAZ', 'Tatra']);
  });

  // guards: BR-VEH-008
  it('вибір марки й моделі через «…»: модель — лише моделі обраної марки', async () => {
    const onValue = vi.fn();
    renderFields({ onValue });
    await pickVehicleDirectoryItem('make', 'BMW');
    expect(onValue).toHaveBeenLastCalledWith({ make: 'mk-bmw', model: '' });

    fireEvent.click(vehicleDirectoryPickButton('model'));
    expect(await pickerRows('Оберіть модель')).toEqual(['X5']);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Оберіть модель' })).getByRole('button', {
        name: 'X5',
      }),
    );
    await waitFor(() => expect(vehicleDirectoryField('model')).toHaveTextContent('X5'));
    expect(onValue).toHaveBeenLastCalledWith({ make: 'mk-bmw', model: 'md-x5' });
  });

  // guards: BR-VEH-008
  it('пошук під час введення: без регістру, входження підрядка; вибір зі списку', async () => {
    const onValue = vi.fn();
    renderFields({ onValue });
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/vehicle-makes', expect.anything()),
    );

    expect(await typeSearch('make', 'TA')).toEqual(['Toyota', 'Tatra']);
    expect(await typeSearch('make', 'mw')).toEqual(['BMW']);
    fireEvent.mouseDown(within(vehicleDirectoryField('make')).getByRole('option', { name: 'BMW' }));

    await waitFor(() => expect(vehicleDirectoryField('make')).toHaveTextContent('BMW'));
    expect(onValue).toHaveBeenLastCalledWith({ make: 'mk-bmw', model: '' });
    await waitFor(() => expect(vehicleDirectorySearch('model')).toBeEnabled());
    expect(await typeSearch('model', 'x')).toEqual(['X5']);
  });

  it('пошук, набраний до відповіді довідника, чекає на неї — не «Нічого не знайдено»', async () => {
    let resolveMakes: (v: unknown) => void = () => {};
    const ok = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string) =>
      path === '/vehicle-makes' ? new Promise(r => (resolveMakes = r)) : ok(path),
    );
    renderFields();
    fireEvent.change(vehicleDirectorySearch('make'), { target: { value: 'bmw' } });
    await new Promise(r => setTimeout(r, 400));
    expect(within(vehicleDirectoryField('make')).queryByText('Нічого не знайдено')).toBeNull();

    act(() => resolveMakes({ items: MAKES, total: MAKES.length }));

    const listbox = await within(vehicleDirectoryField('make')).findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map(o => o.textContent),
    ).toEqual(['BMW']);
    expect(apiFetchMock.mock.calls.filter(c => c[0] === '/vehicle-makes')).toHaveLength(1);
  });

  it('пошук у вікні вибору фільтрує список', async () => {
    renderFields();
    fireEvent.click(vehicleDirectoryPickButton('make'));
    const dialog = await screen.findByRole('dialog', { name: 'Оберіть марку' });
    await within(dialog).findByRole('button', { name: 'ZAZ' });
    fireEvent.change(within(dialog).getByPlaceholderText('Пошук марки…'), {
      target: { value: 'z' },
    });
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'BMW' })).toBeNull());
    expect(within(dialog).getByRole('button', { name: 'ZAZ' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Toyota' })).toBeNull();
  });

  // guards: BR-VEH-008
  it('зміна марки скидає модель і показує моделі нової марки', async () => {
    const onValue = vi.fn();
    renderFields({ initial: { make: 'mk-toyota', model: 'md-camry' }, onValue });
    await waitFor(() => expect(vehicleDirectoryField('model')).toHaveTextContent('Camry'));

    fireEvent.click(
      within(vehicleDirectoryField('make')).getByRole('button', { name: 'Очистити' }),
    );
    expect(onValue).toHaveBeenLastCalledWith({ make: '', model: '' });
    await pickVehicleDirectoryItem('make', 'BMW');

    expect(onValue).toHaveBeenLastCalledWith({ make: 'mk-bmw', model: '' });
    expect(vehicleDirectoryField('model')).not.toHaveTextContent('Camry');
    fireEvent.click(vehicleDirectoryPickButton('model'));
    expect(await pickerRows('Оберіть модель')).toEqual(['X5']);
  });

  // guards: BR-VEH-008
  it('вибір іншої марки у вікні «…» скидає модель; тієї самої — ні', async () => {
    const onValue = vi.fn();
    renderFields({ initial: { make: 'mk-toyota', model: 'md-camry' }, onValue });
    await waitFor(() => expect(vehicleDirectoryField('model')).toHaveTextContent('Camry'));

    await pickVehicleDirectoryItem('make', 'Toyota');
    expect(vehicleDirectoryField('model')).toHaveTextContent('Camry');
    expect(onValue).not.toHaveBeenCalled();

    await pickVehicleDirectoryItem('make', 'BMW');
    expect(onValue).toHaveBeenLastCalledWith({ make: 'mk-bmw', model: '' });
  });

  it('вибір і очищення позначають поле торкнутим (onBlur для RHF)', async () => {
    const onMakeBlur = vi.fn();
    const onModelBlur = vi.fn();
    renderFields({ onMakeBlur, onModelBlur });
    await pickVehicleDirectoryItem('make', 'BMW');
    expect(onMakeBlur).toHaveBeenCalledTimes(1);
    await pickVehicleDirectoryItem('model', 'X5');
    expect(onModelBlur).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(vehicleDirectoryField('model')).getByRole('button', { name: 'Очистити' }),
    );
    expect(onModelBlur).toHaveBeenCalledTimes(2);
    expect(onMakeBlur).toHaveBeenCalledTimes(1);
  });

  it('помилка марки — під полем, пов’язана з групою поля', async () => {
    renderFields({ makeError: 'Оберіть марку зі списку' });
    expect(vehicleDirectoryField('make')).toHaveAccessibleDescription('Оберіть марку зі списку');
  });

  // GOTCHAS 2026-10-21: вікно вибору — шар Escape над карткою контрагента чи майстром календаря.
  it('Escape у вікні вибору над іншим вікном закриває лише вікно вибору', async () => {
    const onParentClose = vi.fn();
    render(
      <Modal open onClose={onParentClose} title="Батьківське вікно">
        <Harness />
      </Modal>,
      { wrapper: createQueryWrapper() },
    );
    fireEvent.click(vehicleDirectoryPickButton('make'));
    await screen.findByRole('dialog', { name: 'Оберіть марку' });

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Оберіть марку' })).not.toBeInTheDocument(),
    );
    expect(onParentClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Батьківське вікно' })).toBeInTheDocument();
  });

  it('Escape у випадному списку пошуку над іншим вікном закриває лише список', async () => {
    const onParentClose = vi.fn();
    render(
      <Modal open onClose={onParentClose} title="Батьківське вікно">
        <Harness />
      </Modal>,
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/vehicle-makes', expect.anything()),
    );
    await typeSearch('make', 'bmw');

    fireEvent.keyDown(vehicleDirectorySearch('make'), { key: 'Escape' });

    await waitFor(() =>
      expect(within(vehicleDirectoryField('make')).queryByRole('listbox')).toBeNull(),
    );
    expect(onParentClose).not.toHaveBeenCalled();
  });

  // guards: BR-VEH-013
  it('порожній список моделей: ролі, що ведуть довідник, — посилання на вкладку марок', async () => {
    renderFields({ initial: { make: 'mk-zaz', model: '' } });
    const hint = await screen.findByTestId('vehicle-no-models-hint');
    const link = screen.getByRole('link', { name: /Марки авто/ });
    expect(hint).toContainElement(link);
    expect(link).toHaveAttribute('href', '/counterparties?tab=vehicle-makes&make=mk-zaz');
    expect(link).toHaveAttribute('target', '_blank');
  });

  // guards: BR-VEH-013
  it('порожній список моделей: роль без права вести довідник — підказка без посилання', async () => {
    role = 'MECHANIC';
    renderFields({ initial: { make: 'mk-zaz', model: '' } });
    const hint = await screen.findByTestId('vehicle-no-models-hint');
    expect(hint.textContent).toMatch(/адміністратора/);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('марки, якої вже немає в довіднику, — назва зі знімка з позначкою «недоступна»', async () => {
    renderFields({ initial: { make: 'mk-gone', model: '' } });
    await waitFor(() =>
      expect(vehicleDirectoryField('make')).toHaveTextContent('Toyota (недоступна)'),
    );
  });

  it('поки довідник вантажиться — назва зі знімка без позначки', () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}));
    renderFields({ initial: { make: 'mk-toyota', model: 'md-camry' } });
    expect(vehicleDirectoryField('make')).toHaveTextContent('Toyota');
    expect(vehicleDirectoryField('make')).not.toHaveTextContent('недоступна');
    expect(vehicleDirectoryField('model')).toHaveTextContent('Camry');
  });

  it('збій завантаження марок — текст помилки й «Повторити», що перечитує список (Bug #958)', async () => {
    let failMakes = true;
    const ok = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string) =>
      path === '/vehicle-makes' && failMakes
        ? Promise.reject(new Error('Помилка сервера'))
        : ok(path),
    );
    renderFields();
    const alert = await screen.findByTestId('vehicle-directory-load-error');
    expect(alert).toHaveTextContent('Не вдалося завантажити марки');
    failMakes = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    await waitFor(() => expect(screen.queryByTestId('vehicle-directory-load-error')).toBeNull());
    await pickVehicleDirectoryItem('make', 'Toyota');
  });

  it('збій завантаження моделей обраної марки — свій текст, не «моделей ще немає» (Bug #958)', async () => {
    const ok = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string) =>
      path.endsWith('/models') ? Promise.reject(new Error('Помилка сервера')) : ok(path),
    );
    renderFields({ initial: { make: 'mk-bmw', model: '' } });
    const alert = await screen.findByTestId('vehicle-directory-load-error');
    expect(alert).toHaveTextContent('Не вдалося завантажити моделі цієї марки');
    expect(screen.queryByTestId('vehicle-no-models-hint')).toBeNull();
  });
});
