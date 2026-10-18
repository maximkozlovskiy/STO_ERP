'use client';

import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Send, Undo2 } from 'lucide-react';
import { fmtDateTime, fmtQty } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { useConfirm } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import {
  SUPPLIER_API_SEND_ROLES,
  isSentToSupplier,
  supplierApiOrderApi,
  supplierApiOrderKeys,
  usePurchaseOrderSupplierApi,
  type PurchaseOrderSupplierApi,
  type SupplierApiOrder,
} from '@/hooks/api/useSupplierApiOrder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type BadgeVariant = 'secondary' | 'info' | 'success' | 'warning' | 'destructive';

const SUMMARY_BADGE: Record<PurchaseOrderSupplierApi['supplierApiStatus'], BadgeVariant> = {
  NOT_SENT: 'secondary',
  QUEUED: 'info',
  SENT: 'info',
  PARTIAL: 'warning',
  CONFIRMED: 'success',
  FAILED: 'destructive',
  NEEDS_ATTENTION: 'warning',
};

const EXTERNAL_BADGE: Record<SupplierApiOrder['status'], BadgeVariant> = {
  QUEUED: 'info',
  SENDING: 'info',
  PLACED: 'info',
  CONFIRMED: 'success',
  PARTIALLY_CONFIRMED: 'warning',
  READY: 'success',
  SHIPPED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'secondary',
  FAILED: 'destructive',
  UNKNOWN: 'warning',
};

/** Скільки після «Оновити статус» опитувати стан: задача постачальнику йде через чергу. */
const WATCH_AFTER_POLL_MS = 30_000;

// crypto.randomUUID є лише в secure context; on-prem сервер СТО відкривають по http у LAN.
const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/**
 * Скасування / видалення замовлення, вже переданого постачальнику (BR-SCON-014, рішення власника):
 * спершу звичайний запит; якщо сервер відмовив, а замовлення справді вже в постачальника, —
 * підтвердження «скасуйте його в кабінеті постачальника» і повтор із `force`. API постачальника
 * не викликається. `nestedOpenRef` — для вікна-власника: Escape підтвердження не має закривати й
 * його (прапорець знімається після події, GOTCHAS 2026-10-12).
 */
export function useSentOrderForce(nestedOpenRef?: MutableRefObject<boolean>) {
  const { t } = useTranslation('supplierApi');
  const { confirm, dialogProps } = useConfirm();

  const run = useCallback(
    async <T,>(
      purchaseOrderId: string,
      kind: 'cancel' | 'delete',
      attempt: (force: boolean) => Promise<T>,
    ): Promise<{ done: true; result: T } | { done: false }> => {
      try {
        return { done: true, result: await attempt(false) };
      } catch (e: unknown) {
        let state: PurchaseOrderSupplierApi;
        try {
          state = await supplierApiOrderApi.get(purchaseOrderId);
        } catch {
          throw e;
        }
        if (!isSentToSupplier(state)) throw e;
        if (nestedOpenRef) nestedOpenRef.current = true;
        const ok = await confirm({
          title: t('order.cancelSentTitle'),
          message: t(kind === 'cancel' ? 'order.cancelSentMessage' : 'order.deleteSentMessage'),
          confirmLabel: t('order.cancelSentConfirm'),
          cancelLabel: t('common:cancel'),
          variant: 'destructive',
        });
        setTimeout(() => {
          if (nestedOpenRef) nestedOpenRef.current = false;
        }, 0);
        if (!ok) return { done: false };
        return { done: true, result: await attempt(true) };
      }
    },
    [confirm, nestedOpenRef, t],
  );

  /**
   * Масове видалення (сторінка «Купівля»): ті самі правила, що й для одиночного, — замовлення,
   * яким сервер відмовив, бо вони вже в постачальника, після ОДНОГО спільного підтвердження
   * повторюються з `force`; решта відмов лишається відмовами. Повертає підсумок для тосту.
   */
  const runMany = useCallback(
    async (
      purchaseOrderIds: string[],
      attempt: (id: string, force: boolean) => Promise<unknown>,
    ): Promise<{ succeeded: number; failed: number }> => {
      const first = await Promise.allSettled(purchaseOrderIds.map(id => attempt(id, false)));
      const rejectedIds = purchaseOrderIds.filter((_, i) => first[i]?.status === 'rejected');
      let succeeded = first.length - rejectedIds.length;
      if (rejectedIds.length === 0) return { succeeded, failed: 0 };

      const states = await Promise.allSettled(rejectedIds.map(id => supplierApiOrderApi.get(id)));
      const sentIds = rejectedIds.filter((_, i) => {
        const st = states[i];
        return st?.status === 'fulfilled' && isSentToSupplier(st.value);
      });
      if (sentIds.length === 0) return { succeeded, failed: rejectedIds.length };

      if (nestedOpenRef) nestedOpenRef.current = true;
      const ok = await confirm({
        title: t('order.cancelSentTitle'),
        message: t('order.deleteSentManyMessage', { count: sentIds.length }),
        confirmLabel: t('order.cancelSentConfirm'),
        cancelLabel: t('common:cancel'),
        variant: 'destructive',
      });
      setTimeout(() => {
        if (nestedOpenRef) nestedOpenRef.current = false;
      }, 0);
      if (!ok) return { succeeded, failed: rejectedIds.length };

      const forced = await Promise.allSettled(sentIds.map(id => attempt(id, true)));
      const forcedOk = forced.filter(r => r.status === 'fulfilled').length;
      succeeded += forcedOk;
      return { succeeded, failed: rejectedIds.length - forcedOk };
    },
    [confirm, nestedOpenRef, t],
  );

  return { run, runMany, dialogProps };
}

interface Props {
  purchaseOrderId: string;
  /** Поточний статус замовлення: «Відправити» з чернетки спершу переводить у «Замовлено». */
  poStatus: string;
  /** Замовлення змінилось на сервері (статус, позиції) — картка перечитує себе й сторінку. */
  onChanged: () => void;
  /** Прапорець вікна-власника «відкрито вкладене підтвердження» (Escape). */
  nestedOpenRef?: MutableRefObject<boolean>;
  /**
   * У картці є незбережені правки: постачальнику пішла б збережена версія, а перечитування картки
   * після дії мовчки стерло б правки — «Відправити» й «Повернути» вимкнені до збереження.
   */
  unsavedChanges?: boolean;
}

/**
 * Передача замовлення постачальнику через API в картці замовлення (BR-SCON-009…013, BR-PO-011):
 * підсумковий статус, зовнішні номери й статуси, рядки «запитано / підтверджено», помилка;
 * «Відправити в API», «Оновити статус», «Повернути непідтверджене в список». Ховається, коли в
 * постачальника немає підключення і замовлення нікуди не передавалось.
 */
export function SupplierApiOrderBlock({
  purchaseOrderId,
  poStatus,
  onChanged,
  nestedOpenRef,
  unsavedChanges = false,
}: Props) {
  const { t } = useTranslation('supplierApi');
  const qc = useQueryClient();
  const features = useUiFeatures();
  // Помилка дії — у блоці (role=alert), а не лише тостом: з вимкненими тостами її не видно.
  const [actionError, setActionError] = useState('');
  // Ключ ідемпотентності живе до успіху: повтор після обриву зв'язку йде з ТИМ САМИМ ключем, і
  // сервер віддає першу відповідь, а не «уже відправлено» як помилку (BR-SCON-009).
  const sendKeyRef = useRef<string | null>(null);
  const { employee } = useAuth();
  const canAct = SUPPLIER_API_SEND_ROLES.includes(employee?.role ?? '');
  const { confirm, dialogProps } = useConfirm();
  const [watchUntil, setWatchUntil] = useState(0);
  const [busy, setBusy] = useState<'send' | 'poll' | 'release' | null>(null);
  const busyRef = useRef(false);
  const { data: state, error, refetch } = usePurchaseOrderSupplierApi(purchaseOrderId, watchUntil);

  const ask = async (title: string, message?: string) => {
    if (nestedOpenRef) nestedOpenRef.current = true;
    const ok = await confirm({ title, message });
    setTimeout(() => {
      if (nestedOpenRef) nestedOpenRef.current = false;
    }, 0);
    return ok;
  };

  const act = async (kind: 'send' | 'poll' | 'release', fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setActionError('');
    try {
      await fn();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : t('order.loadError');
      setActionError(message);
      if (features.toastEnabled) toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(null);
      void refetch();
    }
  };

  const send = () =>
    act('send', async () => {
      const ok = await ask(
        t('order.sendConfirm'),
        poStatus === 'DRAFT' ? t('order.sendConfirmDraft') : undefined,
      );
      if (!ok) return;
      sendKeyRef.current ??= newIdempotencyKey();
      const next = await supplierApiOrderApi.send(purchaseOrderId, sendKeyRef.current);
      sendKeyRef.current = null;
      qc.setQueryData(supplierApiOrderKeys.state(purchaseOrderId), next);
      if (features.toastEnabled) toast.success(t('order.sendQueued'));
      invalidateProcurementSideEffects(qc);
      onChanged();
    });

  const poll = () =>
    act('poll', async () => {
      await supplierApiOrderApi.poll(purchaseOrderId);
      setWatchUntil(Date.now() + WATCH_AFTER_POLL_MS);
      if (features.toastEnabled) toast.success(t('order.pollQueued'));
    });

  const release = () =>
    act('release', async () => {
      if (!(await ask(t('order.releaseConfirm')))) return;
      const res = await supplierApiOrderApi.release(purchaseOrderId);
      qc.setQueryData(supplierApiOrderKeys.state(purchaseOrderId), res.state);
      if (features.toastEnabled) toast.success(t('order.released', { qty: fmtQty(res.released) }));
      invalidateProcurementSideEffects(qc);
      onChanged();
    });

  if (error && !state) {
    return (
      <p className="text-[12px] text-destructive-text" role="alert">
        {t('order.loadError')}
      </p>
    );
  }
  // Відповідь без переліку зовнішніх замовлень (старий API, збій проксі) — блок не показуємо.
  if (!state || !Array.isArray(state.orders)) return null;
  if (!state.hasConnection && state.orders.length === 0 && state.supplierApiStatus === 'NOT_SENT')
    return null;

  const canPoll = canAct && state.orders.some(o => !!o.externalOrderId);

  return (
    <section
      className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5 space-y-2"
      aria-labelledby={`supplier-api-${purchaseOrderId}`}
      data-testid="supplier-api-order-block"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`supplier-api-${purchaseOrderId}`} className="text-[13px] font-semibold">
          {t('order.title')}
        </h3>
        <Badge variant={SUMMARY_BADGE[state.supplierApiStatus]} data-testid="supplier-api-status">
          {t(`order.status.${state.supplierApiStatus}`)}
        </Badge>
        {state.supplierApiSentAt && (
          <span className="text-[12px] text-muted-foreground">
            {t('order.sentAt', { at: fmtDateTime(state.supplierApiSentAt) })}
          </span>
        )}
        {state.sendMode === 'ON_ORDERED' && state.supplierApiStatus === 'NOT_SENT' && (
          <span className="text-[12px] text-muted-foreground">{t('order.sendModeAuto')}</span>
        )}
        {!state.hasConnection && (
          <span className="text-[12px] text-muted-foreground">{t('order.noConnection')}</span>
        )}
        {canAct && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {state.canSend && (
              <Button
                size="xs"
                onClick={() => void send()}
                loading={busy === 'send'}
                disabled={!!busy || unsavedChanges}
                leftIcon={<Send className="h-3 w-3" aria-hidden="true" />}
              >
                {t('order.send')}
              </Button>
            )}
            {canPoll && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void poll()}
                loading={busy === 'poll'}
                disabled={!!busy}
                leftIcon={<RefreshCw className="h-3 w-3" aria-hidden="true" />}
              >
                {t('order.poll')}
              </Button>
            )}
            {state.canRelease && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void release()}
                loading={busy === 'release'}
                disabled={!!busy || unsavedChanges}
                leftIcon={<Undo2 className="h-3 w-3" aria-hidden="true" />}
              >
                {t('order.release')}
              </Button>
            )}
          </div>
        )}
      </div>

      {unsavedChanges && canAct && (state.canSend || state.canRelease) && (
        <p className="text-[12px] text-muted-foreground">{t('order.saveFirst')}</p>
      )}
      {actionError && (
        <p className="text-[12px] text-destructive-text break-words" role="alert">
          {actionError}
        </p>
      )}
      {state.supplierApiError && (
        <p className="text-[12px] text-destructive-text break-words">{state.supplierApiError}</p>
      )}
      {state.warnings.map(w => (
        <p key={w} className="text-[12px] text-warning-text">
          {t('order.warning', { text: w })}
        </p>
      ))}

      {state.orders.length > 0 && (
        <ul className="space-y-1.5">
          {state.orders.map(o => (
            <li key={o.id} className="text-[12px]" data-testid="supplier-api-external-order">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{o.connectionName}</span>
                {o.externalNumber && (
                  <span className="text-muted-foreground">
                    {t('order.externalNumber', { number: o.externalNumber })}
                  </span>
                )}
                <Badge
                  variant={EXTERNAL_BADGE[o.status]}
                  tooltip={o.externalStatusRaw ?? undefined}
                >
                  {t(`order.externalStatus.${o.status}`)}
                </Badge>
              </div>
              {o.error && <p className="text-destructive-text break-words">{o.error}</p>}
              <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                {o.lines.map(l => (
                  <li key={l.id} className="flex flex-wrap gap-x-2">
                    <span className="text-foreground">{l.goodName}</span>
                    <span className="tabular-nums">
                      {t('order.lineRequested', { qty: fmtQty(l.qtyRequested) })}
                    </span>
                    <span className="tabular-nums">
                      {l.qtyConfirmed === null
                        ? t('order.lineAwaiting')
                        : t('order.lineConfirmed', { qty: fmtQty(l.qtyConfirmed) })}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
