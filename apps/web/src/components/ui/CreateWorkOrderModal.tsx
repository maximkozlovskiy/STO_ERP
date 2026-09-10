'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ChangeEvent } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Printer,
  Share2,
  MessageSquare,
  Receipt,
  CreditCard,
  Calendar,
  Shield,
  Minus,
  Download,
} from 'lucide-react';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConflictCheck } from '@/hooks/useConflictCheck';
import { useConfirm } from '@/hooks/useConfirm';
import { useReferenceData } from '@/hooks/useReferenceData';
import type { Branch } from '@/hooks/useReferenceData';
import { useStockTotals } from '@/hooks/useStockTotals';
import { useWorkOrderActions } from '@/hooks/useWorkOrderActions';
import { getCached } from '@/lib/ref-cache';
import { kyivToday, isoToKyivLocalDateTime, localDateTimeToISO } from '@/lib/format';
import { cn, displayCounterpartyName, calcVatTotals } from '@/lib/utils';
import {
  WO_STATUS_LABELS,
  WO_STATUS_DESCRIPTIONS,
  WO_STATUS_TRANSITIONS,
  WO_PRIORITY_LABELS,
  WO_CATEGORY_LABELS,
  WO_EDITABLE_STATUSES,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import { WorkPickerModal, type WorkPickerItem } from '@/components/ui/WorkPickerModal';
import { ServicePickerModal, type ServicePickerItem } from '@/components/ui/ServicePickerModal';
import { GoodPickerModal, type GoodPickerItem } from '@/components/ui/GoodPickerModal';
import { PartsTable } from './work-order/PartsTable';
import { WorksTable } from './work-order/WorksTable';
import type { LocalPart, LocalLine } from './work-order/types';
import { Tooltip } from '@/components/ui/tooltip';
import {
  LinkedDocumentsPanel,
  type LinkedDocumentsCounts,
} from '@/components/ui/LinkedDocumentsPanel';
import { workOrderLinkedConfig } from '@/lib/linked-configs';
import { useLinkedNav } from '@/lib/linked-nav';

// A3-modal: Branch/Lift/Warehouse/Employee/Vehicle типи → useReferenceData (import above).
interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone?: string | null;
}
// A3-modal: Contract/Unit типи → useReferenceData (import above).

// Local line/part rows (pre-save state)
// LocalLine moved to ./work-order/types (shared with WorksTable). Imported above.
// LocalPart moved to ./work-order/types (shared with PartsTable). Imported above.

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
    goodInternalCode?: string | null;
    goodSku?: string | null;
    goodBrandName?: string | null;
    warehouseId: string;
    quantity: number;
    costPrice?: number | null;
    price: number;
    // backend `toPartDto` повертає unitOfMeasureId (work-orders.service.ts:1529),
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
  // A3-modal: довідники + org-налаштування винесено у useReferenceData (self-contained ref-data + settings).
  const {
    branches,
    lifts,
    warehouses,
    employees,
    vehicles,
    contracts,
    units,
    setVehicles,
    setContracts,
    vatMode,
    vatRate,
    recalcPlannedHoursEnabled,
    recalcActualHoursEnabled,
    syncCalendarEnabled,
    loadVehicles: loadVehiclesRef,
    loadContracts,
    employeesById,
    warehousesById,
    unitsById,
    vehiclesById,
    liftsById,
    branchesById,
  } = useReferenceData();
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  // Refs ensure handleModalClose sees sync state, not stale closure.
  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  // Value-based dirty-детекція: базлайн — серіалізований відбиток «чистої» форми.
  // Замінює крихкий baselineReadyRef + setTimeout(0) (гонка macrotask-прапорця з
  // відкладеним flush passive-ефектів React → хибний «Є незбережені зміни» на
  // чистій формі). baselineCapturedRef — чи вже захоплено початковий базлайн.
  const baselineCapturedRef = useRef(false);
  // Bug #639: async авто-вибір єдиної філії — програмна зміна. Ефект авто-вибору
  // піднімає цей прапорець, і наступний прогін dirty-детектора згортає нове значення
  // у базлайн замість dirty.
  const rebaselineRef = useRef(false);
  // Edit-режим: true після завершення першого завантаження (гейт базлайну).
  // `editModeLoading` стартує як false, а load-ефект визначено ПІСЛЯ baseline-ефекту,
  // тож без цього прапорця базлайн захопився б на порожній формі, а завантажені дані
  // згодом хибно позначили б dirty.
  const [editLoaded, setEditLoaded] = useState(false);
  // track initial planned dates loaded from WO so we can detect
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
  // A3-modal: vatMode/vatRate/recalc*/syncCalendar перенесено у useReferenceData (див. вище).
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [editModeLoading, setEditModeLoading] = useState(false);
  const [woNumber, setWoNumber] = useState('');
  // A3-modal: shareLoading/smsLoading/invoiceLoading/invoiceConflict + action-handlers у useWorkOrderActions
  // (виклик нижче, після currentStatus/features/setError/setLinkedDocsRefreshKey).
  // інкрементуємо після успішного invoice create/refresh →
  // LinkedDocumentsPanel ререфетчить без потреби unmount/remount tab.
  const [linkedDocsRefreshKey, setLinkedDocsRefreshKey] = useState(0);
  const [linkedDocsCounts, setLinkedDocsCounts] = useState<LinkedDocumentsCounts | null>(null);
  const [activeTab, setActiveTab] = useState<'main' | 'documents'>('main');
  const linkedNav = useLinkedNav();
  const linkedConfig = useMemo(() => workOrderLinkedConfig(linkedNav), [linkedNav]);
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
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

  // A3-modal: invoiceConflict ESC-ефект перенесено у useWorkOrderActions.

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
      // виключити слоти цього самого наряду — інакше будь-який наряд
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
  // A3-modal: stock-totals кеш винесено у useStockTotals (Bug #452-454 збережено). Виклик — після
  // оголошення parts/newPart/editingPart нижче.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  // A3-modal: vehicleReqRef/contractReqRef перенесено у useReferenceData (race-guard там же).

  // A3-modal: ref-data + settings effect перенесено у useReferenceData.

  // Apply prefill + auto-select single branch when modal opens.
  // deps include `workOrderId` — без цього при перемиканні між мінімізованими
  // tab-ами (A → B, обидва edit-mode, open=true весь час) stale state (error banner,
  // inline "Додати рядок", showLineInput, lines/parts WO-A, статус-меню) лишається
  // видимим поки fetch для B ще не resolved. Тепер кожна зміна workOrderId одразу
  // скидає transient UI до neutral baseline, потім edit-mode useEffect завантажує
  // фактичні дані WO-B.
  useEffect(() => {
    if (!open) {
      baselineCapturedRef.current = false;
      rebaselineRef.current = false;
      setEditLoaded(false);
      return;
    }
    baselineCapturedRef.current = false;
    rebaselineRef.current = false;
    setEditLoaded(false);
    dirty.resetDirty();
    setError('');
    setStatusMenuOpen(false);
    setLinkedDocsCounts(null);
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
    // reset snapshot so previous WO's dates don't bleed into a new session.
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
      const src = getCached<Branch[]>('cache:branches') ?? branches;
      if (src.length === 1) setForm(f => ({ ...f, branchId: src[0].id }));
    }

    if (!isEditMode && prefill?.counterpartyId) {
      loadVehicles(prefill.counterpartyId, prefill.vehicleId);
      loadContracts(prefill.counterpartyId);
    }
    // Базлайн (create або edit) захоплюється value-based ефектом нижче після
    // осідання стану — без setTimeout-гонки.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrderId]);

  // Серіалізований відбиток значущих полів. Value-based dirty-детекція порівнює
  // цей рядок із базлайном — ре-рендер із новим reference, але тими самими
  // значеннями, НЕ позначає форму брудною.
  const formSnapshot = useMemo(
    () =>
      JSON.stringify({
        form,
        lines: lines.map(l => ({
          workId: l.workId,
          employeeId: l.employeeId,
          normoHours: l.normoHours,
          actualHours: l.actualHours,
          price: l.price,
        })),
        parts: parts.map(p => ({
          goodId: p.goodId,
          warehouseId: p.warehouseId,
          quantity: p.quantity,
          price: p.price,
          unitOfMeasureId: p.unitOfMeasureId,
        })),
      }),
    [form, lines, parts],
  );

  // Value-based dirty-детекція + захоплення базлайну.
  // Create: базлайн — перший snapshot після reset (з prefill). Edit: після
  // завершення завантаження (editLoaded=true). Bug #639: async авто-вибір
  // єдиної філії — програмна зміна; ефект авто-вибору піднімає rebaselineRef, і тут
  // нове значення згортається у базлайн замість dirty.
  useEffect(() => {
    if (!open) return;
    if (isEditMode && !editLoaded) return;
    if (!baselineCapturedRef.current) {
      baselineCapturedRef.current = true;
      dirty.captureBaseline(formSnapshot);
      return;
    }
    if (rebaselineRef.current) {
      rebaselineRef.current = false;
      dirty.captureBaseline(formSnapshot);
      return;
    }
    dirty.syncDirty(formSnapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEditMode, editLoaded, formSnapshot]);

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
        // snapshot loaded dates for later change-detection.
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
            goodInternalCode: p.goodInternalCode ?? null,
            goodSku: p.goodSku ?? null,
            goodBrandName: p.goodBrandName ?? null,
            warehouseId: p.warehouseId,
            quantity: String(p.quantity),
            costPrice: p.costPrice ?? null,
            price: String(p.price),
            // зберігаємо UoM що повернув backend, інакше inline-edit dropdown
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
        // Позначаємо завантаження завершеним — value-based ефект захопить базлайн
        // на фактично завантажених даних (не на порожній формі).
        setEditLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrderId]);

  // Fetch linked-documents counts for tab badge — runs on open and after refresh.
  // Separate from the main WO fetch so the badge updates even when Документи tab not visited.
  useEffect(() => {
    if (!open || !isEditMode || !workOrderId) return;
    let cancelled = false;
    apiFetch<{
      invoices: unknown[];
      payments: unknown[];
      calendarSlots: unknown[];
      warranties: unknown[];
    }>(`/work-orders/${workOrderId}/linked-documents`)
      .then(d => {
        if (!cancelled)
          setLinkedDocsCounts({
            invoices: d.invoices.length,
            payments: d.payments.length,
            calendarSlots: d.calendarSlots.length,
            warranties: d.warranties.length,
          });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, isEditMode, workOrderId, linkedDocsRefreshKey]);

  // After branches load (or on open), auto-select if single branch.
  // Covers two cases: (1) branches arrive async after modal opens,
  // (2) modal reopens when branches are already cached (branches dep unchanged).
  useEffect(() => {
    if (!open || isEditMode || branches.length !== 1) return;
    setForm(f => {
      if (f.branchId) return f;
      // Bug #639: авто-вибір після базлайну → програмна зміна; піднімаємо
      // rebaselineRef, щоб dirty-детектор згорнув її у базлайн (не dirty).
      if (baselineCapturedRef.current) rebaselineRef.current = true;
      return { ...f, branchId: branches[0].id };
    });
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

  // A3-modal: loadVehicles/loadContracts у useReferenceData. Тонка обгортка передає onSingleVehicle-колбек
  // (auto-select single vehicle) → хук лишається form-agnostic, а form-мутація тут (spine).
  const loadVehicles = (cpId: string, keepVehicleId?: string) =>
    loadVehiclesRef(cpId, keepVehicleId, vehicleId =>
      setForm(f => (f.vehicleId ? f : { ...f, vehicleId })),
    );

  const [workPickerOpen, setWorkPickerOpen] = useState(false);
  const [editWorkPickerOpen, setEditWorkPickerOpen] = useState(false);
  const [goodPickerOpen, setGoodPickerOpen] = useState(false);
  const [servicePickerOpen, setServicePickerOpen] = useState(false);
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

  // A3-modal: stock-totals кеш винесено у useStockTotals (Bug #452-454 збережено ДОСЛІВНО).
  const { stockTotalsMap, stockWarehouseMap } = useStockTotals(
    parts,
    newPart.goodId,
    editingPart.goodId,
  );

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
    // блокуємо повний дублікат (work + виконавець) — типовий user-error.
    if (lines.some(l => l.workId === newLine.workId && l.employeeId === newLine.employeeId)) {
      setError('Цю роботу для цього виконавця вже додано');
      return;
    }
    // захист від негативних/нульових normoHours (DTO @Min(0.01) інакше rejects after WO created).
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

  const applyService = (service: ServicePickerItem) => {
    setError('');
    // Додаємо роботи з послуги (пропускаємо дублікати workId без employeeId)
    if (service.works.length > 0) {
      setLines(prev => {
        const toAdd = service.works
          .filter(w => !prev.some(l => l.workId === w.workId && !l.employeeId))
          .map(w => ({
            _key: nextKey(),
            workId: w.workId,
            workName: w.workName,
            employeeId: '',
            normoHours: String(w.normoHours * w.quantity),
            actualHours: '',
            price: String(w.price),
          }));
        return [...prev, ...toAdd];
      });
    }
    // Додаємо товари з послуги (пропускаємо дублікати goodId)
    if (service.goods.length > 0) {
      setParts(prev => {
        const toAdd = service.goods
          .filter(g => !prev.some(p => p.goodId === g.goodId))
          .map(g => ({
            _key: nextKey(),
            goodId: g.goodId,
            goodName: g.goodName,
            warehouseId: '',
            quantity: String(g.quantity),
            price: String(g.salePrice),
            unitOfMeasureId: '',
            unitShortName: g.unit,
          }));
        return [...prev, ...toAdd];
      });
    }
  };

  const addPart = () => {
    if (!newPart.goodId || !newPart.warehouseId) return;
    // блокуємо повний дублікат (товар + склад).
    if (parts.some(p => p.goodId === newPart.goodId && p.warehouseId === newPart.warehouseId)) {
      setError('Цей товар із цього складу вже додано');
      return;
    }
    // backend DTO @Min(0.001) для quantity → reject цілого create() після WO POST.
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
    // WEB-H3 (Bug #630): синхронний guard проти concurrent double-submit. Два click-и в
    // одному tick інакше створять 2 наряди до застосування disabled={saving}.
    if (savingRef.current || transitioningRef.current) return;
    // warn user if half-typed row would be silently dropped (data loss).
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
      dirty.resetDirty();
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
    // Commit any open inline-edit row synchronously so save() reads the latest actualHours.
    // setLines is async (React batched), so compute the merged snapshot here and use it
    // directly in the rest of save() via committedLines instead of the stale `lines` closure.
    // spread `l` FIRST so `id` (and other DB-only fields) survive the merge.
    // editingLine state never carries `id` → раніше merge скидав `id` у undefined →
    // save() filter `!!l.id && l.actualHours !== ''` пропускав рядок → PATCH lines
    // не надсилався → actualHours на line-рівні ніколи не зберігалось у IN_PROGRESS/ON_HOLD.
    const committedLines = editingLineKey
      ? lines.map(l => (l._key === editingLineKey ? { ...l, ...editingLine, _key: l._key } : l))
      : lines;
    if (editingLineKey) {
      setLines(committedLines);
      setEditingLineKey(null);
    }
    try {
      // computedActualHours має бути `undefined` коли користувач
      // не вказував явно і recalc не може порахувати (lines.length=0). Інакше
      // PATCH з null перетирав збережене значення WO.actualHours у БД.
      let computedActualHours: number | null | undefined;
      if (recalcActualHoursEnabled) {
        if (committedLines.length > 0) {
          let sum = 0;
          for (const l of committedLines) {
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

      // у IN_PROGRESS/ON_HOLD дозволяємо тільки patch actualHours
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
        for (const line of committedLines.filter(l => !l.id)) {
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
        for (const line of committedLines.filter(l => !!l.id)) {
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
        // у IN_PROGRESS/ON_HOLD PATCH лише actualHours для існуючих рядків.
        // Жодних DELETE/POST/PATCH інших полів — бекенд відхилить як non-actual-only.
        // Only PATCH lines where actualHours was explicitly set (non-empty string).
        // Sending null for lines the user never touched overwrites previously saved
        // values — so skip lines where actualHours is still '' (unmodified).
        for (const line of committedLines.filter(l => !!l.id && l.actualHours !== '')) {
          await apiFetch(`/work-orders/${workOrderId}/lines/${line.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              actualHours: toNumberOrUndefined(line.actualHours) ?? null,
            }),
          });
        }
      }
      // show calendar-sync dialog ONLY when planned dates actually
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
            // коли у наряду немає слоту в календарі, backend silently
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
      dirty.resetDirty();
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
    // При переході COMPLETED→INVOICED пропонуємо створити рахунок якщо його ще немає.
    if (
      newStatus === 'INVOICED' &&
      currentStatus === 'COMPLETED' &&
      linkedDocsCounts?.invoices === 0
    ) {
      const ok = await confirm({
        title: 'Створити рахунок?',
        message: 'Рахунок для цього наряду відсутній. Створити рахунок зараз?',
        confirmLabel: 'Створити рахунок',
        cancelLabel: 'Тільки перевести статус',
      });
      if (ok) {
        void handleInvoice();
        return;
      }
      // ok=false → продовжуємо переводити статус без рахунку
    }
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
  // A3-modal: *ById-мапи перенесено у useReferenceData (див. destructure вгорі).

  // Фактичні години редагуються тільки у статусах В роботі / Призупинено.
  const canEditActual =
    isEditMode && (currentStatus === 'IN_PROGRESS' || currentStatus === 'ON_HOLD');

  // Підсумки фактичних сум: actualHours ?? normoHours для кожного рядка (бо save()
  // надсилає на бекенд саме такий фолбек коли recalcActualHoursFromLines=true).
  // hasAny=true лише коли є ХОЧА Б ОДИН рядок з ЯВНО введеним
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
  // A3-modal: action-handlers (print/saveAs/share/sms/invoice+rollback) + loading + invoiceConflict
  // винесено у useWorkOrderActions. Footer-JSX споживає повернені handlers/флаги.
  const {
    shareLoading,
    smsLoading,
    invoiceLoading,
    invoiceConflict,
    setInvoiceConflict,
    saveAsOpen,
    setSaveAsOpen,
    canShare,
    canInvoice,
    handlePrint,
    handleSaveAs,
    handleShare,
    handleSendSms,
    handleInvoice,
    handleInvoiceRefresh,
    handleInvoiceOpen,
  } = useWorkOrderActions({
    workOrderId,
    isEditMode,
    currentStatus,
    setCurrentStatus,
    features,
    setError,
    setLinkedDocsRefreshKey,
    onUpdated,
  });

  // sto-optimize: stable onClose ref для Modal. Modal має useEffect що додає
  // document.addEventListener('keydown') з useCallback([onClose]) — кожен новий
  // ref → effect re-fires → removeEventListener + addEventListener + body
  // overflow re-write. Без useCallback ця модалка (з частим typing у inputs)
  // тригерила re-attach на КОЖЕН keystroke.
  //
  // regression: читаємо `saving`/`transitioning` ВИКЛЮЧНО з ref'ів —
  // вони оновлюються СИНХРОННО у setSavingBoth/setTransitioningBoth ДО React state-flush.
  // Без ref'а closure захоплює застарілий saving=false коли `create()` ще у `await POST`
  // → Modal закривається на Escape всупереч guard'у (race window що ловить test #381).
  //
  // Бонус: deps = [onClose] (не [saving, transitioning, onClose]) — ref reads не
  // повинні бути у deps. Stable identity → Modal keydown listener не перевідв'язується
  // при кожному flip saving/transitioning (раніше re-attach на START + END кожного
  // save/transition; зараз лише при зміні onClose у parent).
  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    setActiveTab('main');
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // Column header widths (shared between table header and input row grid)
  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
        onSubmit={isEditMode ? save : create}
        title={isEditMode ? 'Наряд на роботу' : 'Новий наряд'}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground shrink-0">
              <span className="font-medium">Номер:</span>
              <span className="text-foreground">
                {isEditMode && woNumber ? woNumber : '— присвоюється автоматично —'}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">Дата документа:</span>
              <div className="w-36">
                <DatePickerInput
                  value={form.documentDate}
                  onChange={v => setForm(f => ({ ...f, documentDate: v }))}
                  disabled={!canEdit}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">Статус:</span>
              <div ref={statusMenuRef} className="relative flex items-center gap-1">
                <button
                  type="button"
                  disabled={transitioning || !statusPrevStep || !isEditMode}
                  onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-[80px] truncate">
                    {statusPrevStep ? (WO_STATUS_LABELS[statusPrevStep] ?? statusPrevStep) : '—'}
                  </span>
                </button>
                <Tooltip content={WO_STATUS_DESCRIPTIONS[currentStatus] ?? currentStatus}>
                  <button
                    type="button"
                    disabled={transitioning || !isEditMode}
                    onClick={() => isEditMode && setStatusMenuOpen(o => !o)}
                    className={cn(
                      'text-sm font-medium px-2.5 py-1 rounded-full transition-colors',
                      STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground',
                      isEditMode && !transitioning && 'cursor-pointer hover:opacity-80',
                      !isEditMode && 'cursor-default',
                    )}
                  >
                    {isEditMode
                      ? (WO_STATUS_LABELS[currentStatus] ?? currentStatus)
                      : (WO_STATUS_LABELS['DRAFT'] ?? 'Чернетка')}
                  </button>
                </Tooltip>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-[80px] truncate">
                    {statusNextStep ? (WO_STATUS_LABELS[statusNextStep] ?? statusNextStep) : '—'}
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
          </div>
        }
        extraHeaderActions={
          <div className="flex items-center gap-1">
            {isEditMode && workOrderId && (
              <button
                onClick={() => {
                  minimizeModal({
                    kind: 'modal',
                    label: woNumber || 'Наряд',
                    modalKey: 'work-order',
                    restoreProps: { workOrderId },
                  });
                  onMinimize?.();
                  setActiveTab('main');
                  onClose();
                }}
                className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
                title="Згорнути у вкладку"
                disabled={saving || transitioning}
              >
                <Minus className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={handleModalClose}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
              title="Закрити"
              disabled={saving || transitioning}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
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
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2',
                activeTab === 'documents'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveTab('documents')}
            >
              Документи
              {linkedDocsCounts && (
                <span className="flex items-center gap-1.5">
                  {linkedDocsCounts.invoices > 0 && (
                    <span className="flex items-center gap-0.5 text-[11px] font-normal">
                      <Receipt size={11} />
                      {linkedDocsCounts.invoices}
                    </span>
                  )}
                  {linkedDocsCounts.payments > 0 && (
                    <span className="flex items-center gap-0.5 text-[11px] font-normal">
                      <CreditCard size={11} />
                      {linkedDocsCounts.payments}
                    </span>
                  )}
                  {linkedDocsCounts.calendarSlots > 0 && (
                    <span className="flex items-center gap-0.5 text-[11px] font-normal">
                      <Calendar size={11} />
                      {linkedDocsCounts.calendarSlots}
                    </span>
                  )}
                  {linkedDocsCounts.warranties > 0 && (
                    <span className="flex items-center gap-0.5 text-[11px] font-normal">
                      <Shield size={11} />
                      {linkedDocsCounts.warranties}
                    </span>
                  )}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Вкладка "Документи" */}
        {activeTab === 'documents' && workOrderId && (
          <LinkedDocumentsPanel
            config={linkedConfig}
            entityId={workOrderId}
            refreshKey={linkedDocsRefreshKey}
            onLoad={setLinkedDocsCounts}
          />
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
              <CollapsibleHeader
                collapsed={headerCollapsed}
                onToggle={() => setHeaderCollapsed(c => !c)}
                chips={[
                  { label: counterpartyDisplayName, primary: true, maxWidth: 'max-w-50' },
                  { label: cpPhone, maxWidth: 'max-w-35' },
                  {
                    label: (() => {
                      const v = form.vehicleId ? vehiclesById.get(form.vehicleId) : null;
                      return v
                        ? `${v.make} ${v.model}${v.licensePlate ? ` · ${v.licensePlate}` : ''}`
                        : null;
                    })(),
                    primary: true,
                    maxWidth: 'max-w-45',
                  },
                  {
                    label: form.liftId ? (liftsById.get(form.liftId)?.name ?? null) : null,
                    maxWidth: 'max-w-30',
                  },
                  {
                    label: form.branchId ? (branchesById.get(form.branchId)?.name ?? null) : null,
                    maxWidth: 'max-w-35',
                  },
                ]}
              />

              {/* ── Tables area — takes remaining space ──────────────────── */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {/* Секція: Роботи — винесено у WorksTable (pure move, byte-identical JSX) */}
                <WorksTable
                  lines={lines}
                  setLines={setLines}
                  newLine={newLine}
                  setNewLine={setNewLine}
                  showLineInput={showLineInput}
                  setShowLineInput={setShowLineInput}
                  editingLineKey={editingLineKey}
                  setEditingLineKey={setEditingLineKey}
                  editingLine={editingLine}
                  setEditingLine={setEditingLine}
                  deletedLineIds={deletedLineIds}
                  addLine={addLine}
                  employees={employees}
                  employeesById={employeesById}
                  vatMode={vatMode}
                  vatRate={vatRate}
                  linesTotals={linesTotals}
                  actualTotals={actualTotals}
                  canEdit={canEdit}
                  canEditActual={canEditActual}
                  EMPTY_LINE={EMPTY_LINE}
                  toNumberOrUndefined={toNumberOrUndefined}
                  saving={saving}
                  fetchWorks={fetchWorks}
                  recalcPlannedHoursEnabled={recalcPlannedHoursEnabled}
                  setForm={setForm}
                  calcPlannedHoursFromLines={calcPlannedHoursFromLines}
                  calcEndFromHours={calcEndFromHours}
                  setWorkPickerOpen={setWorkPickerOpen}
                  setEditWorkPickerOpen={setEditWorkPickerOpen}
                  setServicePickerOpen={setServicePickerOpen}
                />

                {/* Секція: Товари */}
                <PartsTable
                  parts={parts}
                  setParts={setParts}
                  newPart={newPart}
                  setNewPart={setNewPart}
                  showPartInput={showPartInput}
                  setShowPartInput={setShowPartInput}
                  editingPartKey={editingPartKey}
                  setEditingPartKey={setEditingPartKey}
                  editingPart={editingPart}
                  setEditingPart={setEditingPart}
                  deletedPartIds={deletedPartIds}
                  addPart={addPart}
                  warehouses={warehouses}
                  warehousesById={warehousesById}
                  units={units}
                  unitsById={unitsById}
                  stockTotalsMap={stockTotalsMap}
                  stockWarehouseMap={stockWarehouseMap}
                  vatMode={vatMode}
                  vatRate={vatRate}
                  partsTotals={partsTotals}
                  canEdit={canEdit}
                  saving={saving}
                  EMPTY_PART={EMPTY_PART}
                  toNumberOrUndefined={toNumberOrUndefined}
                  fetchGoods={fetchGoods}
                  setGoodPickerOpen={setGoodPickerOpen}
                  setEditGoodPickerOpen={setEditGoodPickerOpen}
                />
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

      <ServicePickerModal
        open={servicePickerOpen}
        onClose={() => setServicePickerOpen(false)}
        onSelect={applyService}
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
            goodInternalCode: g.internalCode ?? null,
            goodSku: g.sku ?? null,
            goodBrandName: g.brandName ?? null,
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
            goodInternalCode: g.internalCode ?? null,
            goodSku: g.sku ?? null,
            goodBrandName: g.brandName ?? null,
            price: String(g.salePrice),
            unitOfMeasureId: g.unitId ?? '',
            unitShortName: g.unitShortName ?? '',
          }))
        }
      />

      {invoiceConflict && (
        // ESC обробляється глобальним document listener (див. useEffect вище —
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
              {/* захист від race — поки triggers in-flight, інші дії dialog
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
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
