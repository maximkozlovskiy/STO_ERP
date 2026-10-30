'use client';

import { useTranslation } from 'react-i18next';
import {
  useLinesSummary,
  type LinesSummaryEntity,
  type LinesSummaryTable,
} from '@/hooks/api/useLinesSummary';
import { fmtQty } from '@/lib/format';
import { PanelSection } from './detail-panel';

interface LinesSummarySectionProps {
  /** Сутність документа = сегмент URL ендпоінта зведення. */
  entity: LinesSummaryEntity;
  /** id вибраного в списку документа; null — нічого не вибрано, запит не йде. */
  id: string | null;
  /** false — панель закрита/вимкнена: запит не йде. */
  enabled?: boolean;
}

/**
 * Блок «Зведення» (+ «Виконавці» для наряду) у боковій панелі списку документів —
 * BR-WO-009 / BR-WO-010. Один компонент на всі п'ять списків: наряди, рахунки, закупівлі,
 * повернення постачальнику, складські документи.
 *
 * Числа рахує сервер (`GET /<entity>/:id/lines-summary`); тут лише підписи й множина.
 */
export function LinesSummarySection({ entity, id, enabled = true }: LinesSummarySectionProps) {
  const { t } = useTranslation('common');
  const { data, error, isPending, isFetching, refetch } = useLinesSummary(entity, id, enabled);

  if (!id || !enabled) return null;

  // Текст сервера (він український) і обрив мережі (api-client перекладає його в NetworkError)
  // показуємо як є. Сирий TypeError браузера («Failed to fetch», «Load failed») — лише якщо він
  // обійшов api-client: замість нього — загальне повідомлення.
  const errorText =
    error instanceof Error && !(error instanceof TypeError) && error.message
      ? error.message
      : t('linesSummary.loadError');

  /** «5 позицій · 7,5 н-год» — текст одного рядка зведення. */
  const describe = (table: LinesSummaryTable): string => {
    const quantity = t(
      table.quantityUnit === 'hours' ? 'linesSummary.hours' : 'linesSummary.units',
      {
        value: fmtQty(table.quantity),
      },
    );
    if (table.key === 'goods') {
      const parts = [t('linesSummary.names', { count: table.distinct }), quantity];
      // «N рядків» — лише коли той самий товар стоїть у кількох рядках; інакше це шум.
      if (table.positions !== table.distinct) {
        parts.push(t('linesSummary.rows', { count: table.positions }));
      }
      return parts.join(' · ');
    }
    if (table.key === 'works') {
      const base = `${t('linesSummary.positions', { count: table.positions })} · ${quantity}`;
      return table.distinct !== table.positions
        ? `${base} ${t('linesSummary.distinctWorks', { n: table.distinct })}`
        : base;
    }
    return `${t('linesSummary.rows', { count: table.positions })} · ${quantity}`;
  };

  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="lines-summary">
      <PanelSection title={t('linesSummary.title')} className="space-y-1.5">
        {error ? (
          <div role="alert" className="space-y-1.5">
            <p className="text-[13px] text-destructive-text">{errorText}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="text-[12px] font-medium text-primary hover:underline disabled:opacity-50"
            >
              {t('retry')}
            </button>
          </div>
        ) : isPending ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            {t('linesSummary.loading')}
          </p>
        ) : data.tables.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('linesSummary.empty')}</p>
        ) : (
          <>
            <dl className="space-y-1">
              {data.tables.map(table => (
                <div
                  key={table.key}
                  className="flex items-baseline justify-between gap-2 text-[13px]"
                  data-testid={`lines-summary-${table.key}`}
                >
                  <dt className="shrink-0 text-muted-foreground">
                    {t(`linesSummary.tables.${table.key}`)}
                  </dt>
                  <dd className="text-right tabular-nums text-foreground">{describe(table)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('linesSummary.hint')}
            </p>
          </>
        )}
      </PanelSection>

      {data && !error && data.executors.length > 0 && (
        <PanelSection title={t('linesSummary.executorsTitle')} className="space-y-1.5">
          <dl className="space-y-1" data-testid="lines-summary-executors">
            {data.executors.map(executor => (
              <div
                key={executor.employeeId}
                className="flex items-baseline justify-between gap-2 text-[13px]"
              >
                <dt className={executor.name ? 'text-foreground' : 'italic text-muted-foreground'}>
                  {executor.name || t('linesSummary.executorNotFound')}
                </dt>
                <dd className="shrink-0 text-right tabular-nums text-muted-foreground">
                  {t('linesSummary.works', { count: executor.works })}
                  {' · '}
                  {t('linesSummary.hours', { value: fmtQty(executor.normoHours) })}
                </dd>
              </div>
            ))}
          </dl>
        </PanelSection>
      )}
    </div>
  );
}
