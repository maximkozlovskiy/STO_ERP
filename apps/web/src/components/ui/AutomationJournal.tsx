'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { AUTOMATION_DOCUMENT_TYPES, type AutomationDocumentTypeValue } from '@sto/shared';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { fmtDateTime, fmtShortDateTime } from '@/lib/format';
import {
  automationChannelLabel,
  automationDocumentHref,
  automationDocumentTypeLabel,
  automationSkipReasonLabel,
  automationStatusLabel,
} from '@/lib/automation';
import {
  useAutomationMessages,
  useAutomationRuns,
  type AutomationActionResult,
  type AutomationJournalFilters,
  type AutomationRun,
} from '@/hooks/api/useAutomation';
import { Badge, type BadgeVariant } from './badge';
import { DateRangeFilter } from './date-range-filter';
import { ListLoadError } from './list-load-error';
import { Pagination } from './pagination';
import { Select } from './select';
import { Spinner } from './spinner';
import { StatusPill } from './status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { TableContainer } from './table-container';

const LIMIT = 20;
const RUN_STATUSES = ['DONE', 'PARTIAL', 'FAILED', 'SKIPPED'] as const;
const MESSAGE_STATUSES = ['QUEUED', 'SENT', 'REJECTED', 'FAILED', 'SKIPPED'] as const;

const RUN_BADGE: Record<string, BadgeVariant> = {
  DONE: 'success',
  PARTIAL: 'warning',
  FAILED: 'destructive',
  SKIPPED: 'secondary',
};
const MESSAGE_BADGE: Record<string, BadgeVariant> = {
  QUEUED: 'info',
  SENT: 'success',
  REJECTED: 'destructive',
  FAILED: 'destructive',
  SKIPPED: 'secondary',
};

const isDocType = (v: string): v is AutomationDocumentTypeValue =>
  (AUTOMATION_DOCUMENT_TYPES as readonly string[]).includes(v);

function DocumentCell({ type, id }: { type: string | null; id: string | null }) {
  const { t } = useTranslation('automation');
  const { employee } = useAuth();
  if (!type) return <span className="text-muted-foreground">—</span>;
  const href = automationDocumentHref(type, id, employee?.role);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{automationDocumentTypeLabel(type)}</span>
      {href && (
        <Link
          href={href}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
          title={t('journal.openDocument')}
          aria-label={`${t('journal.openDocument')}: ${automationDocumentTypeLabel(type)}`}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
    </span>
  );
}

export function ActionResultLine({ r }: { r: AutomationActionResult }) {
  const { t } = useTranslation('automation');
  const details: string[] = [];
  if (r.reason) details.push(automationSkipReasonLabel(r.reason));
  if (r.error) details.push(r.error);
  if (r.channels?.length) details.push(r.channels.map(automationChannelLabel).join(' → '));
  if (r.delayedUntil)
    details.push(t('journal.delayedUntil', { at: fmtShortDateTime(r.delayedUntil) }));
  if (typeof r.recipients === 'number') details.push(t('journal.recipientsN', { n: r.recipients }));
  if (r.taskId) details.push(t('journal.taskCreated'));
  return (
    <li className="text-[12px]" data-result-status={r.status} data-reason={r.reason}>
      <span className="font-medium text-foreground">{t(`actionTypes.${r.type}`)}</span>
      <span
        className={cn(
          'ml-1',
          r.status === 'FAILED'
            ? 'text-destructive-text'
            : r.status === 'SKIPPED'
              ? 'text-warning-text'
              : 'text-success-text',
        )}
      >
        — {t(`actionStatuses.${r.status}`)}
      </span>
      {details.length > 0 && <span className="text-muted-foreground">: {details.join('; ')}</span>}
    </li>
  );
}

function eventText(run: AutomationRun, t: (k: string, o?: Record<string, string>) => string) {
  const type = run.documentType;
  if (run.eventKind === 'CREATED')
    return t('journal.eventCreated', { status: automationStatusLabel(type, run.toStatus) });
  return t('journal.eventChanged', {
    from: automationStatusLabel(type, run.fromStatus),
    to: automationStatusLabel(type, run.toStatus),
  });
}

interface AutomationJournalProps {
  /** Журнал одного правила (вкладка картки); без нього — увесь журнал організації. */
  ruleId?: string | undefined;
}

/**
 * Журнал автоматизації (US-AUT-5, BR-AUT-050): спрацювання правил з результатом кожної дії і
 * повідомлення клієнтам / працівникам зі статусом доставки й причиною пропуску (підписи кодів
 * `AUTOMATION_SKIP_REASONS`), фільтри й посилання на документ.
 */
export function AutomationJournal({ ruleId }: AutomationJournalProps) {
  const { t } = useTranslation('automation');
  const [view, setView] = useState<'runs' | 'messages'>('runs');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [testFilter, setTestFilter] = useState<'' | 'true' | 'false'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters: AutomationJournalFilters = {
    page,
    limit: LIMIT,
    ruleId,
    status: status || undefined,
    documentType: documentType || undefined,
    isTest: view === 'messages' && testFilter ? testFilter === 'true' : undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const runs = useAutomationRuns(filters, view === 'runs');
  const messages = useAutomationMessages(filters, view === 'messages');
  const active = view === 'runs' ? runs : messages;
  const total = active.data?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);

  const change = (apply: () => void) => {
    apply();
    setPage(1);
  };
  const statuses = view === 'runs' ? RUN_STATUSES : MESSAGE_STATUSES;
  const colSpan = view === 'runs' ? (ruleId ? 4 : 5) : ruleId ? 5 : 6;

  return (
    <div className="flex flex-col gap-3 min-h-0" data-testid="automation-journal">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label={t('tabs.journal')}>
          {(['runs', 'messages'] as const).map(v => (
            <StatusPill
              key={v}
              value={v}
              label={t(`journal.${v}`)}
              active={view === v}
              onSelect={() =>
                change(() => {
                  setView(v);
                  setStatus('');
                })
              }
            />
          ))}
        </div>
        <Select
          aria-label={t('journal.status')}
          value={status}
          onChange={e => change(() => setStatus(e.target.value))}
          className="h-8 w-40 text-[13px] py-0.5 px-2 pr-7"
        >
          <option value="">{t('journal.statusAll')}</option>
          {statuses.map(s => (
            <option key={s} value={s}>
              {view === 'runs' ? t(`runStatuses.${s}`) : t(`deliveryStatuses.${s}`)}
            </option>
          ))}
        </Select>
        {!ruleId && (
          <Select
            aria-label={t('journal.document')}
            value={documentType}
            onChange={e => change(() => setDocumentType(e.target.value))}
            className="h-8 w-52 text-[13px] py-0.5 px-2 pr-7"
          >
            <option value="">{t('journal.documentAll')}</option>
            {AUTOMATION_DOCUMENT_TYPES.map(d => (
              <option key={d} value={d}>
                {automationDocumentTypeLabel(d)}
              </option>
            ))}
          </Select>
        )}
        {view === 'messages' && (
          <Select
            aria-label={t('journal.test')}
            value={testFilter}
            onChange={e =>
              change(() => {
                const v = e.target.value;
                setTestFilter(v === 'true' || v === 'false' ? v : '');
              })
            }
            className="h-8 w-44 text-[13px] py-0.5 px-2 pr-7"
          >
            <option value="">{t('journal.testAll')}</option>
            <option value="true">{t('journal.testOnly')}</option>
            <option value="false">{t('journal.realOnly')}</option>
          </Select>
        )}
        <DateRangeFilter
          from={from}
          to={to}
          onFromChange={v => change(() => setFrom(v))}
          onToChange={v => change(() => setTo(v))}
          fromLabel={t('journal.periodFrom')}
          toLabel={t('journal.periodTo')}
        />
      </div>

      <ListLoadError
        error={active.data ? null : active.error}
        onRetry={() => void active.refetch()}
      />

      <TableContainer>
        <Table>
          <TableHeader>
            {view === 'runs' ? (
              <TableRow>
                <TableHead>{t('journal.occurredAt')}</TableHead>
                {!ruleId && <TableHead>{t('journal.rule')}</TableHead>}
                <TableHead>{t('journal.document')}</TableHead>
                <TableHead>{t('journal.event')}</TableHead>
                <TableHead>{t('journal.results')}</TableHead>
              </TableRow>
            ) : (
              <TableRow>
                <TableHead>{t('journal.occurredAt')}</TableHead>
                <TableHead>{t('journal.recipient')}</TableHead>
                <TableHead>{t('journal.channel')}</TableHead>
                <TableHead>{t('journal.status')}</TableHead>
                <TableHead>{t('journal.reason')}</TableHead>
                {!ruleId && <TableHead>{t('journal.document')}</TableHead>}
              </TableRow>
            )}
          </TableHeader>
          <TableBody>
            {active.isLoading && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-10">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!active.isLoading && !active.error && total === 0 && (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="py-10 text-center text-[13px] text-muted-foreground"
                >
                  {view === 'runs' ? t('journal.emptyRuns') : t('journal.emptyMessages')}
                </TableCell>
              </TableRow>
            )}
            {view === 'runs' &&
              !runs.isLoading &&
              (runs.data?.items ?? []).map(run => (
                <TableRow key={run.id} data-run-id={run.id} data-run-status={run.status}>
                  <TableCell className="whitespace-nowrap text-[13px] tabular-nums">
                    {fmtDateTime(run.occurredAt)}
                  </TableCell>
                  {!ruleId && (
                    <TableCell className="text-[13px] max-w-64 wrap-break-word">
                      {run.ruleName}
                    </TableCell>
                  )}
                  <TableCell className="text-[13px]">
                    <DocumentCell type={run.documentType} id={run.documentId} />
                  </TableCell>
                  <TableCell className="text-[13px]">
                    <span className="block text-muted-foreground">
                      {isDocType(run.documentType) ? eventText(run, t) : run.eventKind}
                    </span>
                    <Badge variant={RUN_BADGE[run.status] ?? 'secondary'} dot>
                      {t(`runStatuses.${run.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-96">
                    <ul className="space-y-0.5">
                      {run.actionResults.map(r => (
                        <ActionResultLine key={r.index} r={r} />
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            {view === 'messages' &&
              !messages.isLoading &&
              (messages.data?.items ?? []).map(m => (
                <TableRow key={m.id} data-message-id={m.id} data-message-status={m.status}>
                  <TableCell className="whitespace-nowrap text-[13px] tabular-nums">
                    {fmtDateTime(m.createdAt)}
                  </TableCell>
                  <TableCell className="text-[13px] wrap-break-word max-w-48">
                    {m.recipient || '—'}
                  </TableCell>
                  <TableCell className="text-[13px] whitespace-nowrap">
                    {automationChannelLabel(m.channel)}
                    <span className="block text-[11px] text-muted-foreground">{m.provider}</span>
                  </TableCell>
                  <TableCell className="text-[13px]">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={MESSAGE_BADGE[m.status] ?? 'secondary'} dot>
                        {t(`deliveryStatuses.${m.status}`)}
                      </Badge>
                      {m.isTest && <Badge variant="purple">{t('journal.test')}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell
                    className="text-[12px] text-muted-foreground max-w-72 wrap-break-word"
                    data-reason={m.skipReason ?? undefined}
                  >
                    {[automationSkipReasonLabel(m.skipReason), m.error]
                      .filter(Boolean)
                      .join('; ') || '—'}
                  </TableCell>
                  {!ruleId && (
                    <TableCell className="text-[13px]">
                      <DocumentCell type={m.documentType} id={m.documentId} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}
