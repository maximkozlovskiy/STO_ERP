'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { warrantyFormSchema, type WarrantyFormInput } from '@sto/shared';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { kyivToday, addDaysISO } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useCreateWarranty } from '@/hooks/api/useWarranties';

interface Props {
  open: boolean;
  onClose: () => void;
  workOrderId: string;
  counterpartyId: string;
  /** Викликається після успішного створення (батько рефетчить список). */
  onCreated: () => void;
}

const EMPTY_FORM: WarrantyFormInput = { expiresAt: '', description: '' };

/**
 * Ручне створення гарантії на наряд (POST /warranties). Основний потік — авто-створення при
 * COMPLETED; ця модалка для випадків defaultWarrantyDays=0 або окремої гарантії. expiresAt має бути
 * у майбутньому (бекенд інакше 400) — DatePickerInput min=завтра.
 */
export function WarrantyCreateModal({
  open,
  onClose,
  workOrderId,
  counterpartyId,
  onCreated,
}: Props) {
  const { t } = useTranslation('workOrders');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const createWarranty = useCreateWarranty();
  const [error, setError] = useState('');

  // ── Form (react-hook-form + спільна zod-схема) ──────────────────────────────
  const {
    handleSubmit,
    register,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<WarrantyFormInput>({
    resolver: i18nZodResolver(warrantyFormSchema),
    defaultValues: EMPTY_FORM,
    mode: 'onBlur',
  });
  const expiresAt = watch('expiresAt');

  // WEB-H3 (клас Bug #630/#634): синхронний guard проти concurrent double-submit —
  // `loading` вимикає кнопку лише ПІСЛЯ re-render, два кліки в одному tick → 2 POST.
  const savingRef = useRef(false);

  // min = завтра (Kyiv) — гарантія лише у майбутнє. addDaysISO: UTC-арифметика, без залежності
  // від часового поясу браузера (local-parse + toISOString давав off-by-one на межі дня).
  const tomorrow = addDaysISO(kyivToday(), 1);

  // Скидання при кожному відкритті (модалка монтується постійно, відкривається прапорцем).
  useEffect(() => {
    if (!open) return;
    reset(EMPTY_FORM);
    dirty.resetDirty();
    setError('');
    savingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── Міст RHF isDirty → useDirtyForm (зберігає DirtyConfirmDialog + beforeunload) ──
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  /** Close-guard: під час збереження не закриваємо; при незбережених змінах — підтвердження. */
  const handleClose = async () => {
    if (savingRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const onValid = handleSubmit(async values => {
    if (savingRef.current) return;
    savingRef.current = true;
    setError('');
    try {
      await createWarranty.mutateAsync({
        workOrderId,
        counterpartyId,
        // Кінець вибраного дня в UTC (`T23:59:59Z`) — покриває весь день незалежно від
        // часового поясу браузера. Local-parse `T00:00:00`.toISOString() зсував дату на -1
        // у браузерах із додатнім offset (Kyiv UTC+3): 10-09 00:00 → 09-09 21:00Z (off-by-one).
        expiresAt: `${values.expiresAt}T23:59:59Z`,
        // Схема вже робить emptyToUndefined; тут лише нормалізуємо тип (z.input → unknown-ish).
        description:
          typeof values.description === 'string'
            ? values.description.trim() || undefined
            : undefined,
      });
      if (features.toastEnabled) toast.success(t('warranty.createdToast'));
      dirty.resetDirty();
      onCreated();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('warranty.createError');
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      savingRef.current = false;
    }
  });

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleClose()}
        title={t('warranty.createTitle')}
        size="sm"
        onSubmit={() => void onValid()}
        footer={
          <ModalFooter>
            <Button
              variant="outline"
              onClick={() => void handleClose()}
              disabled={createWarranty.isPending}
            >
              {t('warranty.cancel')}
            </Button>
            <Button onClick={() => void onValid()} loading={createWarranty.isPending}>
              {t('warranty.create')}
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('warranty.expiresLabel')} <span className="text-destructive">*</span>
            </label>
            <DatePickerInput
              value={expiresAt ?? ''}
              onChange={v => setValue('expiresAt', v, { shouldDirty: true, shouldValidate: true })}
              min={tomorrow}
            />
            {errors.expiresAt?.message && (
              <p className="mt-1 text-[12px] text-destructive-text">{errors.expiresAt.message}</p>
            )}
          </div>
          <div>
            <Input
              label={t('warranty.descriptionLabel')}
              {...register('description')}
              placeholder={t('warranty.descriptionPlaceholder')}
              maxLength={500}
              errorMessage={errors.description?.message}
            />
          </div>
        </div>
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
