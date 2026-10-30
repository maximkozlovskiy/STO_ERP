'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Trash2, Workflow } from 'lucide-react';
import {
  AUTOMATION_DOCUMENT_TYPES,
  type AutomationActionTypeValue,
  type AutomationDocumentTypeValue,
} from '@sto/shared';
import { useRequireAuth } from '@/lib/auth';
import { useUrlCard } from '@/lib/url-card';
import { fmtShortDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  automationDocumentTypeLabel,
  automationEventKindLabel,
  automationStatusLabel,
} from '@/lib/automation';
import { useConfirm } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useListPage } from '@/hooks/useListPage';
import {
  useAutomationRules,
  useDeleteAutomationRule,
  useToggleAutomationRule,
  type AutomationRule,
} from '@/hooks/api/useAutomation';
import { ACTION_ICONS } from '@/components/ui/AutomationRuleActions';
import { AutomationJournal } from '@/components/ui/AutomationJournal';
import { AutomationRuleEditModal } from '@/components/ui/AutomationRuleEditModal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TableColumnsDropdown } from '@/components/ui/columns-dropdown';
import { ListEmptyState } from '@/components/ui/empty-state';
import { CatalogHelp } from '@/components/ui/help-popover';
import { Input } from '@/components/ui/input';
import { ListFiltersRow, ListStatusRow } from '@/components/ui/list-toolbar';
import { ListLoadError } from '@/components/ui/list-load-error';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { TableContainer } from '@/components/ui/table-container';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type PageTab = 'rules' | 'journal';
type StateFilter = '' | 'enabled' | 'disabled';

const COLUMN_DEFS: Array<{ key: string; labelKey: string }> = [
  { key: 'name', labelKey: 'columns.name' },
  { key: 'document', labelKey: 'columns.document' },
  { key: 'event', labelKey: 'columns.event' },
  { key: 'actions', labelKey: 'columns.actions' },
  { key: 'lastRun', labelKey: 'columns.lastRun' },
  { key: 'enabled', labelKey: 'columns.enabled' },
];
const DEFAULT_KEYS_JSON = JSON.stringify(COLUMN_DEFS.map(c => c.key));
const NO_RULES: readonly AutomationRule[] = Object.freeze([]);

const isDocType = (v: string): v is AutomationDocumentTypeValue =>
  (AUTOMATION_DOCUMENT_TYPES as readonly string[]).includes(v);

/** Типи дій правила — з JSON дій (форма відповіді API — `Record<string, unknown>[]`). */
function actionTypes(rule: AutomationRule): AutomationActionTypeValue[] {
  const out: AutomationActionTypeValue[] = [];
  for (const a of rule.actions) {
    const type = a.type;
    if (
      (type === 'client_message' || type === 'employee_notification' || type === 'create_task') &&
      !out.includes(type)
    )
      out.push(type);
  }
  return out;
}

/**
 * Налаштування → Автоматизація (docs/objects/automation.md, US-AUT-4, 5): список правил за
 * стандартом «Панель списку» і журнал спрацювань / повідомлень. Керують OWNER і ADMIN.
 */
function AutomationPageClient() {
  const { employee } = useRequireAuth(['OWNER', 'ADMIN']);
  const { t } = useTranslation('automation');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab: PageTab = searchParams.get('tab') === 'journal' ? 'journal' : 'rules';
  const setTab = (next: PageTab) =>
    router.replace(next === 'rules' ? '?' : `?tab=${next}`, { scroll: false });

  const columns = useMemo(() => COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })), [t]);
  const { tableColumns, dragProps } = useListPage('automation-rules', columns);
  const { visibleColumns } = tableColumns;

  const [search, setSearch] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [state, setState] = useState<StateFilter>('');

  const card = useUrlCard();
  const [creating, setCreating] = useState(false);
  const cardOpen = !!card.id || creating;
  // Створене правило відкривається своєю карткою (адреса `?open=`) — без кадру із закритим вікном.
  useEffect(() => {
    if (card.id) setCreating(false);
  }, [card.id]);

  const { data, isLoading, error, refetch } = useAutomationRules(!!employee);
  const toggle = useToggleAutomationRule();
  const remove = useDeleteAutomationRule();
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const [busyId, setBusyId] = useState<string | null>(null);

  const all = data?.items ?? NO_RULES;
  const needle = search.trim().toLowerCase();
  const items = all.filter(
    r =>
      (!needle || r.name.toLowerCase().includes(needle)) &&
      (!documentType || r.documentType === documentType) &&
      (!state || (state === 'enabled') === r.enabled),
  );
  const filtered = !!needle || !!documentType || !!state;

  const setEnabled = async (rule: AutomationRule, enabled: boolean) => {
    if (busyId) return;
    setBusyId(rule.id);
    try {
      await toggle.mutateAsync({ id: rule.id, enabled });
      if (features.toastEnabled) toast.success(t(enabled ? 'toast.enabled' : 'toast.disabled'));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('loadError'));
    } finally {
      setBusyId(null);
    }
  };

  const deleteRule = async (rule: AutomationRule) => {
    const ok = await confirm({
      title: t('deleteConfirm.title'),
      message: t('deleteConfirm.message', { name: rule.name }),
      confirmLabel: t('card.delete'),
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(rule.id);
      if (features.toastEnabled) toast.success(t('toast.deleted'));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('loadError'));
    }
  };

  const closeCard = useCallback(() => {
    setCreating(false);
    card.close();
  }, [card]);

  const colSpan = visibleColumns.length + 1;

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <h1 className="page-title">{t('title')}</h1>
          <CatalogHelp ns="automation" topic="help" align="start" width="lg" />
        </div>
      </div>

      <div
        className="flex gap-0 -mx-4 md:-mx-6 px-4 md:px-6 border-b border-border shrink-0"
        role="tablist"
      >
        {(['rules', 'journal'] as const).map(k => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              'px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors',
              tab === k
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      {tab === 'journal' ? (
        <AutomationJournal />
      ) : (
        <>
          <ListStatusRow label={t('stateLabel')}>
            {(
              [
                ['', t('all')],
                ['enabled', t('enabledOnly')],
                ['disabled', t('disabledOnly')],
              ] as const
            ).map(([value, label]) => (
              <StatusPill
                key={value}
                value={value}
                label={label}
                active={state === value}
                onSelect={v => setState(v === 'enabled' || v === 'disabled' ? v : '')}
              />
            ))}
          </ListStatusRow>

          <ListFiltersRow
            actions={
              <>
                <TableColumnsDropdown table={tableColumns} defaultKeysJson={DEFAULT_KEYS_JSON} />
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('newRule')}
                </Button>
              </>
            }
          >
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              maxLength={100}
              leftElement={<Search />}
              className="w-72 h-8 text-[13px]"
            />
            <Select
              aria-label={t('documentLabel')}
              value={documentType}
              onChange={e => setDocumentType(e.target.value)}
              className="w-56 h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              <option value="">{t('documentAll')}</option>
              {AUTOMATION_DOCUMENT_TYPES.map(d => (
                <option key={d} value={d}>
                  {automationDocumentTypeLabel(d)}
                </option>
              ))}
            </Select>
          </ListFiltersRow>

          <ListLoadError error={data ? null : error} onRetry={() => void refetch()} />

          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  {visibleColumns.map(col => (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ))}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="py-12">
                      <div className="flex justify-center">
                        <Spinner size="md" />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && !error && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="p-0">
                      <ListEmptyState
                        icon={Workflow}
                        title={t('empty.title')}
                        description={t('empty.desc')}
                        filtered={filtered}
                        onResetFilters={() => {
                          setSearch('');
                          setDocumentType('');
                          setState('');
                        }}
                        size="sm"
                      />
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading &&
                  items.map(rule => (
                    <TableRow
                      key={rule.id}
                      data-rule-id={rule.id}
                      onClick={() => card.open(rule.id)}
                      className={cn('group cursor-pointer', !rule.enabled && 'opacity-70')}
                    >
                      {visibleColumns.map(col => {
                        if (col.key === 'name')
                          return (
                            <TableCell key="name" className="max-w-80">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <button
                                  type="button"
                                  className="text-left text-[13px] font-semibold text-foreground hover:text-primary hover:underline wrap-break-word"
                                  onClick={e => {
                                    e.stopPropagation();
                                    card.open(rule.id);
                                  }}
                                >
                                  {rule.name}
                                </button>
                                {rule.systemKey && (
                                  <Badge variant="info" tooltip={t('systemHint')}>
                                    {t('system')}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                          );
                        if (col.key === 'document')
                          return (
                            <TableCell key="document" className="text-[13px] whitespace-nowrap">
                              {automationDocumentTypeLabel(rule.documentType)}
                            </TableCell>
                          );
                        if (col.key === 'event')
                          return (
                            <TableCell key="event" className="text-[13px] max-w-72">
                              {automationEventKindLabel(rule.eventKind)} →{' '}
                              {rule.toStatuses.length === 0 || !isDocType(rule.documentType)
                                ? t('anyStatus')
                                : rule.toStatuses
                                    .map(s => automationStatusLabel(rule.documentType, s))
                                    .join(', ')}
                            </TableCell>
                          );
                        if (col.key === 'actions')
                          return (
                            <TableCell key="actions">
                              <div className="flex items-center gap-1.5 text-muted-foreground">
                                {actionTypes(rule).map(type => {
                                  const Icon = ACTION_ICONS[type];
                                  const label = t(`actionTypes.${type}`);
                                  return (
                                    <span key={type} title={label} aria-label={label} role="img">
                                      <Icon className="h-4 w-4" aria-hidden="true" />
                                    </span>
                                  );
                                })}
                              </div>
                            </TableCell>
                          );
                        if (col.key === 'lastRun')
                          return (
                            <TableCell
                              key="lastRun"
                              className="text-[13px] tabular-nums whitespace-nowrap text-muted-foreground"
                            >
                              {rule.lastRunAt ? fmtShortDateTime(rule.lastRunAt) : t('never')}
                            </TableCell>
                          );
                        if (col.key === 'enabled')
                          return (
                            <TableCell key="enabled" onClick={e => e.stopPropagation()}>
                              <Switch
                                checked={rule.enabled}
                                disabled={busyId === rule.id}
                                onChange={v => void setEnabled(rule, v)}
                                ariaLabel={t('toggleAria', {
                                  action: rule.enabled ? t('disable') : t('enable'),
                                  name: rule.name,
                                })}
                              />
                            </TableCell>
                          );
                        return null;
                      })}
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        {!rule.systemKey && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('card.delete')}
                            aria-label={t('deleteAria', { name: rule.name })}
                            onClick={() => void deleteRule(rule)}
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <AutomationRuleEditModal
        open={cardOpen}
        ruleId={card.id}
        onClose={closeCard}
        onCreated={rule => card.open(rule.id)}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

export default function AutomationSettingsPage() {
  return (
    <Suspense fallback={null}>
      <AutomationPageClient />
    </Suspense>
  );
}
