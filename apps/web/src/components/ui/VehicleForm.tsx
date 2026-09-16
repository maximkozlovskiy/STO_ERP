'use client';

import type { UseFormRegister, FieldErrors, Control } from 'react-hook-form';
import { Controller } from 'react-hook-form';
import {
  FUEL_TYPE_OPTIONS,
  TRANSMISSION_OPTIONS,
  DRIVE_OPTIONS,
  BODY_OPTIONS,
  type VehicleFormInput,
} from '@sto/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';

/**
 * RHF-native форма автомобіля — ЄДИНЕ джерело набору полів (раніше дубльоване у vehicles/new,
 * vehicles/[id] модалці та вкладці авто CounterpartyEditModal). Керується батьком через
 * useForm(vehicleFormSchema). Опції fuel/transmission/drive/body — зі спільної @sto/shared.
 *
 * `compact` — коротка версія (лише марка/модель/рік/держномер/VIN) для вкладки контрагента.
 */
interface Props {
  register: UseFormRegister<VehicleFormInput>;
  errors: FieldErrors<VehicleFormInput>;
  control: Control<VehicleFormInput>;
  compact?: boolean;
}

export function VehicleForm({ register, errors, control, compact = false }: Props) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Марка"
          required
          {...register('make')}
          errorMessage={errors.make?.message}
          placeholder="BMW"
        />
        <Input
          label="Модель"
          required
          {...register('model')}
          errorMessage={errors.model?.message}
          placeholder="X5"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Рік"
          type="number"
          {...register('year')}
          errorMessage={errors.year?.message}
          placeholder="2015"
        />
        <Input label="Держномер" {...register('licensePlate')} placeholder="AA 1234 BB" />
      </div>
      <Input label="VIN" {...register('vin')} placeholder="WVWZZZ1JZXW000001" />

      {!compact && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Пальне" {...register('fuelType')}>
              <option value="">—</option>
              {FUEL_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select label="КПП" {...register('transmissionType')}>
              <option value="">—</option>
              {TRANSMISSION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Привід" {...register('driveType')}>
              <option value="">—</option>
              {DRIVE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select label="Кузов" {...register('bodyType')}>
              <option value="">—</option>
              {BODY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Об'єм двигуна, л"
              type="number"
              step="0.1"
              {...register('engineVolume')}
              errorMessage={errors.engineVolume?.message}
              placeholder="2.0"
            />
            <Input label="Код двигуна" {...register('engineCode')} placeholder="N57D30" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Пробіг, км"
              type="number"
              {...register('currentMileage')}
              errorMessage={errors.currentMileage?.message}
              placeholder="120000"
            />
            <Input label="Колір" {...register('color')} placeholder="Чорний" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Controller
              control={control}
              name="insuranceExpiry"
              render={({ field }) => (
                <DatePickerInput
                  label="Страховка до"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={field.onChange}
                />
              )}
            />
            <Controller
              control={control}
              name="inspectionExpiry"
              render={({ field }) => (
                <DatePickerInput
                  label="Техогляд до"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={field.onChange}
                />
              )}
            />
          </div>
          <Input label="Нотатки" {...register('notes')} />
        </>
      )}
    </div>
  );
}
