'use client';

import { useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Search, Users, Eye, EyeOff, Trash2, Pencil } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { useCounterparties, counterpartiesKeys, Counterparty } from '@/hooks/api/useCounterparties';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import {
  COUNTERPARTY_TYPE_LABELS,
  COUNTERPARTY_TYPE_BADGE,
  COUNTERPARTY_TYPE_DESCRIPTIONS,
} from '@sto/shared';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortableHead,
  TableCell,
} from '@/components/ui/table';
import { useSortState } from '@/hooks/useSortState';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { TableContainer } from '@/components/ui/table-container';
import {
  COUNTERPARTY_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useListPage } from '@/hooks/useListPage';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { cn } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';

interface CrmFilters extends Record<string, unknown> {
  search: string;
  typeFilter: string;
  showDeleted: boolean;
}

const TYPE_LABELS = COUNTERPARTY_TYPE_LABELS;
const TYPE_BADGE = COUNTERPARTY_TYPE_BADGE;
const TYPE_FILTER_OPTIONS = [
  ['', 'Всі'],
  ['CLIENT', 'Клієнти'],
  ['SUPPLIER', 'Постачальники'],
  ['BOTH', 'Обидва'],
] as const;

// Module-level — статичні колонки + прекомпьютений JSON для hasCustomization.
const CRM_COLUMNS: Array<{ key: string; label: string; defaultVisible?: boolean }> = [
  { key: 'name', label: 'Контрагент', defaultVisible: true },
  { key: 'type', label: 'Тип', defaultVisible: true },
  { key: 'phone', label: 'Телефон', defaultVisible: true },
  { key: 'edrpou', label: 'ЄДРПОУ', defaultVisible: false },
  { key: 'balance', label: 'Баланс, ₴', defaultVisible: true },
];
const CRM_COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(CRM_COLUMNS.map(c => c.key));

// Suspense обгортка для useSearchParams — Next.js static-export вимога.
export default function CrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmPageInner />
    </Suspense>
  );
}

function CrmPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const { confirm, dialogProps } = useConfirm();

  // useListPage: shared table/panel/filter infrastructure
  const {
    page,
    setPage,
    resetPage,
    showDeleted,
    setShowDeleted,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns: {
      visibleKeys: colVisible,
      visibleColumns,
      orderedColumns,
      order,
      customLabels,
      toggle: toggleCol,
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    detailPanel,
    panelConfig,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<CrmFilters>('crm', CRM_COLUMNS, { defaultLimit: 20 });

  // Local filter state (specific to counterparties)
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [typeFilter, setTypeFilter] = useState('');

  const { sort: crmSort, toggle: toggleCrmSort } = useSortState('lastName', 'asc');
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

  // Modal state
  const [modal, setModal] = useState(false);
  const [editingCp, setEditingCp] = useState<Counterparty | null>(null);
  const [selectedCp, setSelectedCp] = useState<Counterparty | null>(null);

  // підтримка `?action=new` query: Command Palette + N shortcut
  // навігують сюди замість неіснуючого /counterparties/new маршруту.
  useEffect(() => {
    if (searchParams?.get('action') === 'new') {
      setEditingCp(null);
      setModal(true);
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
      toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, search, typeFilter, showDeleted, setActiveSavedFilterId],
  );

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(counterparties);

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибраних',
        variant: 'destructive',
        onClick: async (ids: string[]) => {
          const results = await Promise.allSettled(
            ids.map(id => apiFetch(`/counterparties/${id}`, { method: 'DELETE' })),
          );
          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          const failed = results.length - succeeded;
          bulkSelect.clear();
          queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
          if (succeeded > 0 && failed === 0) {
            toast.success(`Видалено ${succeeded} контрагент${succeeded === 1 ? 'а' : 'ів'}`);
          } else if (succeeded > 0) {
            toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
          } else {
            toast.error('Не вдалося видалити контрагентів');
          }
        },
      },
    ],
    [bulkSelect, queryClient],
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

  const openEdit = (cp: Counterparty) => {
    setEditingCp(cp);
    setModal(true);
  };

  const markDeleted = async (id: string) => {
    if (!(await confirm({ title: 'Позначити контрагента на видалення?', variant: 'destructive' })))
      return;
    try {
      await apiFetch(`/counterparties/${id}`, { method: 'DELETE' });
      toast.success('Контрагента позначено на видалення');
      if (selectedCp?.id === id) setSelectedCp(null);
      queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
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
      label: 'Основне',
      content: (
        <div className="space-y-3">
          {buildPanelFields(cp, COUNTERPARTY_PANEL_SCHEMA, panelConfig.config, {
            type: v => (
              <div className="flex flex-wrap gap-1.5">
                <Badge
                  variant={TYPE_BADGE[String(v)] ?? 'secondary'}
                  tooltip={COUNTERPARTY_TYPE_DESCRIPTIONS[String(v)]}
                >
                  {TYPE_LABELS[String(v)]}
                </Badge>
                {cp.vatPayer && <Badge variant="warning">ПДВ</Badge>}
                {cp.deletedAt && <Badge variant="secondary">видалено</Badge>}
              </div>
            ),
            balance: v => (
              <span
                className={cn(
                  'font-semibold',
                  Number(v) < 0
                    ? 'text-destructive-text'
                    : Number(v) > 0
                      ? 'text-success-text'
                      : 'text-muted-foreground',
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
        </div>
      ),
    },
    {
      key: 'vehicles',
      label: 'Авто',
      content: vehiclesLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      ) : cpVehicles.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Авто не додано</p>
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
                {v.licensePlate || 'без держномера'}
              </p>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Контрагенти</h1>
        </div>
      </div>

      {!modal && queryError && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {queryError instanceof Error ? queryError.message : ''}
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
      <div className="flex gap-3 flex-wrap shrink-0">
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за ім'ям, телефоном, ЄДРПОУ..."
          leftElement={<Search />}
          className="flex-1 min-w-48 h-8 text-[13px]"
        />
        <Select
          value={typeFilter}
          onChange={e => {
            setTypeFilter(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          className="w-44 h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          {TYPE_FILTER_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(d => !d);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            className={showDeleted ? 'border-primary text-primary' : ''}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={orderedColumns}
            visibleKeys={colVisible}
            onToggle={toggleCol}
            onReorder={reorder}
            onRename={renameColumn}
            onReset={resetConfig}
            hasCustomization={
              JSON.stringify(order) !== CRM_COLUMNS_DEFAULT_KEYS_JSON ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => {
              setEditingCp(null);
              setModal(true);
            }}
          >
            Контрагент
          </Button>
        </div>
      </div>

      {/* Bulk actions */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions}
          onClear={bulkSelect.clear}
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex flex-1 min-h-0">
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                {features.bulkActionsEnabled && (
                  <TableHead className="w-9 pr-0">
                    <input
                      type="checkbox"
                      checked={bulkSelect.allSelected}
                      ref={selectAllRef}
                      onChange={bulkSelect.toggleAll}
                      className="h-3.5 w-3.5 rounded border-border"
                      aria-label="Вибрати всіх"
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col =>
                  col.key === 'name' || col.key === 'balance' ? (
                    <SortableHead
                      key={col.key}
                      sortKey={col.key === 'name' ? 'lastName' : 'balance'}
                      currentSort={crmSort}
                      onSort={toggleCrmSort}
                      {...dragProps(col.key)}
                    >
                      {col.label}
                    </SortableHead>
                  ) : (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ),
                )}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="py-12 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && counterparties.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState
                      icon={Users}
                      title="Нічого не знайдено"
                      description="Спробуйте змінити параметри пошуку"
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
                        detailPanel.enabled && 'cursor-pointer',
                        isDeleted && 'opacity-60',
                        selectedCp?.id === cp.id && detailPanel.enabled && 'bg-secondary',
                        bulkSelect.isSelected(cp.id) && 'bg-primary/5',
                      )}
                      onClick={() => {
                        if (detailPanel.enabled)
                          setSelectedCp(prev => (prev?.id === cp.id ? null : cp));
                      }}
                    >
                      {features.bulkActionsEnabled && (
                        <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={bulkSelect.isSelected(cp.id)}
                            onChange={() => bulkSelect.toggle(cp.id)}
                            className="h-3.5 w-3.5 rounded border-border"
                            aria-label={`Вибрати ${displayName(cp)}`}
                          />
                        </TableCell>
                      )}
                      {visibleColumns.map(col => {
                        if (col.key === 'name')
                          return (
                            <TableCell key="name">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-[13px] font-medium text-primary">
                                  {displayName(cp)}
                                </p>
                                {isDeleted && <Badge variant="secondary">видалено</Badge>}
                              </div>
                              {cp.email && (
                                <p className="text-[12px] text-muted-foreground mt-0.5">
                                  {cp.email}
                                </p>
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
                                {TYPE_LABELS[cp.type]}
                              </Badge>
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
                            <TableCell
                              key="balance"
                              className={cn(
                                'font-semibold tabular-nums text-[13px]',
                                cp.balance < 0
                                  ? 'text-destructive-text'
                                  : cp.balance > 0
                                    ? 'text-success-text'
                                    : 'text-muted-foreground',
                              )}
                            >
                              {fmtMoney(cp.balance)} ₴
                            </TableCell>
                          );
                        return null;
                      })}
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {!isDeleted && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Редагувати"
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => openEdit(cp)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {!isDeleted && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                              title="Позначити на видалення"
                              onClick={() => markDeleted(cp.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </TableContainer>

        <DetailPanel
          open={!!selectedCp && detailPanel.enabled}
          onClose={() => setSelectedCp(null)}
          title={selectedCp ? displayName(selectedCp) : ''}
          tabs={selectedCp ? buildCpTabs(selectedCp) : undefined}
          configFields={crmPanelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReset={panelConfig.reset}
        />
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <CounterpartyEditModal
        open={modal}
        counterparty={editingCp}
        onClose={() => {
          setModal(false);
          setEditingCp(null);
        }}
        onSaved={(cp, isNew) => {
          queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
          if (isNew) {
            // Після створення — лишаємо модалку відкритою в edit-режимі (передаємо
            // створеного як editingCp → з'являються вкладки Авто/Договори). Новий
            // контрагент має нульовий баланс (модалка balance не читає, лише тип потребує).
            setEditingCp({ balance: 0, ...cp } as Counterparty);
          } else {
            setModal(false);
            setEditingCp(null);
          }
        }}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
