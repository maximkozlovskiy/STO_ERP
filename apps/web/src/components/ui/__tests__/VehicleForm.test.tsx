import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  vehicleFormSchema,
  optionLabel,
  BODY_OPTIONS,
  type VehicleFormInput,
  type VehicleFormValues,
} from '@sto/shared';
import i18n from '@/i18n/config';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { pickVehicleDirectoryItem } from '@/__tests__/vehicle-directory-picker';
import { VehicleForm } from '../VehicleForm';

// Марка й модель — вибір із довідника (BR-VEH-008); ідентифікатори — UUID, як у схемі форми.
const BMW = '0a000000-0000-4000-8000-00000000a001';
const X5 = '0a000000-0000-4000-8000-00000000b001';
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'ADMIN' } }),
}));
beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/vehicle-makes') {
      return Promise.resolve({
        items: [{ id: BMW, name: 'BMW', vehicleCount: 0, modelCount: 1, deletedAt: null }],
        total: 1,
      });
    }
    if (path === `/vehicle-makes/${BMW}/models`) {
      return Promise.resolve({ items: [{ id: X5, makeId: BMW, name: 'X5' }], total: 1 });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

const EMPTY: VehicleFormInput = {
  customerGarageId: '',
  makeId: '',
  modelId: '',
  vin: '',
  licensePlate: '',
  year: '',
  engineVolume: '',
  fuelType: '',
  currentMileage: '',
  color: '',
  transmissionType: '',
  driveType: '',
  bodyType: '',
  engineCode: '',
  insuranceExpiry: '',
  inspectionExpiry: '',
  notes: '',
};

function Harness({
  compact,
  onValid,
}: {
  compact?: boolean;
  onValid: (v: VehicleFormValues) => void;
}) {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<VehicleFormInput, unknown, VehicleFormValues>({
    resolver: zodResolver(vehicleFormSchema),
    defaultValues: { ...EMPTY, customerGarageId: '11111111-1111-4111-8111-111111111111' },
  });
  return (
    <form onSubmit={handleSubmit(onValid)}>
      <VehicleForm register={register} errors={errors} control={control} compact={compact} />
      <button type="submit">Зберегти</button>
    </form>
  );
}
const renderHarness = (props: { compact?: boolean; onValid: (v: VehicleFormValues) => void }) =>
  render(<Harness {...props} />, { wrapper: createQueryWrapper() });

describe('VehicleForm', () => {
  it('порожні марка/модель → submit заблоковано (onValid не викликається)', async () => {
    const onValid = vi.fn();
    renderHarness({ onValid });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    // Дати resolver-у відпрацювати; onValid не має викликатись на невалідній формі.
    await new Promise(r => setTimeout(r, 50));
    expect(onValid).not.toHaveBeenCalled();
  });

  it('валідна форма → onValid з коерснутим year (number)', async () => {
    const onValid = vi.fn();
    renderHarness({ onValid });
    await pickVehicleDirectoryItem('make', 'BMW');
    await pickVehicleDirectoryItem('model', 'X5');
    fireEvent.change(screen.getByPlaceholderText('2015'), { target: { value: '2015' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => {
      expect(onValid).toHaveBeenCalledTimes(1);
    });
    expect(onValid.mock.calls[0][0]).toMatchObject({ makeId: BMW, modelId: X5, year: 2015 });
  });

  it('compact — приховує тех.поля (пальне/кузов)', () => {
    renderHarness({ compact: true, onValid: vi.fn() });
    expect(screen.queryByText('Пальне')).toBeNull();
    expect(screen.queryByText('Кузов')).toBeNull();
    // марка/модель лишаються
    expect(screen.getByText('Марка')).toBeInTheDocument();
  });
});

describe('optionLabel', () => {
  it('резолвить label за value; fallback — value', () => {
    expect(optionLabel(BODY_OPTIONS, 'SEDAN')).toBe('Седан');
    expect(optionLabel(BODY_OPTIONS, 'UNKNOWN')).toBe('UNKNOWN');
    expect(optionLabel(BODY_OPTIONS, '')).toBe('');
  });
});

describe('VehicleForm — варіанти мовою інтерфейсу', () => {
  it('en: паливо, КПП, привід і кузов — англійською', async () => {
    await i18n.changeLanguage('en');
    try {
      renderHarness({ onValid: vi.fn() });
      for (const label of ['Diesel', 'Automatic', 'All-wheel', 'Sedan']) {
        expect(screen.getByRole('option', { name: label })).toBeTruthy();
      }
      expect(screen.queryByRole('option', { name: 'Седан' })).toBeNull();
    } finally {
      await i18n.changeLanguage('uk');
    }
  });
});
