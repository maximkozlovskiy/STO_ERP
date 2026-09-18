'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { useIntegrationLogs, type IntegrationLogsFilter } from '@/hooks/api/useIntegrationLogs';
import { type OrgSettings } from './shared';

// Провайдери фільтра. Порожній код = «Усі провайдери» (підпис із каталогу); решта — бренди.
const PROVIDER_CODES = ['', 'liqpay', 'monobank', 'checkbox', 'vchasno', 'novaposhta'];
const PROVIDER_BRAND_NAMES: Record<string, string> = {
  liqpay: 'LiqPay',
  monobank: 'monobank',
  checkbox: 'Checkbox',
  vchasno: 'Вчасно.Каса',
  novaposhta: 'Нова Пошта',
};

const PAGE_SIZE = 50;

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const inputCls =
  'px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20';

export default function IntegrationLogsTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();
  const providerName = (code: string): string =>
    code === '' ? t('integrationLogs.allProviders') : (PROVIDER_BRAND_NAMES[code] ?? code);

  // ── Retention (OrganisationSettings) ───────────────────────────────────────
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(setOrgSettings)
      .catch(() => undefined);
  }, []);

  const saveRetention = async () => {
    if (!orgSettings) return;
    setSavingRetention(true);
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          integrationLogRetentionDays: orgSettings.integrationLogRetentionDays,
        }),
      });
      setOrgSettings(updated);
      if (currentFeatures.toastEnabled) toast.success(t('common.saved'));
    } catch (e: unknown) {
      if (currentFeatures.toastEnabled) {
        toast.error(e instanceof Error ? e.message : t('common.saveError'));
      }
    } finally {
      setSavingRetention(false);
    }
  };

  // ── Logs list ──────────────────────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [provider, setProvider] = useState('');
  const [ok, setOk] = useState(''); // '' | 'true' | 'false'
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filter: IntegrationLogsFilter = {
    page,
    limit: PAGE_SIZE,
    provider: provider || undefined,
    ok: ok || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = useIntegrationLogs(filter);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Скидання сторінки при зміні фільтра.
  const resetTo =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setPage(1);
      setter(v);
    };

  return (
    <div className="space-y-6">
      {/* Retention */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('integrationLogs.retentionLabel')}
        </label>
        <div className="flex items-end gap-3">
          <input
            type="number"
            min={1}
            max={365}
            value={orgSettings?.integrationLogRetentionDays ?? 30}
            onChange={e =>
              orgSettings &&
              setOrgSettings({
                ...orgSettings,
                integrationLogRetentionDays: Math.max(1, Math.min(365, Number(e.target.value))),
              })
            }
            disabled={!orgSettings}
            className={`w-32 ${inputCls}`}
          />
          <Button
            onClick={() => void saveRetention()}
            loading={savingRetention}
            disabled={!orgSettings}
          >
            {t('common.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">{t('integrationLogs.retentionHint')}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={provider}
          onChange={e => resetTo(setProvider)(e.target.value)}
          className={inputCls}
          aria-label={t('integrationLogs.providerAria')}
        >
          {PROVIDER_CODES.map(code => (
            <option key={code} value={code}>
              {providerName(code)}
            </option>
          ))}
        </select>
        <select
          value={ok}
          onChange={e => resetTo(setOk)(e.target.value)}
          className={inputCls}
          aria-label={t('integrationLogs.statusAria')}
        >
          <option value="">{t('integrationLogs.allStatuses')}</option>
          <option value="true">{t('integrationLogs.statusSuccess')}</option>
          <option value="false">{t('integrationLogs.statusErrors')}</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={e => resetTo(setDateFrom)(e.target.value)}
          className={inputCls}
          aria-label={t('integrationLogs.dateFromAria')}
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => resetTo(setDateTo)(e.target.value)}
          className={inputCls}
          aria-label={t('integrationLogs.dateToAria')}
        />
      </div>

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase">
                <th className="px-4 py-3 font-medium">{t('integrationLogs.colTime')}</th>
                <th className="px-4 py-3 font-medium">{t('integrationLogs.colProvider')}</th>
                <th className="px-4 py-3 font-medium">{t('integrationLogs.colOperation')}</th>
                <th className="px-4 py-3 font-medium">{t('integrationLogs.colStatus')}</th>
                <th className="px-4 py-3 font-medium text-right tabular-nums">
                  {t('integrationLogs.colHttp')}
                </th>
                <th className="px-4 py-3 font-medium text-right tabular-nums">
                  {t('integrationLogs.colDuration')}
                </th>
                <th className="px-4 py-3 font-medium">{t('integrationLogs.colDocument')}</th>
                <th className="px-4 py-3 font-medium">{t('integrationLogs.colError')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('integrationLogs.loading')}
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('integrationLogs.notFound')}
                  </td>
                </tr>
              ) : (
                items.map(log => (
                  <tr key={log.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5 whitespace-nowrap tabular-nums">
                      {fmtDateTime(log.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">{log.provider}</td>
                    <td className="px-4 py-2.5">{log.operation}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          log.ok
                            ? 'text-success-text bg-success-subtle border border-success-border rounded-full px-2 py-0.5 text-xs'
                            : 'text-destructive-text bg-destructive-subtle border border-destructive-border rounded-full px-2 py-0.5 text-xs'
                        }
                      >
                        {log.ok ? t('integrationLogs.ok') : t('integrationLogs.statusErrorCell')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{log.httpStatus ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{log.durationMs ?? '—'}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                      {log.documentType ?? '—'}
                    </td>
                    <td
                      className="px-4 py-2.5 max-w-xs truncate text-xs text-destructive-text"
                      title={log.error ?? undefined}
                    >
                      {log.error ?? ''}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              {t('integrationLogs.pageInfo', { page, totalPages, total })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                {t('integrationLogs.prev')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {t('integrationLogs.next')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
