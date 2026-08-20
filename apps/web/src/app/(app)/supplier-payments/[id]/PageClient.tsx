'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { Check, Ban, Trash2, ExternalLink, Pencil } from 'lucide-react';
import { SupplierPaymentCreateModal } from '@/components/ui/SupplierPaymentCreateModal';
import {
  useSupplierPayment,
  useConfirmSupplierPayment,
  useCancelSupplierPayment,
  useDeleteSupplierPayment,
  type SupplierPayment,
} from '@/hooks/api/useSupplierPayments';
import {
  SUPPLIER_PAYMENT_STATUS_LABELS,
  SUPPLIER_PAYMENT_STATUS_BADGE,
  SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS,
  PAYMENT_SOURCE_TYPE_LABELS,
} from '@sto/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate, fmtShortDateTime } from '@/lib/format';

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

/** Single labeled field — рендериться лише коли value не порожнє. */
function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  const isEmpty = value === null || value === undefined || value === '';
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-foreground font-medium">{isEmpty ? '—' : value}</div>
    </div>
  );
}

export default function SupplierPaymentCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { confirm, dialogProps } = useConfirm();

  const { data: sp, isLoading, error } = useSupplierPayment(id ?? null);
  const confirmMut = useConfirmSupplierPayment();
  const cancelMut = useCancelSupplierPayment();
  const deleteMut = useDeleteSupplierPayment();
  const [editOpen, setEditOpen] = useState(false);

  const handleConfirm = async (payment: SupplierPayment) => {
    const ok = await confirm({
      title: 'Провести оплату?',
      message: `Оплата ${payment.number} на суму ${fmt(payment.amount)} зменшить борг перед постачальником. Після проведення документ не можна редагувати.`,
      confirmLabel: 'Провести',
    });
    if (!ok) return;
    try {
      await confirmMut.mutateAsync(payment.id);
      toast.success('Оплату проведено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка проведення');
    }
  };

  const handleCancel = async (payment: SupplierPayment) => {
    const ok = await confirm({
      title: 'Скасувати оплату?',
      message: `Оплату ${payment.number} буде скасовано.`,
      confirmLabel: 'Скасувати оплату',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await cancelMut.mutateAsync(payment.id);
      toast.success('Оплату скасовано');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка скасування');
    }
  };

  const handleDelete = async (payment: SupplierPayment) => {
    const ok = await confirm({
      title: 'Помітити на видалення?',
      message: `Оплату ${payment.number} буде помічено як видалену.`,
      confirmLabel: 'Видалити',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await deleteMut.mutateAsync(payment.id);
      toast.success('Оплату видалено');
      router.push('/supplier-payments');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  if (isLoading || error || !sp) {
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        {error ? (
          <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
            {error instanceof Error ? error.message : 'Помилка завантаження'}
          </p>
        ) : isLoading ? (
          <Spinner size="lg" />
        ) : (
          <p className="text-[13px] text-muted-foreground">Оплату не знайдено</p>
        )}
      </div>
    );
  }

  const isPending = confirmMut.isPending || cancelMut.isPending || deleteMut.isPending;

  return (
    <div className="page-container max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => router.back()}
          className="mt-1 text-muted-foreground hover:text-foreground text-sm"
        >
          ← Назад
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">{sp.number}</h1>
            <Badge
              variant={SUPPLIER_PAYMENT_STATUS_BADGE[sp.status] ?? 'secondary'}
              tooltip={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[sp.status]}
            >
              {SUPPLIER_PAYMENT_STATUS_LABELS[sp.status] ?? sp.status}
            </Badge>
            {sp.deletedAt && (
              <Badge variant="destructive" className="text-[10px]">
                видалено
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{sp.supplierName ?? '—'}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-foreground">{fmt(sp.amount)}</p>
          <p className="text-xs text-muted-foreground">сума оплати</p>
        </div>
      </div>

      {/* Реквізити — усі поля */}
      <div className="bg-surface rounded-xl border border-border p-5 text-sm">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Реквізити
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Номер" value={sp.number} />
          <Field
            label="Статус"
            value={
              <Badge
                variant={SUPPLIER_PAYMENT_STATUS_BADGE[sp.status] ?? 'secondary'}
                tooltip={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[sp.status]}
                className="mt-0.5"
              >
                {SUPPLIER_PAYMENT_STATUS_LABELS[sp.status] ?? sp.status}
              </Badge>
            }
          />
          <Field label="Постачальник" value={sp.supplierName} />
          <Field
            label="Тип джерела"
            value={PAYMENT_SOURCE_TYPE_LABELS[sp.sourceType] ?? sp.sourceType}
          />
          <Field label="Джерело коштів" value={sp.sourceName} />
          <Field label="Метод оплати" value={sp.method} />
          <Field label="Сума" value={<span className="tabular-nums">{fmt(sp.amount)}</span>} />
          <Field
            label="Замовлення постачальнику"
            value={
              sp.purchaseOrderNumber ? (
                <button
                  type="button"
                  onClick={() => router.push(`/purchase-orders?highlight=${sp.purchaseOrderId}`)}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {sp.purchaseOrderNumber}
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : null
            }
          />
          <Field label="Дата документа" value={sp.documentDate ? fmtDate(sp.documentDate) : null} />
          <div className="col-span-2">
            <Field label="Нотатки" value={sp.notes} />
          </div>
          <Field label="Створено" value={fmtShortDateTime(sp.createdAt)} />
          <Field label="Оновлено" value={fmtShortDateTime(sp.updatedAt)} />
          {sp.deletedAt && <Field label="Видалено" value={fmtShortDateTime(sp.deletedAt)} />}
        </div>
      </div>

      {/* Дії */}
      {!sp.deletedAt && (sp.status === 'DRAFT' || sp.status === 'CANCELLED') && (
        <div className="flex gap-2 flex-wrap items-center">
          {sp.status === 'DRAFT' && (
            <>
              <Button
                variant="primary"
                leftIcon={<Check className="h-4 w-4" />}
                loading={confirmMut.isPending}
                disabled={isPending}
                onClick={() => void handleConfirm(sp)}
              >
                Провести
              </Button>
              <Button
                variant="outline"
                leftIcon={<Pencil className="h-4 w-4" />}
                disabled={isPending}
                onClick={() => setEditOpen(true)}
              >
                Редагувати
              </Button>
              <Button
                variant="outline"
                leftIcon={<Ban className="h-4 w-4" />}
                loading={cancelMut.isPending}
                disabled={isPending}
                onClick={() => void handleCancel(sp)}
              >
                Скасувати
              </Button>
            </>
          )}
          <Button
            variant="outline"
            leftIcon={<Trash2 className="h-4 w-4" />}
            loading={deleteMut.isPending}
            disabled={isPending}
            className="text-destructive/80 hover:text-destructive"
            onClick={() => void handleDelete(sp)}
          >
            Помітити на видалення
          </Button>
        </div>
      )}

      <SupplierPaymentCreateModal
        open={editOpen}
        paymentId={sp.id}
        onClose={() => setEditOpen(false)}
        onSaved={() => setEditOpen(false)}
      />

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
