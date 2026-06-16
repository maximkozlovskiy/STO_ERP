'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ChangeEvent } from 'react';
import {
  Trash2,
  Plus,
  Pencil,
  Check,
  X,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Printer,
  Share2,
  MessageSquare,
  Receipt,
  Minus,
  Download,
} from 'lucide-react';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useConflictCheck } from '@/hooks/useConflictCheck';
import { useConfirm } from '@/hooks/useConfirm';
import { getCached, setCache } from '@/lib/ref-cache';
import { kyivToday, isoToKyivLocalDateTime, localDateTimeToISO } from '@/lib/format';
import { cn, displayCounterpartyName, toIdMap, calcVatTotals } from '@/lib/utils';
import {
  WO_STATUS_LABELS,
  WO_STATUS_DESCRIPTIONS,
  WO_STATUS_TRANSITIONS,
  WO_PRIORITY_LABELS,
  WO_CATEGORY_LABELS,
  WO_EDITABLE_STATUSES,
  WO_SHAREABLE_STATUSES,
  WO_INVOICEABLE_STATUSES,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { WorkPickerModal, type WorkPickerItem } from '@/components/ui/WorkPickerModal';
import { GoodPickerModal, type GoodPickerItem } from '@/components/ui/GoodPickerModal';
import { Tooltip } from '@/components/ui/tooltip';
import { LinkedDocumentsPanel } from '@/components/ui/LinkedDocumentsPanel';

interface Branch {
  id: string;
  name: string;
}
interface Lift {
  id: string;
  name: string;
}
interface Warehouse {
  id: string;
  name: string;
  type?: string;
  deletedAt?: string | null;
}
interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  role?: string;
  deletedAt?: string | null;
}
interface Vehicle {
  id: string;
  make: string;
  model: string;
  licensePlate: string | null;
}
interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone?: string | null;
}
interface Contract {
  id: string;
  title: string;
  number?: string | null;
}
interface Unit {
  id: string;
  name: string;
  shortName: string;
}

// Local line/part rows (pre-save state)
interface LocalLine {
  _key: string;
  id?: string; // present for rows already persisted in DB (edit mode)
  workId: string;
  workName: string;
  employeeId: string;
  normoHours: string;
  actualHours: string;
  price: string;
}
interface LocalPart {
  _key: string;
  id?: string; // present for rows already persisted in DB (edit mode)
  goodId: string;
  goodName: string;
  warehouseId: string;
  quantity: string;
  price: string;
  unitOfMeasureId: string;
  unitShortName: string;
}

// WorkOrderDetail for edit mode load
interface WorkOrderDetail {
  id: string;
  number: string;
  status: string;
  branchId: string;
  vehicleId: string;
  counterpartyId: string;
  counterpartyName?: string;
  contractId?: string | null;
  liftId?: string | null;
  description?: string | null;
  inMileage?: number | null;
  priority?: string;
  repairCategory?: string | null;
  documentDate?: string | null;
  plannedAt?: string | null;
  dueDate?: string | null;
  plannedHours?: number | null;
  actualHours?: number | null;
  lines: {
    id: string;
    workId: string;
    workName?: string;
    employeeId: string;
    employeeName?: string;
    normoHours: number;
    actualHours?: number | null;
    price: number;
  }[];
  parts: {
    id: string;
    goodId: string;
    goodName?: string;
    warehouseId: string;
    quantity: number;
    price: number;
    // Bug #434: backend `toPartDto` повертає unitOfMeasureId (work-orders.service.ts:1529),
    // але локальний interface його пропускав → load mapper хардкодив '' → inline-edit
    // dropdown губив попередньо обраний UoM. Type drift: interface локальний, не
    // імпортується з shared, тож TS не ловив розбіжність з backend DTO.
    unitOfMeasureId?: string | null;
    unitShortName?: string;
    coefficient?: number;
  }[];
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  ESTIMATE: 'bg-warning-subtle text-warning',
  APPROVED: 'bg-primary-subtle text-primary',
  IN_PROGRESS: 'bg-info-subtle text-info-text',
  ON_HOLD: 'bg-warning-subtle text-warning',
  COMPLETED: 'bg-success-subtle text-success',
  INVOICED: 'bg-primary-subtle text-primary',
  PAID: 'bg-success-subtle text-success',
  ARCHIVED: 'bg-secondary text-muted-foreground',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};

const TRANSITION_LABELS: Record<string, string> = {
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затвердити',
  IN_PROGRESS: 'В роботу',
  ON_HOLD: 'Призупинити',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставити рахунок',
  PAID: 'Оплачено',
  ARCHIVED: 'В архів',
  CANCELLED: 'Скасувати',
  DRAFT: 'Повернути в чернетку',
};

const TRANSITION_VARIANTS: Record<string, 'default' | 'destructive' | 'outline'> = {
  CANCELLED: 'destructive',
  COMPLETED: 'default',
  PAID: 'default',
  APPROVED: 'default',
  IN_PROGRESS: 'default',
};

const EMPTY_LINE: Omit<LocalLine, '_key'> = {
  workId: '',
  workName: '',
  employeeId: '',
  normoHours: '',
  actualHours: '',
  price: '',
};
const EMPTY_PART: Omit<LocalPart, '_key'> = {
  goodId: '',
  goodName: '',
  warehouseId: '',
  quantity: '1',
  price: '',
  unitOfMeasureId: '',
  unitShortName: '',
};

const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);
// Status order = keys of label map; module-level → uses const map once instead of
// `Object.keys()` per render у IIFE-status-picker (recomputed на КОЖНИЙ keystroke у формі).
const WO_STATUS_ORDER: readonly string[] = Object.freeze(Object.keys(WO_STATUS_LABELS));
// Статуси що виключаються зі стрілок ← / → (доступні тільки через dropdown).
const ARROW_SKIP_STATUSES = new Set(['ON_HOLD', 'ARCHIVED', 'CANCELLED']);

export interface CreateWOPrefill {
  counterpartyId?: string;
  counterpartyDisplay?: string;
  vehicleId?: string;
  branchId?: string;
  liftId?: string;
  description?: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  plannedHours?: string;
}

export interface CreatedWorkOrder {
  id: string;
  number: string;
  counterpartyId: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (wo: CreatedWorkOrder) => void;
  prefill?: CreateWOPrefill;
  workOrderId?: string; // edit mode when provided
  onUpdated?: () => void; // called after PATCH or FSM transition
  onMinimize?: () => void; // called before onClose when user clicks "−"
}

// Crypto-randomUUID gives globally-unique row keys without relying on a
// module-level counter (which would survive HMR/StrictMode and risk reuse).
const nextKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

// sto-optimize: stable no-op handler for disabled DateTimePickerInput placeholders
// (actual-section start/end). Inline `() => {}` create new function references each
// render → DateTimePickerInput memoization marked as dirty even though field is fixed.
const NOOP_DT_CHANGE: (v: string) => void = () => {};

// Calc working hours between two "YYYY-MM-DDTHH:mm" local datetime strings.
// Returns rounded-to-2-decimals string, or '' if inputs are missing/invalid.
const calcPlannedHours = (start?: string, end?: string): string => {
  if (!start || !end) return '';
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return '';
  const hours = (e.getTime() - s.getTime()) / 3_600_000;
  return String(Math.round(hours * 100) / 100);
};

// Working day window: 08:00–20:00 (matches calendar WINDOW_START/WINDOW_END).
const WORK_START_H = 8;
const WORK_END_H = 20;

// Given a "YYYY-MM-DDTHH:mm" start and hours value, compute plannedEndAt
// respecting the working-hours window. Overflow beyond 20:00 continues on the
// next day starting at 08:00 (same logic as CalendarSlotModal.calcEndAt).
// Returns "YYYY-MM-DDTHH:mm" string, or '' if inputs invalid.
const calcEndFromHours = (start: string, hours: number): string => {
  if (!start || !Number.isFinite(hours) || hours <= 0) return '';
  const base = new Date(start);
  if (Number.isNaN(base.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  const startH = base.getHours();
  const startM = base.getMinutes();
  const startMinOfDay = startH * 60 + startM;
  const durationMin = Math.round(hours * 60);
  const endMinOfDay = startMinOfDay + durationMin;
  const workEndMin = WORK_END_H * 60;

  let endDate: Date;
  let endH: number;
  let endM: number;

  if (endMinOfDay <= workEndMin) {
    endDate = new Date(base);
    endH = Math.floor(endMinOfDay / 60);
    endM = endMinOfDay % 60;
  } else {
    // Overflow: next calendar day, starting at WORK_START_H
    const overflowMin = endMinOfDay - workEndMin;
    const day2Min = WORK_START_H * 60 + overflowMin;
    endDate = new Date(base);
    endDate.setDate(endDate.getDate() + 1);
    endH = Math.floor(day2Min / 60);
    endM = day2Min % 60;
  }

  return `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endH)}:${pad(endM)}`;
};

// Recalc plannedHours = max(currentVal, sum of normoHours across all lines).
// Used when recalcPlannedHoursFromLines setting is enabled.
// Does NOT decrease the value if user manually set it higher.
const calcPlannedHoursFromLines = (
  currentVal: string,
  linesArr: { normoHours: string }[],
): string => {
  const sum = linesArr.reduce((acc, l) => {
    const n = Number(l.normoHours.replace(',', '.'));
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  if (sum === 0) return currentVal;
  const current = Number(currentVal.replace(',', '.'));
  const result = Number.isFinite(current) && current > 0 ? Math.max(current, sum) : sum;
  return String(Math.round(result * 100) / 100);
};

// UA users often type `1,5` for fractional values — accept comma as decimal
// separator before passing to `Number()`. Returns `undefined` for empty/NaN.
const toNumberOrUndefined = (raw: string): number | undefined => {
  if (!raw) return undefined;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

export function CreateWorkOrderModal({
  open,
  onClose,
  onCreated,
  prefill,
  workOrderId,
  onUpdated,
  onMinimize,
}: Props) {
  const isEditMode = !!workOrderId;
  const [form, setForm] = useState({
    branchId: '',
    vehicleId: '',
    counterpartyId: '',
    contractId: '',
    liftId: '',
    description: '',
    priority: 'NORMAL',
    repairCategory: '',
    documentDate: kyivToday(),
    plannedStartAt: '',
    plannedEndAt: '',
    plannedHours: '',
    actualHours: '',
  });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [cpPhone, setCpPhone] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  // Refs ensure handleModalClose sees sync state, not stale closure (Bug #381 race).
  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  // Bug #440: track initial planned dates loaded from WO so we can detect
  // whether they actually changed before prompting the calendar-sync dialog.
  // Without this every save() — even one that only touches description or
  // lines — would ask "Планові дати наряду змінились" and lie to the user.
  const initialPlannedRef = useRef<{ startAt: string; endAt: string }>({
    startAt: '',
    endAt: '',
  });
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const setTransitioningBoth = (v: boolean) => {
    transitioningRef.current = v;
    setTransitioning(v);
  };
  const [error, setError] = useState('');
  const [vatMode, setVatMode] = useState<'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'>('NONE');
  const [vatRate, setVatRate] = useState(0);
  // Bug #523: default = true (Prisma schema default + DocumentsTab `?? true`).
  // Раніше `useState(false)` + `?? false` → silent drift: settings toggle on,
  // WO модалка ефективно off коли GET /settings/organisation lag-ить чи не повертає поле.
  const [recalcPlannedHoursEnabled, setRecalcPlannedHoursEnabled] = useState(true);
  const [recalcActualHoursEnabled, setRecalcActualHoursEnabled] = useState(true);
  const [syncCalendarEnabled, setSyncCalendarEnabled] = useState(true);
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [editModeLoading, setEditModeLoading] = useState(false);
  const [woNumber, setWoNumber] = useState('');
  const [shareLoading, setShareLoading] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceConflict, setInvoiceConflict] = useState(false);
  // Bug #409: інкрементуємо після успішного invoice create/refresh →
  // LinkedDocumentsPanel ререфетчить без потреби unmount/remount tab.
  const [linkedDocsRefreshKey, setLinkedDocsRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<'main' | 'documents'>('main');
  const features = useUiFeatures();
  const {
    conflict: calConflict,
    check: checkConflict,
    clear: clearConflict,
    conflictWoNumbers,
  } = useConflictCheck();
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();
  const { minimizeModal } = useTabBarContext();
  const deletedLineIds = useRef<string[]>([]);
  const deletedPartIds = useRef<string[]>([]);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!statusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [statusMenuOpen]);

  // Bug #408 follow-up: onKeyDown на <div role="presentation"> без tabIndex/focus
  // не спрацьовує — Esc мовчки ігнорувався. Глобальний listener забезпечує закриття
  // діалогу-конфлікту з клавіатури згідно §14 a11y.
  //
  // useCapture + stopImmediatePropagation: батьківський <Modal> теж слухає Esc на document
  // (bubble-фаза), тож без capture+stop Esc закрив би одразу і conflict-dialog, і WO modal.
  // Capture-фаза гарантує що наш listener fire-ить ПЕРШИМ; stopImmediatePropagation відсікає
  // подальші listeners на document (включно з Modal handler).
  useEffect(() => {
    if (!invoiceConflict) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (!invoiceLoading) setInvoiceConflict(false);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [invoiceConflict, invoiceLoading]);

  // Conflict check when planned period or liftId changes (edit mode only).
  // Backend expects ISO with TZ; DateTimePickerInput emits naive "YYYY-MM-DDTHH:mm"
  // (no TZ). Normalize via DST-aware localDateTimeToISO (passes through values
  // already ending Z / ±HH:MM). Без цієї нормалізації backend new Date("2026-06-10T14:00")
  // парсить як UTC → +2/+3h зсув → false positives.
  useEffect(() => {
    if (!isEditMode || !form.plannedStartAt || !form.plannedEndAt) {
      clearConflict();
      return;
    }
    const startIso = localDateTimeToISO(form.plannedStartAt);
    const endIso = localDateTimeToISO(form.plannedEndAt);
    if (!startIso || !endIso) {
      clearConflict();
      return;
    }
    checkConflict({
      liftId: form.liftId || undefined,
      startAt: startIso,
      endAt: endIso,
      // Bug #397: виключити слоти цього самого наряду — інакше будь-який наряд
      // з уже створеним слотом показує "Підйомник зайнятий" на власний час.
      excludeWorkOrderId: workOrderId,
    });
  }, [
    form.plannedStartAt,
    form.plannedEndAt,
    form.liftId,
    isEditMode,
    workOrderId,
    checkConflict,
    clearConflict,
  ]);

  // Inline add-row state
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [newPart, setNewPart] = useState<Omit<LocalPart, '_key'>>(EMPTY_PART);
  const [showLineInput, setShowLineInput] = useState(false);
  const [showPartInput, setShowPartInput] = useState(false);

  // Inline edit state (null = no row being edited)
  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null);
  const [editingPart, setEditingPart] = useState<Omit<LocalPart, '_key'>>(EMPTY_PART);

  // Accumulated pre-save rows
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [parts, setParts] = useState<LocalPart[]>([]);
  const [stockTotalsMap, setStockTotalsMap] = useState<Map<string, number>>(new Map());
  // key = `${goodId}:${warehouseId}` → quantity on that specific warehouse
  const [stockWarehouseMap, setStockWarehouseMap] = useState<Map<string, number>>(new Map());

  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  const vehicleReqRef = useRef(0);
  const contractReqRef = useRef(0);
  const branchesRef = useRef(branches);
  branchesRef.current = branches;

  // Load branches, warehouses, employees once
  useEffect(() => {
    const cachedBranches = getCached<Branch[]>('cache:branches');
    if (cachedBranches) {
      setBranches(cachedBranches);
    } else {
      apiFetch<Branch[]>('/branches')
        .then(bs => {
          setBranches(bs);
          setCache('cache:branches', bs);
        })
        .catch(() => {});
    }

    const cachedLifts = getCached<Lift[]>('cache:lifts');
    if (cachedLifts) setLifts(cachedLifts);
    // Always re-fetch to avoid stale deleted lifts appearing in the select
    apiFetch<Lift[] | { items: Lift[] }>('/lifts')
      .then(r => {
        const list = Array.isArray(r) ? r : ((r as { items: Lift[] }).items ?? []);
        setLifts(list);
        setCache('cache:lifts', list);
      })
      .catch(() => {});

    const cachedWarehouses = getCached<Warehouse[]>('cache:warehouses');
    if (cachedWarehouses) setWarehouses(cachedWarehouses);
    apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(r => {
        const all = Array.isArray(r) ? r : ((r as { items: Warehouse[] }).items ?? []);
        const list = all.filter(w => !w.deletedAt && w.type !== 'TIRE_HOTEL');
        setWarehouses(list);
        setCache('cache:warehouses', list);
      })
      .catch(() => {});

    const cachedEmployees = getCached<Employee[]>('cache:employees');
    if (cachedEmployees) setEmployees(cachedEmployees);
    apiFetch<{ items: Employee[] }>('/employees?limit=200&role=MECHANIC')
      .then(r => {
        const list = (Array.isArray(r.items) ? r.items : []).filter(e => !e.deletedAt);
        setEmployees(list);
        setCache('cache:employees', list);
      })
      .catch(() => {});

    // sto-optimize: units є reference data з warm sessionStorage cache (TTL ≥30хв).
    // Cache populated catalog/UnitsTab + catalog/GoodsTab (source pages). Seeding
    // дає instant first-paint списку одиниць для parts table у WO modal.
    const cachedUnits = getCached<Unit[]>('cache:units');
    if (cachedUnits) {
      setUnits(cachedUnits);
    } else {
      apiFetch<{ items: Unit[] } | Unit[]>('/units?limit=200')
        .then(r => {
          const list = Array.isArray(r) ? r : (r.items ?? []);
          setUnits(list);
          setCache('cache:units', list);
        })
        .catch(() => {});
    }

    Promise.all([
      apiFetch<{
        vatMode: string;
        defaultVatRateId?: string | null;
        recalcPlannedHoursFromLines?: boolean;
        recalcActualHoursFromLines?: boolean;
        syncCalendarSlotWithPlannedHours?: boolean;
      }>('/settings/organisation'),
      apiFetch<{ id: string; rate: number; isDefault: boolean }[]>('/settings/tax-rates'),
    ])
      .then(([org, rates]) => {
        setVatMode((org.vatMode as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE') ?? 'NONE');
        // Bug #523: дефолт = true (Prisma schema default). Без цього при legacy DTO
        // response, що не містить поля, settings/DocumentsTab показує on, а тут off.
        setRecalcPlannedHoursEnabled(org.recalcPlannedHoursFromLines ?? true);
        setRecalcActualHoursEnabled(org.recalcActualHoursFromLines ?? true);
        setSyncCalendarEnabled(org.syncCalendarSlotWithPlannedHours ?? true);
        const def = (Array.isArray(rates) ? rates : []).find(r => r.isDefault);
        if (def) setVatRate(Number(def.rate));
      })
      .catch(() => {});
  }, []);

  // Apply prefill + auto-select single branch when modal opens.
  // Bug #421: deps include `workOrderId` — без цього при перемиканні між мінімізованими
  // tab-ами (A → B, обидва edit-mode, open=true весь час) stale state (error banner,
  // inline "Додати рядок", showLineInput, lines/parts WO-A, статус-меню) лишається
  // видимим поки fetch для B ще не resolved. Тепер кожна зміна workOrderId одразу
  // скидає transient UI до neutral baseline, потім edit-mode useEffect завантажує
  // фактичні дані WO-B.
  useEffect(() => {
    if (!open) return;
    setError('');
    setStatusMenuOpen(false);
    setVehicles([]);
    setContracts([]);
    setLines([]);
    setParts([]);
    setNewLine(EMPTY_LINE);
    setNewPart(EMPTY_PART);
    setShowLineInput(false);
    setShowPartInput(false);
    setEditingLineKey(null);
    setEditingPartKey(null);
    setHeaderCollapsed(false);
    setWoNumber('');
    setCurrentStatus('DRAFT');
    // A fresh modal session starts without a prior partial create.
    createdWoRef.current = null;
    // Bug #440: reset snapshot so previous WO's dates don't bleed into a new session.
    initialPlannedRef.current = {
      startAt: prefill?.plannedStartAt ?? '',
      endAt: prefill?.plannedEndAt ?? '',
    };
    setForm({
      branchId: prefill?.branchId ?? '',
      vehicleId: prefill?.vehicleId ?? '',
      counterpartyId: prefill?.counterpartyId ?? '',
      contractId: '',
      liftId: prefill?.liftId ?? '',
      description: prefill?.description ?? '',
      priority: 'NORMAL',
      repairCategory: '',
      documentDate: kyivToday(),
      plannedStartAt: prefill?.plannedStartAt ?? '',
      plannedEndAt: prefill?.plannedEndAt ?? '',
      plannedHours:
        prefill?.plannedHours ?? calcPlannedHours(prefill?.plannedStartAt, prefill?.plannedEndAt),
      actualHours: '',
    });
    setCounterpartyDisplayName(prefill?.counterpartyDisplay ?? '');
    setCpPhone('');

    if (!prefill?.branchId) {
      const src = getCached<Branch[]>('cache:branches') ?? branchesRef.current;
      if (src.length === 1) setForm(f => ({ ...f, branchId: src[0].id }));
    }

    if (!isEditMode && prefill?.counterpartyId) {
      loadVehicles(prefill.counterpartyId, prefill.vehicleId);
      loadContracts(prefill.counterpartyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrderId]);

  // Edit mode — load existing WO data when modal opens or workOrderId changes.
  // Cancellation guard: at TabBar restore time, the user can click tab B while A's
  // fetch is still in flight — without `cancelled` flag A's late-resolved data would
  // overwrite B's fresh state (stale-write race).
  useEffect(() => {
    if (!open || !isEditMode || !workOrderId) return;
    let cancelled = false;
    deletedLineIds.current = [];
    deletedPartIds.current = [];
    setEditModeLoading(true);
    setError('');
    apiFetch<WorkOrderDetail>(`/work-orders/${workOrderId}`)
      .then(wo => {
        if (cancelled) return;
        setWoNumber(wo.number);
        setCurrentStatus(wo.status);
        setForm({
          branchId: wo.branchId ?? '',
          vehicleId: wo.vehicleId ?? '',
          counterpartyId: wo.counterpartyId ?? '',
          contractId: wo.contractId ?? '',
          liftId: wo.liftId ?? '',
          description: wo.description ?? '',
          priority: wo.priority ?? 'NORMAL',
          repairCategory: wo.repairCategory ?? '',
          documentDate: wo.documentDate ? wo.documentDate.slice(0, 10) : kyivToday(),
          plannedStartAt: isoToKyivLocalDateTime(wo.plannedAt),
          plannedEndAt: isoToKyivLocalDateTime(wo.dueDate),
          plannedHours: wo.plannedHours != null ? String(wo.plannedHours) : '',
          actualHours: wo.actualHours != null ? String(wo.actualHours) : '',
        });
        // Bug #440: snapshot loaded dates for later change-detection.
        // Used by save() to decide whether to show calendar-sync dialog.
        initialPlannedRef.current = {
          startAt: isoToKyivLocalDateTime(wo.plannedAt),
          endAt: isoToKyivLocalDateTime(wo.dueDate),
        };
        setCounterpartyDisplayName(wo.counterpartyName ?? '');
        setCpPhone('');
        setLines(
          wo.lines.map(l => ({
            _key: nextKey(),
            id: l.id,
            workId: l.workId,
            workName: l.workName ?? '',
            employeeId: l.employeeId,
            normoHours: String(l.normoHours),
            actualHours: l.actualHours != null ? String(l.actualHours) : '',
            price: String(l.price),
          })),
        );
        setParts(
          wo.parts.map(p => ({
            _key: nextKey(),
            id: p.id,
            goodId: p.goodId,
            goodName: p.goodName ?? '',
            warehouseId: p.warehouseId,
            quantity: String(p.quantity),
            price: String(p.price),
            // Bug #434: зберігаємо UoM що повернув backend, інакше inline-edit dropdown
            // скине вибір до дефолту "шт" навіть якщо реально товар у "кг".
            unitOfMeasureId: p.unitOfMeasureId ?? '',
            unitShortName: p.unitShortName ?? '',
          })),
        );
        if (wo.counterpartyId) {
          loadVehicles(wo.counterpartyId, wo.vehicleId);
          loadContracts(wo.counterpartyId);
        }
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження наряду');
      })
      .finally(() => {
        if (cancelled) return;
        setEditModeLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrderId]);

  // After branches load (or on open), auto-select if single branch.
  // Covers two cases: (1) branches arrive async after modal opens,
  // (2) modal reopens when branches are already cached (branches dep unchanged).
  useEffect(() => {
    if (!open || isEditMode || branches.length !== 1) return;
    setForm(f => (f.branchId ? f : { ...f, branchId: branches[0].id }));
  }, [branches, open, isEditMode]);

  // Auto-select first warehouse for new parts when warehouses load
  useEffect(() => {
    if (warehouses.length === 1) {
      setNewPart(p => (p.warehouseId ? p : { ...p, warehouseId: warehouses[0].id }));
    }
  }, [warehouses]);

  // Auto-collapse header when user starts adding/editing table rows
  useEffect(() => {
    if (showLineInput || showPartInput || !!editingLineKey || !!editingPartKey) {
      setHeaderCollapsed(true);
    }
  }, [showLineInput, showPartInput, editingLineKey, editingPartKey]);

  const loadVehicles = (cpId: string, keepVehicleId?: string) => {
    if (!cpId) return;
    const reqId = ++vehicleReqRef.current;
    apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${cpId}`)
      .then(list => {
        if (reqId !== vehicleReqRef.current) return;
        const all = Array.isArray(list) ? list : [];
        setVehicles(all);
        if (keepVehicleId && all.some(v => v.id === keepVehicleId)) return;
        if (all.length === 1) setForm(f => (f.vehicleId ? f : { ...f, vehicleId: all[0].id }));
      })
      .catch(() => {});
  };

  const loadContracts = (cpId: string) => {
    if (!cpId) return;
    const reqId = ++contractReqRef.current;
    apiFetch<{ items: Contract[] }>(`/counterparties/${cpId}/contracts?limit=100`)
      .then(r => {
        if (reqId !== contractReqRef.current) return;
        setContracts(Array.isArray(r.items) ? r.items : []);
      })
      .catch(() => {});
  };

  const [workPickerOpen, setWorkPickerOpen] = useState(false);
  const [editWorkPickerOpen, setEditWorkPickerOpen] = useState(false);
  const [goodPickerOpen, setGoodPickerOpen] = useState(false);
  const [editGoodPickerOpen, setEditGoodPickerOpen] = useState(false);

  const fetchWorks = useCallback(
    (q: string) =>
      apiFetch<{ items: WorkPickerItem[] }>(`/works?q=${encodeURIComponent(q)}&limit=20`).then(r =>
        (r.items ?? []).map(w => ({
          ...w,
          primary: w.name,
          secondary: `${w.normoHours} год · ${w.price} ₴`,
        })),
      ),
    [],
  );

  const fetchGoods = useCallback(
    (q: string) =>
      apiFetch<{
        items: (Omit<GoodPickerItem, 'unitShortName'> & { unit?: string | null })[];
      }>(`/goods?q=${encodeURIComponent(q)}&limit=20`).then(r =>
        (r.items ?? []).map(g => ({
          ...g,
          unitShortName: g.unit ?? null,
          primary: g.name,
          secondary: g.sku ? `${g.sku} · ${g.salePrice} ₴` : `${g.salePrice} ₴`,
        })),
      ),
    [],
  );

  // Fetch total stock across all warehouses for each unique good in the parts list,
  // including any good currently being added/edited (so the column shows while typing).
  // Goods with no StockItem rows are explicitly mapped to 0 (groupBy omits empty buckets,
  // but UX-wise "no stock" should read as 0, not '—' which we reserve for "unknown goodId").
  //
  // Bug #454: derive a *stable string key* from the set of goodId-s. The previous
  // dep array `[parts, newPart.goodId, editingPart.goodId]` re-fired the effect on
  // ANY parts mutation — including typing in quantity/price — issuing a fresh
  // /goods/stock-totals request per keystroke even when the set of goods had not
  // changed. We memoize a sorted-comma-joined fingerprint so the effect re-runs
  // ONLY when the actual set of goodIds changes.
  const stockGoodIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const p of parts) if (p.goodId) ids.add(p.goodId);
    if (newPart.goodId) ids.add(newPart.goodId);
    if (editingPart.goodId) ids.add(editingPart.goodId);
    // Sort for stability — Set iteration order is insertion-based, but reordering
    // parts (move/delete + re-add) would yield a different key while the *set*
    // is unchanged. Sorting kills that false positive.
    return [...ids].sort().join(',');
  }, [parts, newPart.goodId, editingPart.goodId]);

  useEffect(() => {
    if (!stockGoodIdsKey) {
      setStockTotalsMap(new Map());
      setStockWarehouseMap(new Map());
      return;
    }
    const goodIds = stockGoodIdsKey.split(',');
    let cancelled = false;
    void apiFetch<
      {
        goodId: string;
        totalQuantity: number;
        byWarehouse: { warehouseId: string; quantity: number }[];
      }[]
    >(`/goods/stock-totals?ids=${stockGoodIdsKey}`)
      .then(rows => {
        if (cancelled) return;
        const nextTotals = new Map<string, number>(goodIds.map(id => [id, 0]));
        const nextWh = new Map<string, number>();
        for (const r of rows) {
          nextTotals.set(r.goodId, r.totalQuantity);
          for (const w of r.byWarehouse) {
            nextWh.set(`${r.goodId}:${w.warehouseId}`, w.quantity);
          }
        }
        setStockTotalsMap(nextTotals);
        setStockWarehouseMap(nextWh);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[stock-totals] fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [stockGoodIdsKey]);

  // Counterparty search for the header picker.
  // Wrapped in useCallback so EntityPickerField's outside-click listener
  // is not re-attached on every parent render.
  type HeaderCpItem = SearchPickerItem & { phone?: string | null };
  const fetchCpHeaderItems = useCallback(async (q: string): Promise<HeaderCpItem[]> => {
    const r = await apiFetch<{
      items: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        phone?: string | null;
      }[];
    }>(`/counterparties?q=${encodeURIComponent(q)}&types=CLIENT&types=BOTH&limit=20`);
    return r.items.map(c => ({
      id: c.id,
      primary: displayCounterpartyName(c),
      secondary: c.phone ?? undefined,
    }));
  }, []);

  // sto-optimize: стабільні onChange-handlers для трьох hour-inputs у разделі
  // "Планові та фактичні показники". Раніше — inline arrow на КОЖНЕ перерендеринг
  // (typing у будь-якому полі форми → новий handler → DateTimePickerInput не може
  // memo-skip). useCallback з [] deps безпечний: всі updates йдуть через setForm(f => ...)
  // — найсвіжіший state читається з callback-аргументу, не з closure.
  const handlePlannedStartChange = useCallback((v: string) => {
    setForm(f => ({
      ...f,
      plannedStartAt: v,
      plannedHours: calcPlannedHours(v, f.plannedEndAt),
    }));
  }, []);
  const handlePlannedEndChange = useCallback((v: string) => {
    setForm(f => ({
      ...f,
      plannedEndAt: v,
      plannedHours: calcPlannedHours(f.plannedStartAt, v),
    }));
  }, []);
  const handlePlannedHoursChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm(f => {
      const hours = Number(value.replace(',', '.'));
      const newEnd =
        f.plannedStartAt && Number.isFinite(hours) && hours > 0
          ? calcEndFromHours(f.plannedStartAt, hours)
          : f.plannedEndAt;
      return { ...f, plannedHours: value, plannedEndAt: newEnd || f.plannedEndAt };
    });
  }, []);
  const handleActualHoursChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm(f => ({ ...f, actualHours: value }));
  }, []);

  const addLine = () => {
    if (!newLine.workId || !newLine.employeeId) return;
    // Bug #382: блокуємо повний дублікат (work + виконавець) — типовий user-error.
    if (lines.some(l => l.workId === newLine.workId && l.employeeId === newLine.employeeId)) {
      setError('Цю роботу для цього виконавця вже додано');
      return;
    }
    // Bug #383: захист від негативних/нульових normoHours (DTO @Min(0.01) інакше rejects after WO created).
    const normo = toNumberOrUndefined(newLine.normoHours);
    if (newLine.normoHours && (normo === undefined || normo <= 0)) {
      setError('Нормо-години мають бути більше нуля');
      return;
    }
    const linePrice = toNumberOrUndefined(newLine.price);
    if (newLine.price && (linePrice === undefined || linePrice < 0)) {
      setError('Ціна не може бути відʼємною');
      return;
    }
    setError('');
    const newEntry = { ...newLine, _key: nextKey() };
    setLines(prev => {
      const updated = [...prev, newEntry];
      if (recalcPlannedHoursEnabled) {
        setForm(f => {
          const newHours = calcPlannedHoursFromLines(f.plannedHours, updated);
          const newEnd =
            newHours !== f.plannedHours && f.plannedStartAt
              ? calcEndFromHours(f.plannedStartAt, Number(newHours.replace(',', '.')))
              : f.plannedEndAt;
          return { ...f, plannedHours: newHours, plannedEndAt: newEnd || f.plannedEndAt };
        });
      }
      return updated;
    });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  const addPart = () => {
    if (!newPart.goodId || !newPart.warehouseId) return;
    // Bug #382: блокуємо повний дублікат (товар + склад).
    if (parts.some(p => p.goodId === newPart.goodId && p.warehouseId === newPart.warehouseId)) {
      setError('Цей товар із цього складу вже додано');
      return;
    }
    // Bug #383: backend DTO @Min(0.001) для quantity → reject цілого create() після WO POST.
    const qty = toNumberOrUndefined(newPart.quantity);
    if (qty === undefined || qty <= 0) {
      setError('Кількість має бути більше нуля');
      return;
    }
    const partPrice = toNumberOrUndefined(newPart.price);
    if (newPart.price && (partPrice === undefined || partPrice < 0)) {
      setError('Ціна не може бути відʼємною');
      return;
    }
    setError('');
    setParts(prev => [...prev, { ...newPart, _key: nextKey() }]);
    setNewPart({ ...EMPTY_PART, warehouseId: newPart.warehouseId });
    setShowPartInput(false);
  };

  // Track the WO created in a previous (failed) submit so retry posts only the
  // lines/parts that have not been persisted yet — otherwise the same lines
  // would be duplicated on every retry click.
  const createdWoRef = useRef<CreatedWorkOrder | null>(null);

  const create = async () => {
    // Bug #384: warn user if half-typed row would be silently dropped (data loss).
    // Pre-check BEFORE setSaving so the button stays enabled and the warning is visible.
    const hasHalfLine = !!newLine.workId && !newLine.employeeId;
    const hasHalfPart = !!newPart.goodId && !newPart.warehouseId;
    if (hasHalfLine || hasHalfPart) {
      setError(
        hasHalfLine
          ? 'У рядку «Роботи» не обрано виконавця. Натисніть «+» щоб додати або очистіть рядок.'
          : 'У рядку «Товари» не обрано склад. Натисніть «+» щоб додати або очистіть рядок.',
      );
      return;
    }

    setSavingBoth(true);
    setError('');

    // Auto-flush in-progress rows that the user filled but never clicked "+".
    // Without this, switching focus to the footer button silently drops the
    // half-typed row (data loss).
    const pendingLine: LocalLine | null =
      newLine.workId && newLine.employeeId ? { ...newLine, _key: nextKey() } : null;
    const pendingPart: LocalPart | null =
      newPart.goodId && newPart.warehouseId ? { ...newPart, _key: nextKey() } : null;

    const linesToPost: LocalLine[] = pendingLine ? [...lines, pendingLine] : lines;
    const partsToPost: LocalPart[] = pendingPart ? [...parts, pendingPart] : parts;

    if (pendingLine) {
      setLines(linesToPost);
      setNewLine(EMPTY_LINE);
    }
    if (pendingPart) {
      setParts(partsToPost);
      setNewPart({ ...EMPTY_PART, warehouseId: newPart.warehouseId });
    }

    try {
      // Reuse a previously-created WO on retry to avoid duplicate WO documents.
      let wo = createdWoRef.current;
      if (!wo) {
        wo = await apiFetch<CreatedWorkOrder>('/work-orders', {
          method: 'POST',
          body: JSON.stringify({
            branchId: form.branchId,
            vehicleId: form.vehicleId,
            counterpartyId: form.counterpartyId,
            contractId: form.contractId || undefined,
            liftId: form.liftId || undefined,
            description: form.description || undefined,
            priority: form.priority || 'NORMAL',
            repairCategory: form.repairCategory || undefined,
            documentDate: form.documentDate || undefined,
            plannedAt: localDateTimeToISO(form.plannedStartAt),
            dueDate: localDateTimeToISO(form.plannedEndAt),
            plannedHours: toNumberOrUndefined(form.plannedHours),
          }),
        });
        createdWoRef.current = wo;
      }

      // Post lines sequentially (order matters for display).
      // After each successful POST we drop the row from local state so a retry
      // after a mid-batch failure does NOT duplicate already-saved lines.
      for (const line of linesToPost) {
        await apiFetch(`/work-orders/${wo.id}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            workId: line.workId,
            employeeId: line.employeeId,
            normoHours: toNumberOrUndefined(line.normoHours),
            actualHours: toNumberOrUndefined(line.actualHours),
            price: toNumberOrUndefined(line.price),
          }),
        });
        setLines(prev => prev.filter(l => l._key !== line._key));
      }

      for (const part of partsToPost) {
        await apiFetch(`/work-orders/${wo.id}/parts`, {
          method: 'POST',
          body: JSON.stringify({
            goodId: part.goodId,
            warehouseId: part.warehouseId,
            quantity: toNumberOrUndefined(part.quantity) ?? 1,
            price: toNumberOrUndefined(part.price),
            unitOfMeasureId: part.unitOfMeasureId || undefined,
          }),
        });
        setParts(prev => prev.filter(p => p._key !== part._key));
      }

      createdWoRef.current = null;
      onCreated?.(wo);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення наряду');
    } finally {
      setSavingBoth(false);
    }
  };

  const save = async () => {
    if (!workOrderId) return;
    setSavingBoth(true);
    setError('');
    try {
      // Bug #525: computedActualHours має бути `undefined` коли користувач
      // не вказував явно і recalc не може порахувати (lines.length=0). Інакше
      // PATCH з null перетирав збережене значення WO.actualHours у БД.
      let computedActualHours: number | null | undefined;
      if (recalcActualHoursEnabled) {
        if (lines.length > 0) {
          let sum = 0;
          for (const l of lines) {
            const ah = toNumberOrUndefined(l.actualHours);
            const nh = toNumberOrUndefined(l.normoHours);
            sum += ah ?? nh ?? 0;
          }
          computedActualHours = sum;
        }
        // lines.length === 0 → undefined (не торкаємось WO.actualHours).
      } else if (form.actualHours !== '') {
        computedActualHours = toNumberOrUndefined(form.actualHours) ?? null;
      } else {
        // User explicitly cleared the field → null (clear semantics).
        computedActualHours = null;
      }

      // Bug #522: у IN_PROGRESS/ON_HOLD дозволяємо тільки patch actualHours
      // (на WO + на лініях). Інші поля (description, priority, dates...) сервер
      // відкине бо WO у тих статусах не у EDITABLE_STATUSES для full update.
      // У DRAFT/ESTIMATE/APPROVED → повний PATCH як було.
      if (canEdit) {
        await apiFetch(`/work-orders/${workOrderId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            documentDate: form.documentDate || undefined,
            priority: form.priority || undefined,
            repairCategory: form.repairCategory || undefined,
            description: form.description || undefined,
            liftId: form.liftId || undefined,
            plannedAt: localDateTimeToISO(form.plannedStartAt),
            dueDate: localDateTimeToISO(form.plannedEndAt),
            plannedHours: form.plannedHours !== '' ? toNumberOrUndefined(form.plannedHours) : null,
            actualHours: computedActualHours,
          }),
        });
      } else if (canEditActual) {
        // У IN_PROGRESS/ON_HOLD: лише actualHours на WO рівні. Бекенд update()
        // дозволяє це бо CLOSED_STATUSES.includes(IN_PROGRESS)=false.
        await apiFetch(`/work-orders/${workOrderId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            actualHours: computedActualHours,
          }),
        });
      }
      if (canEdit) {
        // sto-optimize: DELETEs are independent (each row by id) — fire in parallel
        // instead of N × sequential RTT. Promise.allSettled isolates per-row failures;
        // the next save() retry will still target the rows that didn't drop.
        const lineDeletes = deletedLineIds.current.map(lineId =>
          apiFetch(`/work-orders/${workOrderId}/lines/${lineId}`, { method: 'DELETE' }),
        );
        const partDeletes = deletedPartIds.current.map(partId =>
          apiFetch(`/work-orders/${workOrderId}/parts/${partId}`, { method: 'DELETE' }),
        );
        await Promise.allSettled([...lineDeletes, ...partDeletes]);
        deletedLineIds.current = [];
        deletedPartIds.current = [];
        // Sequentially POST нових + PATCH існуючих ліній. Кожен write на бекенді
        // викликає recalcTotals (aggregate + update WO.totalLabor/Parts/Amount).
        // Паралель = race у READ COMMITTED: тх1/тх2 одна одної не бачать у
        // SUM(amount), тому останній writer перетирає тotalAmount → втрачені суми.
        for (const line of lines.filter(l => !l.id)) {
          await apiFetch(`/work-orders/${workOrderId}/lines`, {
            method: 'POST',
            body: JSON.stringify({
              workId: line.workId,
              employeeId: line.employeeId,
              normoHours: toNumberOrUndefined(line.normoHours),
              actualHours: toNumberOrUndefined(line.actualHours),
              price: toNumberOrUndefined(line.price),
            }),
          });
        }
        // PATCH існуючих рядків щоб зберегти actualHours (та інші inline-edit зміни).
        for (const line of lines.filter(l => !!l.id)) {
          await apiFetch(`/work-orders/${workOrderId}/lines/${line.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              workId: line.workId,
              employeeId: line.employeeId,
              normoHours: toNumberOrUndefined(line.normoHours),
              actualHours: line.actualHours !== '' ? toNumberOrUndefined(line.actualHours) : null,
              price: toNumberOrUndefined(line.price),
            }),
          });
        }
        for (const part of parts.filter(p => !p.id)) {
          await apiFetch(`/work-orders/${workOrderId}/parts`, {
            method: 'POST',
            body: JSON.stringify({
              goodId: part.goodId,
              warehouseId: part.warehouseId,
              quantity: toNumberOrUndefined(part.quantity) ?? 1,
              price: toNumberOrUndefined(part.price),
              unitOfMeasureId: part.unitOfMeasureId || undefined,
            }),
          });
        }
      } else if (canEditActual) {
        // Bug #522: у IN_PROGRESS/ON_HOLD PATCH лише actualHours для існуючих рядків.
        // Жодних DELETE/POST/PATCH інших полів — бекенд відхилить як non-actual-only.
        for (const line of lines.filter(l => !!l.id)) {
          await apiFetch(`/work-orders/${workOrderId}/lines/${line.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              actualHours: line.actualHours !== '' ? toNumberOrUndefined(line.actualHours) : null,
            }),
          });
        }
      }
      // Bug #440: show calendar-sync dialog ONLY when planned dates actually
      // changed compared to the values loaded from the WO. Otherwise every save
      // (even a description-only edit) prompts the user with a misleading
      // "Планові дати наряду змінились" message and risks an unnecessary PATCH.
      const datesChanged =
        form.plannedStartAt !== initialPlannedRef.current.startAt ||
        form.plannedEndAt !== initialPlannedRef.current.endAt;
      if (
        syncCalendarEnabled &&
        workOrderId &&
        form.plannedStartAt &&
        form.plannedEndAt &&
        datesChanged
      ) {
        const startAt = localDateTimeToISO(form.plannedStartAt) ?? form.plannedStartAt;
        const endAt = localDateTimeToISO(form.plannedEndAt) ?? form.plannedEndAt;
        const ok = await confirm({
          title: 'Оновити слот в календарі?',
          message: 'Планові дати наряду змінились. Оновити відповідний слот в календарі?',
          confirmLabel: 'Так, оновити',
          cancelLabel: 'Ні',
        });
        if (ok) {
          try {
            const result = await apiFetch<{ updated: number }>(
              `/calendar/slots/by-work-order/${workOrderId}`,
              {
                method: 'PATCH',
                body: JSON.stringify({ startAt, endAt }),
              },
            );
            // Bug #441: коли у наряду немає слоту в календарі, backend silently
            // повертає { updated: 0 }. Без user-facing feedback клієнт думає що
            // синхронізація відбулась.
            if (result && result.updated === 0 && features.toastEnabled) {
              toast.info('Слот у календарі для цього наряду не знайдено');
            }
            // Освіжаємо snapshot, щоб повторні save() без змін дат не запитували знову.
            initialPlannedRef.current = {
              startAt: form.plannedStartAt,
              endAt: form.plannedEndAt,
            };
          } catch (err: unknown) {
            // Surface the error to user — silent failure hides 400/403/500 from backend.
            // Не блокуємо закриття: показуємо повідомлення, але форма далі закривається.
            const syncMsg = err instanceof Error ? err.message : 'Помилка синхронізації слоту';
            if (features.toastEnabled) toast.warning(`Слот календаря не оновлено: ${syncMsg}`);
            // eslint-disable-next-line no-console
            console.warn('Calendar sync failed:', err);
          }
        }
      }
      onUpdated?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  };

  const doTransition = async (newStatus: string) => {
    if (!workOrderId) return;
    if (newStatus === 'IN_PROGRESS' && calConflict?.anyConflict) {
      const ok = await confirm({
        title: 'Перевести наряд в "В роботі"?',
        message: `У календарі є перетин слотів (${calConflict.conflictSlots.length} шт.)${
          conflictWoNumbers ? ': ' + conflictWoNumbers : ''
        }. Продовжити?`,
        confirmLabel: 'Перевести',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    setTransitioningBoth(true);
    setError('');
    try {
      await apiFetch(`/work-orders/${workOrderId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus }),
      });
      setCurrentStatus(newStatus);
      onUpdated?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка переходу статусу');
    } finally {
      setTransitioningBoth(false);
    }
  };

  const allowedTransitions = isEditMode
    ? (WO_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS)
    : EMPTY_TRANSITIONS;

  const { prevStatus: statusPrevStep, nextStatus: statusNextStep } = useMemo(() => {
    const curIdx = WO_STATUS_ORDER.indexOf(currentStatus);
    const arrowTransitions = allowedTransitions.filter(s => !ARROW_SKIP_STATUSES.has(s));
    let prevStatus: string | undefined;
    for (let i = arrowTransitions.length - 1; i >= 0; i--) {
      const s = arrowTransitions[i];
      if (s && WO_STATUS_ORDER.indexOf(s) < curIdx) {
        prevStatus = s;
        break;
      }
    }
    const nextStatus = arrowTransitions.find((s: string) => WO_STATUS_ORDER.indexOf(s) > curIdx);
    return { prevStatus, nextStatus };
  }, [currentStatus, isEditMode]);

  // O(N×M) → O(N+M): Map.get instead of .find() per rendered row/onChange.
  const employeesById = useMemo(() => toIdMap(employees), [employees]);
  const warehousesById = useMemo(() => toIdMap(warehouses), [warehouses]);
  const unitsById = useMemo(() => toIdMap(units), [units]);
  const vehiclesById = useMemo(() => toIdMap(vehicles), [vehicles]);
  const liftsById = useMemo(() => toIdMap(lifts), [lifts]);
  const branchesById = useMemo(() => toIdMap(branches), [branches]);

  // Фактичні години редагуються тільки у статусах В роботі / Призупинено.
  const canEditActual =
    isEditMode && (currentStatus === 'IN_PROGRESS' || currentStatus === 'ON_HOLD');

  // Підсумки фактичних сум: actualHours ?? normoHours для кожного рядка (бо save()
  // надсилає на бекенд саме такий фолбек коли recalcActualHoursFromLines=true).
  // Bug #524: hasAny=true лише коли є ХОЧА Б ОДИН рядок з ЯВНО введеним
  // actualHours — інакше "Факт. роботи" tfoot дублював "Разом робіт" і вводив
  // користувача в оману (виглядало ніби факт. години = плановим).
  // Використовуємо toNumberOrUndefined (а не parseFloat) щоб коректно обробити
  // ukr-коми (1,5 → 1.5); save() теж використовує toNumberOrUndefined → totals
  // у tfoot збігаються з тим, що піде у PATCH backend.
  const actualTotals = useMemo(() => {
    let total = 0;
    let hasAnyActual = false;
    for (const l of lines) {
      const ah = toNumberOrUndefined(l.actualHours);
      const nh = toNumberOrUndefined(l.normoHours);
      const h = ah ?? nh;
      const p = toNumberOrUndefined(l.price);
      if (h != null && p != null) total += h * p;
      if (ah != null) hasAnyActual = true;
    }
    return { total, hasAny: hasAnyActual };
  }, [lines]);

  // Live sum of (actualHours ?? normoHours) across lines — shown in "Фактичні показники → Нормогодин"
  // when recalcActualHoursEnabled so the user sees the computed value before saving.
  const liveActualHours = useMemo(() => {
    if (!recalcActualHoursEnabled || lines.length === 0) return null;
    let sum = 0;
    for (const l of lines) {
      const ah = toNumberOrUndefined(l.actualHours);
      const nh = toNumberOrUndefined(l.normoHours);
      sum += ah ?? nh ?? 0;
    }
    return sum;
  }, [lines, recalcActualHoursEnabled]);

  // Single-pass totals: one scan over lines/parts, two accumulators (total + vat).
  const linesTotals = useMemo(
    () =>
      calcVatTotals(
        lines.map(l => ({
          qty: toNumberOrUndefined(l.normoHours),
          price: toNumberOrUndefined(l.price),
        })),
        vatRate,
      ),
    [lines, vatRate],
  );
  const partsTotals = useMemo(
    () =>
      calcVatTotals(
        parts.map(pt => ({
          qty: toNumberOrUndefined(pt.quantity),
          price: toNumberOrUndefined(pt.price),
        })),
        vatRate,
      ),
    [parts, vatRate],
  );
  const canEdit = isEditMode ? WO_EDITABLE_STATUSES.includes(currentStatus) : true;
  // Share/print/SMS allowed in DRAFT/ESTIMATE/APPROVED; after IN_PROGRESS the public link is inactive.
  const canShare = isEditMode && WO_SHAREABLE_STATUSES.includes(currentStatus);

  const [saveAsOpen, setSaveAsOpen] = useState(false);

  const handlePrint = async () => {
    if (!workOrderId) return;
    // Open blank window synchronously inside click handler — browsers block window.open after await.
    const win = window.open('', '_blank');
    setShareLoading(true);
    try {
      const { token } = await apiFetch<{ token: string }>(
        `/work-orders/${workOrderId}/share-token`,
        { method: 'POST' },
      );
      if (win) {
        win.location.href = `/estimate/${token}?print=1`;
      } else {
        // Popup blocked — fallback: navigate directly (user already in click handler context)
        window.open(`/estimate/${token}?print=1`, '_blank');
      }
    } catch (e: unknown) {
      win?.close();
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handleSaveAs = async (format: 'pdf' | 'xlsx' | 'docx') => {
    setSaveAsOpen(false);
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      const { token } = await apiFetch<{ token: string }>(
        `/work-orders/${workOrderId}/share-token`,
        { method: 'POST' },
      );
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const res = await fetch(`${apiBase}/api/public/work-orders/${token}/export/${format}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const match =
        disposition.match(/filename\*=UTF-8''(.+)/i) ?? disposition.match(/filename="?([^"]+)"?/i);
      const filename = match ? decodeURIComponent(match[1]) : `Кошторис.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handleShare = async () => {
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      const { token } = await apiFetch<{ token: string }>(
        `/work-orders/${workOrderId}/share-token`,
        { method: 'POST' },
      );
      await navigator.clipboard.writeText(`${window.location.origin}/estimate/${token}`);
      if (features.toastEnabled) toast.success('Посилання скопійовано');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handleSendSms = async () => {
    if (!workOrderId) return;
    setSmsLoading(true);
    try {
      // baseUrl формується на сервері з ConfigService('WEB_PUBLIC_URL') —
      // НЕ передаємо з клієнта (open-redirect/phishing ризик).
      await apiFetch(`/work-orders/${workOrderId}/send-estimate-sms`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (features.toastEnabled) toast.success('SMS відправлено клієнту');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка відправки SMS';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setSmsLoading(false);
    }
  };

  const canInvoice = isEditMode && WO_INVOICEABLE_STATUSES.includes(currentStatus);

  const handleInvoice = async () => {
    if (!workOrderId) return;
    // Bug #404: захоплюємо початковий статус ДО transition, щоб мати куди rollback при failure.
    const statusBeforeTransition = currentStatus;
    let transitionedHere = false;
    setInvoiceLoading(true);
    try {
      if (currentStatus === 'COMPLETED') {
        await apiFetch(`/work-orders/${workOrderId}/transition`, {
          method: 'POST',
          body: JSON.stringify({ status: 'INVOICED' }),
        });
        setCurrentStatus('INVOICED');
        transitionedHere = true;
        onUpdated?.();
      }
      const invoice = await apiFetch<{ id: string; number: string }>(
        `/invoices/from-work-order/${workOrderId}`,
        { method: 'POST' },
      );
      // Bug #409: тригернути перезавантаження LinkedDocumentsPanel, інакше "Документи"
      // tab не показує щойно створений рахунок без manual tab-switch.
      setLinkedDocsRefreshKey(k => k + 1);
      if (features.toastEnabled) {
        toast.success(`Рахунок ${invoice.number} створено`, 6000, {
          label: 'Відкрити',
          onClick: () => window.open(`/invoices/${invoice.id}`, '_blank'),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('вже існує')) {
        setInvoiceConflict(true);
      } else {
        // Bug #404: якщо ми щойно перевели COMPLETED→INVOICED і invoice create провалився —
        // rollback transition назад у COMPLETED, щоб FSM-інваріант не порушувався.
        if (transitionedHere && statusBeforeTransition === 'COMPLETED') {
          try {
            await apiFetch(`/work-orders/${workOrderId}/transition`, {
              method: 'POST',
              body: JSON.stringify({ status: 'COMPLETED' }),
            });
            setCurrentStatus('COMPLETED');
            onUpdated?.();
          } catch {
            // warn-only: manual recovery потрібен. Original error все одно показуємо нижче.
          }
        }
        if (features.toastEnabled) toast.error(msg || 'Помилка виставлення рахунку');
        else setError(msg || 'Помилка');
      }
    } finally {
      setInvoiceLoading(false);
    }
  };

  const handleInvoiceRefresh = async () => {
    if (!workOrderId) return;
    setInvoiceConflict(false);
    setInvoiceLoading(true);
    try {
      const invoice = await apiFetch<{ id: string; number: string }>(
        `/invoices/from-work-order/${workOrderId}/refresh`,
        { method: 'POST' },
      );
      // Bug #409: refresh змінив totals/lines рахунку → перезавантажити LinkedDocumentsPanel
      // щоб totals у preview popup були свіжими.
      setLinkedDocsRefreshKey(k => k + 1);
      if (features.toastEnabled) {
        toast.success(`Рахунок ${invoice.number} оновлено`, 6000, {
          label: 'Відкрити',
          onClick: () => window.open(`/invoices/${invoice.id}`, '_blank'),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка оновлення рахунку';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setInvoiceLoading(false);
    }
  };

  const handleInvoiceOpen = async () => {
    if (!workOrderId) return;
    setInvoiceConflict(false);
    try {
      const inv = await apiFetch<{ id: string } | null>(
        `/invoices/from-work-order/${workOrderId}/find`,
      );
      if (inv?.id) {
        window.open(`/invoices/${inv.id}`, '_blank');
      } else {
        // Bug #405: /find повертає null коли рахунку немає (за дизайном — не 404).
        // Race: інший admin скасував рахунок між POST і кліком. Користувач має знати.
        if (features.toastEnabled) {
          toast.warning('Рахунок не знайдено. Можливо, його було скасовано.');
        } else {
          setError('Рахунок не знайдено. Можливо, його було скасовано.');
        }
      }
    } catch {
      window.open(`/invoices?workOrderId=${workOrderId}`, '_blank');
    }
  };

  // sto-optimize: stable onClose ref для Modal. Modal має useEffect що додає
  // document.addEventListener('keydown') з useCallback([onClose]) — кожен новий
  // ref → effect re-fires → removeEventListener + addEventListener + body
  // overflow re-write. Без useCallback ця модалка (з частим typing у inputs)
  // тригерила re-attach на КОЖЕН keystroke.
  //
  // Bug #381 regression: читаємо `saving`/`transitioning` ВИКЛЮЧНО з ref'ів —
  // вони оновлюються СИНХРОННО у setSavingBoth/setTransitioningBoth ДО React state-flush.
  // Без ref'а closure захоплює застарілий saving=false коли `create()` ще у `await POST`
  // → Modal закривається на Escape всупереч guard'у (race window що ловить test #381).
  //
  // Бонус: deps = [onClose] (не [saving, transitioning, onClose]) — ref reads не
  // повинні бути у deps. Stable identity → Modal keydown listener не перевідв'язується
  // при кожному flip saving/transitioning (раніше re-attach на START + END кожного
  // save/transition; зараз лише при зміні onClose у parent).
  const handleModalClose = useCallback(() => {
    if (savingRef.current || transitioningRef.current) return;
    setActiveTab('main');
    onClose();
  }, [onClose]);

  // Column header widths (shared between table header and input row grid)
  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
        title={isEditMode ? woNumber || 'Наряд' : 'Новий наряд'}
        size="content"
        extraHeaderActions={
          isEditMode && workOrderId ? (
            <button
              onClick={() => {
                minimizeModal({
                  kind: 'modal',
                  label: woNumber || 'Наряд',
                  modalKey: 'work-order',
                  restoreProps: { workOrderId },
                });
                onMinimize?.(); // signal caller to skip closeTab
                setActiveTab('main');
                onClose();
              }}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
              title="Згорнути у вкладку"
              disabled={saving || transitioning}
            >
              <Minus className="h-4 w-4" />
            </button>
          ) : undefined
        }
        footer={
          isEditMode ? (
            <div className="flex items-center justify-between w-full gap-2">
              <div>
                {allowedTransitions.includes('CANCELLED') && (
                  <Button
                    variant="destructive"
                    onClick={() => doTransition('CANCELLED')}
                    loading={transitioning}
                    disabled={transitioning || saving}
                    size="sm"
                  >
                    Скасувати
                  </Button>
                )}
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                {canShare && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrint}
                      loading={shareLoading}
                      disabled={shareLoading || smsLoading || saving || transitioning}
                      title="Відкрити для друку"
                    >
                      <Printer size={15} className="mr-1" />
                      Друк
                    </Button>
                    <div className="relative">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSaveAsOpen(v => !v)}
                        disabled={shareLoading || smsLoading || saving || transitioning}
                        title="Зберегти як..."
                      >
                        <Download size={15} className="mr-1" />
                        Зберегти як
                        <ChevronDown size={13} className="ml-1" />
                      </Button>
                      {saveAsOpen && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => setSaveAsOpen(false)}
                          />
                          <div className="absolute bottom-full mb-1 right-0 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
                            {(
                              [
                                { fmt: 'pdf', label: 'PDF' },
                                { fmt: 'xlsx', label: 'Excel (.xlsx)' },
                                { fmt: 'docx', label: 'Word (.docx)' },
                              ] as const
                            ).map(({ fmt, label }) => (
                              <button
                                key={fmt}
                                type="button"
                                onClick={() => void handleSaveAs(fmt)}
                                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors"
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleShare}
                      loading={shareLoading}
                      disabled={shareLoading || smsLoading || saving || transitioning}
                      title="Скопіювати посилання"
                    >
                      <Share2 size={15} className="mr-1" />
                      Поділитись
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSendSms}
                      loading={smsLoading}
                      disabled={shareLoading || smsLoading || saving || transitioning}
                      title="Відправити SMS клієнту"
                    >
                      <MessageSquare size={15} className="mr-1" />
                      SMS
                    </Button>
                  </>
                )}
                {canInvoice && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleInvoice}
                    loading={invoiceLoading}
                    disabled={
                      invoiceLoading || saving || transitioning || shareLoading || smsLoading
                    }
                    title="Виставити рахунок"
                  >
                    <Receipt size={15} className="mr-1" />
                    Виставити рахунок
                  </Button>
                )}
                {(canEdit || canEditActual) && (
                  <Button
                    onClick={save}
                    loading={saving}
                    disabled={
                      saving || transitioning || shareLoading || smsLoading || invoiceLoading
                    }
                  >
                    Зберегти зміни
                  </Button>
                )}
                <Button variant="outline" onClick={onClose} disabled={saving || transitioning}>
                  Закрити
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={create}
              loading={saving}
              disabled={!form.branchId || !form.counterpartyId || !form.vehicleId}
              className="w-full sm:w-auto"
            >
              Створити наряд
            </Button>
          )
        }
      >
        {/* Tab switcher — тільки в режимі редагування */}
        {isEditMode && (
          <div className="flex border-b border-border mb-4 -mx-0">
            <button
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === 'main'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveTab('main')}
            >
              Основне
            </button>
            <button
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === 'documents'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveTab('documents')}
            >
              Документи
            </button>
          </div>
        )}

        {/* Вкладка "Документи" */}
        {activeTab === 'documents' && workOrderId && (
          <LinkedDocumentsPanel workOrderId={workOrderId} refreshKey={linkedDocsRefreshKey} />
        )}

        {/* Вкладка "Основне" */}
        {activeTab === 'main' && (
          <>
            {editModeLoading && (
              <div className="flex justify-center py-8 text-sm text-muted-foreground">
                Завантаження…
              </div>
            )}
            {error && (
              <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            {!editModeLoading && isEditMode && !canEdit && (
              <div className="mb-4 text-[13px] text-warning bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2">
                Наряд у статусі «{WO_STATUS_LABELS[currentStatus] ?? currentStatus}» — редагування
                недоступне
              </div>
            )}

            <div className="flex flex-col min-h-[70dvh]">
              {/* ── Collapsible header ────────────────────────────────────── */}
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
                style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
              >
                <div className="overflow-hidden">
                  <div className="space-y-4 pb-1">
                    {/* Рядок 1: Номер | Дата документа | Статус */}
                    <div className="grid grid-cols-3 gap-4">
                      <Input
                        label="Номер"
                        value={isEditMode && woNumber ? woNumber : '— присвоюється автоматично —'}
                        disabled
                        readOnly
                        className="h-8 text-[13px]"
                      />
                      <Input
                        label="Дата документа"
                        type="date"
                        value={form.documentDate}
                        onChange={e => setForm(f => ({ ...f, documentDate: e.target.value }))}
                        disabled={!canEdit}
                        className="h-8 text-[13px]"
                      />
                      {isEditMode ? (
                        <div>
                          <label className="block text-[13px] font-medium text-foreground mb-1">
                            Статус
                          </label>
                          <div ref={statusMenuRef} className="relative flex items-center gap-1">
                            <button
                              type="button"
                              disabled={transitioning || !statusPrevStep}
                              onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                              className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                              <span className="max-w-[80px] truncate">
                                {statusPrevStep
                                  ? (WO_STATUS_LABELS[statusPrevStep] ?? statusPrevStep)
                                  : '—'}
                              </span>
                            </button>
                            <Tooltip
                              content={WO_STATUS_DESCRIPTIONS[currentStatus] ?? currentStatus}
                            >
                              <button
                                type="button"
                                disabled={transitioning}
                                onClick={() => setStatusMenuOpen(o => !o)}
                                className={cn(
                                  'text-sm font-medium px-2.5 py-1 rounded-full transition-colors',
                                  STATUS_COLORS[currentStatus] ??
                                    'bg-secondary text-muted-foreground',
                                  !transitioning && 'cursor-pointer hover:opacity-80',
                                )}
                              >
                                {WO_STATUS_LABELS[currentStatus] ?? currentStatus}
                              </button>
                            </Tooltip>
                            <button
                              type="button"
                              disabled={transitioning || !statusNextStep}
                              onClick={() => statusNextStep && void doTransition(statusNextStep)}
                              className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <span className="max-w-[80px] truncate">
                                {statusNextStep
                                  ? (WO_STATUS_LABELS[statusNextStep] ?? statusNextStep)
                                  : '—'}
                              </span>
                              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                            </button>
                            {statusMenuOpen && allowedTransitions.length > 0 && (
                              <div className="absolute top-full left-0 mt-1 z-50 min-w-[160px] rounded-lg border border-border bg-surface shadow-lg py-1">
                                {allowedTransitions.map(s => (
                                  <button
                                    key={s}
                                    type="button"
                                    disabled={transitioning}
                                    onClick={() => {
                                      setStatusMenuOpen(false);
                                      void doTransition(s);
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors disabled:opacity-50"
                                  >
                                    {TRANSITION_LABELS[s] ?? s}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className="block text-[13px] font-medium text-foreground mb-1">
                            Статус
                          </label>
                          <Tooltip content={WO_STATUS_DESCRIPTIONS['DRAFT']}>
                            <span
                              className={cn(
                                'inline-block text-sm font-medium px-2.5 py-1 rounded-full cursor-default',
                                STATUS_COLORS['DRAFT'] ?? 'bg-secondary text-muted-foreground',
                              )}
                            >
                              {WO_STATUS_LABELS['DRAFT'] ?? 'Чернетка'}
                            </span>
                          </Tooltip>
                        </div>
                      )}
                    </div>

                    {/* Рядок 2: Філія | Підйомник | Пріоритет */}
                    <div className="grid grid-cols-3 gap-4">
                      <Select
                        label="Філія"
                        required
                        value={form.branchId}
                        onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
                        disabled={!canEdit || isEditMode || branches.length === 1}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        {branches.length !== 1 && <option value="">— Оберіть —</option>}
                        {branches.map(b => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="Підйомник"
                        value={form.liftId}
                        onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
                        disabled={!canEdit}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        <option value="">— Без підйомника —</option>
                        {lifts.map(l => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="Пріоритет"
                        value={form.priority}
                        onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                        disabled={!canEdit}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        {Object.entries(WO_PRIORITY_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </Select>
                    </div>

                    {/* Планові та фактичні показники */}
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="grid grid-cols-2 divide-x divide-border">
                        <div className="px-3 py-1.5 bg-secondary/50 text-xs font-medium text-muted-foreground">
                          Планові показники
                        </div>
                        <div className="px-3 py-1.5 bg-secondary/50 text-xs font-medium text-muted-foreground">
                          Фактичні показники
                        </div>
                      </div>
                      <div className="grid grid-cols-2 divide-x divide-border">
                        <div className="grid grid-cols-[1fr_1fr_auto] gap-3 p-3">
                          <DateTimePickerInput
                            label="Дата та час початку"
                            value={form.plannedStartAt}
                            onChange={handlePlannedStartChange}
                            disabled={!canEdit}
                            inputClassName="h-8 text-[13px]"
                          />
                          <DateTimePickerInput
                            label="Дата та час завершення"
                            value={form.plannedEndAt}
                            onChange={handlePlannedEndChange}
                            disabled={!canEdit}
                            inputClassName="h-8 text-[13px]"
                          />
                          <div className="flex flex-col gap-1 min-w-[80px]">
                            <label className="text-[11px] text-muted-foreground font-medium">
                              Нормогодин
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.5"
                              value={form.plannedHours}
                              onChange={handlePlannedHoursChange}
                              disabled={!canEdit}
                              placeholder="0"
                              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] tabular-nums disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-[1fr_1fr_auto] gap-3 p-3">
                          <DateTimePickerInput
                            label="Дата та час початку"
                            value=""
                            onChange={NOOP_DT_CHANGE}
                            disabled
                            inputClassName="h-8 text-[13px]"
                          />
                          <DateTimePickerInput
                            label="Дата та час завершення"
                            value=""
                            onChange={NOOP_DT_CHANGE}
                            disabled
                            inputClassName="h-8 text-[13px]"
                          />
                          <div className="flex flex-col gap-1 min-w-[80px]">
                            <label className="text-[11px] text-muted-foreground font-medium">
                              Нормогодин
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.5"
                              value={liveActualHours != null ? liveActualHours : form.actualHours}
                              onChange={handleActualHoursChange}
                              disabled={!canEdit || liveActualHours != null}
                              placeholder="0"
                              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] tabular-nums disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Попередження про конфлікт у календарі */}
                    {calConflict?.anyConflict && (
                      <div className="rounded-md bg-warning-subtle border border-warning/20 px-3 py-2 text-[12px] text-warning">
                        ⚠{calConflict.liftConflict && ' Підйомник зайнятий.'}
                        {calConflict.employeeConflict && ' Механік зайнятий.'} Є перетин з{' '}
                        {calConflict.conflictSlots.length} слотом(и) у календарі
                        {conflictWoNumbers && <> ({conflictWoNumbers})</>}. Можна зберегти попри це.
                      </div>
                    )}

                    {/* Клієнт | Договір / Автомобіль | Категорія */}
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[13px] font-medium text-foreground mb-1">
                            Клієнт <span className="text-destructive">*</span>
                          </label>
                          <EntityPickerField<HeaderCpItem>
                            display={counterpartyDisplayName}
                            className="h-8 text-[13px]"
                            placeholder="Пошук клієнта…"
                            ariaLabel="Клієнт"
                            onPick={() => setCpPickerOpen(true)}
                            onSearch={fetchCpHeaderItems}
                            onSearchSelect={item => {
                              setCounterpartyDisplayName(item.primary);
                              setCpPhone(item.phone ?? '');
                              setForm(f => ({
                                ...f,
                                counterpartyId: item.id,
                                vehicleId: '',
                                contractId: '',
                              }));
                              setVehicles([]);
                              setContracts([]);
                              loadVehicles(item.id);
                              loadContracts(item.id);
                            }}
                            onClear={() => {
                              setCounterpartyDisplayName('');
                              setCpPhone('');
                              setForm(f => ({
                                ...f,
                                counterpartyId: '',
                                vehicleId: '',
                                contractId: '',
                              }));
                              setVehicles([]);
                              setContracts([]);
                            }}
                            hidePick={false}
                          />
                        </div>
                        <Select
                          label="Договір"
                          value={form.contractId}
                          onChange={e => setForm(f => ({ ...f, contractId: e.target.value }))}
                          disabled={!canEdit || !form.counterpartyId || contracts.length === 0}
                          className="h-8 text-[13px] py-0.5 px-2 pr-7"
                        >
                          <option value="">— Без договору —</option>
                          {contracts.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.number ? `${c.number} — ` : ''}
                              {c.title}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <Select
                          label="Автомобіль"
                          required
                          value={form.vehicleId}
                          onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
                          disabled={!canEdit || !form.counterpartyId}
                          className="h-8 text-[13px] py-0.5 px-2 pr-7"
                        >
                          <option value="">— Оберіть —</option>
                          {vehicles.map(v => (
                            <option key={v.id} value={v.id}>
                              {v.make} {v.model}
                              {v.licensePlate ? ` (${v.licensePlate})` : ''}
                            </option>
                          ))}
                        </Select>
                        <Select
                          label="Категорія ремонту"
                          value={form.repairCategory}
                          onChange={e => setForm(f => ({ ...f, repairCategory: e.target.value }))}
                          disabled={!canEdit}
                          className="h-8 text-[13px] py-0.5 px-2 pr-7"
                        >
                          <option value="">— Не вказано —</option>
                          {Object.entries(WO_CATEGORY_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>

                    {/* Секція: Опис */}
                    <div>
                      <Input
                        label="Опис"
                        value={form.description}
                        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                        disabled={!canEdit}
                        placeholder="Заміна масла, колодок..."
                        className="h-8 text-[13px]"
                      />
                    </div>
                  </div>
                </div>
                {/* /overflow-hidden */}
              </div>
              {/* /grid collapsible */}

              {/* ── Header toggle strip ───────────────────────────────────── */}
              <button
                type="button"
                onClick={() => setHeaderCollapsed(c => !c)}
                className={[
                  'flex items-center gap-2 w-full py-1.5 px-2 text-[11px]',
                  'hover:bg-secondary/60 transition-colors select-none shrink-0',
                  'border-t border-border',
                ].join(' ')}
              >
                {/* Summary chips — visible only when collapsed */}
                <span className="flex-1 flex items-center gap-2 min-w-0 overflow-hidden">
                  {headerCollapsed ? (
                    <>
                      {counterpartyDisplayName && (
                        <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground font-medium truncate max-w-50">
                          {counterpartyDisplayName}
                        </span>
                      )}
                      {cpPhone && (
                        <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground truncate max-w-35">
                          {cpPhone}
                        </span>
                      )}
                      {(() => {
                        const v = form.vehicleId ? vehiclesById.get(form.vehicleId) : null;
                        return v ? (
                          <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground font-medium truncate max-w-45">
                            {v.make} {v.model}
                            {v.licensePlate ? ` · ${v.licensePlate}` : ''}
                          </span>
                        ) : null;
                      })()}
                      {(() => {
                        const l = form.liftId ? liftsById.get(form.liftId) : null;
                        return l ? (
                          <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground truncate max-w-30">
                            {l.name}
                          </span>
                        ) : null;
                      })()}
                      {(() => {
                        const b = form.branchId ? branchesById.get(form.branchId) : null;
                        return b ? (
                          <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground truncate max-w-35">
                            {b.name}
                          </span>
                        ) : null;
                      })()}
                      {!counterpartyDisplayName && !form.vehicleId && (
                        <span className="text-muted-foreground">Розгорнути шапку</span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Шапка документа</span>
                  )}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground shrink-0">
                  {headerCollapsed ? 'Розгорнути' : 'Згорнути'}
                  <ChevronUp
                    className="h-3 w-3 transition-transform duration-300"
                    style={{ transform: headerCollapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}
                  />
                </span>
              </button>

              {/* ── Tables area — takes remaining space ──────────────────── */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {/* Секція: Роботи — таблиця з inline рядком вводу в tbody */}
                <div className="pt-4 pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-muted-foreground">Роботи</p>
                    {canEdit && !showLineInput && (
                      <button
                        type="button"
                        onClick={() => {
                          setNewLine(EMPTY_LINE);
                          setShowLineInput(true);
                        }}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Додати
                      </button>
                    )}
                  </div>

                  <div className="rounded-lg border border-border overflow-visible">
                    <table className="w-full table-fixed text-[12px]">
                      <colgroup>
                        <col />
                        <col className="w-44" />
                        <col className="w-20" />
                        <col className="w-20" />
                        <col className="w-24" />
                        {vatMode !== 'NONE' && <col className="w-20" />}
                        <col className="w-24" />
                        <col className="w-24" />
                        <col className="w-9" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border bg-secondary/40">
                          <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Назва роботи
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Виконавець
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Год (план)
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Год (факт.)
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Ціна, ₴
                          </th>
                          {vatMode !== 'NONE' && (
                            <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                              ПДВ, ₴
                            </th>
                          )}
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Сума, ₴
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Сума (факт.), ₴
                          </th>
                          <th />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {lines.length === 0 && !showLineInput && (
                          <tr>
                            <td
                              // Bug #435: VAT-колонка умовна (vatMode !== 'NONE'), тож
                              // загальна кількість колонок 6 або 7. Парна таблиця "Товари"
                              // вже робить умовний colSpan; для works був хардкод 6 →
                              // visual drift коли VAT-колонка є.
                              colSpan={vatMode !== 'NONE' ? 9 : 8}
                              className="px-3 py-4 text-center text-[12px] text-muted-foreground"
                            >
                              Натисніть «Додати» щоб додати роботу
                            </td>
                          </tr>
                        )}
                        {lines.map(line => {
                          const emp = employeesById.get(line.employeeId);
                          const h = toNumberOrUndefined(line.normoHours);
                          const p = toNumberOrUndefined(line.price);
                          const sum = h != null && p != null ? h * p : null;
                          return (
                            <tr
                              key={line._key}
                              className={
                                editingLineKey === line._key
                                  ? 'bg-primary/5'
                                  : 'bg-surface hover:bg-secondary/30 transition-colors'
                              }
                            >
                              {editingLineKey === line._key ? (
                                <>
                                  <td className="px-2 py-1.5">
                                    <EntityPickerField<WorkPickerItem>
                                      display={editingLine.workName}
                                      placeholder="Пошук роботи..."
                                      ariaLabel="Робота"
                                      onPick={() => canEdit && setEditWorkPickerOpen(true)}
                                      onSearch={fetchWorks}
                                      onSearchSelect={w =>
                                        setEditingLine(l => ({
                                          ...l,
                                          workId: w.id,
                                          workName: w.name,
                                          normoHours: String(w.normoHours),
                                          price: String(w.price),
                                        }))
                                      }
                                      onClear={() =>
                                        setEditingLine(l => ({ ...l, workId: '', workName: '' }))
                                      }
                                      disabled={!canEdit}
                                    />
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Select
                                      value={editingLine.employeeId}
                                      onChange={e =>
                                        setEditingLine(l => ({ ...l, employeeId: e.target.value }))
                                      }
                                      disabled={!canEdit}
                                    >
                                      <option value="">— Механік —</option>
                                      {employees.map(e => (
                                        <option key={e.id} value={e.id}>
                                          {e.lastName} {e.firstName}
                                        </option>
                                      ))}
                                    </Select>
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Input
                                      placeholder="0"
                                      type="number"
                                      value={editingLine.normoHours}
                                      onChange={e =>
                                        setEditingLine(l => ({ ...l, normoHours: e.target.value }))
                                      }
                                      min="0"
                                      step="0.1"
                                      disabled={!canEdit}
                                    />
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Input
                                      placeholder="—"
                                      type="number"
                                      value={editingLine.actualHours}
                                      onChange={e =>
                                        setEditingLine(l => ({
                                          ...l,
                                          actualHours: e.target.value,
                                        }))
                                      }
                                      min="0"
                                      step="0.1"
                                      disabled={!canEditActual}
                                    />
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Input
                                      placeholder="0"
                                      type="number"
                                      value={editingLine.price}
                                      onChange={e =>
                                        setEditingLine(l => ({ ...l, price: e.target.value }))
                                      }
                                      min="0"
                                      disabled={!canEdit}
                                    />
                                  </td>
                                  {vatMode !== 'NONE' && (
                                    <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                      {(() => {
                                        const h = toNumberOrUndefined(editingLine.normoHours);
                                        const p = toNumberOrUndefined(editingLine.price);
                                        return h != null && p != null && vatRate > 0
                                          ? ((h * p * vatRate) / 100).toFixed(2)
                                          : '—';
                                      })()}
                                    </td>
                                  )}
                                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                    {(() => {
                                      const h = toNumberOrUndefined(editingLine.normoHours);
                                      const p = toNumberOrUndefined(editingLine.price);
                                      return h != null && p != null ? (h * p).toFixed(2) : '—';
                                    })()}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                    {(() => {
                                      const ah = toNumberOrUndefined(editingLine.actualHours);
                                      const nh = toNumberOrUndefined(editingLine.normoHours);
                                      const h = ah ?? nh;
                                      const p = toNumberOrUndefined(editingLine.price);
                                      return h != null && p != null ? (h * p).toFixed(2) : '—';
                                    })()}
                                  </td>
                                  <td className="px-1.5 py-1.5">
                                    <div className="flex flex-col gap-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (!editingLine.workId || !editingLine.employeeId)
                                            return;
                                          setLines(prev =>
                                            prev.map(l =>
                                              l._key === line._key
                                                ? { ...editingLine, _key: l._key }
                                                : l,
                                            ),
                                          );
                                          setEditingLineKey(null);
                                        }}
                                        disabled={!editingLine.workId || !editingLine.employeeId}
                                        title="Зберегти"
                                        className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingLineKey(null)}
                                        title="Скасувати"
                                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td className="px-3 py-1.5 text-foreground truncate">
                                    {line.workName}
                                  </td>
                                  <td className="px-2 py-1.5 text-muted-foreground truncate">
                                    {emp ? `${emp.lastName} ${emp.firstName}` : '—'}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {line.normoHours || '—'}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {line.actualHours || '—'}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {line.price || '—'}
                                  </td>
                                  {vatMode !== 'NONE' && (
                                    <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                      {h != null && p != null && vatRate > 0
                                        ? ((h * p * vatRate) / 100).toFixed(2)
                                        : '—'}
                                    </td>
                                  )}
                                  <td className="px-2 py-1.5 text-left tabular-nums font-medium text-foreground">
                                    {sum != null ? sum.toFixed(2) : '—'}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {(() => {
                                      const ah = toNumberOrUndefined(line.actualHours);
                                      const nh = toNumberOrUndefined(line.normoHours);
                                      const h = ah ?? nh;
                                      return h != null && p != null ? (h * p).toFixed(2) : '—';
                                    })()}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-left">
                                    <div className="flex flex-col gap-1 items-end">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingLineKey(line._key);
                                          setEditingLine({
                                            workId: line.workId,
                                            workName: line.workName,
                                            employeeId: line.employeeId,
                                            normoHours: line.normoHours,
                                            actualHours: line.actualHours,
                                            price: line.price,
                                          });
                                        }}
                                        disabled={saving || (!canEdit && !canEditActual)}
                                        aria-label="Редагувати роботу"
                                        title={
                                          canEditActual && !canEdit
                                            ? 'Ввести год (факт.)'
                                            : 'Редагувати'
                                        }
                                        className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (line.id) deletedLineIds.current.push(line.id);
                                          setLines(prev => {
                                            const updated = prev.filter(l => l._key !== line._key);
                                            if (recalcPlannedHoursEnabled) {
                                              setForm(f => {
                                                const newHours = calcPlannedHoursFromLines(
                                                  f.plannedHours,
                                                  updated,
                                                );
                                                const newEnd =
                                                  newHours !== f.plannedHours && f.plannedStartAt
                                                    ? calcEndFromHours(
                                                        f.plannedStartAt,
                                                        Number(newHours.replace(',', '.')),
                                                      )
                                                    : f.plannedEndAt;
                                                return {
                                                  ...f,
                                                  plannedHours: newHours,
                                                  plannedEndAt: newEnd || f.plannedEndAt,
                                                };
                                              });
                                            }
                                            return updated;
                                          });
                                        }}
                                        disabled={saving || !canEdit}
                                        aria-label="Видалити роботу"
                                        title="Видалити"
                                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })}

                        {/* Рядок вводу — з'являється після кліку "+ Додати" */}
                        {showLineInput && (
                          <tr className="bg-primary/5 border-t-2 border-primary/20">
                            <td className="px-2 py-1.5">
                              <EntityPickerField<WorkPickerItem>
                                display={newLine.workName}
                                placeholder="Пошук роботи..."
                                ariaLabel="Робота"
                                onPick={() => setWorkPickerOpen(true)}
                                onSearch={fetchWorks}
                                onSearchSelect={w =>
                                  setNewLine(l => ({
                                    ...l,
                                    workId: w.id,
                                    workName: w.name,
                                    normoHours: String(w.normoHours),
                                    price: String(w.price),
                                  }))
                                }
                                onClear={() => setNewLine(EMPTY_LINE)}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Select
                                value={newLine.employeeId}
                                onChange={e =>
                                  setNewLine(l => ({ ...l, employeeId: e.target.value }))
                                }
                              >
                                <option value="">— Механік —</option>
                                {employees.map(e => (
                                  <option key={e.id} value={e.id}>
                                    {e.lastName} {e.firstName}
                                  </option>
                                ))}
                              </Select>
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                placeholder="0"
                                type="number"
                                value={newLine.normoHours}
                                onChange={e =>
                                  setNewLine(l => ({ ...l, normoHours: e.target.value }))
                                }
                                min="0"
                                step="0.1"
                              />
                            </td>
                            <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                              —
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                placeholder="0"
                                type="number"
                                value={newLine.price}
                                onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                                min="0"
                              />
                            </td>
                            {vatMode !== 'NONE' && (
                              <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                {(() => {
                                  const h = toNumberOrUndefined(newLine.normoHours);
                                  const p = toNumberOrUndefined(newLine.price);
                                  return h != null && p != null && vatRate > 0
                                    ? ((h * p * vatRate) / 100).toFixed(2)
                                    : '—';
                                })()}
                              </td>
                            )}
                            <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                              {(() => {
                                const h = toNumberOrUndefined(newLine.normoHours);
                                const p = toNumberOrUndefined(newLine.price);
                                return h != null && p != null ? (h * p).toFixed(2) : '—';
                              })()}
                            </td>
                            <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                              —
                            </td>
                            <td className="px-1.5 py-1.5">
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  onClick={addLine}
                                  disabled={!newLine.workId || !newLine.employeeId || saving}
                                  title="Зберегти рядок"
                                  className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setNewLine(EMPTY_LINE);
                                    setShowLineInput(false);
                                  }}
                                  title="Скасувати"
                                  className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {lines.length > 0 && (
                        <tfoot>
                          <tr className="bg-secondary/50 border-t border-border">
                            <td
                              colSpan={5}
                              className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                            >
                              Разом робіт:
                            </td>
                            {vatMode !== 'NONE' && (
                              <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                                {linesTotals.vat.toFixed(2)}
                              </td>
                            )}
                            <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                              {linesTotals.total.toFixed(2)}
                            </td>
                            <td />
                            <td />
                          </tr>
                          {actualTotals.hasAny && (
                            <tr className="bg-secondary/30 border-t border-border/50">
                              <td
                                colSpan={vatMode !== 'NONE' ? 7 : 6}
                                className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                              >
                                Факт. роботи:
                              </td>
                              <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                                {actualTotals.total.toFixed(2)}
                              </td>
                              <td />
                            </tr>
                          )}
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>

                {/* Секція: Товари */}
                <div className="pt-4 pb-2">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-muted-foreground">Товари / Запчастини</p>
                    {canEdit && !showPartInput && (
                      <button
                        type="button"
                        onClick={() => {
                          setNewPart(EMPTY_PART);
                          setShowPartInput(true);
                        }}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Додати
                      </button>
                    )}
                  </div>

                  <div className="rounded-lg border border-border overflow-visible">
                    <table className="w-full table-fixed text-[12px]">
                      <colgroup>
                        <col />
                        <col className="w-44" />
                        <col className="w-20" />
                        <col className="w-20" />
                        <col className="w-28" />
                        <col className="w-24" />
                        {vatMode !== 'NONE' && <col className="w-20" />}
                        <col className="w-24" />
                        <col className="w-9" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border bg-secondary/40">
                          <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Назва товару
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Склад
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            На складі
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            К-сть
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            ОВ
                          </th>
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Ціна, ₴
                          </th>
                          {vatMode !== 'NONE' && (
                            <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                              ПДВ, ₴
                            </th>
                          )}
                          <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                            Сума, ₴
                          </th>
                          <th />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {parts.length === 0 && !showPartInput && (
                          <tr>
                            <td
                              colSpan={vatMode !== 'NONE' ? 9 : 8}
                              className="px-3 py-4 text-center text-[12px] text-muted-foreground"
                            >
                              Натисніть «Додати» щоб додати товар
                            </td>
                          </tr>
                        )}
                        {parts.map(part => {
                          const wh = warehousesById.get(part.warehouseId);
                          const qty = toNumberOrUndefined(part.quantity);
                          const p = toNumberOrUndefined(part.price);
                          const sum = qty != null && p != null ? qty * p : null;
                          return (
                            <tr
                              key={part._key}
                              className={
                                editingPartKey === part._key
                                  ? 'bg-primary/5'
                                  : 'bg-surface hover:bg-secondary/30 transition-colors'
                              }
                            >
                              {editingPartKey === part._key ? (
                                <>
                                  <td className="px-2 py-1.5">
                                    <EntityPickerField<GoodPickerItem>
                                      display={editingPart.goodName}
                                      placeholder="Пошук товару..."
                                      ariaLabel="Товар"
                                      onPick={() => setEditGoodPickerOpen(true)}
                                      onSearch={fetchGoods}
                                      onSearchSelect={g =>
                                        setEditingPart(p => ({
                                          ...p,
                                          goodId: g.id,
                                          goodName: g.name,
                                          price: String(g.salePrice),
                                          unitOfMeasureId: g.unitId ?? '',
                                          unitShortName: g.unitShortName ?? '',
                                        }))
                                      }
                                      onClear={() =>
                                        setEditingPart(p => ({
                                          ...p,
                                          goodId: '',
                                          goodName: '',
                                          unitOfMeasureId: '',
                                          unitShortName: '',
                                        }))
                                      }
                                    />
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Select
                                      value={editingPart.warehouseId}
                                      onChange={e =>
                                        setEditingPart(p => ({ ...p, warehouseId: e.target.value }))
                                      }
                                    >
                                      <option value="">Склад</option>
                                      {warehouses.map(w => (
                                        <option key={w.id} value={w.id}>
                                          {w.name}
                                        </option>
                                      ))}
                                    </Select>
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                    {editingPart.goodId ? (
                                      <>
                                        <span>
                                          {editingPart.warehouseId
                                            ? (stockWarehouseMap.get(
                                                `${editingPart.goodId}:${editingPart.warehouseId}`,
                                              ) ?? 0)
                                            : '—'}
                                        </span>
                                        <span className="opacity-40">/</span>
                                        <span className="opacity-60">
                                          {stockTotalsMap.get(editingPart.goodId) ?? 0}
                                        </span>
                                      </>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Input
                                      placeholder="0"
                                      type="number"
                                      value={editingPart.quantity}
                                      onChange={e =>
                                        setEditingPart(p => ({ ...p, quantity: e.target.value }))
                                      }
                                      min="0.001"
                                      step="any"
                                    />
                                  </td>
                                  <td className="px-1 py-1.5">
                                    <Select
                                      value={editingPart.unitOfMeasureId}
                                      onChange={e => {
                                        const u = unitsById.get(e.target.value);
                                        setEditingPart(p => ({
                                          ...p,
                                          unitOfMeasureId: e.target.value,
                                          unitShortName: u?.shortName ?? '',
                                        }));
                                      }}
                                    >
                                      <option value="">шт</option>
                                      {units.map(u => (
                                        <option key={u.id} value={u.id}>
                                          {u.shortName}
                                        </option>
                                      ))}
                                    </Select>
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <Input
                                      placeholder="0"
                                      type="number"
                                      value={editingPart.price}
                                      onChange={e =>
                                        setEditingPart(p => ({ ...p, price: e.target.value }))
                                      }
                                      min="0"
                                    />
                                  </td>
                                  {vatMode !== 'NONE' && (
                                    <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                      {(() => {
                                        const q = toNumberOrUndefined(editingPart.quantity);
                                        const pr = toNumberOrUndefined(editingPart.price);
                                        return q != null && pr != null && vatRate > 0
                                          ? ((q * pr * vatRate) / 100).toFixed(2)
                                          : '—';
                                      })()}
                                    </td>
                                  )}
                                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                    {(() => {
                                      const q = toNumberOrUndefined(editingPart.quantity);
                                      const pr = toNumberOrUndefined(editingPart.price);
                                      return q != null && pr != null ? (q * pr).toFixed(2) : '—';
                                    })()}
                                  </td>
                                  <td className="px-1.5 py-1.5">
                                    <div className="flex flex-col gap-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (!editingPart.goodId || !editingPart.warehouseId)
                                            return;
                                          setParts(prev =>
                                            prev.map(pt =>
                                              pt._key === part._key
                                                ? { ...editingPart, _key: pt._key }
                                                : pt,
                                            ),
                                          );
                                          setEditingPartKey(null);
                                        }}
                                        disabled={!editingPart.goodId || !editingPart.warehouseId}
                                        title="Зберегти"
                                        className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingPartKey(null)}
                                        title="Скасувати"
                                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td className="px-3 py-1.5 text-foreground truncate">
                                    {part.goodName}
                                  </td>
                                  <td className="px-2 py-1.5 text-muted-foreground truncate">
                                    {wh?.name ?? '—'}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {part.goodId ? (
                                      <>
                                        <span>
                                          {stockWarehouseMap.get(
                                            `${part.goodId}:${part.warehouseId}`,
                                          ) ?? 0}
                                        </span>
                                        <span className="opacity-40">/</span>
                                        <span className="opacity-60">
                                          {stockTotalsMap.get(part.goodId) ?? 0}
                                        </span>
                                      </>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {part.quantity}
                                  </td>
                                  <td className="px-2 py-1.5 text-left text-muted-foreground text-[12px]">
                                    {part.unitShortName || 'шт'}
                                  </td>
                                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                    {part.price || '—'}
                                  </td>
                                  {vatMode !== 'NONE' && (
                                    <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                                      {qty != null && p != null && vatRate > 0
                                        ? ((qty * p * vatRate) / 100).toFixed(2)
                                        : '—'}
                                    </td>
                                  )}
                                  <td className="px-2 py-1.5 text-left tabular-nums font-medium text-foreground">
                                    {sum != null ? sum.toFixed(2) : '—'}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-left">
                                    <div className="flex flex-col gap-1 items-end">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingPartKey(part._key);
                                          setEditingPart({
                                            goodId: part.goodId,
                                            goodName: part.goodName,
                                            warehouseId: part.warehouseId,
                                            quantity: part.quantity,
                                            price: part.price,
                                            unitOfMeasureId: part.unitOfMeasureId,
                                            unitShortName: part.unitShortName,
                                          });
                                        }}
                                        disabled={saving || !canEdit}
                                        aria-label="Редагувати товар"
                                        title="Редагувати"
                                        className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (part.id) deletedPartIds.current.push(part.id);
                                          setParts(prev =>
                                            prev.filter(pt => pt._key !== part._key),
                                          );
                                        }}
                                        disabled={saving || !canEdit}
                                        aria-label="Видалити товар"
                                        title="Видалити"
                                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })}

                        {/* Рядок вводу */}
                        {showPartInput && (
                          <tr className="bg-primary/5 border-t-2 border-primary/20">
                            <td className="px-2 py-1.5">
                              <EntityPickerField<GoodPickerItem>
                                display={newPart.goodName}
                                placeholder="Пошук товару..."
                                ariaLabel="Товар"
                                onPick={() => setGoodPickerOpen(true)}
                                onSearch={fetchGoods}
                                onSearchSelect={g =>
                                  setNewPart(p => ({
                                    ...p,
                                    goodId: g.id,
                                    goodName: g.name,
                                    price: String(g.salePrice),
                                    unitOfMeasureId: g.unitId ?? '',
                                    unitShortName: g.unitShortName ?? '',
                                  }))
                                }
                                onClear={() =>
                                  setNewPart(p => ({ ...EMPTY_PART, warehouseId: p.warehouseId }))
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Select
                                value={newPart.warehouseId}
                                onChange={e =>
                                  setNewPart(p => ({ ...p, warehouseId: e.target.value }))
                                }
                              >
                                <option value="">Склад</option>
                                {warehouses.map(w => (
                                  <option key={w.id} value={w.id}>
                                    {w.name}
                                  </option>
                                ))}
                              </Select>
                            </td>
                            <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                              {newPart.goodId ? (
                                <>
                                  <span>
                                    {newPart.warehouseId
                                      ? (stockWarehouseMap.get(
                                          `${newPart.goodId}:${newPart.warehouseId}`,
                                        ) ?? 0)
                                      : '—'}
                                  </span>
                                  <span className="opacity-40">/</span>
                                  <span className="opacity-60">
                                    {stockTotalsMap.get(newPart.goodId) ?? 0}
                                  </span>
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                placeholder="0"
                                type="number"
                                value={newPart.quantity}
                                onChange={e =>
                                  setNewPart(p => ({ ...p, quantity: e.target.value }))
                                }
                                min="0.001"
                                step="any"
                              />
                            </td>
                            <td className="px-1 py-1.5">
                              <Select
                                value={newPart.unitOfMeasureId}
                                onChange={e => {
                                  const u = unitsById.get(e.target.value);
                                  setNewPart(p => ({
                                    ...p,
                                    unitOfMeasureId: e.target.value,
                                    unitShortName: u?.shortName ?? '',
                                  }));
                                }}
                              >
                                <option value="">шт</option>
                                {units.map(u => (
                                  <option key={u.id} value={u.id}>
                                    {u.shortName}
                                  </option>
                                ))}
                              </Select>
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                placeholder="0"
                                type="number"
                                value={newPart.price}
                                onChange={e => setNewPart(p => ({ ...p, price: e.target.value }))}
                                min="0"
                              />
                            </td>
                            {vatMode !== 'NONE' && (
                              <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                                {(() => {
                                  const qty = toNumberOrUndefined(newPart.quantity);
                                  const p = toNumberOrUndefined(newPart.price);
                                  return qty != null && p != null && vatRate > 0
                                    ? ((qty * p * vatRate) / 100).toFixed(2)
                                    : '—';
                                })()}
                              </td>
                            )}
                            <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                              {(() => {
                                const qty = toNumberOrUndefined(newPart.quantity);
                                const p = toNumberOrUndefined(newPart.price);
                                return qty != null && p != null ? (qty * p).toFixed(2) : '—';
                              })()}
                            </td>
                            <td className="px-1.5 py-1.5">
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  onClick={addPart}
                                  disabled={!newPart.goodId || !newPart.warehouseId || saving}
                                  title="Зберегти рядок"
                                  className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setNewPart(EMPTY_PART);
                                    setShowPartInput(false);
                                  }}
                                  title="Скасувати"
                                  className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {parts.length > 0 && (
                        <tfoot>
                          <tr className="bg-secondary/50 border-t border-border">
                            <td
                              colSpan={vatMode !== 'NONE' ? 5 : 6}
                              className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                            >
                              Разом товарів:
                            </td>
                            {vatMode !== 'NONE' && (
                              <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground" />
                            )}
                            {vatMode !== 'NONE' && (
                              <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                                {partsTotals.vat.toFixed(2)}
                              </td>
                            )}
                            <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                              {partsTotals.total.toFixed(2)}
                            </td>
                            <td />
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              </div>
              {/* /flex-1 tables area */}
            </div>
            {/* /flex-col */}
          </>
        )}
      </Modal>

      <SearchPickerModal<SearchPickerItem & Counterparty>
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        title="Оберіть клієнта"
        selectedId={form.counterpartyId}
        searchPlaceholder="Ім'я, телефон, держ. номер авто..."
        fetchItems={q =>
          apiFetch<{ items: Counterparty[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&types=CLIENT&types=BOTH&limit=20`,
          ).then(r => r.items.map(c => ({ ...c, primary: displayCounterpartyName(c) })))
        }
        onSelect={cp => {
          setCounterpartyDisplayName(cp.primary);
          setCpPhone(cp.phone ?? '');
          setForm(f => ({ ...f, counterpartyId: cp.id, vehicleId: '', contractId: '' }));
          loadVehicles(cp.id);
          loadContracts(cp.id);
        }}
      />

      {/* Work picker for new line row */}
      <WorkPickerModal
        open={workPickerOpen}
        onClose={() => setWorkPickerOpen(false)}
        selectedId={newLine.workId}
        onSelect={w =>
          setNewLine(l => ({
            ...l,
            workId: w.id,
            workName: w.name,
            normoHours: String(w.normoHours),
            price: String(w.price),
          }))
        }
      />

      {/* Work picker for inline edit row */}
      <WorkPickerModal
        open={editWorkPickerOpen}
        onClose={() => setEditWorkPickerOpen(false)}
        selectedId={editingLine.workId}
        onSelect={w =>
          setEditingLine(l => ({
            ...l,
            workId: w.id,
            workName: w.name,
            normoHours: String(w.normoHours),
            price: String(w.price),
          }))
        }
      />

      {/* Good picker for new part row */}
      <GoodPickerModal
        open={goodPickerOpen}
        onClose={() => setGoodPickerOpen(false)}
        selectedId={newPart.goodId}
        onSelect={g =>
          setNewPart(p => ({
            ...p,
            goodId: g.id,
            goodName: g.name,
            price: String(g.salePrice),
            unitOfMeasureId: g.unitId ?? '',
            unitShortName: g.unitShortName ?? '',
          }))
        }
      />

      {/* Good picker for inline edit row */}
      <GoodPickerModal
        open={editGoodPickerOpen}
        onClose={() => setEditGoodPickerOpen(false)}
        selectedId={editingPart.goodId}
        onSelect={g =>
          setEditingPart(p => ({
            ...p,
            goodId: g.id,
            goodName: g.name,
            price: String(g.salePrice),
            unitOfMeasureId: g.unitId ?? '',
            unitShortName: g.unitShortName ?? '',
          }))
        }
      />

      {invoiceConflict && (
        // Bug #408: ESC обробляється глобальним document listener (див. useEffect вище —
        // onKeyDown на <div role="presentation"> без tabIndex/focus не фaйрить).
        // Overlay click + autoFocus для модального UX.
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
          onClick={() => !invoiceLoading && setInvoiceConflict(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="invoice-conflict-title"
            className="bg-surface rounded-xl shadow-xl p-6 max-w-sm w-full mx-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="invoice-conflict-title" className="font-semibold text-base mb-2">
              Рахунок вже існує
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              Для цього наряду вже є активний рахунок. Що зробити?
            </p>
            <div className="flex flex-col gap-2">
              <Button
                autoFocus
                onClick={handleInvoiceRefresh}
                loading={invoiceLoading}
                disabled={invoiceLoading}
                className="w-full"
              >
                Оновити (перезаписати рядки)
              </Button>
              {/* Bug #410: захист від race — поки triggers in-flight, інші дії dialog
                  заборонені (інакше "Відкрити існуючий" відкриває рахунок паралельно з
                  refresh → дві вкладки + застаріле UI). */}
              <Button
                variant="outline"
                onClick={handleInvoiceOpen}
                disabled={invoiceLoading}
                className="w-full"
              >
                Відкрити існуючий
              </Button>
              <Button
                variant="ghost"
                onClick={() => setInvoiceConflict(false)}
                disabled={invoiceLoading}
                className="w-full"
              >
                Скасувати
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog {...confirmDialogProps} />
    </>
  );
}
