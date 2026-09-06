'use client';

import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, RotateCw } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { usePayment, useRetryFiscal } from '@/hooks/api/usePayments';
import {
  FISCAL_STATUS_LABELS,
  FISCAL_STATUS_BADGE,
  FISCAL_STATUS_DESCRIPTIONS,
  PAYMENT_SOURCE_TYPE_LABELS,
} from '@sto/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate } from '@/lib/format';

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function PaymentDetailClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === 'string' ? params.id : null;

  const { data: p, isLoading } = usePayment(id);
  const retryFiscal = useRetryFiscal();

  const onRetry = async () => {
    if (!id) return;
    try {
      await retryFiscal.mutateAsync(id);
      toast.success('Фіскалізацію поставлено в чергу повторно');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка повтору');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (!p) {
    return <div className="p-6 text-muted-foreground">Платіж не знайдено</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-2xl">
      <button
        type="button"
        onClick={() => router.push('/payments')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        До списку оплат
      </button>

      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="page-title">Оплата від {fmtDate(p.createdAt)}</h1>
        <div className="text-xl font-semibold tabular-nums">{fmt(p.amount)}</div>
      </div>

      <div className="bg-surface rounded-xl border border-border p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Контрагент">{p.counterpartyName ?? '—'}</Field>
          <Field label="Метод оплати">{p.method}</Field>
          <Field label="Рахунок-призначення">
            {p.sourceType
              ? `${PAYMENT_SOURCE_TYPE_LABELS[p.sourceType] ?? p.sourceType}${p.sourceName ? ` · ${p.sourceName}` : ''}`
              : '—'}
          </Field>
          <Field label="Дата">{fmtDate(p.createdAt)}</Field>
          {p.notes && <Field label="Примітки">{p.notes}</Field>}
        </div>

        {/* Зв'язки */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
          {p.invoiceId && (
            <Button variant="outline" size="sm" onClick={() => router.push('/invoices')}>
              Рахунок
            </Button>
          )}
          {p.workOrderId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/work-orders?open=${p.workOrderId}`)}
            >
              Наряд
            </Button>
          )}
        </div>
      </div>

      {/* Фіскальний чек (ПРРО) */}
      <div className="bg-surface rounded-xl border border-border p-4 mt-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Фіскальний чек (ПРРО)</h2>
        {p.fiscalStatus ? (
          <>
            <div className="flex items-center gap-2">
              <Badge
                variant={FISCAL_STATUS_BADGE[p.fiscalStatus] ?? 'secondary'}
                tooltip={FISCAL_STATUS_DESCRIPTIONS[p.fiscalStatus]}
              >
                {FISCAL_STATUS_LABELS[p.fiscalStatus] ?? p.fiscalStatus}
              </Badge>
              {p.fiscalReceiptId && (
                <span className="text-sm text-muted-foreground">№ {p.fiscalReceiptId}</span>
              )}
            </div>
            {p.fiscalError && <p className="text-sm text-destructive-text">{p.fiscalError}</p>}
            {p.fiscalStatus === 'FAILED' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onRetry()}
                loading={retryFiscal.isPending}
              >
                <RotateCw className="h-3.5 w-3.5 mr-1" />
                Повторити фіскалізацію
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Фіскалізація не застосовується до цього методу.
          </p>
        )}
      </div>
    </div>
  );
}
