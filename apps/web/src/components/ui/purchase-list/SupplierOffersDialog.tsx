'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  fmtBankCurrencySuffix,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtQty,
  fmtTime,
} from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { useConfirm } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';
import {
  offerTermText,
  supplierOffersApi,
  supplierOffersKeys,
  useItemOffers,
  useSupplierOfferBatch,
  type SupplierOffer,
  type SupplierOfferItem,
  type SupplierOfferRequest,
} from '@/hooks/api/useSupplierOffers';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type ChipVariant = 'info' | 'warning' | 'success' | 'destructive' | 'secondary';

interface ChipView {
  label: string;
  variant: ChipVariant;
  title?: string;
}

/**
 * Стан запиту одного підключення (BR-SOFR-002): черга / виконується → «Завантаження…»;
 * немає зв'язку чи ліміт → «Немає зв'язку — повтор о HH:MM»; готово — кількість пропозицій або
 * «З кешу від …»; помилка — з текстом у підказці.
 */
export function requestChip(
  r: SupplierOfferRequest,
  t: (key: string, opts?: Record<string, unknown>) => string,
): ChipView {
  switch (r.status) {
    case 'QUEUED':
    case 'RUNNING':
      return { label: t('offers.chip.loading'), variant: 'info' };
    case 'RETRYING':
      return {
        label: r.nextRetryAt
          ? t('offers.chip.retry', { time: fmtTime(r.nextRetryAt) })
          : t('offers.chip.retryNoTime'),
        variant: 'warning',
        title: r.error ?? undefined,
      };
    case 'FAILED':
      return {
        label: t('offers.chip.failed'),
        variant: 'destructive',
        title: r.error ?? undefined,
      };
    case 'DONE': {
      const base = r.fromCache
        ? t('offers.chip.cache', { at: fmtDateTime(r.fetchedAt) })
        : t('offers.chip.done', { count: r.offers.length });
      const notes = [
        r.stale ? t('offers.chip.stale') : null,
        r.mirrorStale ? t('offers.chip.mirrorStale') : null,
      ].filter(Boolean);
      return {
        label: notes.length ? `${base} · ${notes.join(', ')}` : base,
        variant: r.stale || r.mirrorStale ? 'warning' : 'success',
      };
    }
    default: {
      const never: never = r.status;
      return { label: String(never), variant: 'secondary' };
    }
  }
}

interface OfferRow {
  offer: SupplierOffer;
  supplierName: string;
  /** Пропозиція з останнього відомого результату, бо поточний запит ще не відповів. */
  fromLastKnown: boolean;
}

/**
 * Запити для показу: поточні з пошуку; якщо підключення ще не відповіло (немає зв'язку), а
 * раніше пропозиції були — показуємо останні відомі (BR-SOFR-003).
 */
export function mergeRequests(
  current: SupplierOfferItem | undefined,
  ...fallbacks: Array<SupplierOfferItem | undefined>
): { requests: SupplierOfferRequest[]; rows: OfferRow[] } {
  const requests = current?.requests ?? fallbacks.find(f => f)?.requests ?? [];
  // Останній виконаний запит кожного підключення серед відомих (попередній пошук, BR-SOFR-003).
  const known = new Map<string, SupplierOfferRequest>();
  for (const f of fallbacks) {
    for (const r of f?.requests ?? []) {
      if (r.status !== 'DONE') continue;
      const prev = known.get(r.connectionId);
      if (!prev || (r.fetchedAt ?? '') > (prev.fetchedAt ?? '')) known.set(r.connectionId, r);
    }
  }
  const rows: OfferRow[] = [];
  for (const r of requests) {
    const prev = known.get(r.connectionId);
    const useKnown = r.status !== 'DONE' && !!prev;
    const src = useKnown && prev ? prev : r;
    for (const offer of src.offers) {
      rows.push({ offer, supplierName: src.supplierName, fromLastKnown: useKnown });
    }
  }
  rows.sort((a, b) => {
    const pa = a.offer.priceUah ?? Number.POSITIVE_INFINITY;
    const pb = b.offer.priceUah ?? Number.POSITIVE_INFINITY;
    return pa - pb || a.offer.offerKey.localeCompare(b.offer.offerKey);
  });
  return { requests, rows };
}

interface Props {
  item: PurchaseListItem | null;
  onClose: () => void;
}

/**
 * «Пропозиції» позиції списку купівлі (BR-SOFR-002, 003, 005, 006): відкриття запускає пошук
 * (свіжий кеш у межах TTL повторно використовується), «Оновити» — запит заново. Поки
 * постачальники відповідають — чипи стану кожного підключення й опитування; офлайн — останні
 * відомі пропозиції. «Обрати» — ручний вибір (ціна в гривні за курсом, знімок у позиції).
 * Ціни бачать лише ролі закупівлі — діалог відкривається лише для них (BR-SOFR-010).
 */
export function SupplierOffersDialog({ item, onClose }: Props) {
  const { t } = useTranslation('supplierApi');
  const features = useUiFeatures();
  const qc = useQueryClient();
  // `nestedOpenRef` — підтвердження відкрите: Escape у ньому не має закривати й цей діалог
  // (знімається після події, GOTCHAS 2026-10-12).
  const { confirm, dialogProps, openRef: nestedOpenRef } = useConfirm();
  const itemId = item?.id ?? null;
  const [batchId, setBatchId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; variant: 'warning' | 'error' } | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyOfferId, setBusyOfferId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const searchSeq = useRef(0);

  const lastKnown = useItemOffers(itemId);
  const batch = useSupplierOfferBatch(batchId);
  // Результат попереднього пошуку в цьому діалозі: після «Оновити» без зв'язку його пропозиції
  // лишаються видимими як останні відомі.
  const [previous, setPrevious] = useState<SupplierOfferItem | undefined>(undefined);
  const currentRef = useRef<SupplierOfferItem | undefined>(undefined);

  const search = useCallback(
    async (id: string, refresh: boolean) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      setNotice(null);
      try {
        const res = await supplierOffersApi.search({ itemIds: [id], refresh });
        if (seq !== searchSeq.current) return;
        qc.setQueryData(supplierOffersKeys.batch(res.id), res);
        if (currentRef.current) setPrevious(currentRef.current);
        setBatchId(res.id);
        if (res.noConnections) setNotice({ text: t('offers.noConnections'), variant: 'warning' });
        else if (res.skippedItemIds.includes(id))
          setNotice({ text: t('offers.noArticle'), variant: 'warning' });
        else if (res.queueUnavailable)
          setNotice({ text: t('offers.queueUnavailable'), variant: 'warning' });
      } catch (e: unknown) {
        if (seq !== searchSeq.current) return;
        setNotice({
          text: t('offers.searchFailed', { error: e instanceof Error ? e.message : '' }),
          variant: 'error',
        });
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [qc, t],
  );

  useEffect(() => {
    setBatchId(null);
    setNotice(null);
    setPrevious(undefined);
    currentRef.current = undefined;
    if (itemId) void search(itemId, false);
    else searchSeq.current += 1;
  }, [itemId, search]);

  const current = batch.data?.items.find(i => i.itemId === itemId);
  const view = current ?? lastKnown.data;
  const { requests, rows } = useMemo(
    () => mergeRequests(current, previous, lastKnown.data),
    [current, previous, lastKnown.data],
  );
  useEffect(() => {
    if (current) currentRef.current = current;
  }, [current]);
  const waiting = requests.some(r => r.status === 'QUEUED' || r.status === 'RUNNING');

  const finish = () => {
    invalidateProcurementSideEffects(qc);
    onClose();
  };

  const choose = async (row: OfferRow) => {
    if (!item || busyRef.current) return;
    if (row.offer.replacesGood) {
      const ok = await confirm({
        title: t('offers.confirmReplace', {
          article: row.offer.article,
          brand: row.offer.brand ?? '',
        }),
        message: t('offers.confirmReplaceHint'),
      });
      if (!ok) return;
    }
    busyRef.current = true;
    setBusyOfferId(row.offer.id);
    try {
      const updated = await supplierOffersApi.choose(item.id, row.offer.id);
      // Кратність пропозиції: сервер округлив кількість позиції вгору (Bug #890) — кажемо про це.
      if (features.toastEnabled)
        toast.success(
          (updated?.quantity ?? 0) > item.quantity
            ? t('offers.chosenToastQty', {
                supplier: row.supplierName,
                qty: fmtQty(updated.quantity),
                step: fmtQty(row.offer.multiplicity ?? 1),
              })
            : t('offers.chosenToast', { supplier: row.supplierName }),
        );
      finish();
    } catch (e: unknown) {
      // Відмова (аналог не обирається, немає курсу, позицію змінено) — у діалозі, не лише тостом:
      // з вимкненими тостами вона інакше не видна ніде.
      setNotice({ text: e instanceof Error ? e.message : t('offers.loadError'), variant: 'error' });
      void lastKnown.refetch();
      if (batchId) void batch.refetch();
    } finally {
      busyRef.current = false;
      setBusyOfferId(null);
    }
  };

  const clear = async () => {
    if (!item || busyRef.current) return;
    busyRef.current = true;
    setBusyOfferId('clear');
    try {
      await supplierOffersApi.clear(item.id);
      if (features.toastEnabled) toast.success(t('offers.clearedToast'));
      finish();
    } catch (e: unknown) {
      setNotice({ text: e instanceof Error ? e.message : t('offers.loadError'), variant: 'error' });
    } finally {
      busyRef.current = false;
      setBusyOfferId(null);
    }
  };

  const handleClose = () => {
    if (nestedOpenRef.current) return;
    searchSeq.current += 1;
    onClose();
  };

  const loadFailed = !view && !!lastKnown.error && !batchId;

  return (
    <>
      <Modal
        open={item !== null}
        onClose={handleClose}
        title={t('offers.title', { good: item?.goodName ?? '' })}
        description={
          item
            ? t('offers.need', { qty: `${fmtQty(item.quantity)} ${item.goodUnit ?? ''}` })
            : undefined
        }
        size="content"
        footer={
          <ModalFooter className="justify-between">
            <div>
              {item?.offerKey && item.status === 'OPEN' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void clear()}
                  loading={busyOfferId === 'clear'}
                  disabled={!!busyOfferId}
                >
                  {t('offers.clear')}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => itemId && void search(itemId, true)}
                loading={searching}
                disabled={!!busyOfferId}
                leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                {t('offers.refresh')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleClose}>
                {t('common:close')}
              </Button>
            </div>
          </ModalFooter>
        }
      >
        <div className="space-y-3 min-w-0" data-testid="supplier-offers-dialog">
          {requests.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-live="polite">
              {requests.map(r => {
                const chip = requestChip(r, t);
                return (
                  <Badge
                    key={r.connectionId}
                    variant={chip.variant}
                    tooltip={chip.title}
                    data-testid="offer-connection-chip"
                  >
                    {r.supplierName}: {chip.label}
                  </Badge>
                );
              })}
            </div>
          )}
          {/* Причина збою підключення — текстом, а не лише в підказці при наведенні (клавіатура,
              читач екрана, сенсорний екран). */}
          {requests.some(r => r.error && (r.status === 'FAILED' || r.status === 'RETRYING')) && (
            <ul className="space-y-0.5 text-[12px] text-muted-foreground">
              {requests
                .filter(r => r.error && (r.status === 'FAILED' || r.status === 'RETRYING'))
                .map(r => (
                  <li key={r.connectionId} className="break-words">
                    {r.supplierName}: {r.error}
                  </li>
                ))}
            </ul>
          )}
          {notice && (
            <div
              role={notice.variant === 'error' ? 'alert' : 'status'}
              className={cn(
                'text-[13px] rounded-lg px-3 py-2 border',
                notice.variant === 'error'
                  ? 'text-destructive-text bg-destructive-subtle border-destructive-border'
                  : 'text-warning-text bg-warning-subtle border-warning-border',
              )}
            >
              {notice.text}
            </div>
          )}

          {loadFailed ? (
            <p className="text-sm text-destructive-text">{t('offers.loadError')}</p>
          ) : !view && (searching || lastKnown.isLoading) ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {waiting || searching ? t('offers.waiting') : t('offers.empty')}
            </p>
          ) : (
            <div className="rounded-xl border border-border overflow-auto max-h-[55dvh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('offers.columns.supplier')}</TableHead>
                    <TableHead>{t('offers.columns.offer')}</TableHead>
                    <TableHead className="text-right">{t('offers.columns.qty')}</TableHead>
                    <TableHead className="text-right">{t('offers.columns.term')}</TableHead>
                    <TableHead className="text-right">{t('offers.columns.price')}</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <OfferTableRow
                      key={row.offer.id}
                      row={row}
                      busy={busyOfferId === row.offer.id}
                      disabled={!!busyOfferId}
                      onChoose={() => void choose(row)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </>
  );
}

function OfferTableRow({
  row,
  busy,
  disabled,
  onChoose,
}: {
  row: OfferRow;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const { t } = useTranslation('supplierApi');
  const o = row.offer;
  const reason = o.notSelectableReason ? t(`offers.reasons.${o.notSelectableReason}`) : null;
  const term = offerTermText(o.deliveryDays, o.deliveryDate, t, fmtDate, '—');
  return (
    <TableRow
      data-testid="supplier-offer-row"
      className={cn(o.chosen && 'bg-primary/5', (o.stale || row.fromLastKnown) && 'opacity-80')}
    >
      <TableCell>
        <div className="whitespace-nowrap">{row.supplierName}</div>
        <div className="text-[11px] text-muted-foreground">
          {o.warehouseName ?? o.warehouseCode ?? '—'}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium tabular-nums">{o.article}</span>
          {o.brand && <span className="text-[11px] text-muted-foreground">{o.brand}</span>}
        </div>
        {o.name && <div className="max-w-64 break-words text-[12px]">{o.name}</div>}
        <div className="flex flex-wrap gap-1 mt-0.5">
          {o.matchStatus && (
            <Badge variant={o.matchStatus === 'matched' ? 'secondary' : 'outline'}>
              {t(`offers.match.${o.matchStatus}`)}
            </Badge>
          )}
          {o.isAnalog && <Badge variant="purple">{t('offers.analog')}</Badge>}
          {o.replacesGood && <Badge variant="outline">{t('offers.replacesGood')}</Badge>}
          {o.stale && <Badge variant="warning">{t('offers.staleOffer')}</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>
          {o.qtyIsLowerBound ? t('offers.qtyLowerBound', { qty: fmtQty(o.qty) }) : fmtQty(o.qty)}
        </div>
        {o.multiplicity && o.multiplicity > 1 ? (
          <div className="text-[11px] text-muted-foreground">
            {t('offers.multiplicity', { qty: fmtQty(o.multiplicity) })}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">{term}</TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">
        {o.price === null ? (
          '—'
        ) : (
          <>
            <div>
              {fmtMoney(o.price)} {fmtBankCurrencySuffix(o.currencyCode)}
            </div>
            {o.currencyCode !== 'UAH' && o.priceUah !== null && (
              <div className="text-[11px] text-muted-foreground">
                ≈ {fmtMoney(o.priceUah)} {fmtBankCurrencySuffix('UAH')}
              </div>
            )}
          </>
        )}
      </TableCell>
      <TableCell className="text-right">
        {o.chosen ? (
          <Badge variant="success">{t('offers.chosen')}</Badge>
        ) : !o.selectable ? (
          <span className="inline-block max-w-44 text-[11px] leading-tight text-muted-foreground">
            {reason}
          </span>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={onChoose}
            loading={busy}
            disabled={disabled}
            aria-label={`${t('offers.choose')}: ${row.supplierName} ${o.article} ${o.warehouseName ?? ''}`}
          >
            {t('offers.choose')}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
