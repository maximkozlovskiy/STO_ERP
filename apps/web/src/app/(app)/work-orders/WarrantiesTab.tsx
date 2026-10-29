'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { WARRANTY_EXPIRING_DAYS, WARRANTY_STATES, type WarrantyState } from '@sto/shared';
import { useDebounce } from '@/hooks/useDebounce';
import { useListPage } from '@/hooks/useListPage';
import { useSortState } from '@/hooks/useSortState';
import { applySavedView, savedViewOf, type SavedFilter } from '@/hooks/useSavedFilters';
import {
  useWarrantyList,
  type WarrantyListFilters,
  type WarrantyListItem,
} from '@/hooks/api/useWarranties';
import { useLinkedNav } from '@/lib/linked-nav';
import { activateRow } from '@/lib/row-activation';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  WARRANTY_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/status-pill';
import { ListFiltersRow, ListStatusRow } from '@/components/ui/list-toolbar';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { ListLoadError } from '@/components/ui/list-load-error';
import { TableColumnsDropdown } from '@/components/ui/columns-dropdown';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { TableContainer } from '@/components/ui/table-container';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  ColumnHead,
  TableLoadingRow,
} from '@/components/ui/table';
import { WarrantyClaimModal } from './WarrantyClaimModal';

interface WarrantyFilters extends Record<string, unknown> {
  search: string;
  state: string;
}

const STATE_BADGE: Record<WarrantyState, BadgeVariant> = {
  ACTIVE: 'success',
  EXPIRING: 'warning',
  EXPIRED: 'secondary',
  CLAIMED: 'info',
};

/** Звернутися можна лише за чинною гарантією (BR-WAR-004) — як умова запису на сервері. */
const CLAIMABLE_STATES: ReadonlySet<WarrantyState> = new Set(['ACTIVE', 'EXPIRING']);

const COLUMN_DEFS: Array<{ key: string; labelKey: string }> = [
  { key: 'number', labelKey: 'warrantiesTab.columns.number' },
  { key: 'client', labelKey: 'warrantiesTab.columns.client' },
  { key: 'description', labelKey: 'warrantiesTab.columns.description' },
  { key: 'createdAt', labelKey: 'warrantiesTab.columns.createdAt' },
  { key: 'expiresAt', labelKey: 'warrantiesTab.columns.expiresAt' },
  { key: 'state', labelKey: 'warrantiesTab.columns.state' },
];
const DEFAULT_KEYS_JSON = JSON.stringify(COLUMN_DEFS.map(c => c.key));
const SORTABLE = new Set(['createdAt', 'expiresAt']);

/** Стабільний порожній список: свіжий `[]` щорендеру перезапускав би ефекти вибору рядка. */
const NO_ITEMS: readonly WarrantyListItem[] = Object.freeze([]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Props {
  /** OWNER / ADMIN / RECEPTIONIST — ролі `POST /warranties/:id/claim`. */
  canClaim: boolean;
}

/**
 * BR-WAR-005: вкладка «Гарантії» сторінки нарядів — список за стандартом списків (пошук, фільтр
 * стану, колонки, збережені фільтри, бічна панель, пагінація) і дія «Звернення».
 * `?open=<id>` (посилання з «Пов'язаних документів» наряду) відкриває гарантію в панелі.
 */
export default function WarrantiesTab({ canClaim }: Props) {
  const { t } = useTranslation('workOrders');
  const router = useRouter();
  const searchParams = useSearchParams();
  const nav = useLinkedNav();

  const columns = useMemo(() => COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })), [t]);
  const {
    page,
    setPage,
    resetPage,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns,
    dragProps,
    detailPanel,
    panelConfig,
    savedFilters: { saved, save, remove },
    features,
    limit,
  } = useListPage<WarrantyFilters>('work-orders-warranties', columns, { defaultLimit: 20 });
  const { visibleKeys, visibleColumns, order, toggle, setVisible, reorder } = tableColumns;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [stateFilter, setStateFilter] = useState<WarrantyState | ''>('');
  const { sort, toggle: toggleSort, set: setSort } = useSortState('expiresAt', 'asc');
  const [selected, setSelected] = useState<WarrantyListItem | null>(null);
  // Гарантія, відкрита посиланням: панель показується, навіть коли користувач її вимкнув.
  const [openedByLink, setOpenedByLink] = useState(false);
  const [claiming, setClaiming] = useState<WarrantyListItem | null>(null);

  const filters: WarrantyListFilters = {
    page,
    limit,
    q: debouncedSearch.trim() || undefined,
    states: stateFilter ? [stateFilter] : undefined,
    sortBy: sort.sortBy === 'createdAt' ? 'createdAt' : 'expiresAt',
    sortDir: sort.sortDir,
  };
  const { data, isLoading, error, refetch } = useWarrantyList(filters);
  const items = data?.items ?? NO_ITEMS;
  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  // ── Посилання `?open=<id>` — залежність від значення параметра, а не «лише при монтуванні»:
  // з «Пов'язаних документів» наряду на цій же сторінці маршрут той самий (Bug #889).
  const openParam = searchParams.get('open');
  const linkId = openParam && UUID_RE.test(openParam) ? openParam : null;
  // Запит за `id` живе, доки гарантія, відкрита посиланням, лишається в панелі: параметр `open`
  // з адреси прибрано одразу, а після звернення `warrantiesKeys.all` перечитує лише активні
  // запити — вимкнений лишив би в панелі старий стан і кнопку «Звернення».
  const linkedQueryId = linkId ?? (openedByLink ? selected?.id : undefined);
  const { data: linked, isFetched: linkedFetched } = useWarrantyList(
    { page: 1, limit: 1, id: linkedQueryId },
    !!linkedQueryId,
  );
  useEffect(() => {
    if (!linkId || !linkedFetched) return;
    const row = linked?.items.find(w => w.id === linkId);
    if (row) {
      setSelected(row);
      setOpenedByLink(true);
    } else if (features.toastEnabled) {
      toast.error(t('warrantiesTab.notFound'));
    }
    router.replace('/work-orders?tab=warranties', { scroll: false });
  }, [linkId, linkedFetched, linked, router, features.toastEnabled, t]);

  // Вибраний рядок пішов зі сторінки (фільтр, пагінація) — забуваємо, щоб панель не з'являлась
  // сама. Рядок, відкритий посиланням, може бути поза поточною сторінкою — його не чіпаємо.
  useEffect(() => {
    if (!selected || openedByLink || isLoading) return;
    if (!items.some(w => w.id === selected.id)) setSelected(null);
  }, [selected, openedByLink, items, isLoading]);
  // Після звернення список перечитано — копія в панелі має взяти новий стан (зокрема гарантія,
  // відкрита посиланням поза поточною сторінкою: її рядок — у відповіді запиту за `id`).
  useEffect(() => {
    if (!selected) return;
    const fresh =
      items.find(w => w.id === selected.id) ?? linked?.items.find(w => w.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [items, linked, selected]);
  useEffect(() => {
    if (!detailPanel.enabled && !openedByLink) setSelected(null);
  }, [detailPanel.enabled, openedByLink]);

  const resetFilters = () => {
    resetPage();
    setActiveSavedFilterId(null);
  };
  const selectState = (v: string) => {
    setStateFilter(WARRANTY_STATES.includes(v as WarrantyState) ? (v as WarrantyState) : '');
    resetFilters();
  };

  const applyFilter = useCallback(
    (preset: SavedFilter<WarrantyFilters>) => {
      setSearch(preset.filters.search ?? '');
      const st = preset.filters.state;
      setStateFilter(WARRANTY_STATES.includes(st as WarrantyState) ? (st as WarrantyState) : '');
      applySavedView(preset, { reorder, setVisible, setSort });
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [reorder, setVisible, setSort, resetPage, setActiveSavedFilterId],
  );
  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = save(
        name,
        { search, state: stateFilter },
        savedViewOf(visibleKeys, order, sort),
      );
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(t('warrantiesTab.savePresetSuccess', { name }));
    },
    [save, search, stateFilter, visibleKeys, order, sort, setActiveSavedFilterId, features, t],
  );

  const closePanel = useCallback(() => {
    setSelected(null);
    setOpenedByLink(false);
  }, []);

  const stateBadge = useCallback(
    (s: WarrantyState) => (
      <Badge
        variant={STATE_BADGE[s]}
        dot
        tooltip={
          s === 'EXPIRING'
            ? t('warrantiesTab.stateHint.EXPIRING', { days: WARRANTY_EXPIRING_DAYS })
            : undefined
        }
      >
        {t(`warrantiesTab.state.${s}`)}
      </Badge>
    ),
    [t],
  );

  const panelTabs = useMemo<DetailPanelTab[] | undefined>(() => {
    if (!selected) return undefined;
    const w = selected;
    return [
      {
        key: 'info',
        label: t('warrantiesTab.panel.info'),
        content: (
          <div className="space-y-3">
            {buildPanelFields(w, WARRANTY_PANEL_SCHEMA, panelConfig.config, {
              state: v => stateBadge(v as WarrantyState),
            }).map(f => (
              <PanelField
                key={f.key}
                fieldKey={f.key}
                label={t(`warrantiesTab.panel.${f.key}`)}
                value={f.value}
                hidden={f.hidden}
              />
            ))}
            <div className="flex flex-col gap-2">
              {canClaim && CLAIMABLE_STATES.has(w.state) && (
                <Button className="w-full" size="sm" onClick={() => setClaiming(w)}>
                  {t('warrantiesTab.claim')}
                </Button>
              )}
              <Button
                className="w-full"
                size="sm"
                variant="outline"
                onClick={() => nav.toWorkOrder(w.workOrderId)}
              >
                {t('warrantiesTab.panel.openWorkOrderButton')}
              </Button>
            </div>
          </div>
        ),
      },
    ];
  }, [selected, panelConfig.config, stateBadge, canClaim, nav, t]);

  const panelConfigFields = useMemo(
    () =>
      schemaToPanelConfigFields(WARRANTY_PANEL_SCHEMA, panelConfig.config).map(f => ({
        ...f,
        label: t(`warrantiesTab.panel.${f.key}`),
      })),
    [panelConfig.config, t],
  );

  const colSpan = visibleColumns.length + 1;
  const filtered = !!stateFilter || !!debouncedSearch.trim();

  return (
    <>
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<WarrantyFilters>
          saved={saved}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={remove}
          hideSaveButton
        />
      )}

      <ListStatusRow label={t('warrantiesTab.columns.state')}>
        {(['', ...WARRANTY_STATES] as const).map(s => (
          <StatusPill
            key={s}
            value={s}
            label={s ? t(`warrantiesTab.state.${s}`) : t('warrantiesTab.all')}
            active={stateFilter === s}
            description={
              s === 'EXPIRING'
                ? t('warrantiesTab.stateHint.EXPIRING', { days: WARRANTY_EXPIRING_DAYS })
                : undefined
            }
            onSelect={selectState}
          />
        ))}
      </ListStatusRow>

      <ListFiltersRow
        actions={
          <>
            {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
            <TableColumnsDropdown table={tableColumns} defaultKeysJson={DEFAULT_KEYS_JSON} />
            <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          </>
        }
      >
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            resetFilters();
          }}
          placeholder={t('warrantiesTab.searchPlaceholder')}
          aria-label={t('warrantiesTab.searchPlaceholder')}
          maxLength={100}
          leftElement={<Search />}
          className="w-72 h-8 text-[13px]"
        />
      </ListFiltersRow>

      <ListLoadError error={data ? null : error} onRetry={() => void refetch()} />

      <div className="flex flex-1 min-h-0">
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                {visibleColumns.map(col => (
                  <ColumnHead
                    key={col.key}
                    sortKey={SORTABLE.has(col.key) ? col.key : undefined}
                    currentSort={sort}
                    onSort={toggleSort}
                    {...dragProps(col.key)}
                  >
                    {col.label}
                  </ColumnHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableLoadingRow colSpan={colSpan} />}
              {!isLoading && !error && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colSpan} className="p-0">
                    <EmptyState
                      icon={ShieldCheck}
                      title={t('warrantiesTab.empty.title')}
                      description={
                        filtered
                          ? t('warrantiesTab.empty.descFilter')
                          : t('warrantiesTab.empty.desc')
                      }
                      size="sm"
                    />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                items.map(w => (
                  <TableRow
                    key={w.id}
                    data-warranty-id={w.id}
                    onClick={() =>
                      activateRow({
                        panelEnabled: detailPanel.enabled,
                        isSelected: selected?.id === w.id,
                        select: () => {
                          setSelected(w);
                          setOpenedByLink(false);
                        },
                        deselect: closePanel,
                        open: () => nav.toWorkOrder(w.workOrderId),
                      })
                    }
                    className={cn(
                      'group cursor-pointer transition-colors',
                      selected?.id === w.id && detailPanel.enabled && 'bg-primary/5',
                    )}
                  >
                    {visibleColumns.map(col => {
                      if (col.key === 'number')
                        return (
                          <TableCell key="number" onClick={e => e.stopPropagation()}>
                            <Link
                              href={`/work-orders/${w.workOrderId}`}
                              className="text-[13px] font-semibold text-primary hover:underline whitespace-nowrap"
                              title={t('warrantiesTab.openWorkOrder', {
                                number: w.workOrderNumber ?? '',
                              })}
                            >
                              {w.workOrderNumber ?? '—'}
                            </Link>
                          </TableCell>
                        );
                      if (col.key === 'client')
                        return (
                          <TableCell key="client">
                            <p className="text-[13px] font-medium text-foreground">
                              {w.counterpartyName || '—'}
                            </p>
                            <p className="text-[12px] text-muted-foreground mt-0.5">
                              {w.vehicleSummary ?? '—'}
                            </p>
                          </TableCell>
                        );
                      if (col.key === 'description')
                        return (
                          <TableCell
                            key="description"
                            className="text-[13px] text-muted-foreground max-w-64"
                          >
                            <div className="line-clamp-2 wrap-break-word" title={w.description}>
                              {w.description || '—'}
                            </div>
                          </TableCell>
                        );
                      if (col.key === 'createdAt')
                        return (
                          <TableCell key="createdAt" className="text-[13px] text-muted-foreground">
                            {fmtDate(w.createdAt)}
                          </TableCell>
                        );
                      if (col.key === 'expiresAt')
                        return (
                          <TableCell key="expiresAt" className="text-[13px] tabular-nums">
                            {fmtDate(w.expiresAt)}
                          </TableCell>
                        );
                      if (col.key === 'state')
                        return <TableCell key="state">{stateBadge(w.state)}</TableCell>;
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      {/* Іконка, не кнопка з текстом: з відкритою панеллю таблиця вужча, і текстова
                          кнопка йшла за горизонтальну прокрутку (Bug #831). */}
                      {canClaim && CLAIMABLE_STATES.has(w.state) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t('warrantiesTab.claim')}
                          aria-label={t('warrantiesTab.claim')}
                          onClick={() => setClaiming(w)}
                        >
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>

        <DetailPanel
          open={!!selected && (detailPanel.enabled || openedByLink)}
          onClose={closePanel}
          title={selected?.workOrderNumber ?? ''}
          tabs={panelTabs}
          configFields={panelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        />
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Після звернення `useClaimWarranty` скидає `warrantiesKeys.all` — список перечитується. */}
      <WarrantyClaimModal warranty={claiming} onClose={() => setClaiming(null)} />
    </>
  );
}
