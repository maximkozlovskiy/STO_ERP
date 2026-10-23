'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { useAuth } from '@/lib/auth';
import {
  VEHICLE_DIRECTORY_WRITE_ROLES,
  useVehicleMakes,
  useVehicleModels,
  vehicleMakesQuery,
  vehicleModelsQuery,
  type VehicleMake,
  type VehicleModel,
} from '@/hooks/api/useVehicleMakes';

/**
 * Марка й модель авто — лише вибір із довідника (BR-VEH-008). Керований компонент: значення —
 * ідентифікатори, батько тримає їх у своїй формі (RHF у `VehicleForm`, стан майстра календаря).
 *
 * - Поле — як поле клієнта: пошук під час введення (випадний список), «…» — вікно вибору з пошуком
 *   і всім списком, × — очистити. Шукає в уже завантаженому довіднику, без запитів до сервера.
 * - Модель — лише моделі обраної марки; без марки поле вимкнене.
 * - Зміна марки (і × на марці) скидає модель: стара модель новій марці не належить (сервер
 *   відповів би 400).
 * - Порожній список моделей — підказка, де їх додати; посилання — лише ролям, що ведуть довідник,
 *   у новій вкладці: незбережена форма авто лишається відкритою (список перечитується при поверненні).
 * - Збій завантаження марок чи моделей — текст помилки з «Повторити» (Bug #958).
 * - `currentMake` / `currentModel` — назви зі знімка авто: показуються, поки довідник вантажиться,
 *   а після завантаження, якщо запису в ньому вже немає, — з позначкою «недоступна».
 * - `onMakeBlur` / `onModelBlur` — після вибору чи очищення: поле без нативного blur, а RHF
 *   (`mode: 'onBlur'`) інакше не позначив би його торкнутим.
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

interface DirectoryItem {
  id: string;
  primary: string;
}

const NO_ITEMS: DirectoryItem[] = [];

const toItems = (rows: readonly (VehicleMake | VehicleModel)[] | undefined): DirectoryItem[] =>
  rows ? rows.map(r => ({ id: r.id, primary: r.name })) : NO_ITEMS;

/** Пошук по назві: без регістру, входження підрядка; порожній запит — увесь список. */
function filterByName(items: DirectoryItem[], q: string): DirectoryItem[] {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter(i => i.primary.toLocaleLowerCase().includes(needle));
}

interface DirectoryFieldProps {
  id: string;
  label: string;
  required: boolean;
  disabled: boolean;
  display: string;
  selectedId: string;
  /** Записи довідника; поки він вантажиться — чекає на завантаження, а не віддає порожній список. */
  load: () => Promise<DirectoryItem[]>;
  pickerTitle: string;
  searchPlaceholder: string;
  emptyText: string;
  hint?: string;
  error?: string;
  onSelect: (item: DirectoryItem) => void;
  onClear: () => void;
}

/**
 * Поле довідника: підпис, EntityPickerField з пошуком, вікно вибору й текст помилки/підказки під
 * полем. Помилка чи підказка пов'язана і з полем пошуку (`aria-describedby`, `aria-invalid`), і з
 * `role="group"` з підписом — бо обране значення показується не полем вводу, а текстом.
 */
function DirectoryField({
  id,
  label,
  required,
  disabled,
  display,
  selectedId,
  load,
  pickerTitle,
  searchPlaceholder,
  emptyText,
  hint,
  error,
  onSelect,
  onClear,
}: DirectoryFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const search = useCallback((q: string) => load().then(items => filterByName(items, q)), [load]);
  const labelId = `${id}-label`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  // 🔍 «Відкрити картку» прихована: у марки й моделі картки немає, а вимкнена кнопка з підказкою
  // «Спочатку оберіть запис» вводила б в оману й після вибору.

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className="flex min-w-0 flex-col gap-1"
    >
      <span id={labelId} className="text-[13px] font-medium text-foreground leading-none">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      <EntityPickerField<DirectoryItem>
        display={display}
        ariaLabel={label}
        ariaInvalid={!!error}
        ariaDescribedBy={describedBy}
        placeholder={searchPlaceholder}
        disabled={disabled}
        hideDetail
        onPick={() => setPickerOpen(true)}
        onClear={onClear}
        onSearch={search}
        onSearchSelect={onSelect}
        className={error ? 'border-destructive' : undefined}
      />
      {error ? (
        <p id={`${id}-error`} className="text-[12px] text-destructive leading-tight">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-[12px] text-muted-foreground leading-tight">
            {hint}
          </p>
        )
      )}
      <SearchPickerModal<DirectoryItem>
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={pickerTitle}
        selectedId={selectedId}
        fetchItems={search}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        onSelect={onSelect}
      />
    </div>
  );
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
  const qc = useQueryClient();
  const makeItems = useMemo(() => toItems(makesQuery.data), [makesQuery.data]);
  // Без марки запит моделей вимкнений, але кеш попередньої марки міг би лишитись у `data`.
  const modelItems = useMemo(
    () => (makeId ? toItems(modelsQuery.data) : NO_ITEMS),
    [makeId, modelsQuery.data],
  );
  // Пошук, набраний до відповіді сервера, чекає на неї: інакше «Нічого не знайдено» на марку, що є.
  // `ensureQueryData` приєднується до запиту, що вже йде (другого не шле), а збій кидає — поле й
  // вікно вибору показують «не вдалося», а не «не знайдено». Колбеки не залежать від `data`:
  // інакше прихід даних змінив би `fetchItems` відкритого вікна вибору, і воно перечитало б увесь
  // список поверх уже набраного пошуку.
  const loadMakes = useCallback(
    async () => toItems(await qc.ensureQueryData(vehicleMakesQuery())),
    [qc],
  );
  const loadModels = useCallback(
    async () => (makeId ? toItems(await qc.ensureQueryData(vehicleModelsQuery(makeId))) : NO_ITEMS),
    [qc, makeId],
  );

  const missingLabel = (loaded: boolean, name: string | undefined): string => {
    const shown = name || '…';
    return loaded ? t('form.unavailable', { name: shown }) : shown;
  };
  const modelsLoaded = !!makeId && modelsQuery.isSuccess;
  const makeDisplay = makeId
    ? (makeItems.find(m => m.id === makeId)?.primary ??
      missingLabel(makesQuery.isSuccess, currentMake))
    : '';
  const modelDisplay = modelId
    ? (modelItems.find(m => m.id === modelId)?.primary ?? missingLabel(modelsLoaded, currentModel))
    : '';
  // Збій завантаження — свій текст, а не «Оберіть марку» над порожнім списком (Bug #958).
  const failedQuery = makesQuery.isError
    ? makesQuery
    : makeId && modelsQuery.isError
      ? modelsQuery
      : null;

  const selectMake = (item: DirectoryItem) => {
    if (item.id !== makeId) {
      onMakeChange(item.id);
      onModelChange('');
    }
    onMakeBlur?.();
  };
  const clearMake = () => {
    onMakeChange('');
    onModelChange('');
    onMakeBlur?.();
  };
  const selectModel = (item: DirectoryItem) => {
    onModelChange(item.id);
    onModelBlur?.();
  };
  const clearModel = () => {
    onModelChange('');
    onModelBlur?.();
  };

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-3">
        <DirectoryField
          id={`${idPrefix}-make`}
          label={t('form.make')}
          required={required}
          disabled={disabled}
          display={makeDisplay}
          selectedId={makeId}
          load={loadMakes}
          pickerTitle={t('form.makePickerTitle')}
          searchPlaceholder={t('form.makeSearchPlaceholder')}
          emptyText={t('form.makeNotFound')}
          error={makeError}
          onSelect={selectMake}
          onClear={clearMake}
        />
        <DirectoryField
          id={`${idPrefix}-model`}
          label={t('form.model')}
          required={required}
          disabled={disabled || !makeId}
          display={modelDisplay}
          selectedId={modelId}
          load={loadModels}
          pickerTitle={t('form.modelPickerTitle')}
          searchPlaceholder={t('form.modelSearchPlaceholder')}
          emptyText={t('form.modelNotFound')}
          hint={makeId ? undefined : t('form.pickMakeFirst')}
          error={modelError}
          onSelect={selectModel}
          onClear={clearModel}
        />
      </div>
      {failedQuery && (
        <p
          role="alert"
          className="text-[12px] text-destructive-text"
          data-testid="vehicle-directory-load-error"
        >
          {t(failedQuery === makesQuery ? 'form.makesLoadFailed' : 'form.modelsLoadFailed')}{' '}
          <button
            type="button"
            onClick={() => void failedQuery.refetch()}
            className="text-primary underline-offset-2 hover:underline"
          >
            {t('form.directoryRetry')}
          </button>
        </p>
      )}
      {modelsLoaded && modelItems.length === 0 && (
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
