'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import {
  paymentReversalSchema,
  type PaymentReversalFormInput,
  type PaymentReversalFormValues,
} from '@sto/shared';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useReversePayment } from '@/hooks/api/useBankStatements';
import { usePaymentMethodName } from '@/hooks/api/usePaymentMethods';
import { newIdempotencyKey } from '@/lib/idempotency-key';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

/** Що сторнується — уже відформатоване тим, хто відкриває картку (у нього є валюта й дата). */
export interface PaymentReversalTarget {
  id: string;
  /** Сума з валютою, як у рядку, з якого відкрито картку. */
  amountText: string;
  dateText: string;
  partyName?: string | null;
  /** Готовий підпис способу; без нього — назва з довідника за `methodCode`, інакше сам код. */
  methodLabel?: string | null;
  /** Код способу оплати (`Payment.method`) — картка бере його назву з довідника, не показує код. */
  methodCode?: string | null;
  /**
   * Оплата з рознесення виписки: true — рядок виписки стане «Нерознесений»; undefined — невідомо
   * (рядок «Пов'язаних документів»), картка каже «якщо».
   */
  fromBankStatement?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Оплата. Батько тримає її й після закриття (закриває лише `open`), щоб під час анімації виходу
   * вміст картки не зникав.
   */
  payment: PaymentReversalTarget | null;
  /** Після успішного сторно — до закриття (напр. панель «Пов'язаних документів» перечитується). */
  onReversed?: () => void;
}

/** Межа довжини причини — зі спільної схеми, щоб лічильник не розійшовся з валідацією. */
const REASON_MAX = paymentReversalSchema.shape.reason.maxLength ?? undefined;

/**
 * Картка сторно безготівкової оплати клієнта (BR-PAY-024, `POST /payments/:id/reverse`). Зразок —
 * сторно касової операції (`CashReversalModal`): що сторнується й що станеться, — ДО відправки;
 * причина обов'язкова (спільна `paymentReversalSchema`); «Сторнувати» спершу просить підтвердження
 * в самій картці. Ключ ідемпотентності — один на відкриття.
 *
 * `void` перед `submit()`/`close()` у JSX: відмову сервера `reverse` пише в банер картки, а
 * `confirmClose()` не реджектиться — проміс нікому не потрібен.
 */
export function PaymentReversalModal({ open, onClose, payment, onReversed }: Props) {
  const { t } = useTranslation('cash');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const reversePayment = useReversePayment();
  const reasonId = useId();
  const methodName = usePaymentMethodName(
    open && !payment?.methodLabel ? payment?.methodCode : null,
  );
  const methodText = payment?.methodLabel ?? methodName ?? payment?.methodCode ?? null;

  const {
    register,
    reset,
    watch,
    getValues,
    handleSubmit,
    formState: { errors },
  } = useForm<PaymentReversalFormInput, unknown, PaymentReversalFormValues>({
    resolver: i18nZodResolver(paymentReversalSchema),
    defaultValues: { reason: '' },
  });

  const [error, setError] = useState('');
  // Другий крок: людина натиснула «Сторнувати», картка питає «Так, сторнувати?».
  const [confirming, setConfirming] = useState(false);
  // Один ключ на відкриття: повтор після обриву на відповіді не дасть другої спроби сторно.
  const idempotencyKeyRef = useRef('');
  // `isPending` — знімок рендеру: два кліки в одному кадрі обидва бачать `false`.
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
  }, [open, payment?.id]);

  const reason = watch('reason') ?? '';

  const reverse = async (values: PaymentReversalFormValues) => {
    if (!payment || savingRef.current) return;
    savingRef.current = true;
    setError('');
    try {
      await reversePayment.mutateAsync({
        paymentId: payment.id,
        idempotencyKey: idempotencyKeyRef.current,
        reason: values.reason,
      });
      if (features.toastEnabled) toast.success(t('paymentReversal.success'));
      dirty.resetDirty();
      onReversed?.();
      onClose();
    } catch (e) {
      // Причину могли б виправити — повертаємо картку на перший крок, текст відмови лишається.
      setConfirming(false);
      setError(e instanceof Error && e.message ? e.message : t('paymentReversal.error'));
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
    if (reversePayment.isPending || savingRef.current || dirty.dialogProps.open) return;
    if (getValues('reason')?.trim()) dirty.markDirty();
    else dirty.resetDirty();
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const p = payment;

  return (
    <>
      <Modal
        open={open}
        onClose={() => void close()}
        onSubmit={() => void submit()}
        title={t('paymentReversal.title')}
        size="md"
        footer={
          confirming ? (
            <div className="flex w-full flex-col gap-2">
              <span role="status" className="text-[13px] text-destructive-text">
                {t('paymentReversal.confirmText')}
              </span>
              <div className="flex items-center justify-end gap-2">
                {/* «Назад» — праворуч, на місці кнопки першого кроку: подвійний клік по
                    «Сторнувати» влучає в «Назад», а не підтверджує сторно сам. */}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void submit()}
                  loading={reversePayment.isPending}
                  disabled={reversePayment.isPending}
                >
                  {t('paymentReversal.confirmSubmit')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={reversePayment.isPending}
                >
                  {t('paymentReversal.back')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void close()}
                disabled={reversePayment.isPending}
              >
                {t('paymentReversal.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void submit()}
                disabled={reversePayment.isPending}
              >
                {t('paymentReversal.submit')}
              </Button>
            </div>
          )
        }
      >
        <div className="space-y-4">
          {p && (
            <section
              aria-label={t('paymentReversal.summaryTitle')}
              className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[13px]"
            >
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">{t('paymentReversal.fieldDate')}</dt>
                <dd className="tabular-nums">{p.dateText}</dd>
                <dt className="text-muted-foreground">{t('paymentReversal.fieldAmount')}</dt>
                <dd className="font-semibold tabular-nums">{p.amountText}</dd>
                {methodText && (
                  <>
                    <dt className="text-muted-foreground">{t('paymentReversal.fieldMethod')}</dt>
                    <dd>{methodText}</dd>
                  </>
                )}
                {p.partyName && (
                  <>
                    <dt className="text-muted-foreground">{t('paymentReversal.fieldParty')}</dt>
                    <dd>{p.partyName}</dd>
                  </>
                )}
              </dl>
            </section>
          )}

          {p && (
            <div
              role="note"
              className="space-y-1 text-[13px] text-warning-text bg-warning-subtle border border-warning-border rounded-lg px-3 py-2"
            >
              <div className="font-medium">{t('paymentReversal.consequenceTitle')}</div>
              <p>{t('paymentReversal.consequence.common', { amount: p.amountText })}</p>
              <p>
                {p.fromBankStatement
                  ? t('paymentReversal.consequence.bankLine')
                  : t('paymentReversal.consequence.bankLineMaybe')}
              </p>
              <p>{t('paymentReversal.consequence.money')}</p>
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
              {t('paymentReversal.reasonLabel')}
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
              placeholder={t('paymentReversal.reasonPlaceholder')}
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
                  {t('paymentReversal.counter', { count: reason.length, max: REASON_MAX })}
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
