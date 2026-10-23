'use client';

import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import {
  VEHICLE_DIRECTORY_WRITE_ROLES,
  useVehicleMakes,
  useVehicleModels,
} from '@/hooks/api/useVehicleMakes';

/**
 * Марка й модель авто — лише вибір із довідника (BR-VEH-008). Керований компонент: значення —
 * ідентифікатори, батько тримає їх у своїй формі (RHF у `VehicleForm`, стан майстра календаря).
 *
 * - Модель — лише моделі обраної марки; без марки поле вимкнене.
 * - Зміна марки скидає модель: стара модель новій марці не належить (сервер відповів би 400).
 * - Порожній список моделей — підказка, де їх додати; посилання — лише ролям, що ведуть довідник,
 *   у новій вкладці: незбережена форма авто лишається відкритою (список перечитується при поверненні).
 * - `currentMake` / `currentModel` — назви зі знімка авто: показуються, поки довідник вантажиться,
 *   а після завантаження, якщо запису в ньому вже немає, — з позначкою «недоступна».
 */
interface Props {
  makeId: string;
  modelId: string;
  onMakeChange: (makeId: string) => void;
  onModelChange: (modelId: string) => void;
  onMakeBlur?: () => void;
  onModelBlur?: () => void;
  makeError?: string;
  modelError?: string;
  currentMake?: string;
  currentModel?: string;
  required?: boolean;
  disabled?: boolean;
  idPrefix?: string;
}

export function VehicleMakeModelFields({
  makeId,
  modelId,
  onMakeChange,
  onModelChange,
  onMakeBlur,
  onModelBlur,
  makeError,
  modelError,
  currentMake,
  currentModel,
  required = true,
  disabled = false,
  idPrefix = 'vehicle',
}: Props) {
  const { t } = useTranslation('vehicles');
  const { employee } = useAuth();
  const canEditDirectory = VEHICLE_DIRECTORY_WRITE_ROLES.includes(employee?.role ?? '');
  const makesQuery = useVehicleMakes();
  const modelsQuery = useVehicleModels(makeId || null);
  const makes = makesQuery.data ?? [];
  const models = modelsQuery.data ?? [];

  const missingLabel = (loaded: boolean, name: string | undefined): string => {
    const shown = name || '…';
    return loaded ? t('form.unavailable', { name: shown }) : shown;
  };
  const makeMissing = !!makeId && !makes.some(m => m.id === makeId);
  const modelMissing = !!modelId && !models.some(m => m.id === modelId);
  const modelsLoaded = !!makeId && modelsQuery.isSuccess;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-3">
        <Select
          id={`${idPrefix}-make`}
          label={t('form.make')}
          required={required}
          disabled={disabled}
          value={makeId}
          onChange={e => {
            const next = e.target.value;
            if (next === makeId) return;
            onMakeChange(next);
            onModelChange('');
          }}
          onBlur={onMakeBlur}
          errorMessage={makeError}
        >
          <option value="">{t('form.makePlaceholder')}</option>
          {makeMissing && (
            <option value={makeId}>{missingLabel(makesQuery.isSuccess, currentMake)}</option>
          )}
          {makes.map(m => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select
          id={`${idPrefix}-model`}
          label={t('form.model')}
          required={required}
          disabled={disabled || !makeId}
          value={modelId}
          onChange={e => onModelChange(e.target.value)}
          onBlur={onModelBlur}
          errorMessage={modelError}
          hint={makeId ? undefined : t('form.pickMakeFirst')}
        >
          <option value="">{t('form.modelPlaceholder')}</option>
          {modelMissing && (
            <option value={modelId}>{missingLabel(modelsLoaded, currentModel)}</option>
          )}
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </div>
      {modelsLoaded && models.length === 0 && (
        <p className="text-[12px] text-muted-foreground" data-testid="vehicle-no-models-hint">
          {canEditDirectory ? (
            <>
              {t('form.noModelsHint')}{' '}
              <a
                href={`/counterparties?tab=vehicle-makes&make=${encodeURIComponent(makeId)}`}
                target="_blank"
                rel="noopener"
                className="text-primary underline-offset-2 hover:underline"
              >
                {t('form.noModelsLink')}
              </a>
            </>
          ) : (
            t('form.noModelsAskAdmin')
          )}
        </p>
      )}
    </div>
  );
}
