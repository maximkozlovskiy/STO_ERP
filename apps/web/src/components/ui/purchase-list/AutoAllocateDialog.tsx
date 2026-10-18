'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SUPPLIER_OFFER_BATCH_MAX, SUPPLIER_STRATEGIES } from '@sto/shared';
import { fmtBankCurrencySuffix, fmtDate, fmtMoney, fmtQty } from '@/lib/format';
import { toast } from '@/lib/toast';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import {
  batchProgress,
  offerTermText,
  supplierOffersApi,
  supplierOffersKeys,
  useSupplierOfferBatch,
  useSupplierProcurementSettings,
  type SupplierAllocationItem,
  type SupplierAllocationResult,
  type SupplierStrategy,
} from '@/hooks/api/useSupplierOffers';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Props {
  /** Обрані позиції; null — діалог закрито. */
  ids: string[] | null;
  onClose: () => void;
  onApplied: () => void;
}

/**
 * «Підібрати автоматично» (BR-SOFR-007…009): пошук пропозицій для обраних позицій (прогрес
 * batch-у), попередній перегляд розподілу (`dryRun`) за стратегією — типово зі налаштувань — і
 * «Застосувати». Позиції з ручним вибором типово лишаються як є; прапорець «Перезаписати ручний
 * вибір» передає `overrideManual` (рішення за замовчуванням 2026-10-18).
 */
export function AutoAllocateDialog({ ids, onClose, onApplied }: Props) {
  const { t } = useTranslation('supplierApi');
  const qc = useQueryClient();
  const features = useUiFeatures();
  const open = ids !== null;
  const settings = useSupplierProcurementSettings(open);
  const [strategy, setStrategy] = useState<SupplierStrategy | ''>('');
  const [overrideManual, setOverrideManual] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<SupplierAllocationResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const seq = useRef(0);
  const batch = useSupplierOfferBatch(batchId);
  const progress = batchProgress(batch.data);
  const searchActive = !batch.data
    ? !!batchId
    : batch.data.items.some(i =>
        i.requests.some(r => r.status === 'QUEUED' || r.status === 'RUNNING'),
      );
  const tooMany = (ids?.length ?? 0) > SUPPLIER_OFFER_BATCH_MAX;
  const idsKey = ids?.join(',') ?? '';

  useEffect(() => {
    seq.current += 1;
    setBatchId(null);
    setPreview(null);
    setNotice('');
    setOverrideManual(false);
    setStrategy('');
    if (!ids || ids.length === 0 || ids.length > SUPPLIER_OFFER_BATCH_MAX) return;
    const mine = seq.current;
    supplierOffersApi
      .search({ itemIds: ids })
      .then(res => {
        if (mine !== seq.current) return;
        qc.setQueryData(supplierOffersKeys.batch(res.id), res);
        setBatchId(res.id);
        if (res.noConnections) setNotice(t('offers.noConnections'));
        else if (res.queueUnavailable) setNotice(t('offers.queueUnavailable'));
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setNotice(e instanceof Error ? e.message : t('allocate.error'));
      });
    // ids — масив, порівнюємо за складом (idsKey); новий масив тих самих позицій пошуку не повторює.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, qc, t]);

  // Стратегія за замовчуванням — з налаштувань, щойно вони прийшли (і користувач ще не обрав).
  useEffect(() => {
    if (open && !strategy && settings.data) setStrategy(settings.data.defaultStrategy);
  }, [open, strategy, settings.data]);
  // Налаштування недоступні — не блокувати діалог: «Оптимально» як стратегія-компроміс.
  useEffect(() => {
    if (open && !strategy && settings.error) setStrategy('OPTIMAL');
  }, [open, strategy, settings.error]);

  const runPreview = useCallback(
    async (s: SupplierStrategy, override: boolean) => {
      if (!batchId) return;
      const mine = ++seq.current;
      setPreviewing(true);
      try {
        const res = await supplierOffersApi.allocate({
          batchId,
          strategy: s,
          dryRun: true,
          overrideManual: override,
        });
        if (mine === seq.current) setPreview(res);
      } catch (e: unknown) {
        if (mine === seq.current) setNotice(e instanceof Error ? e.message : t('allocate.error'));
      } finally {
        if (mine === seq.current) setPreviewing(false);
      }
    },
    [batchId, t],
  );

  // Попередній перегляд — коли постачальники відповіли (повтори «немає зв'язку» не чекаємо:
  // автопідбір бере лише отримані пропозиції) і після зміни стратегії чи прапорця.
  useEffect(() => {
    if (!open || !batchId || !strategy || searchActive || !batch.data) return;
    void runPreview(strategy, overrideManual);
  }, [open, batchId, strategy, overrideManual, searchActive, batch.data, runPreview]);

  const applicable = (preview?.items ?? []).filter(i => i.parts.length > 0).length;
  // Одна умова для кнопки й Ctrl+Enter (Modal onSubmit): застосовується лише показаний перегляд
  // поточної стратегії, коли пошук і перерахунок завершено.
  const canApply =
    !!preview &&
    preview.strategy === strategy &&
    !previewing &&
    !searchActive &&
    applicable > 0 &&
    !tooMany;

  const apply = async () => {
    if (!batchId || !strategy || !preview || !canApply || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setNotice('');
    try {
      // Відбиток перегляду: розподіл змінився після показу → 409, нічого не записано (BR-SOFR-009).
      const res = await supplierOffersApi.allocate({
        batchId,
        strategy,
        overrideManual,
        previewToken: preview.previewToken,
      });
      const count = res.items.filter(i => i.parts.length > 0).length;
      if (features.toastEnabled) toast.success(t('allocate.applied', { count }));
      invalidateProcurementSideEffects(qc);
      onApplied();
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : t('allocate.error'));
      // 409 — позиції змінились: перерахувати перегляд від поточного стану.
      void runPreview(strategy, overrideManual);
      invalidateProcurementSideEffects(qc);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const handleClose = () => {
    if (applyingRef.current) return;
    seq.current += 1;
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      onSubmit={() => void apply()}
      title={t('allocate.title', { count: ids?.length ?? 0 })}
      size="lg"
      footer={
        <ModalFooter className="justify-between">
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {preview && preview.totalUah !== null
              ? t('allocate.total', {
                  sum: `${fmtMoney(preview.totalUah)} ${fmtBankCurrencySuffix('UAH')}`,
                })
              : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} disabled={applying}>
              {t('common:cancel')}
            </Button>
            <Button onClick={() => void apply()} loading={applying} disabled={!canApply}>
              {t('allocate.apply')}
            </Button>
          </div>
        </ModalFooter>
      }
    >
      <div className="space-y-3" data-testid="auto-allocate-dialog">
        {tooMany ? (
          <p role="alert" className="text-sm text-destructive-text">
            {t('allocate.tooMany', { max: SUPPLIER_OFFER_BATCH_MAX })}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-56">
                <Select
                  id="auto-allocate-strategy"
                  label={t('allocate.strategy')}
                  value={strategy}
                  onChange={e => setStrategy(e.target.value as SupplierStrategy)}
                  hint={strategy ? t(`strategyHint.${strategy}`) : undefined}
                  disabled={!strategy || applying}
                >
                  {SUPPLIER_STRATEGIES.map(s => (
                    <option key={s} value={s}>
                      {t(`strategy.${s}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <label
                className="flex items-start gap-2 text-[13px] pb-1"
                title={t('allocate.overrideManualHint')}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={overrideManual}
                  disabled={applying}
                  onChange={e => setOverrideManual(e.target.checked)}
                />
                <span>
                  {t('allocate.overrideManual')}
                  <span className="block text-[11px] text-muted-foreground">
                    {t('allocate.overrideManualHint')}
                  </span>
                </span>
              </label>
            </div>

            {(searchActive || !batchId) && !notice && (
              <div
                className="flex items-center gap-2 text-[13px] text-muted-foreground"
                role="status"
              >
                <Spinner size="sm" />
                {t('allocate.searching', { done: progress.done, total: progress.total })}
              </div>
            )}
            {notice && (
              <div
                role="alert"
                className="text-[13px] rounded-lg px-3 py-2 border text-warning-text bg-warning-subtle border-warning-border"
              >
                {notice}
              </div>
            )}
            {previewing && !preview && (
              <p className="text-[13px] text-muted-foreground" role="status">
                {t('allocate.previewing')}
              </p>
            )}
            {preview && (
              <div className="rounded-xl border border-border overflow-auto max-h-[50dvh]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('allocate.columns.good')}</TableHead>
                      <TableHead className="text-right">{t('allocate.columns.need')}</TableHead>
                      <TableHead>{t('allocate.columns.parts')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.items.map(i => (
                      <AllocationRow key={i.itemId} item={i} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {preview && applicable === 0 && (
              <p className="text-[13px] text-muted-foreground">{t('allocate.nothing')}</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function AllocationRow({ item }: { item: SupplierAllocationItem }) {
  const { t } = useTranslation('supplierApi');
  return (
    <TableRow data-testid="allocation-row">
      <TableCell className="max-w-64 break-words">{item.goodName}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtQty(item.need)}</TableCell>
      <TableCell className="text-[13px]">
        {item.skippedReason ? (
          <span className="text-muted-foreground">
            {t(`allocate.skipped.${item.skippedReason}`)}
          </span>
        ) : (
          <ul className="space-y-0.5">
            {item.parts.map(p => {
              const params = {
                supplier: p.supplierName,
                warehouse: p.warehouseName ? ` · ${p.warehouseName}` : '',
                qty: fmtQty(p.qty),
                price: `${fmtMoney(p.priceUah)} ${fmtBankCurrencySuffix('UAH')}`,
                term: offerTermText(p.days, null, t, fmtDate) ?? '',
              };
              return (
                <li key={p.offerId}>
                  {p.priceUah === null
                    ? t('allocate.partNoPrice', params)
                    : t('allocate.part', params)}
                  {p.isAnalog && (
                    <span className="ml-1 text-purple-text">({t('offers.analog')})</span>
                  )}
                </li>
              );
            })}
            {item.uncovered > 0 && (
              <li className="text-warning-text">
                {t('allocate.uncovered', { qty: fmtQty(item.uncovered) })}
              </li>
            )}
          </ul>
        )}
      </TableCell>
    </TableRow>
  );
}
