'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { previewMatchStatusLabel, bankTxMatchTypeLabel } from '@/i18n/enumLabel';
import {
  useBankStatementImport,
  type ColumnMapping,
  type PreviewRow,
  type ApplyRow,
  type PreviewMatchStatus,
  type ApplyImportResult,
} from '@/hooks/api/useBankStatements';

interface BankAccount {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}

type Step = 1 | 2 | 3 | 4;

// Дефолтна розмітка (типовий Privat24-подібний CSV) — редагована користувачем.
const DEFAULT_MAPPING: ColumnMapping = {
  startRow: 2,
  dateCol: 1,
  amountCol: 2,
  externalIdCol: 3,
  payerNameCol: undefined,
  payerIbanCol: undefined,
  payerEdrpouCol: undefined,
  purposeCol: undefined,
};

const PREVIEW_BADGE: Record<PreviewMatchStatus, BadgeVariant> = {
  matched: 'success',
  ambiguous: 'warning',
  notFound: 'secondary',
  duplicate: 'destructive',
};

export function BankStatementImportModal({ open, onClose, onApplied }: Props) {
  const { t } = useTranslation('bankStatements');
  const { rawPreview, preview, apply } = useBankStatementImport();

  const [step, setStep] = useState<Step>(1);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(DEFAULT_MAPPING);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [result, setResult] = useState<ApplyImportResult | null>(null);
  const [error, setError] = useState('');

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setBankAccountId('');
    setFile(null);
    setMapping(DEFAULT_MAPPING);
    setRawRows([]);
    setPreviewRows([]);
    setResult(null);
    setError('');
    apiFetch<{ items: BankAccount[] }>('/bank-accounts')
      .then(res => setBanks(res.items ?? []))
      .catch(() => {});
  }, [open]);

  const goRawPreview = useCallback(async () => {
    if (!file) {
      setError(t('import.error.noFile'));
      return;
    }
    if (!bankAccountId) {
      setError(t('import.error.noAccount'));
      return;
    }
    setError('');
    try {
      const res = await rawPreview.mutateAsync(file);
      setRawRows(res.rows ?? []);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('import.error.generic'));
    }
  }, [file, bankAccountId, rawPreview, t]);

  const goPreview = useCallback(async () => {
    if (!file) return;
    setError('');
    try {
      const res = await preview.mutateAsync({ file, bankAccountId, mapping });
      setPreviewRows(res.rows ?? []);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('import.error.generic'));
    }
  }, [file, bankAccountId, mapping, preview, t]);

  const goApply = useCallback(async () => {
    setError('');
    // Дублікати не імпортуємо — бекенд усе одно skip-ає, але не шлемо їх зайве.
    const rows: ApplyRow[] = previewRows
      .filter(r => r.matchStatus !== 'duplicate')
      .map(r => ({
        externalId: r.externalId,
        operationDate: r.operationDate,
        amount: r.amount,
        payerName: r.payerName ?? undefined,
        payerIban: r.payerIban ?? undefined,
        payerEdrpou: r.payerEdrpou ?? undefined,
        purpose: r.purpose ?? undefined,
      }));
    try {
      const res = await apply.mutateAsync({ bankAccountId, rows });
      setResult(res);
      setStep(4);
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('import.error.generic'));
    }
  }, [previewRows, bankAccountId, apply, onApplied, t]);

  const setCol = (key: keyof ColumnMapping) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    const n = raw === '' ? undefined : Number(raw);
    setMapping(m => ({
      ...m,
      [key]: n && Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined,
    }));
  };

  const importableCount = previewRows.filter(r => r.matchStatus !== 'duplicate').length;
  const busy = rawPreview.isPending || preview.isPending || apply.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('import.title')}
      description={step < 4 ? t('import.step', { current: step, total: 3 }) : undefined}
      size={step === 3 ? 'xl' : 'lg'}
    >
      <div className="space-y-4">
        {error && (
          <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* ── Крок 1: файл + рахунок ─────────────────────────────── */}
        {step === 1 && (
          <>
            <Select
              label={t('import.step1.bankAccount')}
              required
              value={bankAccountId}
              onChange={e => setBankAccountId(e.target.value)}
              className="h-8 text-[13px]"
            >
              <option value="">{t('import.step1.bankAccountPlaceholder')}</option>
              {banks.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>

            <div className="flex flex-col gap-1">
              <label className="text-[13px] font-medium text-foreground leading-none">
                {t('import.step1.file')}
              </label>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                className="text-[13px] file:mr-3 file:rounded file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-[13px]"
              />
            </div>

            <div className="flex justify-end pt-2">
              <Button size="sm" loading={busy} onClick={goRawPreview}>
                {t('import.step1.next')}
              </Button>
            </div>
          </>
        )}

        {/* ── Крок 2: розмітка колонок ───────────────────────────── */}
        {step === 2 && (
          <>
            <p className="text-[13px] text-muted-foreground">{t('import.step2.hint')}</p>

            {rawRows.length > 0 && (
              <div className="overflow-auto border border-border rounded-lg max-h-48">
                <table className="text-[12px] tabular-nums">
                  <thead>
                    <tr className="bg-secondary">
                      {rawRows[0]!.map((_, ci) => (
                        <th key={ci} className="px-2 py-1 text-left font-medium whitespace-nowrap">
                          {t('import.step2.col', { n: ci + 1 })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rawRows.slice(0, 8).map((row, ri) => (
                      <tr key={ri} className="border-t border-border">
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className="px-2 py-1 whitespace-nowrap max-w-[160px] truncate"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Input
                label={t('import.step2.startRow')}
                type="number"
                min={1}
                value={mapping.startRow ?? ''}
                onChange={setCol('startRow')}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('import.step2.dateCol')}
                type="number"
                min={1}
                value={mapping.dateCol ?? ''}
                onChange={setCol('dateCol')}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('import.step2.amountCol')}
                type="number"
                min={1}
                value={mapping.amountCol ?? ''}
                onChange={setCol('amountCol')}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('import.step2.externalIdCol')}
                type="number"
                min={1}
                value={mapping.externalIdCol ?? ''}
                onChange={setCol('externalIdCol')}
                className="h-8 text-[13px]"
              />
              <Input
                label={`${t('import.step2.payerNameCol')} ${t('import.step2.optional')}`}
                type="number"
                min={1}
                value={mapping.payerNameCol ?? ''}
                onChange={setCol('payerNameCol')}
                className="h-8 text-[13px]"
              />
              <Input
                label={`${t('import.step2.payerIbanCol')} ${t('import.step2.optional')}`}
                type="number"
                min={1}
                value={mapping.payerIbanCol ?? ''}
                onChange={setCol('payerIbanCol')}
                className="h-8 text-[13px]"
              />
              <Input
                label={`${t('import.step2.payerEdrpouCol')} ${t('import.step2.optional')}`}
                type="number"
                min={1}
                value={mapping.payerEdrpouCol ?? ''}
                onChange={setCol('payerEdrpouCol')}
                className="h-8 text-[13px]"
              />
              <Input
                label={`${t('import.step2.purposeCol')} ${t('import.step2.optional')}`}
                type="number"
                min={1}
                value={mapping.purposeCol ?? ''}
                onChange={setCol('purposeCol')}
                className="h-8 text-[13px]"
              />
            </div>

            <div className="flex justify-between pt-2">
              <Button variant="outline" size="sm" onClick={() => setStep(1)} disabled={busy}>
                {t('import.step2.back')}
              </Button>
              <Button size="sm" loading={busy} onClick={goPreview}>
                {t('import.step2.preview')}
              </Button>
            </div>
          </>
        )}

        {/* ── Крок 3: передперегляд ──────────────────────────────── */}
        {step === 3 && (
          <>
            {preview.isPending ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : previewRows.length === 0 ? (
              <p className="text-[13px] text-muted-foreground py-6 text-center">
                {t('import.step3.empty')}
              </p>
            ) : (
              <div className="overflow-auto border border-border rounded-lg max-h-80">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-secondary">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('import.step3.date')}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {t('import.step3.amount')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('import.step3.payer')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('import.step3.match')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('import.step3.suggested')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map(r => (
                      <tr key={`${r.rowIndex}-${r.externalId}`} className="border-t border-border">
                        <td className="px-2 py-1.5 tabular-nums whitespace-nowrap text-muted-foreground">
                          {fmtDate(r.operationDate)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium whitespace-nowrap">
                          {fmtMoney(r.amount)} ₴
                        </td>
                        <td className="px-2 py-1.5 max-w-[180px] truncate">{r.payerName ?? '—'}</td>
                        <td className="px-2 py-1.5">
                          <Badge variant={PREVIEW_BADGE[r.matchStatus]}>
                            {previewMatchStatusLabel(r.matchStatus)}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 max-w-[200px] truncate text-muted-foreground">
                          {r.suggestedCounterpartyName ?? '—'}
                          {r.suggestedMatchType
                            ? ` · ${bankTxMatchTypeLabel(r.suggestedMatchType)}`
                            : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="outline" size="sm" onClick={() => setStep(2)} disabled={busy}>
                {t('import.step3.back')}
              </Button>
              <Button
                size="sm"
                loading={apply.isPending}
                disabled={busy || importableCount === 0}
                onClick={goApply}
              >
                {t('import.step3.apply', { count: importableCount })}
              </Button>
            </div>
          </>
        )}

        {/* ── Крок 4: результат ──────────────────────────────────── */}
        {step === 4 && result && (
          <>
            <div className="rounded-lg border border-border bg-secondary/40 px-4 py-3 text-[14px] space-y-1">
              <div className="font-semibold">{t('import.result.title')}</div>
              <div className="text-success-text">
                {t('import.result.created', { count: result.created })}
              </div>
              <div className="text-muted-foreground">
                {t('import.result.skipped', { count: result.skipped })}
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                onClick={() => {
                  if (result.created > 0) toast.success(t('import.result.title'));
                  onClose();
                }}
              >
                {t('import.result.close')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
