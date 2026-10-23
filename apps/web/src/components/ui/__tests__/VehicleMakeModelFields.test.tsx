import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { VehicleMakeModelFields } from '../VehicleMakeModelFields';

/**
 * Марка й модель авто — вибір із довідника (BR-VEH-008): модель — лише моделі обраної марки,
 * без марки поле вимкнене, зміна марки скидає модель; порожній список моделей — підказка, де їх
 * додати (посилання — лише ролям, що ведуть довідник, BR-VEH-013).
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
];
const MODELS: Record<string, { id: string; makeId: string; name: string }[]> = {
  'mk-toyota': [
    { id: 'md-camry', makeId: 'mk-toyota', name: 'Camry' },
    { id: 'md-corolla', makeId: 'mk-toyota', name: 'Corolla' },
  ],
  'mk-bmw': [{ id: 'md-x5', makeId: 'mk-bmw', name: 'X5' }],
  'mk-zaz': [],
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

function Harness({
  initial = { make: '', model: '' },
}: {
  initial?: { make: string; model: string };
}) {
  const [value, setValue] = useState(initial);
  return (
    <VehicleMakeModelFields
      makeId={value.make}
      modelId={value.model}
      onMakeChange={make => setValue(v => ({ ...v, make }))}
      onModelChange={model => setValue(v => ({ ...v, model }))}
      currentMake="Toyota"
      currentModel="Camry"
    />
  );
}

const renderFields = (initial?: { make: string; model: string }) =>
  render(<Harness initial={initial} />, { wrapper: createQueryWrapper() });
const makeSelect = () => screen.getByLabelText(/^Марка/) as HTMLSelectElement;
const modelSelect = () => screen.getByLabelText(/^Модель/) as HTMLSelectElement;
const optionNames = (select: HTMLSelectElement) =>
  Array.from(select.options)
    .filter(o => o.value)
    .map(o => o.text);

describe('VehicleMakeModelFields', () => {
  // guards: BR-VEH-008
  it('без марки модель вимкнена; марки — з довідника', async () => {
    renderFields();
    await screen.findByRole('option', { name: 'Toyota' });
    expect(optionNames(makeSelect())).toEqual(['Toyota', 'BMW', 'ZAZ']);
    expect(modelSelect()).toBeDisabled();
  });

  // guards: BR-VEH-008
  it('моделі — лише обраної марки', async () => {
    renderFields();
    await screen.findByRole('option', { name: 'Toyota' });
    fireEvent.change(makeSelect(), { target: { value: 'mk-bmw' } });
    await screen.findByRole('option', { name: 'X5' });
    expect(modelSelect()).toBeEnabled();
    expect(optionNames(modelSelect())).toEqual(['X5']);
  });

  // guards: BR-VEH-008
  it('зміна марки скидає модель і показує моделі нової марки', async () => {
    renderFields({ make: 'mk-toyota', model: 'md-camry' });
    await screen.findByRole('option', { name: 'Corolla' });
    expect(modelSelect().value).toBe('md-camry');

    fireEvent.change(makeSelect(), { target: { value: 'mk-bmw' } });

    await screen.findByRole('option', { name: 'X5' });
    expect(modelSelect().value).toBe('');
    expect(optionNames(modelSelect())).toEqual(['X5']);
  });

  it('вибір тієї самої марки модель не скидає', async () => {
    renderFields({ make: 'mk-toyota', model: 'md-camry' });
    await screen.findByRole('option', { name: 'Corolla' });
    fireEvent.change(makeSelect(), { target: { value: 'mk-toyota' } });
    expect(modelSelect().value).toBe('md-camry');
  });

  // guards: BR-VEH-013
  it('порожній список моделей: ролі, що ведуть довідник, — посилання на вкладку марок', async () => {
    renderFields({ make: 'mk-zaz', model: '' });
    const hint = await screen.findByTestId('vehicle-no-models-hint');
    const link = screen.getByRole('link', { name: /Марки авто/ });
    expect(hint).toContainElement(link);
    expect(link).toHaveAttribute('href', '/counterparties?tab=vehicle-makes&make=mk-zaz');
    expect(link).toHaveAttribute('target', '_blank');
  });

  // guards: BR-VEH-013
  it('порожній список моделей: роль без права вести довідник — підказка без посилання', async () => {
    role = 'MECHANIC';
    renderFields({ make: 'mk-zaz', model: '' });
    const hint = await screen.findByTestId('vehicle-no-models-hint');
    expect(hint.textContent).toMatch(/адміністратора/);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('марки, якої вже немає в довіднику, — назва зі знімка з позначкою «недоступна»', async () => {
    renderFields({ make: 'mk-gone', model: '' });
    await screen.findByRole('option', { name: 'Toyota' });
    await waitFor(() => expect(makeSelect().selectedOptions[0]?.text).toBe('Toyota (недоступна)'));
  });
});
