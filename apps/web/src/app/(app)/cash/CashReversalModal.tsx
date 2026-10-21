'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import {
  cashReversalSchema,
  type CashReversalFormInput,
  type CashReversalFormValues,
} from '@sto/shared';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { toast } from '@/lib/toast';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useReverseCashOperation, type CashOperation } from '@/hooks/api/useCash';
import { newIdempotencyKey } from '@/lib/idempotency-key';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Рядок-оригінал. Батько тримає його й після закриття (закриває лише `open`), щоб під час
   * анімації виходу вміст картки не зникав.
   */
  operation: CashOperation | null;
  /** Символ валюти каси — сума в картці така сама, як у рядку історії. */
  currencySymbol: string;
}

/** Приводи, сторно яких відкочує ще щось, крім каси (BR-CASH-024, 025). */
const CONSEQUENCE_REASONS = new Set([
  'SALE_PAYMENT',
  'SUPPLIER_PAYMENT',
  'REFUND',
  'SUPPLIER_REFUND_IN',
]);

/** Межа довжини причини — зі спільної схеми, щоб лічильник не розійшовся з валідацією. */
const REASON_MAX = cashReversalSchema.shape.reason.maxLength ?? undefined;

/**
 * Картка сторно касової операції (BR-CASH-023…025). Зразок — скасування рознесення банківського
 * платежу (`UnreconcileBankTransactionModal`): що саме сторнується й що станеться, — ДО відправки;
 * причина обов'язкова (спільна `cashReversalSchema`, MP-F6).
 *
 * Сторно незворотне, тому «Сторнувати» спершу просить підтвердження в самій картці, а не
 * вкладеним діалогом: вкладена модалка ділила б із карткою Escape (docs/GOTCHAS.md, 2026-10-12).
 *
 * `void` перед `submit()`/`close()` у JSX: відмову сервера `reverse` пише в банер картки, а
 * `confirmClose()` не реджектиться — проміс нікому не потрібен.
 */
export function CashReversalModal({ open, onClose, operation, currencySymbol }: Props) {
  const { t } = useTranslation('cash');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const reverseOp = useReverseCashOperation();
  const reasonId = useId();

  const {
    register,
    reset,
    watch,
    getValues,
    handleSubmit,
    formState: { errors },
  } = useForm<CashReversalFormInput, unknown, CashReversalFormValues>({
    resolver: i18nZodResolver(cashReversalSchema),
    defaultValues: { reason: '' },
  });

  const [error, setError] = useState('');
  // Другий крок: людина натиснула «Сторнувати», картка питає «Так, сторнувати?».
  const [confirming, setConfirming] = useState(false);
  // Один ключ на відкриття: повтор після обриву на відповіді не створить другого сторно.
  const idempotencyKeyRef = useRef('');
  // `reverseOp.isPending` — знімок рендеру: два кліки в одному кадрі обидва бачать `false`.
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    reset({ reason: '' });
    setError('');
    setConfirming(false);
    idempotencyKeyRef.current = newIdempotencyKey();
    savingRef.current = false;
    dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, operation?.id]);

  const reason = watch('reason') ?? '';

  const reverse = async (values: CashReversalFormValues) => {
    if (!operation || savingRef.current) return;
    savingRef.current = true;
    setError('');
    try {
      await reverseOp.mutateAsync({
        cashRegisterId: operation.cashRegisterId,
        operationId: operation.id,
        idempotencyKey: idempotencyKeyRef.current,
        reason: values.reason,
      });
      toast.success(t('reversal.success'));
      dirty.resetDirty();
      onClose();
    } catch (e) {
      // Причину могли б виправити — повертаємо картку на перший крок, текст відмови лишається.
      setConfirming(false);
      setError(e instanceof Error && e.message ? e.message : t('reversal.error'));
    } finally {
      savingRef.current = false;
    }
  };

  // Перший клік лише перевіряє причину й просить підтвердження; запит іде з другого.
  const submit = handleSubmit(async values => {
    if (confirming) {
      await reverse(values);
      return;
    }
    setError('');
    setConfirming(true);
  });

  const close = async () => {
    if (reverseOp.isPending || savingRef.current || dirty.dialogProps.open) return;
    if (getValues('reason')?.trim()) dirty.markDirty();
    else dirty.resetDirty();
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const op = operation;
  const amountText = op ? `${fmtMoney(op.amount)} ${currencySymbol}`.trim() : '';
  const party = op?.counterpartyName || op?.employeeName || '';
  const reasonLabel = op ? t(`reasons.${op.reason}`, { defaultValue: op.reason }) : '';

  return (
    <>
      <Modal
        open={open}
        onClose={() => void close()}
        onSubmit={() => void submit()}
        title={t('reversal.title')}
        size="md"
        footer={
          confirming ? (
            <div className="flex w-full flex-col gap-2">
              <span role="status" className="text-[13px] text-destructive-text">
                {t('reversal.confirmText')}
              </span>
              <div className="flex items-center justify-end gap-2">
                {/* «Назад» — праворуч, на місці кнопки першого кроку: подвійний клік по
                    «Сторнувати» влучає в «Назад», а не підтверджує сторно сам. */}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void submit()}
                  loading={reverseOp.isPending}
                  disabled={reverseOp.isPending}
                >
                  {t('reversal.confirmSubmit')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={reverseOp.isPending}
                >
                  {t('reversal.back')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void close()}
                disabled={reverseOp.isPending}
              >
                {t('reversal.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void submit()}
                disabled={reverseOp.isPending}
              >
                {t('reversal.submit')}
              </Button>
            </div>
          )
        }
      >
        <div className="space-y-4">
          {op && (
            <section
              aria-label={t('reversal.summaryTitle')}
              className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[13px]"
            >
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">{t('reversal.fieldDate')}</dt>
                <dd className="tabular-nums">{fmtDateTime(op.createdAt)}</dd>
                <dt className="text-muted-foreground">{t('reversal.fieldOperation')}</dt>
                <dd>
                  {op.direction === 'IN'
                    ? t('operations.directionIn')
                    : t('operations.directionOut')}
                  {' · '}
                  {reasonLabel}
                </dd>
                <dt className="text-muted-foreground">{t('reversal.fieldAmount')}</dt>
                <dd className="font-semibold tabular-nums">{amountText}</dd>
                {party && (
                  <>
                    <dt className="text-muted-foreground">{t('reversal.fieldParty')}</dt>
                    <dd>{party}</dd>
                  </>
                )}
                {op.baseDocumentNumber && (
                  <>
                    <dt className="text-muted-foreground">{t('reversal.fieldBase')}</dt>
                    <dd>{op.baseDocumentNumber}</dd>
                  </>
                )}
              </dl>
            </section>
          )}

          {op && (
            <div
              role="note"
              className="space-y-1 text-[13px] text-warning-text bg-warning-subtle border border-warning-border rounded-lg px-3 py-2"
            >
              <div className="font-medium">{t('reversal.consequenceTitle')}</div>
              <p>
                {op.direction === 'IN'
                  ? t('reversal.consequence.commonIn', { amount: amountText })
                  : t('reversal.consequence.commonOut', { amount: amountText })}
              </p>
              {CONSEQUENCE_REASONS.has(op.reason) && (
                <p>{t(`reversal.consequence.${op.reason}`)}</p>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
            >
              {error}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label
              htmlFor={reasonId}
              className="text-[13px] font-medium text-foreground leading-none"
            >
              {t('reversal.reasonLabel')}
              <span className="ml-0.5 text-destructive">*</span>
            </label>
            <textarea
              id={reasonId}
              {...register('reason', { onChange: () => setConfirming(false) })}
              maxLength={REASON_MAX}
              rows={3}
              required
              autoFocus
              aria-invalid={!!errors.reason}
              placeholder={t('reversal.reasonPlaceholder')}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition-all duration-150 hover:border-border-hover focus:border-primary focus:ring-3 focus:ring-brand-100 resize-y"
            />
            <div className="flex items-start justify-between gap-3">
              <p
                role={errors.reason ? 'alert' : undefined}
                className="text-[12px] text-destructive"
              >
                {errors.reason?.message}
              </p>
              {REASON_MAX !== undefined && (
                <p className="shrink-0 text-[12px] text-muted-foreground text-right tabular-nums">
                  {t('reversal.counter', { count: reason.length, max: REASON_MAX })}
                </p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
