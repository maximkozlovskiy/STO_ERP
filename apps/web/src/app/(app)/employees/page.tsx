'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEmployees, employeesKeys } from '@/hooks/api/useEmployees';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Pencil, Users, Trash2, Eye, EyeOff, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  DetailPanel,
  PanelField,
  PanelSection,
  type DetailPanelTab,
} from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { ModalTabs } from '@/components/ui/modal-tabs';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/format';

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

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник',
  ADMIN: 'Адміністратор',
  RECEPTIONIST: 'Приймальник',
  MECHANIC: 'Механік',
  STOREKEEPER: 'Комірник',
  ACCOUNTANT: 'Бухгалтер',
  CLIENT: 'Клієнт',
  XLSX_MANAGER: 'Менеджер імпорту',
};
const ROLE_BADGE: Record<string, BadgeVariant> = {
  OWNER: 'destructive',
  ADMIN: 'default',
  RECEPTIONIST: 'secondary',
  MECHANIC: 'warning',
  STOREKEEPER: 'secondary',
  ACCOUNTANT: 'secondary',
  CLIENT: 'secondary',
  XLSX_MANAGER: 'secondary',
};
const RATE_LABELS: Record<string, string> = {
  percent_normo: '% від норма-год',
  fixed_plus_bonus: 'Ставка + бонус',
};
const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активний',
  ON_LEAVE: 'У відпустці',
  FIRED: 'Звільнений',
};
const STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  FIRED: 'secondary',
};

const ROLE_FILTER_OPTIONS: [string, string][] = [
  ['', 'Всі посади'],
  ['OWNER', 'Власник'],
  ['ADMIN', 'Адміністратор'],
  ['RECEPTIONIST', 'Приймальник'],
  ['MECHANIC', 'Механік'],
  ['STOREKEEPER', 'Комірник'],
  ['ACCOUNTANT', 'Бухгалтер'],
  ['XLSX_MANAGER', 'Менеджер імпорту'],
];

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
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="mb-3">
      <label className="block text-[13px] font-medium text-foreground mb-2">{label}</label>
      <div className="border border-border rounded-lg max-h-36 overflow-y-auto divide-y divide-border">
        {items.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">Немає записів</p>
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

// ─── Main Page ───────────────────────────────────────────

export default function EmployeesPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST']);
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const detailPanel = useDetailPanel('employees');
  const panelConfig = useDetailPanelConfig('employees');

  const COLUMNS = useMemo(
    () => [
      { key: 'name', label: 'ПІБ', defaultVisible: true },
      { key: 'role', label: 'Посада', defaultVisible: true },
      { key: 'status', label: 'Статус', defaultVisible: true },
      { key: 'rate', label: 'Схема нарахування', defaultVisible: false },
      { key: 'zones', label: 'Зони', defaultVisible: false },
      { key: 'lifts', label: 'Підйомники', defaultVisible: false },
    ],
    [],
  );

  const {
    visibleKeys: colVisible,
    visibleColumns,
    orderedColumns,
    order,
    customLabels,
    toggle: toggleCol,
    reorder,
    renameColumn,
    resetConfig,
  } = useTableColumns('employees', COLUMNS);
  const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);

  const [zones, setZones] = useState<Zone[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [workCategories, setWorkCategories] = useState<WorkCategory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  const [modal, setModal] = useState<'create' | 'card' | 'edit' | null>(null);
  const [editEmp, setEditEmp] = useState<Employee | null>(null);
  const [editForm, setEditForm] = useState({
    firstName: '',
    lastName: '',
    role: 'MECHANIC',
    phone: '',
    email: '',
    status: 'ACTIVE',
    dateOfHire: '',
    dateOfFire: '',
    rateType: 'percent_normo',
    percent: '40',
    fixedMonthly: '0',
    bonusPercent: '10',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [selected, setSelected] = useState<Employee | null>(null);
  const [selectedEmp, setSelectedEmp] = useState<Employee | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [roleFilter, setRoleFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  const { data: employees = [], isLoading: loading } = useEmployees({
    q: debouncedSearch || undefined,
    role: roleFilter || undefined,
    showDeleted,
  });
  const qc = useQueryClient();

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    role: 'MECHANIC',
    phone: '',
    email: '',
    status: 'ACTIVE',
    dateOfHire: '',
    rateType: 'percent_normo',
    percent: '40',
    fixedMonthly: '0',
    bonusPercent: '10',
  });

  const [assignedZones, setAssignedZones] = useState<string[]>([]);
  const [assignedLifts, setAssignedLifts] = useState<string[]>([]);
  const [assignedCats, setAssignedCats] = useState<string[]>([]);
  const [assignedBranches, setAssignedBranches] = useState<string[]>([]);
  const [allBranches, setAllBranches] = useState(false);

  // Edit modal assignment state
  const [editZoneIds, setEditZoneIds] = useState<string[]>([]);
  const [editLiftIds, setEditLiftIds] = useState<string[]>([]);
  const [editWorkCatIds, setEditWorkCatIds] = useState<string[]>([]);
  const [editBranchIds, setEditBranchIds] = useState<string[]>([]);
  const [editAllBranches, setEditAllBranches] = useState(false);

  // ─── Saved filters ────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<EmployeeFilters>('employees');

  const applyFilter = useCallback((preset: { id: string; filters: EmployeeFilters }) => {
    setSearch(preset.filters.search ?? '');
    setRoleFilter(preset.filters.roleFilter ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search, roleFilter, showDeleted });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, search, roleFilter, showDeleted, features.toastEnabled],
  );

  // ─── Bulk select ──────────────────────────────────────
  const bulkSelect = useBulkSelect(employees);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  // `load` is intentionally omitted from deps — it's recreated each render
  // but its effective input (filters from page state) is captured at click time
  // via closure. Including it would invalidate `bulkActions` on every keystroke
  // and re-render BulkBar.
  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибраних',
        variant: 'destructive',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        onClick: async ids => {
          if (
            !(await confirm({
              title: `Помітити ${ids.length} співробітників на видалення?`,
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
        label: 'Звільнити вибраних',
        variant: 'outline',
        onClick: async ids => {
          if (
            !(await confirm({
              title: `Змінити статус ${ids.length} співробітників на "Звільнений"?`,
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
    [confirm, bulkSelect],
  );

  // ─── Unsaved guard — create modal ────────────────────
  const createDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // ─── Unsaved guard — edit modal ───────────────────────
  const editDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // Only the employee list depends on filters — reference data (zones, lifts,
  const load = () => qc.invalidateQueries({ queryKey: employeesKeys.all });

  // Reference data — paint instantly from sessionStorage, then refresh in
  // parallel. Runs once on mount, independent of list filters.
  const loadReference = () => {
    const cZones = getCached<Zone[]>('cache:zones');
    const cLifts = getCached<Lift[]>('cache:lifts');
    const cCats = getCached<WorkCategory[]>('cache:work-categories');
    const cBranches = getCached<Branch[]>('cache:branches');
    if (cZones) setZones(cZones);
    if (cLifts) setLifts(cLifts);
    if (cCats) setWorkCategories(cCats);
    if (cBranches) setBranches(cBranches);
    Promise.all([
      apiFetch<Zone[]>('/zones').then(d => {
        setZones(d);
        setCache('cache:zones', d);
      }),
      apiFetch<Lift[]>('/lifts').then(d => {
        setLifts(d);
        setCache('cache:lifts', d);
      }),
      apiFetch<WorkCategory[]>('/work-categories').then(d => {
        setWorkCategories(d);
        setCache('cache:work-categories', d);
      }),
      // `/branches` returns a plain `BranchResponseDto[]` (BranchesController.findAll), NOT a
      // paginated `{ items, total }` envelope. Treating it as `{ items }` resulted in `r.items`
      // being undefined and the branches multi-select staying empty — blocking B10 entirely.
      apiFetch<Branch[]>('/branches').then(d => {
        setBranches(d);
        setCache('cache:branches', d);
      }),
    ]).catch(() => {
      /* reference data is non-blocking; list still renders */
    });
  };

  useEffect(() => {
    loadReference();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCard = (emp: Employee) => {
    setSelected(emp);
    setAssignedZones(emp.zoneIds);
    setAssignedLifts(emp.liftIds);
    setAssignedCats(emp.workCategoryIds);
    setAssignedBranches(emp.branchIds ?? []);
    setAllBranches(emp.allBranches ?? false);
    setError('');
    setModal('card');
  };

  const openCreate = () => {
    setForm({
      firstName: '',
      lastName: '',
      role: 'MECHANIC',
      phone: '',
      email: '',
      status: 'ACTIVE',
      dateOfHire: '',
      rateType: 'percent_normo',
      percent: '40',
      fixedMonthly: '0',
      bonusPercent: '10',
    });
    setError('');
    createDirty.resetDirty();
    setModal('create');
  };

  const closeModal = async () => {
    if (modal === 'create') {
      if (!(await createDirty.confirmClose())) return;
    }
    setModal(null);
    setSelected(null);
    setError('');
  };

  const buildRateScheme = () => {
    if (form.rateType === 'percent_normo') {
      return { type: 'percent_normo', params: { percent: Number(form.percent) } };
    }
    return {
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: Number(form.fixedMonthly), bonusPercent: Number(form.bonusPercent) },
    };
  };

  const create = async () => {
    if (form.rateType === 'percent_normo') {
      const pct = Number(form.percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        setError('Відсоток має бути від 1 до 100');
        return;
      }
    } else {
      const fixed = Number(form.fixedMonthly);
      const bonus = Number(form.bonusPercent);
      if (!Number.isFinite(fixed) || fixed < 0) {
        setError("Фіксована ставка повинна бути невід'ємним числом");
        return;
      }
      if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) {
        setError('Бонус має бути від 0 до 100');
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch<Employee>('/employees', {
        method: 'POST',
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          role: form.role,
          phone: form.phone || undefined,
          email: form.email || undefined,
          status: form.status || 'ACTIVE',
          dateOfHire: form.dateOfHire || undefined,
          rateScheme: buildRateScheme(),
        }),
      });
      createDirty.resetDirty();
      setModal(null);
      setSelected(null);
      setError('');
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const saveAssignments = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await Promise.all([
        apiFetch<void>(`/employees/${selected.id}/zones`, {
          method: 'POST',
          body: JSON.stringify({ zoneIds: assignedZones }),
        }),
        apiFetch<void>(`/employees/${selected.id}/lifts`, {
          method: 'POST',
          body: JSON.stringify({ liftIds: assignedLifts }),
        }),
        apiFetch<void>(`/employees/${selected.id}/work-categories`, {
          method: 'POST',
          body: JSON.stringify({ workCategoryIds: assignedCats }),
        }),
        apiFetch<void>(`/employees/${selected.id}/branches`, {
          method: 'POST',
          body: JSON.stringify({ branchIds: allBranches ? [] : assignedBranches, allBranches }),
        }),
      ]);
      setModal(null);
      setSelected(null);
      setError('');
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const markForDeletion = async (id: string) => {
    if (!(await confirm({ title: 'Помітити співробітника на видалення?', variant: 'destructive' })))
      return;
    setMarkingId(id);
    setError('');
    try {
      await apiFetch<void>(`/employees/${id}`, { method: 'DELETE' });
      if (selectedEmp?.id === id) setSelectedEmp(null);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setMarkingId(null);
    }
  };

  const openEditEmp = (emp: Employee) => {
    setEditEmp(emp);
    const rs = emp.rateScheme;
    setEditForm({
      firstName: emp.firstName,
      lastName: emp.lastName,
      role: emp.role,
      phone: emp.phone ?? '',
      email: emp.email ?? '',
      status: emp.status,
      dateOfHire: emp.dateOfHire ? emp.dateOfHire.slice(0, 10) : '',
      dateOfFire: emp.dateOfFire ? emp.dateOfFire.slice(0, 10) : '',
      rateType: rs?.type ?? 'percent_normo',
      percent: rs?.type === 'percent_normo' ? String(rs.params.percent ?? 40) : '40',
      fixedMonthly: rs?.type === 'fixed_plus_bonus' ? String(rs.params.fixedMonthly ?? 0) : '0',
      bonusPercent: rs?.type === 'fixed_plus_bonus' ? String(rs.params.bonusPercent ?? 10) : '10',
    });
    setEditZoneIds(emp.zoneIds ?? []);
    setEditLiftIds(emp.liftIds ?? []);
    setEditWorkCatIds(emp.workCategoryIds ?? []);
    setEditBranchIds(emp.branchIds ?? []);
    setEditAllBranches(emp.allBranches ?? false);
    setEditError('');
    editDirty.resetDirty();
    setModal('edit');
  };

  const closeEditModal = async () => {
    if (!(await editDirty.confirmClose())) return;
    setModal(null);
    setEditEmp(null);
  };

  const saveEditEmp = async () => {
    if (!editEmp) return;
    setEditSaving(true);
    setEditError('');
    let rateScheme;
    if (editForm.rateType === 'percent_normo') {
      const pct = Number(editForm.percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        setEditError('Відсоток має бути від 1 до 100');
        setEditSaving(false);
        return;
      }
      rateScheme = { type: 'percent_normo', params: { percent: pct } };
    } else {
      const fixed = Number(editForm.fixedMonthly);
      const bonus = Number(editForm.bonusPercent);
      if (!Number.isFinite(fixed) || fixed < 0) {
        setEditError("Фіксована ставка повинна бути невід'ємним числом");
        setEditSaving(false);
        return;
      }
      if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) {
        setEditError('Бонус має бути від 0 до 100');
        setEditSaving(false);
        return;
      }
      rateScheme = {
        type: 'fixed_plus_bonus',
        params: { fixedMonthly: fixed, bonusPercent: bonus },
      };
    }
    try {
      await apiFetch<Employee>(`/employees/${editEmp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: editForm.firstName,
          lastName: editForm.lastName,
          role: editForm.role,
          phone: editForm.phone || undefined,
          email: editForm.email || undefined,
          status: editForm.status,
          dateOfHire: editForm.dateOfHire || undefined,
          dateOfFire: editForm.dateOfFire || undefined,
          rateScheme,
        }),
      });
      // Save all assignments in parallel
      await Promise.all([
        apiFetch<void>(`/employees/${editEmp.id}/branches`, {
          method: 'POST',
          body: JSON.stringify({
            branchIds: editAllBranches ? [] : editBranchIds,
            allBranches: editAllBranches,
          }),
        }),
        apiFetch<void>(`/employees/${editEmp.id}/zones`, {
          method: 'POST',
          body: JSON.stringify({ zoneIds: editZoneIds }),
        }),
        apiFetch<void>(`/employees/${editEmp.id}/lifts`, {
          method: 'POST',
          body: JSON.stringify({ liftIds: editLiftIds }),
        }),
        apiFetch<void>(`/employees/${editEmp.id}/work-categories`, {
          method: 'POST',
          body: JSON.stringify({ workCategoryIds: editWorkCatIds }),
        }),
      ]);
      editDirty.resetDirty();
      setModal(null);
      setEditEmp(null);
      load();
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setEditSaving(false);
    }
  };

  const flatCats = flattenTree(workCategories);

  const EMP_CONFIG_FIELD_DEFS = [
    { key: 'status', label: 'Статус' },
    { key: 'role', label: 'Посада' },
    { key: 'phone', label: 'Телефон' },
    { key: 'email', label: 'Email' },
    { key: 'rateScheme', label: 'Схема нарахування' },
    { key: 'dateOfHire', label: 'Дата прийняття' },
  ] as const;

  const employeesPanelConfigFields = EMP_CONFIG_FIELD_DEFS.map(f => ({
    ...f,
    hidden: panelConfig.isFieldHidden(f.key),
  }));

  const buildEmployeeTabs = (emp: Employee): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          <PanelField
            label="Статус"
            fieldKey="status"
            hidden={panelConfig.isFieldHidden('status')}
            value={<Badge variant={STATUS_BADGE[emp.status]}>{STATUS_LABELS[emp.status]}</Badge>}
          />
          <PanelField
            label="Посада"
            fieldKey="role"
            hidden={panelConfig.isFieldHidden('role')}
            value={ROLE_LABELS[emp.role]}
          />
          <PanelField
            label="Телефон"
            fieldKey="phone"
            hidden={panelConfig.isFieldHidden('phone')}
            value={emp.phone}
          />
          <PanelField
            label="Email"
            fieldKey="email"
            hidden={panelConfig.isFieldHidden('email')}
            value={emp.email}
          />
          <PanelField
            label="Схема нарахування"
            fieldKey="rateScheme"
            hidden={panelConfig.isFieldHidden('rateScheme')}
            value={emp.rateScheme ? RATE_LABELS[emp.rateScheme.type] : undefined}
          />
          <PanelField
            label="Дата прийняття"
            fieldKey="dateOfHire"
            hidden={panelConfig.isFieldHidden('dateOfHire')}
            value={emp.dateOfHire ? fmtDate(emp.dateOfHire) : undefined}
          />
          {emp.status === 'FIRED' && emp.dateOfFire && (
            <PanelField label="Дата звільнення" value={fmtDate(emp.dateOfFire)} />
          )}
        </div>
      ),
    },
    {
      key: 'zones',
      label: 'Зони/Підйомники',
      content: (
        <div className="space-y-3">
          <PanelSection title="Зони">
            {emp.zoneIds.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Не призначено</p>
            ) : (
              emp.zoneIds.map(id => (
                <p key={id} className="text-[13px] text-foreground">
                  {id}
                </p>
              ))
            )}
          </PanelSection>
          <PanelSection title="Підйомники">
            {emp.liftIds.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Не призначено</p>
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
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Співробітники</h1>
          <p className="page-subtitle">{employees.length} записів</p>
        </div>
      </div>

      {!modal && error && (
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
          className="mb-3"
          hideSaveButton
        />
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за ім'ям..."
          leftElement={<Search />}
          className="flex-1 min-w-48"
        />
        <Select
          value={roleFilter}
          onChange={e => {
            setRoleFilter(e.target.value);
            setActiveSavedFilterId(null);
          }}
          className="w-48"
        >
          {ROLE_FILTER_OPTIONS.map(([v, l]) => (
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
              JSON.stringify(order) !== JSON.stringify(COLUMNS.map(c => c.key)) ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button onClick={openCreate} leftIcon={<Plus className="h-4 w-4" />}>
            Співробітник
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
          className="mb-3"
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
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
                      aria-label="Вибрати всі"
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col => (
                  <TableHead key={col.key} {...dragProps(col.key)}>
                    {col.label}
                  </TableHead>
                ))}
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
                      title="Немає співробітників"
                      description="Додайте першого співробітника"
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
                        'transition-colors',
                        isDeleted && 'opacity-60',
                        detailPanel.enabled && 'cursor-pointer',
                        selectedEmp?.id === emp.id && 'bg-secondary',
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
                            aria-label={`Вибрати ${emp.lastName} ${emp.firstName}`}
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
                                {isDeleted && <Badge variant="secondary">видалено</Badge>}
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
                              <Badge variant={ROLE_BADGE[emp.role] ?? 'secondary'}>
                                {ROLE_LABELS[emp.role] ?? emp.role}
                              </Badge>
                            </TableCell>
                          );
                        if (col.key === 'status')
                          return (
                            <TableCell key="status">
                              <Badge variant={STATUS_BADGE[emp.status] ?? 'secondary'}>
                                {STATUS_LABELS[emp.status] ?? emp.status}
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
                            title="Редагувати"
                            onClick={() => openEditEmp(emp)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            title="Помітити на видалення"
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
          open={!!selectedEmp}
          onClose={() => setSelectedEmp(null)}
          title={selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : ''}
          subtitle={selectedEmp ? ROLE_LABELS[selectedEmp.role] : ''}
          tabs={selectedEmp ? buildEmployeeTabs(selectedEmp) : undefined}
          configFields={employeesPanelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReset={panelConfig.reset}
        />
      </div>

      {/* Create modal */}
      <Modal
        open={modal === 'create'}
        onClose={closeModal}
        title="Новий співробітник"
        size="lg"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.firstName || !form.lastName}
            className="w-full"
          >
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ім'я"
              required
              value={form.firstName}
              onChange={e => {
                setForm(f => ({ ...f, firstName: e.target.value }));
                createDirty.markDirty();
              }}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              required
              value={form.lastName}
              onChange={e => {
                setForm(f => ({ ...f, lastName: e.target.value }));
                createDirty.markDirty();
              }}
              placeholder="Коваль"
            />
          </div>
          <Select
            label="Посада"
            required
            value={form.role}
            onChange={e => {
              setForm(f => ({ ...f, role: e.target.value }));
              createDirty.markDirty();
            }}
          >
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Телефон"
              value={form.phone}
              onChange={e => {
                setForm(f => ({ ...f, phone: e.target.value }));
                createDirty.markDirty();
              }}
              placeholder="+38 (067) 123-45-67"
            />
            <Input
              label="Email"
              type="email"
              value={form.email}
              onChange={e => {
                setForm(f => ({ ...f, email: e.target.value }));
                createDirty.markDirty();
              }}
              placeholder="ivan@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Статус"
              value={form.status}
              onChange={e => {
                setForm(f => ({ ...f, status: e.target.value }));
                createDirty.markDirty();
              }}
            >
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <DatePickerInput
              label="Дата прийому"
              value={form.dateOfHire}
              onChange={v => {
                setForm(f => ({ ...f, dateOfHire: v }));
                createDirty.markDirty();
              }}
            />
          </div>
          <Select
            label="Схема нарахування"
            required
            value={form.rateType}
            onChange={e => {
              setForm(f => ({ ...f, rateType: e.target.value }));
              createDirty.markDirty();
            }}
          >
            {Object.entries(RATE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          {form.rateType === 'percent_normo' && (
            <Input
              label="Відсоток, %"
              type="number"
              value={form.percent}
              onChange={e => {
                setForm(f => ({ ...f, percent: e.target.value }));
                createDirty.markDirty();
              }}
            />
          )}
          {form.rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ставка, грн/міс"
                type="number"
                value={form.fixedMonthly}
                onChange={e => {
                  setForm(f => ({ ...f, fixedMonthly: e.target.value }));
                  createDirty.markDirty();
                }}
              />
              <Input
                label="Бонус, %"
                type="number"
                value={form.bonusPercent}
                onChange={e => {
                  setForm(f => ({ ...f, bonusPercent: e.target.value }));
                  createDirty.markDirty();
                }}
              />
            </div>
          )}
        </div>
      </Modal>

      {/* Card modal — assignment */}
      <Modal
        open={modal === 'card' && !!selected}
        onClose={closeModal}
        title={selected ? `${selected.lastName} ${selected.firstName}` : ''}
        size="lg"
        footer={
          <Button onClick={saveAssignments} loading={saving} className="w-full">
            Зберегти прив'язки
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {selected && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground mb-4">
              {ROLE_LABELS[selected.role]}
              {selected.rateScheme
                ? ` · ${RATE_LABELS[selected.rateScheme.type] ?? selected.rateScheme.type}`
                : ''}
            </p>
            <CheckboxList
              label="Зони"
              items={zones}
              selected={assignedZones}
              onChange={setAssignedZones}
            />
            <CheckboxList
              label="Підйомники"
              items={lifts}
              selected={assignedLifts}
              onChange={setAssignedLifts}
            />
            <CheckboxList
              label="Категорії робіт"
              items={flatCats}
              selected={assignedCats}
              onChange={setAssignedCats}
            />
            <div className="mb-3">
              <label className="block text-[13px] font-medium text-foreground mb-2">
                Доступ до філій
              </label>
              <label className="flex items-center gap-2 mb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allBranches}
                  onChange={e => setAllBranches(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-[13px] text-foreground">Доступ до всіх філій</span>
              </label>
              {!allBranches && (
                <CheckboxList
                  label=""
                  items={branches}
                  selected={assignedBranches}
                  onChange={setAssignedBranches}
                />
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Edit modal — employee data */}
      <Modal
        open={modal === 'edit' && !!editEmp}
        onClose={closeEditModal}
        title={editEmp ? `${editEmp.lastName} ${editEmp.firstName}` : ''}
        size="lg"
        footer={
          <>
            <Button
              onClick={saveEditEmp}
              loading={editSaving}
              disabled={!editForm.firstName || !editForm.lastName}
            >
              Зберегти
            </Button>
            <Button variant="outline" onClick={closeEditModal}>
              Скасувати
            </Button>
          </>
        }
      >
        {editError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {editError}
          </div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ім'я"
              required
              value={editForm.firstName}
              onChange={e => {
                setEditForm(f => ({ ...f, firstName: e.target.value }));
                editDirty.markDirty();
              }}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              required
              value={editForm.lastName}
              onChange={e => {
                setEditForm(f => ({ ...f, lastName: e.target.value }));
                editDirty.markDirty();
              }}
              placeholder="Коваль"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Посада"
              required
              value={editForm.role}
              onChange={e => {
                setEditForm(f => ({ ...f, role: e.target.value }));
                editDirty.markDirty();
              }}
            >
              {Object.entries(ROLE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select
              label="Статус"
              value={editForm.status}
              onChange={e => {
                setEditForm(f => ({ ...f, status: e.target.value }));
                editDirty.markDirty();
              }}
            >
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Телефон"
              value={editForm.phone}
              onChange={e => {
                setEditForm(f => ({ ...f, phone: e.target.value }));
                editDirty.markDirty();
              }}
              placeholder="+38 (067) 123-45-67"
            />
            <Input
              label="Email"
              value={editForm.email}
              onChange={e => {
                setEditForm(f => ({ ...f, email: e.target.value }));
                editDirty.markDirty();
              }}
              placeholder="ivan@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DatePickerInput
              label="Дата прийому"
              value={editForm.dateOfHire}
              onChange={v => {
                setEditForm(f => ({ ...f, dateOfHire: v }));
                editDirty.markDirty();
              }}
            />
            <DatePickerInput
              label="Дата звільнення"
              value={editForm.dateOfFire}
              onChange={v => {
                setEditForm(f => ({ ...f, dateOfFire: v }));
                editDirty.markDirty();
              }}
            />
          </div>
          <Select
            label="Схема нарахування"
            required
            value={editForm.rateType}
            onChange={e => {
              setEditForm(f => ({ ...f, rateType: e.target.value }));
              editDirty.markDirty();
            }}
          >
            {Object.entries(RATE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          {editForm.rateType === 'percent_normo' && (
            <Input
              label="Відсоток, %"
              type="number"
              value={editForm.percent}
              onChange={e => {
                setEditForm(f => ({ ...f, percent: e.target.value }));
                editDirty.markDirty();
              }}
            />
          )}
          {editForm.rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ставка, грн/міс"
                type="number"
                value={editForm.fixedMonthly}
                onChange={e => {
                  setEditForm(f => ({ ...f, fixedMonthly: e.target.value }));
                  editDirty.markDirty();
                }}
              />
              <Input
                label="Бонус, %"
                type="number"
                value={editForm.bonusPercent}
                onChange={e => {
                  setEditForm(f => ({ ...f, bonusPercent: e.target.value }));
                  editDirty.markDirty();
                }}
              />
            </div>
          )}
        </div>

        {/* Related assignments — tabs at bottom */}
        <ModalTabs
          tabs={[
            {
              key: 'zones',
              label: 'Зони та підйомники',
              count: (editEmp?.zoneIds.length ?? 0) + (editEmp?.liftIds.length ?? 0),
              content: (
                <div className="grid grid-cols-2 gap-4">
                  <CheckboxList
                    label="Зони"
                    items={zones}
                    selected={editZoneIds}
                    onChange={ids => {
                      setEditZoneIds(ids);
                      editDirty.markDirty();
                    }}
                  />
                  <CheckboxList
                    label="Підйомники"
                    items={lifts}
                    selected={editLiftIds}
                    onChange={ids => {
                      setEditLiftIds(ids);
                      editDirty.markDirty();
                    }}
                  />
                </div>
              ),
            },
            {
              key: 'categories',
              label: 'Категорії робіт',
              count: editEmp?.workCategoryIds.length ?? 0,
              content: (
                <CheckboxList
                  label=""
                  items={flatCats}
                  selected={editWorkCatIds}
                  onChange={ids => {
                    setEditWorkCatIds(ids);
                    editDirty.markDirty();
                  }}
                />
              ),
            },
            ...(branches.length > 0
              ? [
                  {
                    key: 'branches',
                    label: 'Філії',
                    content: (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editAllBranches}
                            onChange={e => {
                              setEditAllBranches(e.target.checked);
                              editDirty.markDirty();
                            }}
                            className="rounded border-border"
                          />
                          <span className="text-[13px] text-foreground">Доступ до всіх філій</span>
                        </label>
                        {!editAllBranches && (
                          <CheckboxList
                            label=""
                            items={branches}
                            selected={editBranchIds}
                            onChange={ids => {
                              setEditBranchIds(ids);
                              editDirty.markDirty();
                            }}
                          />
                        )}
                        <p className="text-[12px] text-muted-foreground">
                          OWNER та ADMIN мають доступ до всіх філій автоматично.
                        </p>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Modal>
      <DirtyConfirmDialog {...createDirty.dialogProps} />
      <DirtyConfirmDialog {...editDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
