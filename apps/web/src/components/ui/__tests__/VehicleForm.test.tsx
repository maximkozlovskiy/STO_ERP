import { describe, it, expect, vi } from 'vitest';
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
import { VehicleForm } from '../VehicleForm';

const EMPTY: VehicleFormInput = {
  customerGarageId: '',
  make: '',
  model: '',
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
    defaultValues: { ...EMPTY, customerGarageId: '11111111-1111-1111-1111-111111111111' },
  });
  return (
    <form onSubmit={handleSubmit(onValid)}>
      <VehicleForm register={register} errors={errors} control={control} compact={compact} />
      <button type="submit">Зберегти</button>
    </form>
  );
}

describe('VehicleForm', () => {
  it('порожні марка/модель → submit заблоковано (onValid не викликається)', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    // Дати resolver-у відпрацювати; onValid не має викликатись на невалідній формі.
    await new Promise(r => setTimeout(r, 50));
    expect(onValid).not.toHaveBeenCalled();
  });

  it('валідна форма → onValid з коерснутим year (number)', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    fireEvent.change(screen.getByPlaceholderText('BMW'), { target: { value: 'BMW' } });
    fireEvent.change(screen.getByPlaceholderText('X5'), { target: { value: 'X5' } });
    fireEvent.change(screen.getByPlaceholderText('2015'), { target: { value: '2015' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => {
      expect(onValid).toHaveBeenCalledTimes(1);
    });
    expect(onValid.mock.calls[0][0]).toMatchObject({ make: 'BMW', model: 'X5', year: 2015 });
  });

  it('compact — приховує тех.поля (пальне/кузов)', () => {
    render(<Harness compact onValid={vi.fn()} />);
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
