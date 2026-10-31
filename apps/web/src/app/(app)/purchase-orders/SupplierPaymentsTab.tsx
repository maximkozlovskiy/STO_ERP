'use client';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPLIER_PAYMENT_STATUS_BADGE } from '@sto/shared';
import {
  useSupplierPaymentsList,
  useConfirmSupplierPayment,
  useCancelSupplierPayment,
  type SupplierPayment,
} from '@/hooks/api/useSupplierPayments';
import { useConfirm } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { ListStatusRow } from '@/components/ui/list-toolbar';
import { StatusPill } from '@/components/ui/status-pill';
import { TableContainer } from '@/components/ui/table-container';
import { Pagination } from '@/components/ui/pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { supplierPaymentStatusLabel } from '@/i18n/enumLabel';
import { fmtBankCurrencySuffix, fmtDate, fmtMoney } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency-key';
import { toast } from '@/lib/toast';

const PAGE_SIZE = 20;

/** Фільтр статусу: «Чернетки» першими — заради них вкладка й з'явилась (BR-SUPPAY-014). */
const STATUS_FILTERS = ['DRAFT', '', 'CONFIRMED', 'CANCELLED', 'REVERSED'] as const;

const TH = 'text-left font-medium px-3 py-2 border-b border-border whitespace-nowrap';
const TD = 'px-3 py-2 border-b border-border';

/** Сума у валюті оплати (валюта її джерела коштів), не завжди «₴». */
const amountText = (p: SupplierPayment) =>
  `${fmtMoney(p.amount)} ${fmtBankCurrencySuffix(p.currencyCode)}`;

interface Props {
  /** Відкрити картку замовлення-підстави (роль має доступ до картки, BR-PO-015). */
  onOpenOrder?: (id: string) => void;
}

/**
 * Оплати постачальникам у «Купівлі» (рішення власника 2026-10-30, TECH-DEBT (б) №36): перелік із
 * фільтром статусу — передусім «Чернетки», старі оплати, які з видаленням сторінки оплат більше
 * ніде не було видно. Чернетку можна «Провести» (з ключем ідемпотентності; сервер перевіряє статус
 * замовлення, зміну й залишок каси — BR-SUPPAY-015) або «Скасувати».
 */
export function SupplierPaymentsTab({ onOpenOrder }: Props) {
  const { t } = useTranslation('supplierPayments');
  const features = useUiFeatures();
  const [status, setStatus] = useState<string>('DRAFT');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const { confirm, dialogProps } = useConfirm();

  const { data, isLoading, error } = useSupplierPaymentsList({ status, page, limit: PAGE_SIZE });
  const confirmMut = useConfirmSupplierPayment();
  const cancelMut = useCancelSupplierPayment();
  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const pickStatus = useCallback((value: string) => {
    setStatus(value);
    setPage(1);
    setFormError('');
  }, []);

  const runRowAction = useCallback(
    async (p: SupplierPayment, kind: 'confirm' | 'cancel') => {
      const ok =
        kind === 'confirm'
          ? await confirm({
              title: t('list.confirmDialog.title', { number: p.number }),
              message: t('list.confirmDialog.message', {
                amount: amountText(p),
                supplier: p.supplierName ?? '—',
                source: p.sourceName ?? '—',
              }),
              confirmLabel: t('list.confirm'),
            })
          : await confirm({
              title: t('list.cancelDialog.title', { number: p.number }),
              message: t('list.cancelDialog.message'),
              confirmLabel: t('list.cancelDialog.confirmLabel'),
              cancelLabel: t('list.cancelDialog.keep'),
              variant: 'destructive',
            });
      if (!ok) return;
      setBusyId(p.id);
      setFormError('');
      try {
        if (kind === 'confirm') {
          await confirmMut.mutateAsync({ id: p.id, idempotencyKey: newIdempotencyKey() });
        } else {
          await cancelMut.mutateAsync(p.id);
        }
        if (features.toastEnabled) {
          toast.success(
            t(kind === 'confirm' ? 'list.toast.confirmed' : 'list.toast.cancelled', {
              number: p.number,
            }),
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : t('list.loadError');
        setFormError(msg);
        if (features.toastEnabled) toast.error(msg);
      } finally {
        setBusyId(null);
      }
    },
    [confirm, confirmMut, cancelMut, features.toastEnabled, t],
  );

  const emptyText = status === 'DRAFT' ? t('list.emptyDrafts') : t('list.empty');

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <ListStatusRow label={t('list.statusLabel')}>
        {STATUS_FILTERS.map(code => (
          <StatusPill
            key={code || 'all'}
            value={code}
            label={
              code === ''
                ? t('list.all')
                : code === 'DRAFT'
                  ? t('list.drafts')
                  : supplierPaymentStatusLabel(code)
            }
            active={status === code}
            onSelect={pickStatus}
          />
        ))}
      </ListStatusRow>
      {status === 'DRAFT' && <p className="text-[12px] text-muted-foreground">{t('list.help')}</p>}

      {(formError || error) && (
        <div
          role="alert"
          className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
        >
          {formError || (error instanceof Error ? error.message : t('list.loadError'))}
        </div>
      )}

      <TableContainer>
        <table className="w-full text-[13px] tabular-nums border-collapse">
          <thead className="sticky top-0 z-10 bg-secondary text-muted-foreground">
            <tr>
              <th className={TH}>{t('list.columns.number')}</th>
              <th className={TH}>{t('list.columns.date')}</th>
              <th className={TH}>{t('list.columns.supplier')}</th>
              <th className={TH}>{t('list.columns.source')}</th>
              <th className={TH}>{t('list.columns.order')}</th>
              <th className={`${TH} text-right`}>{t('list.columns.amount')}</th>
              <th className={TH}>{t('list.columns.status')}</th>
              <th className={`${TH} text-right`}>
                <span className="sr-only">{t('list.columns.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading && !data ? (
              <tr>
                <td colSpan={8} className="py-8 text-center">
                  <Spinner />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            ) : (
              items.map(p => (
                <tr key={p.id} className="hover:bg-secondary/40">
                  <td className={`${TD} font-medium whitespace-nowrap`}>{p.number}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {p.documentDate ? fmtDate(p.documentDate) : '—'}
                  </td>
                  <td className={TD}>{p.supplierName ?? '—'}</td>
                  <td className={TD}>{p.sourceName ?? '—'}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {p.purchaseOrderId && p.purchaseOrderNumber && onOpenOrder ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        aria-label={t('list.openOrder', { number: p.purchaseOrderNumber })}
                        onClick={() => onOpenOrder(p.purchaseOrderId!)}
                      >
                        {p.purchaseOrderNumber}
                      </button>
                    ) : (
                      (p.purchaseOrderNumber ?? '—')
                    )}
                  </td>
                  <td className={`${TD} text-right whitespace-nowrap`}>{amountText(p)}</td>
                  <td className={TD}>
                    <Badge variant={SUPPLIER_PAYMENT_STATUS_BADGE[p.status] ?? 'secondary'}>
                      {supplierPaymentStatusLabel(p.status)}
                    </Badge>
                  </td>
                  <td className={`${TD} text-right`}>
                    {p.status === 'DRAFT' && (
                      <div className="flex justify-end gap-2 whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={t('list.cancelAria', { number: p.number })}
                          disabled={busyId !== null}
                          onClick={() => void runRowAction(p, 'cancel')}
                        >
                          {t('list.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          aria-label={t('list.confirmAria', { number: p.number })}
                          loading={busyId === p.id}
                          disabled={busyId !== null}
                          onClick={() => void runRowAction(p, 'confirm')}
                        >
                          {t('list.confirm')}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableContainer>
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
