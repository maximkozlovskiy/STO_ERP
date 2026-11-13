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
import { ReversalReasonField } from './reversal-reason-field';

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

/** Що саме сторнує картка: запит і тексти, що відрізняють оплату клієнта від оплати постачальнику. */
export interface ReversalReasonModalProps extends Props {
  /** Запит сторно: тіло `{ reason }`, ключ ідемпотентності — один на відкриття картки. */
  reverse: (args: { id: string; idempotencyKey: string; reason: string }) => Promise<unknown>;
  /** Запит у дорозі (`mutation.isPending`) — кнопки вимкнено, закриття заблоковано. */
  pending: boolean;
  texts: {
    title: string;
    /** Підпис контрагента в «Що сторнується» (платник / постачальник). */
    partyLabel: string;
    /** Абзаци «Що станеться» — уже з сумою. */
    consequences: string[];
    reasonPlaceholder: string;
    success: string;
    error: string;
  };
}

/** Межа довжини причини — зі спільної схеми, щоб лічильник не розійшовся з валідацією. */
const REASON_MAX = paymentReversalSchema.shape.reason.maxLength ?? undefined;

/**
 * Картка сторно безготівкової оплати клієнта (BR-PAY-024, `POST /payments/:id/reverse`) — тонка
 * обгортка над спільною `ReversalReasonModal` з її запитом і текстами.
 */
export function PaymentReversalModal(props: Props) {
  const { t } = useTranslation('cash');
  const reversePayment = useReversePayment();
  const amount = props.payment?.amountText ?? '';
  return (
    <ReversalReasonModal
      {...props}
      reverse={({ id, idempotencyKey, reason }) =>
        reversePayment.mutateAsync({ paymentId: id, idempotencyKey, reason })
      }
      pending={reversePayment.isPending}
      texts={{
        title: t('paymentReversal.title'),
        partyLabel: t('paymentReversal.fieldParty'),
        consequences: [
          t('paymentReversal.consequence.common', { amount }),
          props.payment?.fromBankStatement
            ? t('paymentReversal.consequence.bankLine')
            : t('paymentReversal.consequence.bankLineMaybe'),
          t('paymentReversal.consequence.money'),
        ],
        reasonPlaceholder: t('paymentReversal.reasonPlaceholder'),
        success: t('paymentReversal.success'),
        error: t('paymentReversal.error'),
      }}
    />
  );
}

/**
 * Спільна картка сторно оплати з причиною: оплата клієнта (`PaymentReversalModal`) і оплата
 * постачальнику (BR-SUPPAY-017). Зразок — сторно касової операції (`CashReversalModal`): що
 * сторнується й що станеться, — ДО відправки; причина обов'язкова (спільна `paymentReversalSchema`);
 * «Сторнувати» спершу просить підтвердження в самій картці. Ключ ідемпотентності — один на відкриття.
 *
 * `void` перед `submit()`/`close()` у JSX: відмову сервера `reverse` пише в банер картки, а
 * `confirmClose()` не реджектиться — проміс нікому не потрібен.
 */
export function ReversalReasonModal({
  open,
  onClose,
  payment,
  onReversed,
  reverse: reverseRequest,
  pending,
  texts,
}: ReversalReasonModalProps) {
  const { t } = useTranslation('cash');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
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
      await reverseRequest({
        id: payment.id,
        idempotencyKey: idempotencyKeyRef.current,
        reason: values.reason,
      });
      if (features.toastEnabled) toast.success(texts.success);
      dirty.resetDirty();
      onReversed?.();
      onClose();
    } catch (e) {
      // Причину могли б виправити — повертаємо картку на перший крок, текст відмови лишається.
      setConfirming(false);
      setError(e instanceof Error && e.message ? e.message : texts.error);
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
    if (pending || savingRef.current || dirty.dialogProps.open) return;
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
        title={texts.title}
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
                  loading={pending}
                  disabled={pending}
                >
                  {t('paymentReversal.confirmSubmit')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  {t('paymentReversal.back')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => void close()} disabled={pending}>
                {t('paymentReversal.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void submit()}
                disabled={pending}
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
                    <dt className="text-muted-foreground">{texts.partyLabel}</dt>
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
              {texts.consequences.map(line => (
                <p key={line}>{line}</p>
              ))}
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

          <ReversalReasonField
            id={reasonId}
            label={t('paymentReversal.reasonLabel')}
            placeholder={texts.reasonPlaceholder}
            registration={register('reason', { onChange: () => setConfirming(false) })}
            maxLength={REASON_MAX}
            errorMessage={errors.reason?.message}
            counter={
              REASON_MAX === undefined
                ? undefined
                : t('paymentReversal.counter', { count: reason.length, max: REASON_MAX })
            }
          />
        </div>
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
