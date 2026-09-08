'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { useIntegrationLogs, type IntegrationLogsFilter } from '@/hooks/api/useIntegrationLogs';
import { type OrgSettings } from './shared';

const PROVIDERS = [
  { code: '', name: 'Усі провайдери' },
  { code: 'liqpay', name: 'LiqPay' },
  { code: 'monobank', name: 'monobank' },
  { code: 'checkbox', name: 'Checkbox' },
  { code: 'vchasno', name: 'Вчасно.Каса' },
  { code: 'novaposhta', name: 'Нова Пошта' },
];

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
  const currentFeatures = useUiFeatures();

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
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      if (currentFeatures.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка збереження');
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
          Зберігати логи (днів)
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
            Зберегти
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">
          Старіші логи щоночі видаляються (1–365 днів). Логи містять лише метадані обмінів — без
          секретів і тіл запитів.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={provider}
          onChange={e => resetTo(setProvider)(e.target.value)}
          className={inputCls}
        >
          {PROVIDERS.map(p => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={ok} onChange={e => resetTo(setOk)(e.target.value)} className={inputCls}>
          <option value="">Усі статуси</option>
          <option value="true">Успіх</option>
          <option value="false">Помилки</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={e => resetTo(setDateFrom)(e.target.value)}
          className={inputCls}
          aria-label="Дата від"
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => resetTo(setDateTo)(e.target.value)}
          className={inputCls}
          aria-label="Дата до"
        />
      </div>

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase">
                <th className="px-4 py-3 font-medium">Час</th>
                <th className="px-4 py-3 font-medium">Провайдер</th>
                <th className="px-4 py-3 font-medium">Операція</th>
                <th className="px-4 py-3 font-medium">Статус</th>
                <th className="px-4 py-3 font-medium text-right tabular-nums">HTTP</th>
                <th className="px-4 py-3 font-medium text-right tabular-nums">Час, мс</th>
                <th className="px-4 py-3 font-medium">Документ</th>
                <th className="px-4 py-3 font-medium">Помилка</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    Завантаження…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    Логів не знайдено
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
                        {log.ok ? 'OK' : 'Помилка'}
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
              Сторінка {page} з {totalPages} · всього {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                Назад
              </Button>
              <Button
                variant="secondary"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Далі
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
