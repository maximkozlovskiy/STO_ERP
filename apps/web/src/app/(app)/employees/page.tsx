'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEmployees, employeesKeys } from '@/hooks/api/useEmployees';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Pencil, Users, Trash2, Eye, EyeOff, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  EMPLOYEE_STATUS_BADGE,
  EMPLOYEE_STATUS_DESCRIPTIONS,
  EMPLOYEE_ROLE_BADGE,
  EMPLOYEE_ROLE_DESCRIPTIONS,
} from '@sto/shared';
import { employeeStatusLabel, employeeRoleLabel } from '@/i18n/enumLabel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
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
import {
  DetailPanel,
  PanelField,
  PanelSection,
  type DetailPanelTab,
} from '@/components/ui/detail-panel';
import {
  EMPLOYEE_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { useListPage } from '@/hooks/useListPage';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { Pagination } from '@/components/ui/pagination';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/format';
import { EmployeeEditModal, type EmployeeForModal } from '@/components/ui/EmployeeEditModal';

// ─── Types ───────────────────────────────────────────────

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  phone: string | null;
  deletedAt: string | null;
  rateScheme?: { type: string; params: Record<string, number> };
  zoneIds: string[];
  liftIds: string[];
  workCategoryIds: string[];
  branchIds: string[];
  allBranches: boolean;
  status: 'ACTIVE' | 'ON_LEAVE' | 'FIRED';
  email?: string | null;
  dateOfHire?: string | null;
  dateOfFire?: string | null;
}
interface Zone {
  id: string;
  name: string;
  type: string;
}
interface Lift {
  id: string;
  name: string;
  type: string;
}
interface WorkCategory {
  id: string;
  name: string;
  parentId: string | null;
  children: WorkCategory[];
}
interface Branch {
  id: string;
  name: string;
  address: string;
}

interface EmployeeFilters extends Record<string, unknown> {
  search: string;
  roleFilter: string;
  showDeleted: boolean;
}

// Role/status labels via i18n wrappers; badge constants imported from @sto/shared
const ROLE_BADGE = EMPLOYEE_ROLE_BADGE;
const STATUS_BADGE = EMPLOYEE_STATUS_BADGE;

// Role filter: code list; '' = «Всі посади» (i18n), інші коди рендеряться через employeeRoleLabel().
const ROLE_FILTER_CODES = [
  '',
  'OWNER',
  'ADMIN',
  'RECEPTIONIST',
  'MECHANIC',
  'STOREKEEPER',
  'ACCOUNTANT',
  'XLSX_MANAGER',
] as const;

function CheckboxList({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation('employees');
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="mb-3">
      <label className="block text-[13px] font-medium text-foreground mb-2">{label}</label>
      <div className="border border-border rounded-lg max-h-36 overflow-y-auto divide-y divide-border">
        {items.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">{t('empty.noRecords')}</p>
        )}
        {items.map(item => (
          <label
            key={item.id}
            className="flex items-center gap-2 px-3 py-2 hover:bg-secondary cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={() => toggle(item.id)}
              className="rounded border-border"
            />
            <span className="text-[13px] text-foreground">{item.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function flattenTree(cats: WorkCategory[]): { id: string; name: string }[] {
  return cats.flatMap(c => [{ id: c.id, name: c.name }, ...flattenTree(c.children)]);
}

// Module-level — статичні колонки (label = i18n-ключ, резолвиться у компоненті) +
// прекомпьютений JSON для hasCustomization.
const COLUMN_DEFS: Array<{ key: string; labelKey: string; defaultVisible?: boolean }> = [
  { key: 'name', labelKey: 'columns.name', defaultVisible: true },
  { key: 'role', labelKey: 'columns.role', defaultVisible: true },
  { key: 'status', labelKey: 'columns.status', defaultVisible: true },
  { key: 'rate', labelKey: 'columns.rate', defaultVisible: false },
  { key: 'zones', labelKey: 'columns.zones', defaultVisible: false },
  { key: 'lifts', labelKey: 'columns.lifts', defaultVisible: false },
];
const COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(COLUMN_DEFS.map(c => c.key));

// ─── Main Page ───────────────────────────────────────────

export default function EmployeesPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST']);
  const { t } = useTranslation('employees');
  const { confirm, dialogProps } = useConfirm();

  // Колонки з перекладеними мітками (label = i18n).
  const COLUMNS = useMemo(() => COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })), [t]);
  // Rate-scheme мітки (i18n) — використовуються у таблиці і в detail-панелі.
  const RATE_LABELS = useMemo<Record<string, string>>(
    () => ({
      percent_normo: t('rateScheme.percent_normo'),
      per_normo_hour: t('rateScheme.per_normo_hour'),
      fixed_plus_bonus: t('rateScheme.fixed_plus_bonus'),
    }),
    [t],
  );

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
    limit: LIMIT,
  } = useListPage<EmployeeFilters>('employees', COLUMNS, { defaultLimit: 20 });

  const [zones, setZones] = useState<Zone[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [workCategories, setWorkCategories] = useState<WorkCategory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  // Unified modal state: 'create' = новий, Employee = редагування, null = закрито
  const [modalEmp, setModalEmp] = useState<Employee | 'create' | null>(null);
  const [selectedEmp, setSelectedEmp] = useState<Employee | null>(null);
  const [error, setError] = useState('');
  const [markingId, setMarkingId] = useState<string | null>(null);

  // findAll() ніколи не повертає rateScheme (сек'юріті-фільтр для RECEPTIONIST) —
  // список-рядок employee завжди має rateScheme=undefined. Якщо відкрити модалку
  // редагування прямо на ньому, форма тихо підставляє дефолтну схему
  // (percent_normo/40%) і зберігає її, перезаписуючи реальну зарплатну схему
  // співробітника. Тому перед редагуванням довантажуємо картку через
  // GET /employees/:id, де rateScheme присутній для OWNER/ADMIN.
  const openEditModal = useCallback(async (emp: Employee) => {
    try {
      const full = await apiFetch<Employee>(`/employees/${emp.id}`);
      setModalEmp(full);
    } catch {
      setModalEmp(emp);
    }
  }, []);

  // Filters (specific to employees)
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [roleFilter, setRoleFilter] = useState('');

  const { sort: empSort, toggle: toggleEmpSort } = useSortState('lastName', 'asc');
  const { data, isLoading: loading } = useEmployees({
    q: debouncedSearch || undefined,
    role: roleFilter || undefined,
    showDeleted,
    sortBy: empSort.sortBy,
    sortDir: empSort.sortDir,
    page,
    limit: LIMIT,
  });
  const employees = data?.items ?? (EMPTY_ITEMS as unknown as Employee[]);
  const totalPages = Math.ceil((data?.total ?? 0) / LIMIT);
  const qc = useQueryClient();

  const applyFilter = useCallback(
    (preset: { id: string; filters: EmployeeFilters }) => {
      setSearch(preset.filters.search ?? '');
      setRoleFilter(preset.filters.roleFilter ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [setShowDeleted, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search, roleFilter, showDeleted });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(t('filters.filterSaved', { name }));
    },
    [saveFilter, search, roleFilter, showDeleted, features.toastEnabled, setActiveSavedFilterId, t],
  );

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(employees);

  // `load` is intentionally omitted from deps — it's recreated each render
  // but its effective input (filters from page state) is captured at click time
  // via closure. Including it would invalidate `bulkActions` on every keystroke
  // and re-render BulkBar.
  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: t('actions.bulkDelete'),
        variant: 'destructive',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        onClick: async ids => {
          if (
            !(await confirm({
              title: t('confirm.bulkDelete', { count: ids.length }),
              variant: 'destructive',
            }))
          )
            return;
          await Promise.allSettled(
            ids.map(id => apiFetch<void>(`/employees/${id}`, { method: 'DELETE' })),
          );
          bulkSelect.clear();
          load();
        },
      },
      {
        id: 'fire',
        label: t('actions.bulkFire'),
        variant: 'outline',
        onClick: async ids => {
          if (
            !(await confirm({
              title: t('confirm.bulkFire', { count: ids.length }),
              variant: 'destructive',
            }))
          )
            return;
          await Promise.allSettled(
            ids.map(id =>
              apiFetch<void>(`/employees/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'FIRED' }),
              }),
            ),
          );
          bulkSelect.clear();
          load();
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm, bulkSelect, t],
  );

  const load = () => qc.invalidateQueries({ queryKey: employeesKeys.all });

  const markForDeletion = async (id: string) => {
    if (!(await confirm({ title: t('confirm.markForDeletion'), variant: 'destructive' }))) return;
    setMarkingId(id);
    setError('');
    try {
      await apiFetch<void>(`/employees/${id}`, { method: 'DELETE' });
      // functional setter: `selectedEmp?.id` via captured closure can be stale
      // if user switched rows between confirm and DELETE-result.
      // `prev` is React queue state, not closure.
      setSelectedEmp(prev => (prev?.id === id ? null : prev));
      load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('errors.delete');
      // 404 = запис уже видалений (stale UI або паралельний запит) — оновлюємо список
      // та закриваємо panel якщо він показував цей запис. Дзеркалить infrastructure/page.tsx.
      if (/не знайдено|not found/i.test(msg)) {
        setSelectedEmp(prev => (prev?.id === id ? null : prev));
        load();
      } else {
        setError(msg);
      }
    } finally {
      setMarkingId(null);
    }
  };

  const handleEmployeeSaved = useCallback(() => {
    setModalEmp(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const employeesPanelConfigFields = schemaToPanelConfigFields(
    EMPLOYEE_PANEL_SCHEMA,
    panelConfig.config,
  );

  const buildEmployeeTabs = (emp: Employee): DetailPanelTab[] => [
    {
      key: 'info',
      label: t('panel.tabInfo'),
      content: (
        <div className="space-y-3">
          {buildPanelFields(emp, EMPLOYEE_PANEL_SCHEMA, panelConfig.config, {
            status: v => (
              <Badge
                variant={STATUS_BADGE[String(v)] ?? 'secondary'}
                tooltip={EMPLOYEE_STATUS_DESCRIPTIONS[String(v)]}
              >
                {employeeStatusLabel(String(v))}
              </Badge>
            ),
            role: v => (
              <Badge
                variant={ROLE_BADGE[String(v)] ?? 'secondary'}
                tooltip={EMPLOYEE_ROLE_DESCRIPTIONS[String(v)]}
              >
                {employeeRoleLabel(String(v))}
              </Badge>
            ),
            dateOfHire: v => (v ? fmtDate(String(v)) : undefined),
            dateOfFire: v => (emp.status === 'FIRED' && v ? fmtDate(String(v)) : undefined),
          }).map(f => (
            <PanelField
              key={f.key}
              fieldKey={f.key}
              label={f.label}
              value={f.value}
              hidden={f.hidden}
            />
          ))}
          <PanelField
            label={t('panel.rateScheme')}
            fieldKey="rateScheme"
            hidden={panelConfig.isFieldHidden('rateScheme')}
            value={emp.rateScheme ? RATE_LABELS[emp.rateScheme.type] : undefined}
          />
        </div>
      ),
    },
    {
      key: 'zones',
      label: t('panel.tabZones'),
      content: (
        <div className="space-y-3">
          <PanelSection title={t('panel.zones')}>
            {emp.zoneIds.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('empty.notAssigned')}</p>
            ) : (
              emp.zoneIds.map(id => (
                <p key={id} className="text-[13px] text-foreground">
                  {id}
                </p>
              ))
            )}
          </PanelSection>
          <PanelSection title={t('panel.lifts')}>
            {emp.liftIds.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('empty.notAssigned')}</p>
            ) : (
              emp.liftIds.map(id => (
                <p key={id} className="text-[13px] text-foreground">
                  {id}
                </p>
              ))
            )}
          </PanelSection>
        </div>
      ),
    },
  ];

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('title')}</h1>
        </div>
      </div>

      {modalEmp === null && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<EmployeeFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Filters */}
      <div className="flex gap-3 shrink-0 flex-wrap">
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          placeholder={t('filters.searchPlaceholder')}
          leftElement={<Search />}
          className="flex-1 min-w-48 h-8 text-[13px]"
        />
        <Select
          value={roleFilter}
          onChange={e => {
            setRoleFilter(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          className="w-48 h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          {ROLE_FILTER_CODES.map(code => (
            <option key={code} value={code}>
              {code === '' ? t('filters.allRoles') : employeeRoleLabel(code)}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? t('filters.hideDeleted') : t('filters.showDeleted')}
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
              JSON.stringify(order) !== COLUMNS_DEFAULT_KEYS_JSON ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button onClick={() => setModalEmp('create')} leftIcon={<Plus className="h-4 w-4" />}>
            {t('addButton')}
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
        <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
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
                      aria-label={t('aria.selectAll')}
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col =>
                  col.key === 'name' ? (
                    <SortableHead
                      key={col.key}
                      sortKey="lastName"
                      currentSort={empSort}
                      onSort={toggleEmpSort}
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
                    className="py-10 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && employees.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState
                      icon={Users}
                      title={t('empty.title')}
                      description={t('empty.description')}
                    />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                employees.map(emp => {
                  const isDeleted = !!emp.deletedAt;
                  const isMarking = markingId === emp.id;
                  return (
                    <TableRow
                      key={emp.id}
                      className={cn(
                        'group transition-colors',
                        isDeleted && 'opacity-60',
                        detailPanel.enabled && 'cursor-pointer',
                        selectedEmp?.id === emp.id && detailPanel.enabled && 'bg-secondary',
                        bulkSelect.isSelected(emp.id) && 'bg-primary/5',
                      )}
                      onClick={() => {
                        if (detailPanel.enabled)
                          setSelectedEmp(prev => (prev?.id === emp.id ? null : emp));
                      }}
                    >
                      {features.bulkActionsEnabled && (
                        <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={bulkSelect.isSelected(emp.id)}
                            onChange={() => bulkSelect.toggle(emp.id)}
                            className="h-3.5 w-3.5 rounded border-border"
                            aria-label={t('aria.selectRow', {
                              name: `${emp.lastName} ${emp.firstName}`,
                            })}
                          />
                        </TableCell>
                      )}
                      {visibleColumns.map(col => {
                        if (col.key === 'name')
                          return (
                            <TableCell key="name">
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] font-medium text-foreground">
                                  {emp.lastName} {emp.firstName}
                                </span>
                                {isDeleted && (
                                  <Badge variant="secondary">{t('badge.deleted')}</Badge>
                                )}
                              </div>
                              {emp.phone && (
                                <p className="text-[12px] text-muted-foreground mt-0.5">
                                  {emp.phone}
                                </p>
                              )}
                            </TableCell>
                          );
                        if (col.key === 'role')
                          return (
                            <TableCell key="role">
                              <Badge
                                variant={ROLE_BADGE[emp.role] ?? 'secondary'}
                                tooltip={EMPLOYEE_ROLE_DESCRIPTIONS[emp.role]}
                              >
                                {employeeRoleLabel(emp.role)}
                              </Badge>
                            </TableCell>
                          );
                        if (col.key === 'status')
                          return (
                            <TableCell key="status">
                              <Badge
                                variant={STATUS_BADGE[emp.status] ?? 'secondary'}
                                tooltip={EMPLOYEE_STATUS_DESCRIPTIONS[emp.status]}
                              >
                                {employeeStatusLabel(emp.status)}
                              </Badge>
                            </TableCell>
                          );
                        if (col.key === 'rate')
                          return (
                            <TableCell key="rate" className="text-muted-foreground">
                              {emp.rateScheme ? (
                                (RATE_LABELS[emp.rateScheme.type] ?? emp.rateScheme.type) +
                                (emp.rateScheme.type === 'percent_normo'
                                  ? ` ${emp.rateScheme.params.percent}%`
                                  : '')
                              ) : (
                                <span className="text-foreground-faint">—</span>
                              )}
                            </TableCell>
                          );
                        if (col.key === 'zones')
                          return (
                            <TableCell key="zones" className="text-muted-foreground">
                              {emp.zoneIds.length > 0 ? (
                                emp.zoneIds
                                  .map(id => zones.find(z => z.id === id)?.name ?? id)
                                  .join(', ')
                              ) : (
                                <span className="text-foreground-faint">—</span>
                              )}
                            </TableCell>
                          );
                        if (col.key === 'lifts')
                          return (
                            <TableCell key="lifts" className="text-muted-foreground">
                              {emp.liftIds.length > 0 ? (
                                emp.liftIds
                                  .map(id => lifts.find(l => l.id === id)?.name ?? id)
                                  .join(', ')
                              ) : (
                                <span className="text-foreground-faint">—</span>
                              )}
                            </TableCell>
                          );
                        return null;
                      })}
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('actions.edit')}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => void openEditModal(emp)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            title={t('actions.markForDeletion')}
                            disabled={isMarking || !!markingId || isDeleted}
                            onClick={() => markForDeletion(emp.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedEmp && detailPanel.enabled}
          onClose={() => setSelectedEmp(null)}
          title={selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : ''}
          subtitle={selectedEmp ? employeeRoleLabel(selectedEmp.role) : ''}
          tabs={selectedEmp ? buildEmployeeTabs(selectedEmp) : undefined}
          configFields={employeesPanelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReset={panelConfig.reset}
        />
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <EmployeeEditModal
        open={modalEmp !== null}
        employee={modalEmp === 'create' || modalEmp === null ? null : modalEmp}
        onClose={() => setModalEmp(null)}
        onSaved={handleEmployeeSaved}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
