'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { useDeadLetter, useResolveDeadLetter } from '@/hooks/api/useDeadLetter';

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

/**
 * Мінімальний UI для DeadLetterService (аудит стеку, backend #2) — черги, що вичерпали всі спроби
 * (SMS/ПРРО/webhooks/etc). Раніше видимі лише через bull-board (dev-only, /admin/queues) — у проді
 * оператор не мав способу побачити/розібрати провалені job-и. Список + позначення "опрацьовано".
 */
export default function DeadLetterTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();

  const [page, setPage] = useState(1);
  const [queueName, setQueueName] = useState('');
  const [resolved, setResolved] = useState('false');

  const filter = {
    page,
    limit: PAGE_SIZE,
    queueName: queueName || undefined,
    resolved: resolved || undefined,
  };
  const { data, isLoading } = useDeadLetter(filter);
  const resolveMutation = useResolveDeadLetter();
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetTo =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setPage(1);
      setter(v);
    };

  const handleResolve = async (id: string) => {
    try {
      await resolveMutation.mutateAsync(id);
      if (currentFeatures.toastEnabled) toast.success(t('deadLetter.resolved'));
    } catch (e: unknown) {
      if (currentFeatures.toastEnabled) {
        toast.error(e instanceof Error ? e.message : t('deadLetter.resolveError'));
      }
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">{t('deadLetter.hint')}</p>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          value={queueName}
          onChange={e => resetTo(setQueueName)(e.target.value)}
          placeholder={t('deadLetter.queueFilterPlaceholder')}
          className={inputCls}
          aria-label={t('deadLetter.queueFilterAria')}
        />
        <select
          value={resolved}
          onChange={e => resetTo(setResolved)(e.target.value)}
          className={inputCls}
          aria-label={t('deadLetter.statusAria')}
        >
          <option value="false">{t('deadLetter.statusActive')}</option>
          <option value="true">{t('deadLetter.statusResolved')}</option>
          <option value="">{t('deadLetter.statusAll')}</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase">
                <th className="px-4 py-3 font-medium">{t('deadLetter.colTime')}</th>
                <th className="px-4 py-3 font-medium">{t('deadLetter.colQueue')}</th>
                <th className="px-4 py-3 font-medium">{t('deadLetter.colJob')}</th>
                <th className="px-4 py-3 font-medium text-right tabular-nums">
                  {t('deadLetter.colAttempts')}
                </th>
                <th className="px-4 py-3 font-medium">{t('deadLetter.colReason')}</th>
                <th className="px-4 py-3 font-medium">{t('deadLetter.colStatus')}</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('deadLetter.loading')}
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('deadLetter.notFound')}
                  </td>
                </tr>
              ) : (
                items.map(job => (
                  <tr key={job.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5 whitespace-nowrap tabular-nums">
                      {fmtDateTime(job.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">{job.queueName}</td>
                    <td className="px-4 py-2.5">{job.jobName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {job.attemptsMade}/{job.maxAttempts}
                    </td>
                    <td
                      className="px-4 py-2.5 max-w-xs truncate text-xs text-destructive-text"
                      title={job.failedReason}
                    >
                      {job.failedReason}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          job.resolved
                            ? 'text-success-text bg-success-subtle border border-success-border rounded-full px-2 py-0.5 text-xs'
                            : 'text-destructive-text bg-destructive-subtle border border-destructive-border rounded-full px-2 py-0.5 text-xs'
                        }
                      >
                        {job.resolved
                          ? t('deadLetter.statusResolved')
                          : t('deadLetter.statusActive')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!job.resolved && (
                        <Button
                          variant="secondary"
                          onClick={() => void handleResolve(job.id)}
                          loading={
                            resolveMutation.isPending && resolveMutation.variables === job.id
                          }
                          disabled={resolveMutation.isPending}
                        >
                          {t('deadLetter.resolve')}
                        </Button>
                      )}
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
              {t('deadLetter.pageInfo', { page, totalPages, total })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                {t('deadLetter.prev')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {t('deadLetter.next')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
