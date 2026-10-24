'use client';

import type { ApiSchema } from '@sto/shared';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { validationText } from '@/lib/validation';
import {
  workOrderFormSchema,
  type WorkOrderFormInput,
  type WorkOrderFormValues,
} from '@sto/shared';
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
  ChevronUp,
  UserRound,
  CalendarClock,
} from 'lucide-react';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { DeletedDocumentBanner } from '@/components/ui/DeletedDocumentBanner';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConflictCheck } from '@/hooks/useConflictCheck';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { useConfirm } from '@/hooks/useConfirm';
import { useReferenceData } from '@/hooks/useReferenceData';
import type { Branch } from '@/hooks/useReferenceData';
import { useStockTotals } from '@/hooks/useStockTotals';
import { useWorkOrderActions } from '@/hooks/useWorkOrderActions';
import { getCached, setCache } from '@/lib/ref-cache';
import { kyivToday, isoToKyivLocalDateTime, localDateTimeToISO } from '@/lib/format';
import { notifyCalendarChanged } from '@/lib/calendar-events';
import { useBranchWorkHours } from '@/hooks/useBranchWorkHours';
import { calcEndFromHours, calcPlannedHours } from './work-order/planned-dates';
import {
  cn,
  displayCounterpartyName,
  calcVatTotals,
  splitVatTotals,
  sumLineAmounts,
} from '@/lib/utils';
import { VatTotalsSummary } from '@/components/ui/work-order/VatTotalsSummary';
import {
  WO_STATUS_LABELS,
  WO_STATUS_DESCRIPTIONS,
  WO_STATUS_TRANSITIONS,
  WO_PRIORITY_LABELS,
  WO_CATEGORY_LABELS,
  WO_EDITABLE_STATUSES,
  WO_PAYABLE_STATUSES,
  WO_PREPAYMENT_STATUSES,
  PAYMENT_CREATE_ROLES,
} from '@sto/shared';
import {
  woStatusLabel,
  woPriorityLabel,
  woCategoryLabel,
  contractTypeLabel,
} from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { ClientPaymentModal } from '@/components/ui/ClientPaymentModal';
import { invoiceRemaining } from '@/lib/invoice-payment';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cancelConfirmOptions } from '@/components/ui/work-order/cancel-confirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import { DocumentSection, SectionActionButton } from '@/components/ui/document-section';
import { WorkPickerModal, type WorkPickerItem } from '@/components/ui/WorkPickerModal';
import { ServicePickerModal, type ServicePickerItem } from '@/components/ui/ServicePickerModal';
import {
  GoodPickerModal,
  fetchGoodPickerItems,
  type GoodPickerItem,
} from '@/components/ui/GoodPickerModal';
import { pickPartWarehouse } from '@/lib/part-warehouse';
import {
  pickLineExecutor,
  slotMechanicId,
  type LinkedSlotMechanic,
} from '@/lib/work-line-executor';
import { useLiftMechanics } from '@/hooks/api/useLiftMechanics';
import { newIdempotencyKey } from '@/lib/idempotency-key';
import { PartsTable, type PartRow } from './work-order/PartsTable';
import { WorksTable } from './work-order/WorksTable';
import { InvoiceConflictDialog } from './work-order/InvoiceConflictDialog';
import { ShareLinkPanel } from './work-order/ShareLinkPanel';
import { PlannedActualMetrics } from './work-order/PlannedActualMetrics';
import type { LocalPart, LocalLine, WorkOrderFormState } from './work-order/types';
import { Tooltip } from '@/components/ui/tooltip';
import {
  LinkedDocumentsPanel,
  type LinkedDocumentsCounts,
} from '@/components/ui/LinkedDocumentsPanel';
import { workOrderLinkedConfig } from '@/lib/linked-configs';
import { canViewWarranties } from '@/lib/warranty-roles';
import { useLinkedNav } from '@/lib/linked-nav';
import { CurrencySelect } from '@/components/ui/CurrencySelect';
import {
  SendToListButton,
  useInvalidateProcurement,
  useWorkOrderProcurementState,
} from '@/components/ui/purchase-list/WorkOrderProcurement';

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
  /** Заповнене — наряд позначено на видалення (приходить лише з `?withDeleted=true`). */
  deletedAt?: ApiSchema<'WorkOrderDetailDto'>['deletedAt'];
  number: string;
  status: string;
  branchId: string;
  vehicleId: string;
  counterpartyId: string;
  counterpartyName?: string;
  contractId?: string | null;
  currencyId?: string | null;
  currencyCode?: string | null;
  /** «Разом» наряду й уже сплачене — для «Оплатити» (BR-PAY-001/017). */
  totalAmount?: number;
  paidAmount?: number;
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

const TRANSITION_VARIANTS: Record<string, 'default' | 'destructive' | 'outline'> = {
  CANCELLED: 'destructive',
  COMPLETED: 'default',
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

/** Поля товару, які рядок бере з вибраного товару (пошуком у рядку чи вікном вибору). */
const partGoodFields = (g: GoodPickerItem) => ({
  goodId: g.id,
  goodName: g.name,
  goodInternalCode: g.internalCode ?? null,
  goodSku: g.sku ?? null,
  goodBrandName: g.brandName ?? null,
  price: String(g.salePrice),
  unitOfMeasureId: g.unitId ?? '',
  unitShortName: g.unitShortName ?? '',
});

const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

interface WorkOrderPayState {
  totalAmount: number;
  paidAmount: number;
  currencyCode: string | null;
  counterpartyId: string;
}
/** Гроші наряду для «Оплатити» — з відповіді сервера, а не з форми (незбережені рядки не в рахунку). */
const toPayState = (wo: WorkOrderDetail): WorkOrderPayState => ({
  totalAmount: wo.totalAmount ?? 0,
  paidAmount: wo.paidAmount ?? 0,
  currencyCode: wo.currencyCode ?? null,
  counterpartyId: wo.counterpartyId,
});
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
  /** Механік запису календаря, з якого відкрито новий наряд, — виконавець нових робіт (BR-WO-030). */
  employeeId?: string;
}

/** Рядок `cache:works`: категорія роботи — для BR-WO-030 (запасний варіант без зв'язку). */
interface WorkCategoryRow {
  id: string;
  name?: string;
  normoHours?: number;
  price?: number;
  categoryId?: string | null;
}

/** Скільки id в одному `GET /works?ids=` (межа сервера — 200, як `limit`). */
const WORK_IDS_PER_REQUEST = 200;

/**
 * Категорії робіт за id — для робіт «+ Послуга» (у відповіді послуги категорії немає):
 * `GET /works?ids=` лише робіт послуги (раніше `?limit=200`: роботи далі за алфавітом лишались без
 * категорії, рішення власника 2026-10-22). Питаємо сервер щоразу: кеш вкладки ніхто не оновлює, і
 * роботі, яку перенесли в іншу категорію, правило підставляло б механіка за старою (Bug #946). Кеш
 * лише поповнюється й відповідає, коли сервер недоступний; збій без кешу — невідома категорія:
 * механіка з категоріями правило тоді не підставить.
 */
async function workCategoriesFor(workIds: readonly string[]): Promise<Map<string, string | null>> {
  const cachedRows = getCached<WorkCategoryRow[]>('cache:works') ?? [];
  const map = new Map(cachedRows.map(w => [w.id, w.categoryId ?? null] as const));
  const wanted = [...new Set(workIds)];
  if (wanted.length === 0) return map;
  try {
    const fetched: WorkCategoryRow[] = [];
    for (let i = 0; i < wanted.length; i += WORK_IDS_PER_REQUEST) {
      const ids = wanted.slice(i, i + WORK_IDS_PER_REQUEST);
      const r = await apiFetch<{ items: WorkCategoryRow[] }>(
        `/works?ids=${ids.map(encodeURIComponent).join(',')}&limit=${WORK_IDS_PER_REQUEST}`,
      );
      fetched.push(...(r.items ?? []).map(({ id, categoryId }) => ({ id, categoryId })));
    }
    for (const w of fetched) map.set(w.id, w.categoryId ?? null);
    const fresh = new Set(fetched.map(w => w.id));
    setCache('cache:works', [...cachedRows.filter(w => !fresh.has(w.id)), ...fetched]);
    return map;
  } catch {
    return map;
  }
}

export interface CreatedWorkOrder {
  id: string;
  number: string;
  counterpartyId: string | null;
  /** Плановий початок / завершення: обидва є → сервер уже створив запис календаря (BR-WO-020). */
  plannedAt?: string | null;
  dueDate?: string | null;
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

// Глобально унікальний ключ рядка без лічильника рівня модуля (той переживав би HMR/StrictMode
// і ризикував повтором) — той самий генератор, що й ключі ідемпотентності.
const nextKey = newIdempotencyKey;

// Планові нормогодини / автокінець — у робочих годинах філії: `work-order/planned-dates.ts`
// (calcPlannedHours / calcEndFromHours), години — useBranchWorkHours (BR-WO-019).

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

// Тип рядка/деталі у RHF field-array: валідовані поля схеми + локальні display-поля
// (workName/goodName…). append/update приймають цей ширший тип (cast через FormLineArg).
type FormLineArg = NonNullable<WorkOrderFormInput['lines']>[number] & Partial<LocalLine>;
type FormPartArg = NonNullable<WorkOrderFormInput['parts']>[number] & Partial<LocalPart>;

// Порожній input-shape форми (RHF defaultValues + reset). Усі header-поля — рядки ('' = не
// задано), priority дефолт 'NORMAL', documentDate = сьогодні (Kyiv). lines/parts порожні.
// Дзеркалить старий WorkOrderFormState + порожні масиви рядків/деталей.
const emptyDefaults = (): WorkOrderFormInput => ({
  branchId: '',
  vehicleId: '',
  counterpartyId: '',
  contractId: '',
  currencyId: '',
  liftId: '',
  description: '',
  priority: 'NORMAL',
  repairCategory: '',
  documentDate: kyivToday(),
  plannedStartAt: '',
  plannedEndAt: '',
  plannedHours: '',
  actualHours: '',
  lines: [],
  parts: [],
});

export function CreateWorkOrderModal({
  open,
  onClose,
  onCreated,
  prefill,
  workOrderId,
  onUpdated,
  onMinimize,
}: Props) {
  const { t } = useTranslation('workOrders');
  const isEditMode = !!workOrderId;

  // ── react-hook-form + спільна zod-схема (шапка + lines[] + parts[]) ──────────
  // Multi-request submit (Invoice-архітектура): шапка → POST /work-orders, рядки/деталі —
  // окремими POST/PATCH /lines та /parts. Валідація через i18nZodResolver(workOrderFormSchema).
  const {
    control,
    reset,
    watch,
    setValue,
    getValues,
    formState: { isDirty: rhfDirty },
  } = useForm<WorkOrderFormInput, unknown, WorkOrderFormValues>({
    resolver: i18nZodResolver(workOrderFormSchema),
    defaultValues: emptyDefaults(),
    mode: 'onBlur',
  });
  // Суб-компоненти WorksTable/PartsTable оперують setLines/setParts (повний масив) і матчать
  // рядки за _key — тож parent тримає field-array лише як RHF-джерело правди й пише через
  // replace() (shim setLines/setParts). append/update/remove не потрібні (усе йде через replace).
  const { replace: replaceLines } = useFieldArray({ control, name: 'lines' });
  const { replace: replaceParts } = useFieldArray({ control, name: 'parts' });

  // Спостерігаємо весь стан форми одним watch() — далі будуємо read-only `form`-об'єкт та
  // `lines`/`parts` (з _key), щоб уся наявна логіка (handlers/JSX/суб-компоненти) читала їх
  // без змін. watch() повертає найсвіжіші значення на кожен ре-рендер.
  const watchedAll = watch();

  // `form` shim: read-only відбиток шапки у формі старого WorkOrderFormState. Уся наявна
  // логіка (`form.plannedStartAt`, header-JSX, useEffect-и, save/create) читає його без змін.
  const form: WorkOrderFormState = useMemo(
    () => ({
      branchId: watchedAll.branchId ?? '',
      vehicleId: watchedAll.vehicleId ?? '',
      counterpartyId: watchedAll.counterpartyId ?? '',
      contractId: (watchedAll.contractId as string) ?? '',
      currencyId: (watchedAll.currencyId as string) ?? '',
      liftId: (watchedAll.liftId as string) ?? '',
      description: (watchedAll.description as string) ?? '',
      priority: (watchedAll.priority as string) ?? 'NORMAL',
      repairCategory: (watchedAll.repairCategory as string) ?? '',
      documentDate: (watchedAll.documentDate as string) ?? '',
      plannedStartAt: (watchedAll.plannedStartAt as string) ?? '',
      plannedEndAt: (watchedAll.plannedEndAt as string) ?? '',
      plannedHours: (watchedAll.plannedHours as string) ?? '',
      actualHours: (watchedAll.actualHours as string) ?? '',
    }),
    [watchedAll],
  );

  // BR-WO-019: робочі години філії наряду (пікер планових дат, автокінець).
  const workHours = useBranchWorkHours(form.branchId);
  const workHoursRef = useRef(workHours);
  workHoursRef.current = workHours;
  // Планові дати й підйомник збереженого наряду на момент завантаження: запис календаря наряду
  // (BR-WO-020) змінюється лише з ними, тож відкритий календар перечитується лише тоді.
  const savedScheduleRef = useRef({ plannedStartAt: '', plannedEndAt: '', liftId: '' });

  // `setForm` shim: приймає той самий SetStateAction<WorkOrderFormState>, що й старий useState.
  // Обчислює наступний стан із getValues()-знімка й пише лише змінені поля через setValue
  // (shouldDirty:true → RHF isDirty ↑, dirty-guard). getValues (а не `form`) — щоб послідовні
  // setForm у одному tick бачили свіжі значення (React-batched setState-семантика).
  const setForm = useCallback(
    (updater: WorkOrderFormState | ((prev: WorkOrderFormState) => WorkOrderFormState)) => {
      const v = getValues();
      const prev: WorkOrderFormState = {
        branchId: v.branchId ?? '',
        vehicleId: v.vehicleId ?? '',
        counterpartyId: v.counterpartyId ?? '',
        contractId: (v.contractId as string) ?? '',
        currencyId: (v.currencyId as string) ?? '',
        liftId: (v.liftId as string) ?? '',
        description: (v.description as string) ?? '',
        priority: (v.priority as string) ?? 'NORMAL',
        repairCategory: (v.repairCategory as string) ?? '',
        documentDate: (v.documentDate as string) ?? '',
        plannedStartAt: (v.plannedStartAt as string) ?? '',
        plannedEndAt: (v.plannedEndAt as string) ?? '',
        plannedHours: (v.plannedHours as string) ?? '',
        actualHours: (v.actualHours as string) ?? '',
      };
      const next = typeof updater === 'function' ? updater(prev) : updater;
      (Object.keys(next) as (keyof WorkOrderFormState)[]).forEach(k => {
        if (next[k] !== prev[k]) {
          setValue(k as keyof WorkOrderFormInput, next[k], { shouldDirty: true });
        }
      });
    },
    [getValues, setValue],
  );

  // `lines`/`parts` shim: field-array items несуть _key/id + display-поля → LocalLine/LocalPart.
  // field.id (RHF-внутрішній) ≠ _key; зберігаємо _key на кожному item (append/update/reset).
  const lines = useMemo<LocalLine[]>(
    () => (watchedAll.lines as unknown as LocalLine[]) ?? [],
    [watchedAll.lines],
  );
  const parts = useMemo<LocalPart[]>(
    () => (watchedAll.parts as unknown as LocalPart[]) ?? [],
    [watchedAll.parts],
  );

  // `setLines`/`setParts` shim: приймають SetStateAction<LocalLine[]|LocalPart[]> (як старий
  // useState), матеріалізують наступний масив і пишуть його через field-array replace()
  // (shouldDirty вбудований). getValues-знімок — щоб послідовні updater-и у одному tick
  // бачили свіжий масив.
  const setLines = useCallback(
    (updater: LocalLine[] | ((prev: LocalLine[]) => LocalLine[])) => {
      const prev = (getValues('lines') as unknown as LocalLine[]) ?? [];
      const next = typeof updater === 'function' ? updater(prev) : updater;
      replaceLines(next);
    },
    [getValues, replaceLines],
  );
  const setParts = useCallback(
    (updater: LocalPart[] | ((prev: LocalPart[]) => LocalPart[])) => {
      const prev = (getValues('parts') as unknown as LocalPart[]) ?? [];
      const next = typeof updater === 'function' ? updater(prev) : updater;
      replaceParts(next);
    },
    [getValues, replaceParts],
  );

  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [cpPhone, setCpPhone] = useState('');
  // A3-modal: довідники + org-налаштування винесено у useReferenceData (self-contained ref-data + settings).
  const {
    branches,
    lifts,
    warehouses,
    employees,
    employeesLoaded,
    vehicles,
    contracts,
    units,
    setVehicles,
    setContracts,
    vatMode,
    vatRate,
    recalcPlannedHoursEnabled,
    recalcActualHoursEnabled,
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
  // Dirty-детекція — RHF isDirty (bridge-ефект нижче → dirty.markDirty/resetDirty).
  // Value-based базлайн (baselineCapturedRef/rebaselineRef/editLoaded/formSnapshot) прибрано:
  // reset() ставить нову «чисту» базу (rhfDirty=false), а програмні зміни (авто-вибір філії
  // Bug #639, currency defaultToBase Bug #747) йдуть через setValue({shouldDirty:false}) — не
  // вмикають dirty без крихкого baseline-rebaseline протоколу.
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const setTransitioningBoth = (v: boolean) => {
    transitioningRef.current = v;
    setTransitioning(v);
  };
  const [error, setError] = useState('');
  // Документ позначено на видалення → картка лише на перегляд. Прапорець прив'язано до id
  // завантаженого документа, тож інший наряд у тій самій модалці його не успадковує.
  const [deletedDocId, setDeletedDocId] = useState<string | null>(null);
  // Id наряду, який справді завантажено у форму (Bug #844).
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
  const isDeleted = isEditMode && deletedDocId === workOrderId;
  // Документ ще не завантажено (або завантаження не вдалось): у формі стоять типові значення
  // «чернетки», а не цей документ. Жодних дій — інакше «Підтвердити» провело б документ, якого
  // користувач не бачить (Bug #844). Разом із «видалено» це дає картку лише на перегляд.
  const notLoaded = isEditMode && loadedDocId !== workOrderId;
  const viewOnly = isDeleted || notLoaded;
  // A3-modal: vatMode/vatRate/recalc* перенесено у useReferenceData (див. вище).
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [payState, setPayState] = useState<WorkOrderPayState | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  // Наряд, відкритий у картці зараз: пізня відповідь для попереднього (вкладки) не пишеться.
  const workOrderIdRef = useRef(workOrderId);
  workOrderIdRef.current = workOrderId;
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
  const { employee: currentEmployee } = useAuth();
  const canOpenWarranties = canViewWarranties(currentEmployee?.role);
  const linkedConfig = useMemo(
    () => workOrderLinkedConfig(linkedNav, { canOpenWarranties }),
    [linkedNav, canOpenWarranties],
  );
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  const {
    conflict: calConflict,
    check: checkConflict,
    clear: clearConflict,
    conflictWoNumbers,
  } = useConflictCheck();
  // Підтвердження поверх картки (BR-WO-025): «Ні» чи Escape закривають лише його — воно верхній шар
  // Escape (useEscapeLayer у Modal).
  const {
    confirm: confirmOverCard,
    choose: chooseOverCard,
    dialogProps: confirmDialogProps,
  } = useConfirm();
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

  // Conflict check when planned period or liftId changes — і для нового наряду: з BR-WO-020
  // створення наряду з датами вже займає підйомник (сервер відповідає 400 на зайнятий).
  // Backend expects ISO with TZ; DateTimePickerInput emits naive "YYYY-MM-DDTHH:mm"
  // (no TZ). Normalize via DST-aware localDateTimeToISO (passes through values
  // already ending Z / ±HH:MM). Без цієї нормалізації backend new Date("2026-06-10T14:00")
  // парсить як UTC → +2/+3h зсув → false positives.
  // Без підйомника перевіряти нічого: механіка картка наряду не обирає, а сервер на запит без
  // ресурсу відповідає «конфлікту немає», не читаючи календар.
  useEffect(() => {
    if (!open || !form.liftId || !form.plannedStartAt || !form.plannedEndAt) {
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
      liftId: form.liftId,
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
    open,
    workOrderId,
    checkConflict,
    clearConflict,
  ]);

  // Inline add-row state
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [newPart, setNewPart] = useState<Omit<LocalPart, '_key'>>(EMPTY_PART);
  const [showLineInput, setShowLineInput] = useState(false);
  const [showPartInput, setShowPartInput] = useState(false);
  // BR-WO-030: виконавець нової роботи — механік запису календаря наряду, інакше єдиний механік
  // підйомника. Категорія обраної роботи нового рядка і прапорець «виконавця обрала людина» —
  // ручний вибір автопідстановка не перезаписує.
  const [newLineCategoryId, setNewLineCategoryId] = useState<string | null>(null);
  const newLineExecutorManualRef = useRef(false);
  // Механік найранішого запису наряду в календарі (наявний наряд — з linked-documents).
  const [linkedSlotMechanicId, setLinkedSlotMechanicId] = useState<string | null>(null);

  // Inline edit state (null = no row being edited)
  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null);
  const [editingPart, setEditingPart] = useState<Omit<LocalPart, '_key'>>(EMPTY_PART);
  // BR-WO-029: товар, для якого рядок ще чекає автовибору складу (залишки ще не прийшли).
  // Ручний вибір складу знімає очікування — пізня відповідь його не перезапише.
  const partAutoPickRef = useRef<Record<PartRow, string | null>>({ new: null, edit: null });

  // Accumulated pre-save rows: lines/parts тепер джерело правди — RHF field-array (оголошено
  // вгорі як watch()-shim lines/parts + setLines/setParts→replace). Старий useState прибрано.
  // A3-modal: stock-totals кеш винесено у useStockTotals (Bug #452-454 збережено). Виклик — після
  // оголошення parts/newPart/editingPart нижче.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  // Перемикач шапки в картці — дві різні кнопки: «Згорнути» в першій секції (ховається разом із
  // шапкою) і картка-зведення «Розгорнути» (зникає з розгортанням). Після кліку фокус переходить на
  // кнопку протилежної дії, а не лишається на схованій / не падає на <body>. Лише клік людини —
  // автозгортання під час правки рядка фокус не забирає.
  const headerCollapseBtnRef = useRef<HTMLButtonElement>(null);
  const headerExpandBtnRef = useRef<HTMLButtonElement>(null);
  const headerToggleFocusRef = useRef(false);
  const toggleHeaderByUser = useCallback((collapsed: boolean) => {
    headerToggleFocusRef.current = true;
    setHeaderCollapsed(collapsed);
  }, []);
  useEffect(() => {
    if (!headerToggleFocusRef.current) return;
    headerToggleFocusRef.current = false;
    // preventScroll: шапка ще анімується з 0fr у контейнері overflow-hidden — фокус без нього
    // прокрутив би той контейнер, і верх шапки лишився б зрізаним після розгортання.
    (headerCollapsed ? headerExpandBtnRef : headerCollapseBtnRef).current?.focus({
      preventScroll: true,
    });
  }, [headerCollapsed]);

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
    if (!open) return;
    dirty.resetDirty();
    setError('');
    setStatusMenuOpen(false);
    setLinkedDocsCounts(null);
    setVehicles([]);
    setContracts([]);
    setNewLine(EMPTY_LINE);
    setNewLineCategoryId(null);
    newLineExecutorManualRef.current = false;
    setLinkedSlotMechanicId(null);
    setNewPart(EMPTY_PART);
    partAutoPickRef.current = { new: null, edit: null };
    setShowLineInput(false);
    setShowPartInput(false);
    setEditingLineKey(null);
    setEditingPartKey(null);
    setHeaderCollapsed(false);
    setWoNumber('');
    setCurrentStatus('DRAFT');
    setPayState(null);
    setPayOpen(false);
    // A fresh modal session starts without a prior partial create.
    createdWoRef.current = null;
    postedLineKeysRef.current = new Set();
    postedPartKeysRef.current = new Set();
    setCounterpartyDisplayName(prefill?.counterpartyDisplay ?? '');
    setCpPhone('');

    if (!isEditMode) {
      // Авто-вибір єдиної філії (Bug #639) — програмний, тож входить у reset-базу (не dirty),
      // а не окремим setValue. prefill.branchId має пріоритет.
      let branchId = prefill?.branchId ?? '';
      if (!branchId) {
        const src = getCached<Branch[]>('cache:branches') ?? branches;
        if (src.length === 1) branchId = src[0].id;
      }
      // reset() ставить нову «чисту» базу → rhfDirty=false (edit-режим заповнюється load-ефектом).
      reset({
        ...emptyDefaults(),
        branchId,
        vehicleId: prefill?.vehicleId ?? '',
        counterpartyId: prefill?.counterpartyId ?? '',
        liftId: prefill?.liftId ?? '',
        description: prefill?.description ?? '',
        plannedStartAt: prefill?.plannedStartAt ?? '',
        plannedEndAt: prefill?.plannedEndAt ?? '',
        plannedHours:
          prefill?.plannedHours ??
          calcPlannedHours(prefill?.plannedStartAt, prefill?.plannedEndAt, workHoursRef.current),
      });
      if (prefill?.counterpartyId) {
        loadVehicles(prefill.counterpartyId, prefill.vehicleId);
        loadContracts(prefill.counterpartyId);
      }
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
    setLoadedDocId(null);
    apiFetch<WorkOrderDetail>(`/work-orders/${workOrderId}?withDeleted=true`)
      .then(wo => {
        if (cancelled) return;
        setDeletedDocId(wo.deletedAt ? workOrderId : null);
        setLoadedDocId(workOrderId);
        setWoNumber(wo.number);
        setCurrentStatus(wo.status);
        setPayState(toPayState(wo));
        const loadedLines: LocalLine[] = wo.lines.map(l => ({
          _key: nextKey(),
          id: l.id,
          workId: l.workId,
          workName: l.workName ?? '',
          employeeId: l.employeeId,
          employeeName: l.employeeName ?? '',
          normoHours: String(l.normoHours),
          actualHours: l.actualHours != null ? String(l.actualHours) : '',
          price: String(l.price),
        }));
        const loadedParts: LocalPart[] = wo.parts.map(p => ({
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
        }));
        savedScheduleRef.current = {
          plannedStartAt: isoToKyivLocalDateTime(wo.plannedAt),
          plannedEndAt: isoToKyivLocalDateTime(wo.dueDate),
          liftId: wo.liftId ?? '',
        };
        // reset() із завантаженими даними → нова «чиста» база (rhfDirty=false для незмінених даних).
        // lines/parts несуть _key/display-поля поза схемою (widened у field-array item).
        reset({
          ...emptyDefaults(),
          branchId: wo.branchId ?? '',
          vehicleId: wo.vehicleId ?? '',
          counterpartyId: wo.counterpartyId ?? '',
          contractId: wo.contractId ?? '',
          currencyId: wo.currencyId ?? '',
          liftId: wo.liftId ?? '',
          description: wo.description ?? '',
          priority: wo.priority ?? 'NORMAL',
          repairCategory: wo.repairCategory ?? '',
          documentDate: wo.documentDate ? wo.documentDate.slice(0, 10) : kyivToday(),
          plannedStartAt: savedScheduleRef.current.plannedStartAt,
          plannedEndAt: savedScheduleRef.current.plannedEndAt,
          plannedHours: wo.plannedHours != null ? String(wo.plannedHours) : '',
          actualHours: wo.actualHours != null ? String(wo.actualHours) : '',
          lines: loadedLines as unknown as WorkOrderFormInput['lines'],
          parts: loadedParts as unknown as WorkOrderFormInput['parts'],
        });
        setCounterpartyDisplayName(wo.counterpartyName ?? '');
        setCpPhone('');
        if (wo.counterpartyId) {
          loadVehicles(wo.counterpartyId, wo.vehicleId);
          loadContracts(wo.counterpartyId);
        }
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t('detail.loadError'));
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

  // Fetch linked-documents counts for tab badge — runs on open and after refresh.
  // Separate from the main WO fetch so the badge updates even when Документи tab not visited.
  useEffect(() => {
    if (!open || !isEditMode || !workOrderId) return;
    let cancelled = false;
    apiFetch<{
      invoices: unknown[];
      payments: unknown[];
      calendarSlots: LinkedSlotMechanic[];
      warranties: unknown[];
    }>(`/work-orders/${workOrderId}/linked-documents`)
      .then(d => {
        if (cancelled) return;
        setLinkedDocsCounts({
          invoices: d.invoices.length,
          payments: d.payments.length,
          calendarSlots: d.calendarSlots.length,
          warranties: d.warranties.length,
        });
        setLinkedSlotMechanicId(slotMechanicId(d.calendarSlots));
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
    if (getValues('branchId')) return;
    // Bug #639: авто-вибір єдиної філії — програмна зміна; setValue({shouldDirty:false})
    // не вмикає dirty-guard (форма лишається «чистою» на open).
    setValue('branchId', branches[0].id, { shouldDirty: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, open, isEditMode]);

  // Auto-collapse header when user starts adding/editing table rows
  useEffect(() => {
    if (showLineInput || showPartInput || !!editingLineKey || !!editingPartKey) {
      setHeaderCollapsed(true);
    }
  }, [showLineInput, showPartInput, editingLineKey, editingPartKey]);

  // A3-modal: loadVehicles/loadContracts у useReferenceData. Тонка обгортка передає onSingleVehicle-колбек
  // (auto-select single vehicle) → хук лишається form-agnostic, а form-мутація тут (spine).
  const loadVehicles = (cpId: string, keepVehicleId?: string) =>
    loadVehiclesRef(cpId, keepVehicleId, vehicleId => {
      // Авто-вибір єдиного авто — програмний (shouldDirty:false), як branch-autoselect.
      if (!getValues('vehicleId')) setValue('vehicleId', vehicleId, { shouldDirty: false });
    });

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
          secondary: t('card.workPickerSecondary', { hours: w.normoHours, price: w.price }),
        })),
      ),
    [t],
  );

  const fetchGoods = useCallback(
    (q: string) =>
      fetchGoodPickerItems(q, g => (g.sku ? `${g.sku} · ${g.salePrice} ₴` : `${g.salePrice} ₴`)),
    [],
  );

  // Стан закупівлі збережених рядків (списки купівлі, замовлення, нестача) — бейдж і
  // «До списку купівлі» (docs/objects/purchase-list.md).
  const invalidateProcurement = useInvalidateProcurement();
  const procurement = useWorkOrderProcurementState(isEditMode ? workOrderId : null);
  const savedPartsForProcurement = useMemo(
    () =>
      parts
        .filter((p): p is LocalPart & { id: string } => !!p.id)
        .map(p => ({ id: p.id, goodName: p.goodName })),
    [parts],
  );

  // A3-modal: stock-totals кеш винесено у useStockTotals (Bug #452-454 збережено ДОСЛІВНО).
  const { stockTotalsMap, stockWarehouseMap, stockFreeByGood } = useStockTotals(
    parts,
    newPart.goodId,
    editingPart.goodId,
  );

  // BR-WO-029: товар обрано → склад очищується й підбирається, щойно прийдуть залишки товару.
  // Той самий товар, обраний повторно (вікно вибору), — не зміна товару: склад (ручний чи
  // підставлений) лишається. Інакше поле очищувалось, а набір товарів не змінювався — нового
  // запиту залишків і автовибору не було, склад лишався порожнім (Bug #936).
  const newPartGoodId = newPart.goodId;
  const editingPartGoodId = editingPart.goodId;
  const pickPartGood = useCallback(
    (row: PartRow, g: GoodPickerItem) => {
      const set = row === 'new' ? setNewPart : setEditingPart;
      if ((row === 'new' ? newPartGoodId : editingPartGoodId) === g.id) {
        set(p => ({ ...p, ...partGoodFields(g) }));
        return;
      }
      partAutoPickRef.current[row] = g.id;
      set(p => ({ ...p, ...partGoodFields(g), warehouseId: '' }));
    },
    [newPartGoodId, editingPartGoodId],
  );

  const pickPartWarehouseManually = useCallback((row: PartRow, warehouseId: string) => {
    partAutoPickRef.current[row] = null;
    const set = row === 'new' ? setNewPart : setEditingPart;
    set(p => ({ ...p, warehouseId }));
  }, []);

  // Інший рядок у правці — очікування попереднього не стосується його товару.
  useEffect(() => {
    partAutoPickRef.current.edit = null;
  }, [editingPartKey]);

  useEffect(() => {
    // До відповіді `/warehouses` перелік порожній — «основного немає» тут ще не означає нічого.
    if (warehouses.length === 0) return;
    const pending = partAutoPickRef.current;
    const apply = (row: PartRow, goodId: string, set: typeof setNewPart): void => {
      if (!goodId || pending[row] !== goodId) return;
      const free = stockFreeByGood.get(goodId);
      if (free === undefined) return;
      pending[row] = null;
      // `null` — залишки не отримано: як «вільної немає» (основний), а не порожнє поле назавжди.
      const warehouseId = pickPartWarehouse(free ?? [], warehouses);
      set(p => (p.goodId === goodId ? { ...p, warehouseId } : p));
    };
    apply('new', newPart.goodId, setNewPart);
    apply('edit', editingPart.goodId, setEditingPart);
  }, [stockFreeByGood, warehouses, newPart.goodId, editingPart.goodId]);

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
  // Робочі години — з ref: хендлери лишаються стабільними (memo PlannedActualMetrics), а
  // рахують за годинами філії, обраної зараз.
  const handlePlannedStartChange = useCallback((v: string) => {
    setForm(f => ({
      ...f,
      plannedStartAt: v,
      plannedHours: calcPlannedHours(v, f.plannedEndAt, workHoursRef.current),
    }));
  }, []);
  const handlePlannedEndChange = useCallback((v: string) => {
    setForm(f => ({
      ...f,
      plannedEndAt: v,
      plannedHours: calcPlannedHours(f.plannedStartAt, v, workHoursRef.current),
    }));
  }, []);
  const handlePlannedHoursChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm(f => {
      const hours = Number(value.replace(',', '.'));
      const newEnd =
        f.plannedStartAt && Number.isFinite(hours) && hours > 0
          ? calcEndFromHours(f.plannedStartAt, hours, workHoursRef.current)
          : f.plannedEndAt;
      return { ...f, plannedHours: value, plannedEndAt: newEnd || f.plannedEndAt };
    });
  }, []);
  /** Автокінець для рядків робіт (WorksTable): ті самі робочі години філії. */
  const calcEndForLines = useCallback(
    (start: string, hours: number) => calcEndFromHours(start, hours, workHoursRef.current),
    [],
  );
  const handleActualHoursChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm(f => ({ ...f, actualHours: value }));
  }, []);

  // ── BR-WO-030: виконавець нової роботи ─────────────────────────────────────────
  const calendarMechanicId = isEditMode ? linkedSlotMechanicId : (prefill?.employeeId ?? null);
  const liftMechanics = useLiftMechanics(form.liftId);
  const activeMechanicIds = useMemo(() => employees.map(e => e.id), [employees]);
  // Свіжі входи правила для «+ Послуга»: категорії її робіт приходять після await.
  const executorInputsRef = useRef({
    calendarMechanicId,
    liftMechanics,
    activeMechanicIds,
    mechanics: employees,
  });
  executorInputsRef.current = {
    calendarMechanicId,
    liftMechanics,
    activeMechanicIds,
    mechanics: employees,
  };

  // Новий рядок: виконавець підставляється, щойно обрано роботу, і стежить за даними правила, що
  // приходять пізніше (механіки підйомника, запис календаря, довідник) — доки його не обрала людина.
  // Порожній рядок («Додати», «×», скасування, після додавання) знімає прапорець ручного вибору.
  useEffect(() => {
    if (!newLine.workId) {
      if (!newLine.employeeId) newLineExecutorManualRef.current = false;
      return;
    }
    if (newLineExecutorManualRef.current) return;
    const employeeId = pickLineExecutor({
      calendarMechanicId,
      liftMechanics,
      workCategoryId: newLineCategoryId,
      activeMechanicIds,
      mechanics: employees,
    });
    setNewLine(l =>
      l.workId && !newLineExecutorManualRef.current && l.employeeId !== employeeId
        ? { ...l, employeeId }
        : l,
    );
  }, [
    newLine.workId,
    newLine.employeeId,
    newLineCategoryId,
    calendarMechanicId,
    liftMechanics,
    activeMechanicIds,
    employees,
  ]);

  /** Робота нового рядка — пошуком у рядку чи вікном вибору. Той самий вибір вдруге нічого не скидає. */
  const pickNewLineWork = useCallback((w: WorkPickerItem) => {
    setNewLineCategoryId(w.categoryId ?? null);
    setNewLine(l => ({
      ...l,
      workId: w.id,
      workName: w.name,
      normoHours: String(w.normoHours),
      price: String(w.price),
    }));
  }, []);

  const changeNewLineExecutor = useCallback((employeeId: string) => {
    newLineExecutorManualRef.current = true;
    setNewLine(l => ({ ...l, employeeId }));
  }, []);

  const addLine = () => {
    if (!newLine.workId || !newLine.employeeId) return;
    // блокуємо повний дублікат (work + виконавець) — типовий user-error.
    if (lines.some(l => l.workId === newLine.workId && l.employeeId === newLine.employeeId)) {
      setError(t('card.duplicateLine'));
      return;
    }
    // захист від негативних/нульових normoHours (DTO @Min(0.01) інакше rejects after WO created).
    const normo = toNumberOrUndefined(newLine.normoHours);
    if (newLine.normoHours && (normo === undefined || normo <= 0)) {
      setError(t('card.normoHoursPositive'));
      return;
    }
    const linePrice = toNumberOrUndefined(newLine.price);
    if (newLine.price && (linePrice === undefined || linePrice < 0)) {
      setError(t('card.priceNegative'));
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
              ? calcEndForLines(f.plannedStartAt, Number(newHours.replace(',', '.')))
              : f.plannedEndAt;
          return { ...f, plannedHours: newHours, plannedEndAt: newEnd || f.plannedEndAt };
        });
      }
      return updated;
    });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  const applyService = async (service: ServicePickerItem) => {
    setError('');
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
    // Роботи з послуги — кожна з виконавцем за BR-WO-030 (категорія — зі списку робіт). Пропускаємо
    // дублікат: та сама робота без виконавця чи з тим самим виконавцем уже в наряді.
    if (service.works.length === 0) return;
    const forWorkOrder = workOrderIdRef.current;
    const categories = await workCategoriesFor(service.works.map(w => w.workId));
    if (workOrderIdRef.current !== forWorkOrder) return;
    const inputs = executorInputsRef.current;
    setLines(prev => {
      const toAdd = service.works
        .map(w => ({
          w,
          employeeId: pickLineExecutor({
            calendarMechanicId: inputs.calendarMechanicId,
            liftMechanics: inputs.liftMechanics,
            workCategoryId: categories.get(w.workId) ?? null,
            activeMechanicIds: inputs.activeMechanicIds,
            mechanics: inputs.mechanics,
          }),
        }))
        .filter(
          ({ w, employeeId }) =>
            !prev.some(
              l => l.workId === w.workId && (!l.employeeId || l.employeeId === employeeId),
            ),
        )
        .map(({ w, employeeId }) => ({
          _key: nextKey(),
          workId: w.workId,
          workName: w.workName,
          employeeId,
          normoHours: String(w.normoHours * w.quantity),
          actualHours: '',
          price: String(w.price),
        }));
      return [...prev, ...toAdd];
    });
  };

  const addPart = () => {
    if (!newPart.goodId || !newPart.warehouseId) return;
    // блокуємо повний дублікат (товар + склад).
    if (parts.some(p => p.goodId === newPart.goodId && p.warehouseId === newPart.warehouseId)) {
      setError(t('card.duplicatePart'));
      return;
    }
    // backend DTO @Min(0.001) для quantity → reject цілого create() після WO POST.
    const qty = toNumberOrUndefined(newPart.quantity);
    if (qty === undefined || qty <= 0) {
      setError(t('card.qtyPositive'));
      return;
    }
    const partPrice = toNumberOrUndefined(newPart.price);
    if (newPart.price && (partPrice === undefined || partPrice < 0)) {
      setError(t('card.priceNegative'));
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
  // Bug #755 (retry-safety РЯДКІВ/ДЕТАЛЕЙ): multi-request submit (POST шапка → N× POST /lines,
  // /parts) при обриві на рядку #2 лишає рядок #1 збереженим на беку. Повторний клік ре-постив
  // би ВСІ рядки з форми → задвоєна сума. Запам'ятовуємо _key кожного успішно збереженого рядка
  // й на ретраї пропускаємо його. _key стабільний per-row (nextKey() при append/flush/load).
  const postedLineKeysRef = useRef<Set<string>>(new Set());
  const postedPartKeysRef = useRef<Set<string>>(new Set());

  const create = async () => {
    // WEB-H3 (Bug #630): синхронний guard проти concurrent double-submit. Два click-и в
    // одному tick інакше створять 2 наряди до застосування disabled={saving}.
    if (savingRef.current || transitioningRef.current) return;
    // Валідація через спільну zod-схему (Invoice/PO-патерн: safeParse(getValues) як гейт;
    // payload далі будується з form.*/toNumberOrUndefined для UA-коми та existing-семантики).
    // Half-row auto-flush нижче доповнює lines/parts staging-рядком ДО перевірки.
    {
      const flushLine =
        newLine.workId && newLine.employeeId ? [{ ...newLine, _key: nextKey() }] : [];
      const flushPart =
        newPart.goodId && newPart.warehouseId ? [{ ...newPart, _key: nextKey() }] : [];
      const parsed = workOrderFormSchema.safeParse({
        ...getValues(),
        lines: [...(getValues('lines') ?? []), ...flushLine],
        parts: [...(getValues('parts') ?? []), ...flushPart],
      });
      if (!parsed.success) {
        setError(validationText(parsed.error.issues[0]?.message ?? t('card.checkFields')));
        return;
      }
    }
    // warn user if half-typed row would be silently dropped (data loss).
    // Pre-check BEFORE setSaving so the button stays enabled and the warning is visible.
    const hasHalfLine = !!newLine.workId && !newLine.employeeId;
    const hasHalfPart = !!newPart.goodId && !newPart.warehouseId;
    if (hasHalfLine || hasHalfPart) {
      setError(hasHalfLine ? t('card.halfLine') : t('card.halfPart'));
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
            currencyId: form.currencyId || undefined,
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
      // after a mid-batch failure does NOT duplicate already-saved lines. Bug #755:
      // додатково фіксуємо _key у postedLineKeysRef і пропускаємо його на ретраї —
      // drop-from-array сам по собі не захищає (setLines shim → replace, а мид-батч
      // fail лишає обірваний масив; Set — авторитетне джерело «вже збережено»).
      for (const line of linesToPost) {
        if (line._key && postedLineKeysRef.current.has(line._key)) continue;
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
        if (line._key) postedLineKeysRef.current.add(line._key);
        setLines(prev => prev.filter(l => l._key !== line._key));
      }

      for (const part of partsToPost) {
        if (part._key && postedPartKeysRef.current.has(part._key)) continue;
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
        if (part._key) postedPartKeysRef.current.add(part._key);
        setParts(prev => prev.filter(p => p._key !== part._key));
      }

      createdWoRef.current = null;
      postedLineKeysRef.current = new Set();
      postedPartKeysRef.current = new Set();
      dirty.resetDirty();
      // BR-WO-020: наряд з обома плановими датами вже має запис календаря — відкритий календар
      // перечитує записи.
      if (form.plannedStartAt && form.plannedEndAt) notifyCalendarChanged();
      onCreated?.(wo);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.createError'));
    } finally {
      setSavingBoth(false);
    }
  };

  const save = async () => {
    // Ctrl+Enter у модалці кличе цей самий обробник — видалений наряд не зберігаємо.
    if (!workOrderId || viewOnly) return;
    // WEB-H3: синхронний guard проти concurrent double-submit (savingRef фліпається до re-render).
    if (savingRef.current || transitioningRef.current) return;
    // Commit any open inline-edit row synchronously so save() reads the latest actualHours.
    // setLines is async (React batched), so compute the merged snapshot here and use it
    // directly in the rest of save() via committedLines instead of the stale `lines` closure.
    // spread `l` FIRST so `id` (and other DB-only fields) survive the merge.
    // editingLine state never carries `id` → раніше merge скидав `id` у undefined →
    // save() filter `!!l.id && l.actualHours !== ''` пропускав рядок → PATCH lines
    // не надсилався → actualHours на line-рівні ніколи не зберігалось у IN_PROGRESS/ON_HOLD.
    // ⚠️ Commit editing row у field-array ДО читання getValues('lines') (RHF-джерело правди).
    const committedLines = editingLineKey
      ? lines.map(l => (l._key === editingLineKey ? { ...l, ...editingLine, _key: l._key } : l))
      : lines;
    if (editingLineKey) {
      setLines(committedLines);
      setEditingLineKey(null);
    }
    // Валідація через спільну zod-схему (гейт; payload будується з form.*/committedLines нижче
    // для UA-коми та existing null-семантики). committedLines merge вже враховано.
    {
      const parsed = workOrderFormSchema.safeParse({
        ...getValues(),
        lines: committedLines,
        parts: getValues('parts') ?? [],
      });
      if (!parsed.success) {
        setError(validationText(parsed.error.issues[0]?.message ?? t('card.checkFields')));
        return;
      }
    }
    setSavingBoth(true);
    setError('');
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
            currencyId: form.currencyId || undefined,
            priority: form.priority || undefined,
            repairCategory: form.repairCategory || undefined,
            description: form.description || undefined,
            // liftId/plannedAt/dueDate: nullable-семантика бекенду (workOrderUpdateSchema)
            // очищає поле при explicit `null`, а `undefined` (omit) лишає без змін. Форма
            // не має окремого "не чіпати" значення — порожній інпут/Select === "користувач
            // очистив" → мусимо слати `null`, інакше clear мовчки не зберігається (як Bug #755
            // nullable-паттерн для plannedHours/actualHours нижче).
            liftId: form.liftId || null,
            plannedAt:
              localDateTimeToISO(form.plannedStartAt) ?? (form.plannedStartAt ? undefined : null),
            dueDate:
              localDateTimeToISO(form.plannedEndAt) ?? (form.plannedEndAt ? undefined : null),
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
        const lineIds = deletedLineIds.current;
        const partIds = deletedPartIds.current;
        const [lineResults, partResults] = await Promise.all([
          Promise.allSettled(
            lineIds.map(lineId =>
              apiFetch(`/work-orders/${workOrderId}/lines/${lineId}`, { method: 'DELETE' }),
            ),
          ),
          Promise.allSettled(
            partIds.map(partId =>
              apiFetch(`/work-orders/${workOrderId}/parts/${partId}`, { method: 'DELETE' }),
            ),
          ),
        ]);
        // Bug #869: відмову сервера не ковтаємо — сума нижче сплаченого (BR-WO-015) лишала рядок
        // у наряді, а картка закривалась без повідомлення. Невидалені лишаються на повтор.
        deletedLineIds.current = lineIds.filter((_, i) => lineResults[i]?.status === 'rejected');
        deletedPartIds.current = partIds.filter((_, i) => partResults[i]?.status === 'rejected');
        const deleteFailure = [...lineResults, ...partResults].find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        if (deleteFailure) throw deleteFailure.reason;
        // Sequentially POST нових + PATCH існуючих ліній. Кожен write на бекенді
        // викликає recalcTotals (aggregate + update WO.totalLabor/Parts/Amount).
        // Паралель = race у READ COMMITTED: тх1/тх2 одна одної не бачать у
        // SUM(amount), тому останній writer перетирає тotalAmount → втрачені суми.
        for (const line of committedLines.filter(l => !l.id)) {
          // Bug #755: на ретраї (частина рядків уже збережена) пропускаємо вже-POST-нуті _key —
          // новий рядок (без id) інакше щоразу потрапляє у фільтр → задвоєна сума.
          if (line._key && postedLineKeysRef.current.has(line._key)) continue;
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
          if (line._key) postedLineKeysRef.current.add(line._key);
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
          // Bug #755: retry-dedup нових деталей (без id) через postedPartKeysRef.
          if (part._key && postedPartKeysRef.current.has(part._key)) continue;
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
          if (part._key) postedPartKeysRef.current.add(part._key);
        }
        // Bug #837: PATCH збережених рядків товарів, змінених у картці (кількість, ціна, одиниця).
        // Раніше тут був лише POST нових: правка наявного рядка мовчки губилась — картка показувала
        // нову кількість, а в базі (і у «Зведенні» панелі списку) лишалась стара.
        // Послідовно, як рядки робіт: кожен PATCH перераховує тотали наряду. Після успіху картка
        // закривається, тож прапорець `_dirty` знімати нема кому; після помилки він лишається,
        // і повторне «Зберегти» шле ті самі значення ще раз (PATCH ідемпотентний).
        for (const part of parts.filter(p => !!p.id && p._dirty)) {
          await apiFetch(`/work-orders/${workOrderId}/parts/${part.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              quantity: toNumberOrUndefined(part.quantity),
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
      // BR-WO-020: запис календаря наряду сервер переносить / видаляє в тій самій транзакції,
      // що й зберігає дати й підйомник (раніше — окремий діалог і PATCH by-work-order тут).
      // Відкритий календар перечитує записи — лише коли дати чи підйомник справді змінились.
      const saved = savedScheduleRef.current;
      if (
        canEdit &&
        (form.plannedStartAt !== saved.plannedStartAt ||
          form.plannedEndAt !== saved.plannedEndAt ||
          form.liftId !== saved.liftId)
      )
        notifyCalendarChanged();
      postedLineKeysRef.current = new Set();
      postedPartKeysRef.current = new Set();
      dirty.resetDirty();
      // Товари наряду могли змінитись — стан закупівлі (нестача, позиції списків) перечитується.
      invalidateProcurement();
      onUpdated?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('detail.saveError'));
    } finally {
      setSavingBoth(false);
    }
  };

  const doTransition = async (newStatus: string) => {
    // Стрілки ◀/▶ лежать у тому ж контейнері, що й меню: клік по них меню не закриває, а відкрите
    // меню під підтвердженням з'їло б його перший Escape.
    setStatusMenuOpen(false);
    if (!workOrderId || viewOnly) return;
    // При переході COMPLETED→INVOICED пропонуємо створити рахунок якщо його ще немає.
    if (
      newStatus === 'INVOICED' &&
      currentStatus === 'COMPLETED' &&
      linkedDocsCounts?.invoices === 0
    ) {
      // Обидві кнопки — дії; Escape / хрестик — відмова від обох (Bug #926: Escape переводив наряд
      // у «Виставлено», а назад FSM не веде).
      const choice = await chooseOverCard({
        title: t('card.invoicePrompt.title'),
        message: t('card.invoicePrompt.message'),
        confirmLabel: t('card.invoicePrompt.confirm'),
        cancelLabel: t('card.invoicePrompt.cancel'),
      });
      if (choice === null) return;
      if (choice) {
        void handleInvoice();
        return;
      }
      // false — «Тільки перевести статус»: переводимо без рахунку
    }
    if (newStatus === 'IN_PROGRESS' && calConflict?.anyConflict) {
      const ok = await confirmOverCard({
        title: t('card.inProgressConfirm.title'),
        message: t('card.inProgressConfirm.message', {
          n: calConflict.conflictSlots.length,
          numbers: conflictWoNumbers ? ': ' + conflictWoNumbers : '',
        }),
        confirmLabel: t('card.inProgressConfirm.confirm'),
        variant: 'destructive',
      });
      if (!ok) return;
    }
    // BR-WO-025: скасування — лише після підтвердження; з «Виконано» — попередження про повернення
    // товарів на склад і сторно боргу клієнта (той самий текст, що на сторінці наряду).
    if (
      newStatus === 'CANCELLED' &&
      !(await confirmOverCard(cancelConfirmOptions(t, currentStatus)))
    )
      return;
    setTransitioningBoth(true);
    setError('');
    try {
      const updated = await apiFetch<{ status?: string } | null>(
        `/work-orders/${workOrderId}/transition`,
        { method: 'POST', body: JSON.stringify({ status: newStatus }) },
      );
      // Статус — з відповіді сервера: повністю сплачений наряд із «Виконано» сам іде до
      // «Оплачено» (BR-WO-016), тож натиснута кнопка — не обов'язково статус наряду.
      setCurrentStatus(updated?.status ?? newStatus);
      // BR-WO-022: скасований наряд звільняє свої записи календаря — відкритий календар
      // (картка поверх нього) перечитує їх, інакше показував би запис скасованого наряду.
      if ((updated?.status ?? newStatus) === 'CANCELLED') notifyCalendarChanged();
      // «Виконано» перераховує суму наряду — перечитуємо гроші для «Оплатити».
      void reloadPayState();
      // Перехід міняє резерв і позиції списків купівлі наряду (BR-WO-021, BR-PL-013).
      invalidateProcurement();
      onUpdated?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.transitionError'));
    } finally {
      setTransitioningBoth(false);
    }
  };

  /** Перечитати статус і гроші наряду (після оплати чи переходу) — форму з рядками не чіпає. */
  const reloadPayState = async () => {
    const requestedId = workOrderId;
    if (!requestedId) return;
    try {
      const wo = await apiFetch<WorkOrderDetail>(`/work-orders/${requestedId}`);
      if (workOrderIdRef.current !== requestedId) return;
      setCurrentStatus(wo.status);
      setPayState(toPayState(wo));
    } catch {
      // Статус і гроші лишаються попередніми; наступне відкриття картки перечитає наряд.
    }
  };

  // Видалений наряд переходів не має: сервер відповість 404 на будь-яку зміну. Ручного переходу
  // в «Оплачено» немає — замість нього «Оплатити» (BR-WO-016): «Оплачено» ставлять лише гроші.
  const allowedTransitions =
    isEditMode && !viewOnly
      ? (WO_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS).filter(s => s !== 'PAID')
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
  }, [currentStatus, isEditMode, viewOnly]);

  // O(N×M) → O(N+M): Map.get instead of .find() per rendered row/onChange.
  // A3-modal: *ById-мапи перенесено у useReferenceData (див. destructure вгорі).

  // Фактичні години редагуються тільки у статусах В роботі / Призупинено.
  const canEditActual =
    isEditMode && !viewOnly && (currentStatus === 'IN_PROGRESS' || currentStatus === 'ON_HOLD');

  // Підсумки фактичних сум: actualHours ?? normoHours для кожного рядка (бо save()
  // надсилає на бекенд саме такий фолбек коли recalcActualHoursFromLines=true).
  // hasAny=true лише коли є ХОЧА Б ОДИН рядок з ЯВНО введеним
  // actualHours — інакше "Факт. роботи" tfoot дублював "Разом робіт" і вводив
  // користувача в оману (виглядало ніби факт. години = плановим).
  // Використовуємо toNumberOrUndefined (а не parseFloat) щоб коректно обробити
  // ukr-коми (1,5 → 1.5); save() теж використовує toNumberOrUndefined → totals
  // у tfoot збігаються з тим, що піде у PATCH backend.
  const actualTotals = useMemo(
    () => ({
      total: sumLineAmounts(
        lines.map(l => ({
          qty: toNumberOrUndefined(l.actualHours) ?? toNumberOrUndefined(l.normoHours),
          price: toNumberOrUndefined(l.price),
        })),
      ),
      hasAny: lines.some(l => toNumberOrUndefined(l.actualHours) != null),
    }),
    [lines],
  );

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
        vatMode,
      ),
    [lines, vatRate, vatMode],
  );
  const partsTotals = useMemo(
    () =>
      calcVatTotals(
        parts.map(pt => ({
          qty: toNumberOrUndefined(pt.quantity),
          price: toNumberOrUndefined(pt.price),
        })),
        vatRate,
        vatMode,
      ),
    [parts, vatRate, vatMode],
  );
  // Підсумок документа за BR-WO-007. База — ФАКТИЧНІ роботи (actualHours ?? normoHours) плюс
  // запчастини: саме від неї бекенд рахує ПДВ і суму до сплати, і рахує ПДВ один раз на всю
  // базу — сума ПДВ із двох таблиць могла б відрізнятись на копійку.
  const documentTotals = useMemo(
    () => splitVatTotals(actualTotals.total + partsTotals.total, vatRate, vatMode),
    [actualTotals.total, partsTotals.total, vatRate, vatMode],
  );
  const canEdit = isEditMode ? WO_EDITABLE_STATUSES.includes(currentStatus) && !viewOnly : true;
  // Share/print/SMS allowed in DRAFT/ESTIMATE/APPROVED; after IN_PROGRESS the public link is inactive.
  // A3-modal: action-handlers (print/saveAs/share/sms/invoice+rollback) + loading + invoiceConflict
  // винесено у useWorkOrderActions. Footer-JSX споживає повернені handlers/флаги.
  const { employee } = useAuth();

  // «Оплатити» (BR-PAY-001): статуси, що приймають оплату, і ролі, яким дозволено POST /payments.
  const canPay =
    isEditMode &&
    !viewOnly &&
    !!payState &&
    WO_PAYABLE_STATUSES.includes(currentStatus) &&
    PAYMENT_CREATE_ROLES.includes(employee?.role ?? '');
  const payRemaining = payState ? invoiceRemaining(payState.totalAmount, payState.paidAmount) : 0;
  const openPay = () => setPayOpen(true);
  const closePay = useCallback(() => setPayOpen(false), []);
  const handlePaid = (_amount: number, formatted: string) => {
    closePay();
    if (features.toastEnabled) toast.success(t('payment.paidToast', { amount: formatted }));
    // Наряд міг стати «Оплачено» (BR-PAY-005) — статус і сплачене беремо з сервера.
    void reloadPayState();
    setLinkedDocsRefreshKey(k => k + 1);
    onUpdated?.();
  };

  const {
    shareLoading,
    smsLoading,
    invoiceLoading,
    printLoading,
    invoiceConflict,
    setInvoiceConflict,
    saveAsOpen,
    setSaveAsOpen,
    canShare,
    canInvoice,
    canPrintOrder,
    canPrintInvoice,
    handlePrint,
    handlePrintOrder,
    handleSaveOrderPdf,
    handlePrintInvoice,
    handleSaveAs,
    handleShare,
    shareOpen,
    setShareOpen,
    shareLink,
    handleCopyShareLink,
    handleRegenerateShare,
    handleRevokeShare,
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
    viewOnly,
    woNumber,
    role: employee?.role,
  });

  // Меню статусу й «Зберегти як» — шари над карткою: Escape закриває лише їх (Bug #924, клас Bug #783),
  // а не картку. Меню «Зберегти як» живе в `useWorkOrderActions` і скиданням при відкритті вище не
  // покрите — без цього картка відкривалась із розгорнутим меню (Bug #925).
  // Меню видно лише за наявності переходів: інакше перехоплювач «ковтав» би Escape без меню.
  const statusMenuShown = statusMenuOpen && allowedTransitions.length > 0;
  useEscapeLayer(statusMenuShown, () => setStatusMenuOpen(false));
  useEscapeLayer(saveAsOpen, () => setSaveAsOpen(false));
  useEffect(() => {
    if (open) {
      setSaveAsOpen(false);
      setShareOpen(false);
    }
  }, [open, workOrderId, setSaveAsOpen, setShareOpen]);

  // regression: читаємо `saving`/`transitioning` ВИКЛЮЧНО з ref'ів —
  // вони оновлюються СИНХРОННО у setSavingBoth/setTransitioningBoth ДО React state-flush.
  // Без ref'а closure захоплює застарілий saving=false коли `create()` ще у `await POST`
  // → Modal закривається на Escape всупереч guard'у (race window що ловить test #381).
  //
  // Escape у вкладених вікнах (вибір, оплата, «До списку купівлі», підтвердження, конфлікт рахунку)
  // сюди не доходить — вони вищі шари Escape (Bug #923).
  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    setActiveTab('main');
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // Підсумок документа — у футері ліворуч, один примірник для обох режимів (варіант A).
  const totalsSummary =
    lines.length > 0 || parts.length > 0 ? (
      <VatTotalsSummary split={documentTotals} currencySymbol="" layout="inline" />
    ) : null;

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleModalClose()}
        onSubmit={() => void (isEditMode ? save() : create())}
        title={isEditMode ? t('card.titleEdit') : t('card.titleNew')}
        size="content"
        // A card with tabs keeps a stable size: the short "documents" tab must not shrink the window.
        fixedHeight={isEditMode ? 'full' : false}
        // Варіант A «Картки секцій»: білі секції на сірому тілі, підсумок і кнопки — у білому футері.
        bodyClassName="bg-secondary"
        footerClassName="bg-surface"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground shrink-0">
              <span className="font-medium">{t('card.number')}</span>
              <span className="text-foreground">
                {isEditMode && woNumber ? woNumber : t('card.autoNumber')}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">
                {t('card.documentDate')}
              </span>
              <div className="w-36">
                <DatePickerInput
                  value={form.documentDate}
                  onChange={v => setForm(f => ({ ...f, documentDate: v }))}
                  disabled={!canEdit}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">
                {t('card.status')}
              </span>
              <div ref={statusMenuRef} className="relative flex items-center gap-1">
                <button
                  type="button"
                  disabled={transitioning || !statusPrevStep || !isEditMode}
                  onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-[80px] truncate">
                    {statusPrevStep ? woStatusLabel(statusPrevStep) : '—'}
                  </span>
                </button>
                <Tooltip content={WO_STATUS_DESCRIPTIONS[currentStatus] ?? currentStatus}>
                  <button
                    type="button"
                    disabled={transitioning || !isEditMode || viewOnly}
                    onClick={() => isEditMode && setStatusMenuOpen(o => !o)}
                    className={cn(
                      'inline-flex items-center gap-1.5 h-7 text-[13px] font-semibold px-3 rounded-full transition-colors',
                      STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground',
                      isEditMode && !transitioning && 'cursor-pointer hover:opacity-80',
                      !isEditMode && 'cursor-default',
                    )}
                  >
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-current" />
                    {isEditMode ? woStatusLabel(currentStatus) : woStatusLabel('DRAFT')}
                  </button>
                </Tooltip>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-[80px] truncate">
                    {statusNextStep ? woStatusLabel(statusNextStep) : '—'}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </button>
                {statusMenuShown && (
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
                        {t(`card.transition.${s}`, { defaultValue: s })}
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
                    label: woNumber || t('card.minimizedLabel'),
                    modalKey: 'work-order',
                    restoreProps: { workOrderId },
                  });
                  onMinimize?.();
                  setActiveTab('main');
                  onClose();
                }}
                className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
                title={t('card.minimize')}
                aria-label={t('card.minimize')}
                disabled={saving || transitioning}
              >
                <Minus className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => void handleModalClose()}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
              title={t('common:close')}
              aria-label={t('common:close')}
              disabled={saving || transitioning}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        }
        footer={
          isEditMode ? (
            <div className="flex flex-wrap items-center w-full gap-x-4 gap-y-2">
              {totalsSummary}
              <div className="flex gap-2 items-center flex-wrap justify-end ml-auto">
                {allowedTransitions.includes('CANCELLED') && (
                  <Button
                    variant="destructive"
                    onClick={() => void doTransition('CANCELLED')}
                    loading={transitioning}
                    disabled={transitioning || saving}
                    size="sm"
                  >
                    {t('common:cancel')}
                  </Button>
                )}
                {/* BR-WO-012: «Друк», «Зберегти як», «Поділитись» і SMS ідуть через токен поширення
                    (POST /work-orders/:id/share-token), а сервер видаленого наряду не знаходить —
                    у картці перегляду весь блок сховано. */}
                {canShare && !viewOnly && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handlePrint()}
                      loading={shareLoading}
                      disabled={shareLoading || smsLoading || saving || transitioning}
                      title={t('card.printTitle')}
                    >
                      <Printer size={15} className="mr-1" />
                      {t('detail.print')}
                    </Button>
                    <div className="relative">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSaveAsOpen(v => !v)}
                        disabled={shareLoading || smsLoading || saving || transitioning}
                        title={t('card.saveAsTitle')}
                      >
                        <Download size={15} className="mr-1" />
                        {t('card.saveAs')}
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
                    {!viewOnly && (
                      <>
                        <div className="relative">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleShare()}
                            loading={shareLoading && !shareOpen}
                            disabled={shareLoading || smsLoading || saving || transitioning}
                            title={t('card.shareTitle')}
                            aria-expanded={shareOpen}
                          >
                            <Share2 size={15} className="mr-1" />
                            {t('card.share')}
                          </Button>
                          {shareOpen && shareLink && (
                            <ShareLinkPanel
                              link={shareLink}
                              loading={shareLoading}
                              onCopy={() => void handleCopyShareLink()}
                              onRegenerate={() => void handleRegenerateShare()}
                              onRevoke={() => void handleRevokeShare()}
                              onClose={() => setShareOpen(false)}
                            />
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleSendSms()}
                          loading={smsLoading}
                          disabled={shareLoading || smsLoading || saving || transitioning}
                          title={t('card.smsTitle')}
                        >
                          <MessageSquare size={15} className="mr-1" />
                          SMS
                        </Button>
                      </>
                    )}
                  </>
                )}
                {/* BR-WO-013: від «Виконано» друкується наряд-замовлення (серверний PDF з
                    реквізитами), а не кошторис; для видаленого наряду canPrintOrder = false. */}
                {canPrintOrder && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handlePrintOrder()}
                      loading={printLoading}
                      disabled={printLoading || saving || transitioning || invoiceLoading}
                    >
                      <Printer size={15} className="mr-1" />
                      {t('print.order')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleSaveOrderPdf()}
                      disabled={printLoading || saving || transitioning || invoiceLoading}
                    >
                      <Download size={15} className="mr-1" />
                      {t('print.savePdf')}
                    </Button>
                    {canPrintInvoice && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handlePrintInvoice()}
                        disabled={printLoading || saving || transitioning || invoiceLoading}
                      >
                        <Printer size={15} className="mr-1" />
                        {t('print.invoice')}
                      </Button>
                    )}
                  </>
                )}
                {canPay && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={openPay}
                    disabled={payRemaining <= 0 || saving || transitioning}
                    title={payRemaining <= 0 ? t('payment.nothingToPay') : undefined}
                  >
                    <CreditCard size={15} className="mr-1" />
                    {t('payment.pay')}
                  </Button>
                )}
                {canInvoice && !viewOnly && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void handleInvoice()}
                    loading={invoiceLoading}
                    disabled={
                      invoiceLoading || saving || transitioning || shareLoading || smsLoading
                    }
                    title={t('invoice.create')}
                  >
                    <Receipt size={15} className="mr-1" />
                    {t('invoice.create')}
                  </Button>
                )}
                {(canEdit || canEditActual) && (
                  <Button
                    onClick={() => void save()}
                    loading={saving}
                    disabled={
                      saving || transitioning || shareLoading || smsLoading || invoiceLoading
                    }
                  >
                    {t('card.saveChanges')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  // Як Escape і «×»: незбережені зміни — спершу підтвердження (useDirtyForm).
                  onClick={() => void handleModalClose()}
                  disabled={saving || transitioning}
                >
                  {t('common:close')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center w-full gap-x-4 gap-y-2">
              {totalsSummary}
              <Button
                onClick={() => void create()}
                loading={saving}
                disabled={!form.branchId || !form.counterpartyId || !form.vehicleId}
                className="w-full sm:w-auto sm:ml-auto"
              >
                {t('card.createOrder')}
              </Button>
            </div>
          )
        }
      >
        {/* Tab switcher — тільки в режимі редагування */}
        {isEditMode && (
          // -mt-4: вкладки під самою шапкою — без порожньої смуги між шапкою і вкладками.
          <div className="flex border-b border-border -mt-4 mb-3">
            <button
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === 'main'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveTab('main')}
            >
              {t('card.tabMain')}
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
              {t('card.tabDocuments')}
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
                {t('common:loading')}
              </div>
            )}
            {error && (
              <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            {isDeleted && <DeletedDocumentBanner className="mb-4" />}
            {!editModeLoading && isEditMode && !canEdit && !viewOnly && (
              <div className="mb-4 text-[13px] text-warning bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2">
                {t('card.readOnlyStatus', { status: woStatusLabel(currentStatus) })}
              </div>
            )}

            <div className="flex flex-col min-h-[70dvh]">
              {/* ── Шапка документа: картки «Клієнт і автомобіль» і «Планування» (варіант A).
                  Згортаються разом у картку-зведення нижче; автозгортання під час правки рядка
                  робіт / товарів — як і раніше (ефект headerCollapsed). ───────────────── */}
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
                style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
              >
                <div className="overflow-hidden">
                  <div className="flex flex-col gap-4 pb-4">
                    <DocumentSection
                      icon={UserRound}
                      title={t('card.clientVehicle')}
                      actions={
                        <SectionActionButton
                          ref={headerCollapseBtnRef}
                          aria-expanded
                          onClick={() => toggleHeaderByUser(true)}
                        >
                          {t('common:collapse')}
                          <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                        </SectionActionButton>
                      }
                    >
                      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                        <div className="col-span-2">
                          <EntityPickerField<HeaderCpItem>
                            label={t('card.client')}
                            required
                            display={counterpartyDisplayName}
                            placeholder={t('card.clientSearch')}
                            ariaLabel={t('card.client')}
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
                            // Як решта полів шапки: у картці лише на перегляд (статус не дозволяє
                            // правку або наряд позначено на видалення) клієнта не змінити й не очистити.
                            disabled={!canEdit}
                          />
                        </div>
                        <Select
                          label={t('card.vehicle')}
                          required
                          value={form.vehicleId}
                          onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
                          disabled={!canEdit || !form.counterpartyId}
                        >
                          <option value="">{t('addLine.choose')}</option>
                          {vehicles.map(v => (
                            <option key={v.id} value={v.id}>
                              {v.make} {v.model}
                              {v.licensePlate ? ` (${v.licensePlate})` : ''}
                            </option>
                          ))}
                        </Select>
                        <Select
                          label={t('detail.contract')}
                          value={form.contractId}
                          onChange={e => setForm(f => ({ ...f, contractId: e.target.value }))}
                          disabled={!canEdit || !form.counterpartyId || contracts.length === 0}
                        >
                          <option value="">{t('card.noContract')}</option>
                          {contracts.map(c => (
                            <option key={c.id} value={c.id}>
                              {/* Номер і тип: решту полів договору механік не отримує */}
                              {c.contractType
                                ? `${c.number} — ${contractTypeLabel(c.contractType)}`
                                : c.number}
                            </option>
                          ))}
                        </Select>
                        <Select
                          label={t('detail.branch')}
                          required
                          value={form.branchId}
                          onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
                          disabled={!canEdit || isEditMode || branches.length === 1}
                        >
                          {branches.length !== 1 && <option value="">{t('addLine.choose')}</option>}
                          {branches.map(b => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </Select>
                        <Select
                          label={t('detail.repairCategory')}
                          value={form.repairCategory}
                          onChange={e => setForm(f => ({ ...f, repairCategory: e.target.value }))}
                          disabled={!canEdit}
                        >
                          <option value="">{t('card.notSpecified')}</option>
                          {Object.keys(WO_CATEGORY_LABELS).map(k => (
                            <option key={k} value={k}>
                              {woCategoryLabel(k)}
                            </option>
                          ))}
                        </Select>
                        <div>
                          <Controller
                            control={control}
                            name="currencyId"
                            render={({ field }) => (
                              <CurrencySelect
                                value={typeof field.value === 'string' ? field.value : ''}
                                onChange={id => field.onChange(id)}
                                // Bug #747/#766-клас: авто-дефолт базової валюти — програмна зміна,
                                // не дія користувача → shouldDirty:false, щоб незаймана модалка не
                                // вважалась брудною (єдиний патерн із Invoice/PO модалками).
                                onAutoDefault={id =>
                                  setValue('currencyId', id, { shouldDirty: false })
                                }
                                disabled={!canEdit}
                              />
                            )}
                          />
                        </div>
                        <Select
                          label={t('detail.priority')}
                          value={form.priority}
                          onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                          disabled={!canEdit}
                        >
                          {Object.keys(WO_PRIORITY_LABELS).map(k => (
                            <option key={k} value={k}>
                              {woPriorityLabel(k)}
                            </option>
                          ))}
                        </Select>
                        <div className="col-span-2 lg:col-span-4">
                          <Input
                            label={t('detail.description')}
                            value={form.description}
                            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                            disabled={!canEdit}
                            placeholder={t('card.descriptionPlaceholder')}
                          />
                        </div>
                      </div>
                    </DocumentSection>

                    <DocumentSection
                      icon={CalendarClock}
                      title={t('card.planning')}
                      subtitle={t('card.planningHint')}
                    >
                      {/* Підйомник · План · Факт: на широкому екрані в один ряд, вужче — «Факт»
                          під «Планом» (дата з часом не обрізається, Bug #878). */}
                      <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)_minmax(0,1fr)]">
                        {/* «План» і «Факт» мають рядок-легенду над підписами полів, підйомник — ні:
                            притиснутий до низу рядка сітки, його поле стоїть в одну лінію з датами
                            (Bug #937). Вузько — окремим рядком, вирівнювати нема з чим. */}
                        <div className="md:self-end" data-testid="wo-lift">
                          <Select
                            label={t('card.lift')}
                            value={form.liftId}
                            onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
                            disabled={!canEdit}
                          >
                            <option value="">{t('card.noLift')}</option>
                            {lifts.map(l => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <PlannedActualMetrics
                          canEdit={canEdit}
                          plannedStartAt={form.plannedStartAt}
                          plannedEndAt={form.plannedEndAt}
                          plannedHours={form.plannedHours}
                          actualHours={form.actualHours}
                          liveActualHours={liveActualHours}
                          onPlannedStartChange={handlePlannedStartChange}
                          onPlannedEndChange={handlePlannedEndChange}
                          onPlannedHoursChange={handlePlannedHoursChange}
                          onActualHoursChange={handleActualHoursChange}
                          workHours={workHours}
                        />
                      </div>
                      {calConflict?.anyConflict && (
                        <div className="mt-4 rounded-md bg-warning-subtle border border-warning/20 px-3 py-2 text-[12px] text-warning">
                          ⚠{calConflict.liftConflict && ` ${t('card.conflict.lift')}`}
                          {calConflict.employeeConflict && ` ${t('card.conflict.employee')}`}{' '}
                          {t('card.conflict.overlap', { n: calConflict.conflictSlots.length })}
                          {conflictWoNumbers && <> ({conflictWoNumbers})</>}.{' '}
                          {t('card.conflict.rejected')}
                        </div>
                      )}
                    </DocumentSection>
                  </div>
                </div>
              </div>

              {/* ── Секції табличних частин (+ картка-зведення згорнутої шапки) ─────── */}
              <div className="flex-1 min-h-0 flex flex-col gap-4">
                <CollapsibleHeader
                  variant="card"
                  toggleRef={headerExpandBtnRef}
                  collapsed={headerCollapsed}
                  onToggle={() => toggleHeaderByUser(false)}
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
                  employeesLoaded={employeesLoaded}
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
                  onNewLineWorkPicked={pickNewLineWork}
                  onNewLineExecutorChange={changeNewLineExecutor}
                  recalcPlannedHoursEnabled={recalcPlannedHoursEnabled}
                  setForm={setForm}
                  calcPlannedHoursFromLines={calcPlannedHoursFromLines}
                  calcEndFromHours={calcEndForLines}
                  setWorkPickerOpen={setWorkPickerOpen}
                  setEditWorkPickerOpen={setEditWorkPickerOpen}
                  setServicePickerOpen={setServicePickerOpen}
                />

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
                  stockFreeByGood={stockFreeByGood}
                  onGoodPicked={pickPartGood}
                  onWarehousePicked={pickPartWarehouseManually}
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
                  procurement={procurement}
                  headerAction={
                    isEditMode && workOrderId && !viewOnly ? (
                      <SendToListButton
                        appearance="section"
                        workOrderId={workOrderId}
                        status={currentStatus}
                        parts={savedPartsForProcurement}
                        procurement={procurement}
                        disabled={saving}
                      />
                    ) : undefined
                  }
                />
              </div>
            </div>
            {/* /flex-col */}
          </>
        )}
      </Modal>

      <SearchPickerModal<SearchPickerItem & Counterparty>
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        title={t('card.pickClient')}
        selectedId={form.counterpartyId}
        searchPlaceholder={t('card.pickClientSearch')}
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
        onSelect={pickNewLineWork}
      />

      <ServicePickerModal
        open={servicePickerOpen}
        onClose={() => setServicePickerOpen(false)}
        onSelect={service => void applyService(service)}
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
        onSelect={g => pickPartGood('new', g)}
      />

      {/* Good picker for inline edit row */}
      <GoodPickerModal
        open={editGoodPickerOpen}
        onClose={() => setEditGoodPickerOpen(false)}
        selectedId={editingPart.goodId}
        onSelect={g => pickPartGood('edit', g)}
      />

      <InvoiceConflictDialog
        open={invoiceConflict}
        loading={invoiceLoading}
        onClose={() => setInvoiceConflict(false)}
        onRefresh={() => void handleInvoiceRefresh()}
        onOpenExisting={() => void handleInvoiceOpen()}
      />
      <ConfirmDialog {...confirmDialogProps} />
      <DirtyConfirmDialog {...dirty.dialogProps} />
      {/* «Оплатити» з наряду: аванс до «Виконано», оплата після (BR-PAY-020). Монтується лише
          відкритим — каси, способи оплати й мутація не живуть у закритій картці. */}
      {payOpen && (
        <ClientPaymentModal
          open={payOpen}
          target={
            workOrderId && payState
              ? {
                  kind: 'workOrder',
                  id: workOrderId,
                  counterpartyId: payState.counterpartyId,
                  amount: payState.totalAmount,
                  paidAmount: payState.paidAmount,
                  currencyCode: payState.currencyCode,
                }
              : null
          }
          title={
            WO_PREPAYMENT_STATUSES.includes(currentStatus)
              ? t('payment.advanceTitle', { number: woNumber })
              : t('payment.payTitle', { number: woNumber })
          }
          onClose={closePay}
          onPaid={handlePaid}
        />
      )}
    </>
  );
}
