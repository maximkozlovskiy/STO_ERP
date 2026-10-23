'use client';

import type { UseFormRegister, FieldErrors, Control } from 'react-hook-form';
import { Controller, useController } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { VehicleFormInput } from '@sto/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { VehicleMakeModelFields } from '@/components/ui/VehicleMakeModelFields';
import { vehicleOptions } from '@/lib/vehicle-options';

/**
 * RHF-native форма автомобіля — ЄДИНЕ джерело набору полів (раніше дубльоване у vehicles/new,
 * vehicles/[id] модалці та вкладці авто CounterpartyEditModal). Керується батьком через
 * useForm(vehicleFormSchema). Опції fuel/transmission/drive/body — `lib/vehicle-options` (мовою інтерфейсу).
 *
 * `compact` — коротка версія (лише марка/модель/рік/держномер/VIN) для вкладки контрагента.
 * Марка й модель — вибір із довідника (`VehicleMakeModelFields`, BR-VEH-008); `currentNames` —
 * знімок назв авто, що редагується (видно, поки довідник вантажиться).
 */
interface Props {
  register: UseFormRegister<VehicleFormInput>;
  errors: FieldErrors<VehicleFormInput>;
  control: Control<VehicleFormInput>;
  compact?: boolean;
  currentNames?: { make: string; model: string };
}

/**
 * Порожня форма авто (усі поля — рядки web-стану; схема коерсить). customerGarageId заповнює той,
 * хто відкриває форму (гараж з картки контрагента або auto-create при збереженні).
 */
export function emptyVehicleForm(): VehicleFormInput {
  return {
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
}

export function VehicleForm({ register, errors, control, compact = false, currentNames }: Props) {
  const { t } = useTranslation('vehicles');
  const { field: makeField } = useController({ control, name: 'makeId' });
  const { field: modelField } = useController({ control, name: 'modelId' });
  return (
    <div className="space-y-3">
      <VehicleMakeModelFields
        makeId={typeof makeField.value === 'string' ? makeField.value : ''}
        modelId={typeof modelField.value === 'string' ? modelField.value : ''}
        onMakeChange={makeField.onChange}
        onModelChange={modelField.onChange}
        onMakeBlur={makeField.onBlur}
        onModelBlur={modelField.onBlur}
        makeError={errors.makeId?.message}
        modelError={errors.modelId?.message}
        currentMake={currentNames?.make}
        currentModel={currentNames?.model}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('card.info.year')}
          type="number"
          {...register('year')}
          errorMessage={errors.year?.message}
          placeholder="2015"
        />
        <Input
          label={t('form.licensePlate')}
          {...register('licensePlate')}
          placeholder="AA 1234 BB"
        />
      </div>
      <Input label="VIN" {...register('vin')} placeholder="WVWZZZ1JZXW000001" />

      {!compact && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Select label={t('form.fuelType')} {...register('fuelType')}>
              <option value="">—</option>
              {vehicleOptions('fuel', t).map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select label={t('form.transmission')} {...register('transmissionType')}>
              <option value="">—</option>
              {vehicleOptions('transmission', t).map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label={t('card.info.driveType')} {...register('driveType')}>
              <option value="">—</option>
              {vehicleOptions('drive', t).map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select label={t('card.info.bodyType')} {...register('bodyType')}>
              <option value="">—</option>
              {vehicleOptions('body', t).map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('form.engineVolume')}
              type="number"
              step="0.1"
              {...register('engineVolume')}
              errorMessage={errors.engineVolume?.message}
              placeholder="2.0"
            />
            <Input
              label={t('card.info.engineCode')}
              {...register('engineCode')}
              placeholder="N57D30"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('card.info.currentMileage')}
              type="number"
              {...register('currentMileage')}
              errorMessage={errors.currentMileage?.message}
              placeholder="120000"
            />
            <Input
              label={t('card.info.color')}
              {...register('color')}
              placeholder={t('form.colorPlaceholder')}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Controller
              control={control}
              name="insuranceExpiry"
              render={({ field }) => (
                <DatePickerInput
                  label={t('card.info.insuranceExpiry')}
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
                  label={t('card.info.inspectionExpiry')}
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={field.onChange}
                />
              )}
            />
          </div>
          <Input label={t('card.info.notes')} {...register('notes')} />
        </>
      )}
    </div>
  );
}
