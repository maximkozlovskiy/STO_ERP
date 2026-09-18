'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '@/hooks/useConfirm';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { type DocNumberConfig } from './shared';

// Повний перелік DocumentType (schema.prisma) — усі 13 значень мають людський підпис,
// інакше засіяні setup-ом типи (STOCK_OPENING, RECONCILIATION_ACT) показуються сирим кодом.
// Підписи — у settings-каталозі (numbers.docTypes.*); тут лише ключі (порядок збережено).
const DOC_TYPE_KEYS = [
  'WORK_ORDER',
  'INVOICE',
  'PURCHASE_ORDER',
  'SUPPLIER_RETURN',
  'STOCK_RECEIPT',
  'STOCK_WRITEOFF',
  'STOCK_TRANSFER',
  'STOCK_OPENING',
  'RECONCILIATION_ACT',
  'COMPLETION_ACT',
  'COUNTERPARTY_AGREEMENT',
  'GOOD_INTERNAL_CODE',
  'SUPPLIER_PAYMENT',
];

export default function NumbersTab() {
  const { t } = useTranslation('settings');
  const { confirm, dialogProps } = useConfirm();
  const docTypeLabel = (code: string): string =>
    DOC_TYPE_KEYS.includes(code) ? t(`numbers.docTypes.${code}`) : code;
  const [docNumbers, setDocNumbers] = useState<DocNumberConfig[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<DocNumberConfig[]>('/settings/document-numbers')
      .then(setDocNumbers)
      .catch((e: unknown) =>
        console.warn(
          '[NumbersTab] /settings/document-numbers failed:',
          e instanceof Error ? e.message : e,
        ),
      );
  }, []);

  const resetDocNumber = async (documentType: string) => {
    if (!(await confirm({ title: t('numbers.resetConfirm', { documentType }) }))) return;
    try {
      await apiFetch(`/settings/document-numbers/${documentType}/reset`, { method: 'POST' });
      setDocNumbers(prev =>
        prev.map(c => (c.documentType === documentType ? { ...c, currentSeq: 0 } : c)),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {docNumbers.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('numbers.noConfigs')}</p>
      )}

      {docNumbers.map(cfg => (
        <div key={cfg.id} className="bg-surface rounded-xl border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              {docTypeLabel(cfg.documentType)}
            </span>
            <span className="text-xs text-muted-foreground font-mono">#{cfg.currentSeq}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <label className="block text-muted-foreground mb-1">{t('numbers.prefix')}</label>
              <Input
                value={cfg.prefix ?? ''}
                onChange={e => {
                  const prefix = e.target.value || null;
                  setDocNumbers(prev =>
                    prev.map(c => (c.documentType === cfg.documentType ? { ...c, prefix } : c)),
                  );
                }}
                onBlur={e => {
                  const prefix = e.target.value || null;
                  apiFetch(`/settings/document-numbers/${cfg.documentType}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ prefix }),
                  }).catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : t('numbers.prefixSaveError')),
                  );
                }}
                className="h-8 text-[13px]"
                placeholder={t('numbers.prefixPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-muted-foreground mb-1">{t('numbers.separator')}</label>
              <Input
                value={cfg.separator}
                onChange={e => {
                  const separator = e.target.value || '-';
                  setDocNumbers(prev =>
                    prev.map(c => (c.documentType === cfg.documentType ? { ...c, separator } : c)),
                  );
                }}
                onBlur={e => {
                  const separator = e.target.value || '-';
                  apiFetch(`/settings/document-numbers/${cfg.documentType}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ separator }),
                  }).catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : t('numbers.separatorSaveError')),
                  );
                }}
                className="h-8 text-[13px] w-16"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">
              {t('numbers.resetLabel')}{' '}
              {cfg.resetPeriod === 'NEVER'
                ? t('numbers.resetPeriod.NEVER')
                : cfg.resetPeriod === 'YEARLY'
                  ? t('numbers.resetPeriod.YEARLY')
                  : t('numbers.resetPeriod.MONTHLY')}
            </span>
            {cfg.resetPeriod !== 'NEVER' && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void resetDocNumber(cfg.documentType)}
                className="h-7 text-xs"
              >
                {t('numbers.resetCounter')}
              </Button>
            )}
          </div>
        </div>
      ))}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
