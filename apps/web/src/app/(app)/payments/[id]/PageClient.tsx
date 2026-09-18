'use client';

import type { ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RotateCw } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { usePayment, useRetryFiscal } from '@/hooks/api/usePayments';
import { useBaseCurrency } from '@/hooks/api/useCash';
import { FISCAL_STATUS_BADGE, FISCAL_STATUS_DESCRIPTIONS } from '@sto/shared';
import { fiscalStatusLabel, paymentSourceTypeLabel } from '@/i18n/enumLabel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate } from '@/lib/format';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function PaymentDetailClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);
  const { t } = useTranslation('payments');
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === 'string' ? params.id : null;

  const { data: p, isLoading } = usePayment(id);
  const retryFiscal = useRetryFiscal();
  const { data: baseCurrency } = useBaseCurrency();
  const baseCode = baseCurrency?.code ?? 'UAH';
  const baseSymbol = baseCurrency?.symbol ?? '₴';

  const onRetry = async () => {
    if (!id) return;
    try {
      await retryFiscal.mutateAsync(id);
      toast.success(t('toast.retryQueued'));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('toast.retryError'));
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
    return <div className="p-6 text-muted-foreground">{t('detail.notFound')}</div>;
  }

  // Валюта оплати: код рядка або базовий (історичні/UAH).
  const isBase = !p.currencyCode || p.currencyCode === baseCode;
  const paymentSymbol = isBase ? baseSymbol : p.currencyCode;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-2xl">
      <button
        type="button"
        onClick={() => router.push('/payments')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('detail.back')}
      </button>

      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="page-title">{t('detail.title', { date: fmtDate(p.createdAt) })}</h1>
        <div className="flex flex-col items-end">
          <div className="text-xl font-semibold tabular-nums">
            {fmtMoney(p.amount)} {paymentSymbol}
          </div>
          {!isBase && p.amountBase != null && (
            <div className="text-sm text-muted-foreground tabular-nums">
              {fmtMoney(p.amountBase)} {baseSymbol}
              {p.rateUsed != null && t('detail.rateSuffix', { rate: p.rateUsed })}
            </div>
          )}
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('detail.fields.counterparty')}>{p.counterpartyName ?? '—'}</Field>
          <Field label={t('detail.fields.method')}>{p.method}</Field>
          <Field label={t('detail.fields.source')}>
            {p.sourceType
              ? `${paymentSourceTypeLabel(p.sourceType)}${p.sourceName ? ` · ${p.sourceName}` : ''}`
              : '—'}
          </Field>
          <Field label={t('detail.fields.date')}>{fmtDate(p.createdAt)}</Field>
          {!isBase && (
            <Field label={t('detail.fields.currency')}>
              {p.currencyCode}
              {p.rateUsed != null && (
                <span className="text-muted-foreground">
                  {t('detail.rateSuffix', { rate: p.rateUsed })}
                </span>
              )}
            </Field>
          )}
          {p.notes && <Field label={t('detail.fields.notes')}>{p.notes}</Field>}
        </div>

        {/* Зв'язки */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
          {p.invoiceId && (
            <Button variant="outline" size="sm" onClick={() => router.push('/invoices')}>
              {t('detail.links.invoice')}
            </Button>
          )}
          {p.workOrderId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/work-orders?open=${p.workOrderId}`)}
            >
              {t('detail.links.workOrder')}
            </Button>
          )}
        </div>
      </div>

      {/* Фіскальний чек (ПРРО) */}
      <div className="bg-surface rounded-xl border border-border p-4 mt-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t('detail.fiscal.heading')}</h2>
        {p.fiscalStatus ? (
          <>
            <div className="flex items-center gap-2">
              <Badge
                variant={FISCAL_STATUS_BADGE[p.fiscalStatus] ?? 'secondary'}
                tooltip={FISCAL_STATUS_DESCRIPTIONS[p.fiscalStatus]}
              >
                {fiscalStatusLabel(p.fiscalStatus)}
              </Badge>
              {p.fiscalReceiptId && (
                <span className="text-sm text-muted-foreground">
                  {t('detail.fiscal.receiptNumber', { number: p.fiscalReceiptId })}
                </span>
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
                {t('detail.fiscal.retry')}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('detail.fiscal.notApplicable')}</p>
        )}
      </div>
    </div>
  );
}
