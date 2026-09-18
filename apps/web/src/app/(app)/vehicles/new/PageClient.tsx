'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { vehicleFormSchema, type VehicleFormInput, type VehicleFormValues } from '@sto/shared';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { VehicleForm } from '@/components/ui/VehicleForm';

interface VehicleResponse {
  id: string;
  customerGarageId: string;
  make: string;
  model: string;
}

// Гараж не має власного GET-by-id endpoint (лише список /counterparties/:id/garages) —
// назва передається з картки контрагента через query, без зайвого round-trip до API.

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

export default function NewVehiclePageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);
  const { t } = useTranslation('vehicles');
  const router = useRouter();
  const searchParams = useSearchParams();
  const garageId = searchParams.get('garageId') ?? '';
  const garageName = searchParams.get('garageName') ?? '';

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<VehicleFormInput, unknown, VehicleFormValues>({
    resolver: i18nZodResolver(vehicleFormSchema),
    defaultValues: { ...EMPTY, customerGarageId: garageId },
    mode: 'onBlur',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = handleSubmit(async (values: VehicleFormValues) => {
    if (!garageId) {
      setError(t('new.garageMissing'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      // customerGarageId завжди з query (форма не редагує гараж) — гарантуємо коректний UUID.
      const vehicle = await apiFetch<VehicleResponse>('/vehicles', {
        method: 'POST',
        body: JSON.stringify({ ...values, customerGarageId: garageId }),
      });
      router.replace(`/vehicles/${vehicle.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('new.saveError'));
    } finally {
      setSaving(false);
    }
  });

  if (!garageId) {
    return (
      <div className="page-container max-w-xl flex flex-col items-center justify-center py-20 gap-4">
        <p className="text-destructive-text">{t('new.garageMissingCard')}</p>
        <Button variant="ghost" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('new.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="page-container max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          {t('new.back')}
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">{t('new.title')}</h1>
          {garageName && (
            <p className="text-sm text-muted-foreground">{t('new.garage', { name: garageName })}</p>
          )}
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      <div className="bg-surface rounded-xl border border-border p-5">
        <VehicleForm register={register} errors={errors} control={control} />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pb-6">
        <Button onClick={onSubmit} loading={saving} className="flex-1">
          {t('new.save')}
        </Button>
        <Button variant="outline" onClick={() => router.back()}>
          {t('new.cancel')}
        </Button>
      </div>
    </div>
  );
}
