'use client';

import { Fragment, useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react';
import { TabDivider } from '@/components/ui/tab-divider';
import { useTranslation } from 'react-i18next';
import { activateRow } from '@/lib/row-activation';
import { useDebounce } from '@/hooks/useDebounce';
import { useSelectedRowRefresh } from '@/hooks/useSelectedRowRefresh';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUrlCard } from '@/lib/url-card';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Users, Pencil, X } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { useCounterparties, counterpartiesKeys, Counterparty } from '@/hooks/api/useCounterparties';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { COUNTERPARTY_TYPE_BADGE, COUNTERPARTY_TYPE_DESCRIPTIONS } from '@sto/shared';
import { counterpartyTypeLabel } from '@/i18n/enumLabel';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  TableBody,
  TableRow,
  TableCell,
  MoneyCell,
  DocLink,
  TableLoadingRow,
  ListTableHeader,
} from '@/components/ui/table';
import { useSortState } from '@/hooks/useSortState';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import {
  COUNTERPARTY_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { type BulkAction } from '@/components/ui/bulk-actions-bar';
import { useListPage } from '@/hooks/useListPage';
import { ListTableLayout } from '@/components/ui/list-table-layout';
import { ListToolbar } from '@/components/ui/list-view-actions';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { cn, settlementBalanceTone, settlementBalanceToneClass } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';
import { RowDeleteButton } from '@/components/ui/row-delete-button';

interface CrmFilters extends Record<string, unknown> {
  search: string;
  typeFilter: string;
  showDeleted: boolean;
}

const TYPE_BADGE = COUNTERPARTY_TYPE_BADGE;
const TYPE_FILTER_OPTIONS = [
  ['', 'typeFilter.all'],
  ['CLIENT', 'typeFilter.client'],
  ['SUPPLIER', 'typeFilter.supplier'],
  ['BOTH', 'typeFilter.both'],
] as const;

// Module-level — статичні колонки (label = i18n labelKey, резолвиться у компоненті) +
// прекомпьютений JSON для hasCustomization.
const CRM_COLUMN_DEFS: Array<{ key: string; labelKey: string; defaultVisible?: boolean }> = [
  { key: 'name', labelKey: 'columns.name', defaultVisible: true },
  { key: 'type', labelKey: 'columns.type', defaultVisible: true },
  { key: 'statuses', labelKey: 'columns.statuses', defaultVisible: true },
  { key: 'phone', labelKey: 'columns.phone', defaultVisible: true },
  { key: 'edrpou', labelKey: 'columns.edrpou', defaultVisible: false },
  { key: 'balance', labelKey: 'columns.balance', defaultVisible: true },
];
const CRM_COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(CRM_COLUMN_DEFS.map(c => c.key));

// Suspense обгортка для useSearchParams — Next.js static-export вимога.
// Верхній рівень = таб-роутер: список контрагентів + довідник статусів-міток.
/** Колонки списку, за якими сортує сервер: ключ колонки → поле сортування. */
const CRM_SORT_KEYS: Partial<Record<string, string>> = { name: 'lastName', balance: 'balance' };

export default function CrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmTabsShell />
    </Suspense>
  );
}

const CounterpartyStatusesTab = dynamic(() => import('./CounterpartyStatusesTab'), { ssr: false });
const VehicleMakesTab = dynamic(() => import('./VehicleMakesTab'), { ssr: false });

// Довідники (статуси, марки авто) — за роздільником після списку.
type CrmTab = 'list' | 'statuses' | 'vehicle-makes';
const CRM_TABS: { key: CrmTab; labelKey: string }[] = [
  { key: 'list', labelKey: 'tabs.list' },
  { key: 'statuses', labelKey: 'tabs.statuses' },
  { key: 'vehicle-makes', labelKey: 'tabs.vehicleMakes' },
];
const preloadTab = (key: CrmTab): void => {
  if (key === 'statuses') void import('./CounterpartyStatusesTab');
  if (key === 'vehicle-makes') void import('./VehicleMakesTab');
};

function CrmTabsShell() {
  const { t } = useTranslation('counterparties');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'list') as CrmTab;
  const setTab = (t: CrmTab) =>
    router.replace(t === 'list' ? '/counterparties' : `/counterparties?tab=${t}`, {
      scroll: false,
    });

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('title')}</h1>
        </div>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {CRM_TABS.map(tabItem => (
          <Fragment key={tabItem.key}>
            {tabItem.key === 'statuses' && <TabDivider />}
            <button
              onMouseEnter={() => preloadTab(tabItem.key)}
              onClick={() => setTab(tabItem.key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
                tab === tabItem.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(tabItem.labelKey)}
            </button>
          </Fragment>
        ))}
      </div>

      {tab === 'statuses' ? (
        <CounterpartyStatusesTab />
      ) : tab === 'vehicle-makes' ? (
        <VehicleMakesTab />
      ) : (
        <CrmPageInner />
      )}
    </div>
  );
}

function CrmPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const { t } = useTranslation('counterparties');
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const { confirm, dialogProps } = useConfirm();

  // Колонки з i18n-мітками — резолвляться у компоненті (labelKey → t), memo по `t`.
  const CRM_COLUMNS = useMemo(
    () => CRM_COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })),
    [t],
  );

  // useListPage: shared table/panel/filter infrastructure
  const listPage = useListPage<CrmFilters>('crm', CRM_COLUMNS, { defaultLimit: 20 });
  const {
    page,
    setPage,
    resetPage,
    changeFilter,
    showDeleted,
    setShowDeleted,
    activeSavedFilterId,
    setActiveSavedFilterId,
    visibleColumns,
    colSpan,
    detailPanel,
    panelConfig,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = listPage;

  // Помилка дії (delete/bulk/save-filter) для випадку коли toast вимкнено (features.toastEnabled=false):
  // без цього fallback помилки мутацій тихо зникали б (queryError покриває лише завантаження списку).
  const [actionError, setActionError] = useState('');

  // Local filter state (specific to counterparties)
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [typeFilter, setTypeFilter] = useState('');

  const crmSorting = useSortState('lastName', 'asc');
  const { sort: crmSort } = crmSorting;
  const {
    data: queryData,
    isLoading: loading,
    error: queryError,
  } = useCounterparties({
    page,
    limit,
    types: typeFilter,
    q: debouncedSearch,
    showDeleted,
    sortBy: crmSort.sortBy,
    sortDir: crmSort.sortDir,
  });
  // stable empty array reference: ?? [] creates fresh array each render → useBulkSelect prunes every cycle.
  const counterparties = queryData?.items ?? (EMPTY_ITEMS as unknown as Counterparty[]);
  const total = queryData?.total ?? 0;

  // Картка контрагента — в адресі (`?open=<id>`): посилання відкриває її, «Назад» закриває.
  // Рядок береться зі списку; контрагента поза поточною сторінкою (посилання) — запитом за id.
  // Нова картка (створення) адреси не має — `creating`.
  const cpCard = useUrlCard();
  const { open: openCpCard, close: closeCpCard } = cpCard;
  const [creating, setCreating] = useState(false);
  const listCp = cpCard.id ? counterparties.find(c => c.id === cpCard.id) : undefined;
  const { data: fetchedCp } = useQuery({
    queryKey: counterpartiesKeys.detail(cpCard.id ?? ''),
    queryFn: () => apiFetch<Counterparty>(`/counterparties/${cpCard.id}`),
    enabled: !!cpCard.id && !listCp && !loading,
  });
  const editingCp: Counterparty | null = cpCard.id ? (listCp ?? fetchedCp ?? null) : null;
  const modal = creating || !!editingCp;
  // «Створення» знімаємо, лише коли в адресі вже картка створеного: інакше між збереженням і
  // оновленням адреси вікно на мить закрилося б.
  useEffect(() => {
    if (cpCard.id) setCreating(false);
  }, [cpCard.id]);
  const closeCard = useCallback(() => {
    setCreating(false);
    closeCpCard();
  }, [closeCpCard]);
  const [selectedCp, setSelectedCp] = useState<Counterparty | null>(null);

  // Вимкнули панель → вибір скидаємо: інакше після повторного вмикання клік по тому самому
  // рядку сховав би панель замість показати (Bug #624, як у закупівель і складу).
  useEffect(() => {
    if (!detailPanel.enabled) setSelectedCp(null);
  }, [detailPanel.enabled]);
  // Рядок пішов із завантаженої сторінки (фільтр, інша сторінка, видалення) → вибір забуваємо,
  // щоб панель не відкрилась сама, коли рядок повернеться.
  useEffect(() => {
    if (selectedCp && !loading && !counterparties.some(i => i.id === selectedCp.id))
      setSelectedCp(null);
  }, [selectedCp, counterparties, loading]);
  // Панель тримає копію рядка: після збереження картки список перечитується, а панель
  // показувала б старі дані, доки рядок не вибрати знову.
  useSelectedRowRefresh(counterparties, selectedCp?.id, setSelectedCp);

  // підтримка `?action=new` query: Command Palette + N shortcut
  // навігують сюди замість неіснуючого /counterparties/new маршруту.
  useEffect(() => {
    if (searchParams?.get('action') === 'new') {
      setCreating(true);
      router.replace('/counterparties', { scroll: false });
    }
  }, [searchParams, router]);

  // ── Vehicles for selected counterparty (detail panel) ───────────────────────
  const [cpVehicles, setCpVehicles] = useState<
    { id: string; make: string; model: string; year: number | null; licensePlate: string }[]
  >([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  const applyFilter = useCallback(
    (preset: { id: string; filters: CrmFilters }) => {
      setSearch(preset.filters.search ?? '');
      setTypeFilter(preset.filters.typeFilter ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [setShowDeleted, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search, typeFilter, showDeleted });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(t('filters.filterSaved', { name }));
    },
    [saveFilter, search, typeFilter, showDeleted, setActiveSavedFilterId, features.toastEnabled, t],
  );

  const bulkSelect = useBulkSelect(counterparties);

  // `void queryClient.invalidateQueries(...)` по всьому файлу — фонова інвалідація кешу:
  // TanStack сам перезапитує активні queries і сам тримає їхній error-стан (його показує
  // відповідна таблиця / panel). Результат нікому не потрібен, чекати на нього нема де.
  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: t('actions.bulkDelete'),
        variant: 'destructive',
        // (А) Тіло саме звітує про результат (toast / setActionError), а BulkAction.onClick
        // типізований як (ids) => void — тому async-логіка живе у void-IIFE.
        onClick: (ids: string[]) => {
          void (async () => {
            const results = await Promise.allSettled(
              ids.map(id => apiFetch(`/counterparties/${id}`, { method: 'DELETE' })),
            );
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - succeeded;
            bulkSelect.clear();
            void queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
            if (features.toastEnabled) {
              if (succeeded > 0 && failed === 0) {
                toast.success(
                  succeeded === 1
                    ? t('toast.deletedOne', { count: succeeded })
                    : t('toast.deletedMany', { count: succeeded }),
                );
              } else if (succeeded > 0) {
                toast.warning(
                  t('toast.deletedPartial', { succeeded, total: results.length, failed }),
                );
              } else {
                toast.error(t('toast.bulkDeleteNone'));
              }
            } else if (failed > 0) {
              setActionError(
                succeeded > 0
                  ? t('errors.deletedPartial', { succeeded, total: results.length, failed })
                  : t('errors.bulkDeleteNone'),
              );
            }
          })();
        },
      },
    ],
    [bulkSelect, queryClient, features.toastEnabled, t],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedCp || !detailPanel.enabled) {
      setCpVehicles([]);
      return;
    }
    let cancelled = false;
    setVehiclesLoading(true);
    // sto-optimize: bulk /vehicles?counterpartyId=X (join through customerGarage)
    // raніше: garages list → per-garage vehicles fetch (N+1).
    apiFetch<
      {
        id: string;
        make: string;
        model: string;
        year: number | null;
        licensePlate: string;
      }[]
    >(`/vehicles?counterpartyId=${selectedCp.id}`)
      .then(vehicles => {
        if (!cancelled) setCpVehicles(vehicles);
      })
      .catch(() => {
        if (!cancelled) setCpVehicles([]);
      })
      .finally(() => {
        if (!cancelled) setVehiclesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCp?.id, detailPanel.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEdit = (cp: Counterparty) => openCpCard(cp.id);

  const markDeleted = async (id: string) => {
    if (!(await confirm({ title: t('confirm.markForDeletion'), variant: 'destructive' }))) return;
    try {
      await apiFetch(`/counterparties/${id}`, { method: 'DELETE' });
      if (features.toastEnabled) toast.success(t('toast.markedForDeletion'));
      if (selectedCp?.id === id) setSelectedCp(null);
      void queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('errors.deleteFailed');
      if (features.toastEnabled) toast.error(msg);
      else setActionError(msg);
    }
  };

  const displayName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? '—';

  const totalPages = Math.ceil(total / limit);

  const crmPanelConfigFields = schemaToPanelConfigFields(
    COUNTERPARTY_PANEL_SCHEMA,
    panelConfig.config,
  );

  const buildCpTabs = (cp: Counterparty): DetailPanelTab[] => [
    {
      key: 'info',
      label: t('detail.info'),
      content: (
        <div className="space-y-3">
          {buildPanelFields(cp, COUNTERPARTY_PANEL_SCHEMA, panelConfig.config, {
            type: v => (
              <div className="flex flex-wrap gap-1.5">
                <Badge
                  variant={TYPE_BADGE[String(v)] ?? 'secondary'}
                  tooltip={COUNTERPARTY_TYPE_DESCRIPTIONS[String(v)]}
                >
                  {counterpartyTypeLabel(String(v))}
                </Badge>
                {cp.vatPayer && <Badge variant="warning">{t('badges.vat')}</Badge>}
                {cp.deletedAt && <Badge variant="secondary">{t('badges.deleted')}</Badge>}
              </div>
            ),
            balance: v => (
              // WEB-R3-5: тон ЗАЛЕЖИТЬ ВІД ТИПУ (не лише знака): CLIENT balance>0 = борг нам
              // (destructive), не «зелений плюс». Тип-aware helper (узгоджений з BALANCE_SIGN).
              <span
                className={cn(
                  'font-semibold',
                  settlementBalanceToneClass(settlementBalanceTone(Number(v), cp.type)),
                )}
              >
                {fmtMoney(Number(v))} ₴
              </span>
            ),
          }).map(f => (
            <PanelField
              key={f.key}
              fieldKey={f.key}
              label={f.label}
              value={f.value}
              hidden={f.hidden}
            />
          ))}
          {!cp.deletedAt && (
            <div className="pt-1">
              <Button variant="outline" size="sm" className="w-full" onClick={() => openEdit(cp)}>
                {t('common:openCard')}
              </Button>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'vehicles',
      label: t('detail.vehicles'),
      content: vehiclesLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      ) : cpVehicles.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('detail.noVehicles')}</p>
      ) : (
        <div className="space-y-2">
          {cpVehicles.map(v => (
            <div
              key={v.id}
              className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px]"
            >
              <p className="font-medium text-foreground">
                {v.make} {v.model}
              </p>
              <p className="text-muted-foreground text-[12px] mt-0.5">
                {v.year && `${v.year} · `}
                {v.licensePlate || t('detail.noLicensePlate')}
              </p>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <>
      {!modal && queryError && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {queryError instanceof Error ? queryError.message : ''}
        </div>
      )}

      {!modal && actionError && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError('')}
            className="shrink-0 text-destructive/70 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
            aria-label={t('aria.closeMessage')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<CrmFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Filters */}
      <ListToolbar
        list={listPage}
        defaultKeysJson={CRM_COLUMNS_DEFAULT_KEYS_JSON}
        onSaveFilter={handleSaveFilter}
        onAdd={() => setCreating(true)}
        addLabel={t('actions.addCounterparty')}
        searchLabel={t('filters.searchPlaceholder')}
        search={[search, setSearch]}
      >
        <Select
          value={typeFilter}
          onChange={e => changeFilter(() => setTypeFilter(e.target.value))}
          className="w-44 h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          {TYPE_FILTER_OPTIONS.map(([v, labelKey]) => (
            <option key={v} value={v}>
              {t(labelKey)}
            </option>
          ))}
        </Select>
      </ListToolbar>

      <ListTableLayout
        list={listPage}
        bulk={bulkSelect}
        bulkActions={bulkActions}
        panel={
          <DetailPanel
            open={!!selectedCp && detailPanel.enabled}
            onClose={() => setSelectedCp(null)}
            title={selectedCp ? displayName(selectedCp) : ''}
            tabs={selectedCp ? buildCpTabs(selectedCp) : undefined}
            configFields={crmPanelConfigFields}
            onToggleField={panelConfig.toggleField}
            onReset={panelConfig.reset}
          />
        }
      >
        <ListTableHeader
          list={listPage}
          sorting={crmSorting}
          sortKeys={CRM_SORT_KEYS}
          rightAligned={['balance']}
          bulk={bulkSelect}
          selectAllLabel={t('aria.selectAll')}
        />
        <TableBody>
          {loading && <TableLoadingRow colSpan={colSpan} />}
          {!loading && counterparties.length === 0 && (
            <TableRow>
              <TableCell colSpan={colSpan} className="p-0">
                <EmptyState
                  icon={Users}
                  title={t('empty.title')}
                  description={t('empty.description')}
                  size="sm"
                />
              </TableCell>
            </TableRow>
          )}
          {!loading &&
            counterparties.map((cp: Counterparty) => {
              const isDeleted = !!cp.deletedAt;
              return (
                <TableRow
                  key={cp.id}
                  className={cn(
                    'group transition-colors',
                    // Видалений контрагент картки не має — з вимкненою панеллю клік нічого не робить.
                    (detailPanel.enabled || !isDeleted) && 'cursor-pointer',
                    isDeleted && 'opacity-60',
                    selectedCp?.id === cp.id && detailPanel.enabled && 'bg-secondary',
                    bulkSelect.isSelected(cp.id) && 'bg-primary/5',
                  )}
                  // Стандарт списків: панель увімкнена → клік показує/ховає панель;
                  // вимкнена → клік відкриває картку (те саме, що олівець).
                  onClick={() =>
                    activateRow({
                      panelEnabled: detailPanel.enabled,
                      isSelected: selectedCp?.id === cp.id,
                      select: () => setSelectedCp(cp),
                      deselect: () => setSelectedCp(null),
                      open: isDeleted ? undefined : () => openEdit(cp),
                    })
                  }
                >
                  {features.bulkActionsEnabled && (
                    <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={bulkSelect.isSelected(cp.id)}
                        onChange={() => bulkSelect.toggle(cp.id)}
                        className="h-3.5 w-3.5 rounded border-border"
                        aria-label={t('aria.selectRow', { name: displayName(cp) })}
                      />
                    </TableCell>
                  )}
                  {visibleColumns.map(col => {
                    if (col.key === 'name')
                      return (
                        <TableCell key="name">
                          <div className="flex items-center gap-2 flex-wrap">
                            {isDeleted ? (
                              <p className="text-[13px] font-medium text-muted-foreground">
                                {displayName(cp)}
                              </p>
                            ) : (
                              <DocLink
                                href={cpCard.hrefFor(cp.id)}
                                onOpen={() => openEdit(cp)}
                                className="whitespace-normal"
                              >
                                {displayName(cp)}
                              </DocLink>
                            )}
                            {isDeleted && <Badge variant="secondary">{t('badges.deleted')}</Badge>}
                          </div>
                          {cp.email && (
                            <p className="text-[12px] text-muted-foreground mt-0.5">{cp.email}</p>
                          )}
                        </TableCell>
                      );
                    if (col.key === 'type')
                      return (
                        <TableCell key="type">
                          <Badge
                            variant={TYPE_BADGE[cp.type] ?? 'secondary'}
                            tooltip={COUNTERPARTY_TYPE_DESCRIPTIONS[cp.type]}
                          >
                            {counterpartyTypeLabel(cp.type)}
                          </Badge>
                        </TableCell>
                      );
                    if (col.key === 'statuses')
                      return (
                        <TableCell key="statuses">
                          {cp.statuses && cp.statuses.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {cp.statuses.map(s => (
                                <span
                                  key={s.id}
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium text-white"
                                  style={{ backgroundColor: s.color }}
                                >
                                  {s.name}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-[13px]">—</span>
                          )}
                        </TableCell>
                      );
                    if (col.key === 'phone')
                      return (
                        <TableCell key="phone" className="text-muted-foreground text-[13px]">
                          {cp.phone ?? '—'}
                        </TableCell>
                      );
                    if (col.key === 'edrpou')
                      return (
                        <TableCell key="edrpou" className="text-muted-foreground text-[13px]">
                          {cp.edrpou ?? '—'}
                        </TableCell>
                      );
                    if (col.key === 'balance')
                      return (
                        <MoneyCell
                          key="balance"
                          // WEB-R3-5: тип-aware тон (CLIENT balance>0 = борг нам = destructive).
                          className={cn(
                            'font-semibold text-[13px]',
                            settlementBalanceToneClass(settlementBalanceTone(cp.balance, cp.type)),
                          )}
                        >
                          {fmtMoney(cp.balance)} ₴
                        </MoneyCell>
                      );
                    return null;
                  })}
                  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {!isDeleted && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t('actions.edit')}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => openEdit(cp)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {!isDeleted && (
                        <RowDeleteButton
                          title={t('actions.markForDeletion')}
                          onClick={() => void markDeleted(cp.id)}
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </ListTableLayout>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <CounterpartyEditModal
        open={modal}
        counterparty={editingCp}
        onClose={closeCard}
        onSaved={(cp, isNew) => {
          void queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
          if (isNew) {
            // Після створення — лишаємо модалку відкритою в edit-режимі (картка створеного
            // в адресі → з'являються вкладки Авто/Договори). Новий контрагент має нульовий
            // баланс (модалка balance не читає, лише тип потребує).
            queryClient.setQueryData(counterpartiesKeys.detail(cp.id), {
              balance: 0,
              ...cp,
            });
            openCpCard(cp.id);
          } else {
            closeCard();
          }
        }}
      />
      <ConfirmDialog {...dialogProps} />
    </>
  );
}
