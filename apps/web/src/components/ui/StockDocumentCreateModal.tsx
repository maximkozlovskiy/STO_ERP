'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  stockDocumentFormSchema,
  type StockDocumentFormInput,
  type StockDocumentFormValues,
} from '@sto/shared';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Minus,
  Printer,
  Download,
  Share2,
  MessageSquare,
  Plus,
  Trash2,
  X,
  Upload,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { getCached, setCache } from '@/lib/ref-cache';
import { cn } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import { pickScannedGood } from '@/lib/barcode';
import {
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_STATUS_TRANSITIONS,
  STOCK_DOC_TYPE_LABELS,
} from '@sto/shared';
import { stockDocStatusLabel, stockDocTypeLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { ExcelImportWizard } from '@/components/ui/ExcelImportWizard';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Branch {
  id: string;
  name: string;
}

interface Warehouse {
  id: string;
  name: string;
  deletedAt?: string | null;
}

interface Good {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  barcode?: string | null;
  barcodes?: string[];
}

interface PurchaseOrderRef {
  id: string;
  number: string;
  status?: string;
  supplierName?: string;
}

interface StockDocDetail {
  id: string;
  number: string;
  status: string;
  type: string;
  branchId: string;
  warehouseId: string;
  targetWarehouseId?: string | null;
  purchaseOrderId?: string | null;
  purchaseOrderNumber?: string | null;
  notes?: string | null;
  documentDate?: string | null;
  lines?: StockDocLine[];
}

interface StockDocLine {
  id: string;
  goodId: string;
  goodName?: string | null;
  unit?: string | null;
  quantity: number;
  price?: number;
}

// Локальний елемент рядка форми (useFieldArray). goodName/unit — лише для відображення
// (не валідуються схемою). quantity/price — рядки web-стану; схема коерсить у числа.
interface LocalLine {
  goodId: string;
  goodName: string;
  unit: string;
  quantity: string;
  price: string;
}

export interface StockDocResponse {
  id: string;
  number: string;
  type: string;
  status: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  CONFIRMED: 'bg-success-subtle text-success',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};

const STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — документ підготовлено, ще не підтверджено',
  CONFIRMED: 'Підтверджено — документ проведено, залишки змінено',
  CANCELLED: 'Скасовано — документ скасовано',
};

const TRANSITION_LABELS: Record<string, string> = {
  CONFIRMED: 'Підтвердити',
  CANCELLED: 'Скасувати',
};

const STOCK_DOC_STATUS_ORDER = Object.keys(STOCK_DOC_STATUS_LABELS);
const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

const EMPTY_LINE: LocalLine = {
  goodId: '',
  goodName: '',
  unit: 'шт',
  quantity: '1',
  price: '',
};

// «Чиста» база форми — reset() до неї на open дає rhfDirty=false (Bug #639: авто-вибір
// branch/warehouse через setValue({shouldDirty:false}), тому не вмикає dirty-guard).
const emptyDefaults = (): StockDocumentFormInput => ({
  type: 'WRITEOFF',
  branchId: '',
  warehouseId: '',
  targetWarehouseId: '',
  purchaseOrderId: '',
  notes: '',
  documentDate: kyivToday(),
  lines: [],
});

// ─── Props ────────────────────────────────────────────────────────────────────

export interface StockDocumentCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (doc?: StockDocResponse) => void;
  stockDocumentId?: string;
  onMinimize?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StockDocumentCreateModal({
  open,
  onClose,
  onSaved,
  stockDocumentId,
  onMinimize,
}: StockDocumentCreateModalProps) {
  const isEditMode = !!stockDocumentId;
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const { minimizeModal } = useTabBarContext();

  // react-hook-form + спільна zod-схема (шапка + line-items через useFieldArray).
  const {
    control,
    register,
    reset,
    watch,
    setValue,
    getValues,
    handleSubmit,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<StockDocumentFormInput, unknown, StockDocumentFormValues>({
    resolver: i18nZodResolver(stockDocumentFormSchema),
    defaultValues: emptyDefaults(),
    mode: 'onBlur',
  });
  // Рядки document (goodId/quantity/price + локальні goodName/unit для відображення).
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watchedLines = watch('lines');
  const formType = watch('type');
  const branchId = watch('branchId');
  const warehouseId = watch('warehouseId');

  // Display-номер обраного PO (поза формою: лише візуал, не валідується).
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');
  const [poPickerOpen, setPoPickerOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [docNumber, setDocNumber] = useState('');
  const [newLine, setNewLine] = useState<LocalLine>(EMPTY_LINE);
  const [showLineInput, setShowLineInput] = useState(false);
  const [excelWizardOpen, setExcelWizardOpen] = useState(false);
  // Стабільний onClose — GOTCHAS modal-thrashing.
  const closeExcelWizard = useCallback(() => setExcelWizardOpen(false), []);
  const [goodSearchOpen, setGoodSearchOpen] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [error, setError] = useState('');

  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  // Bug #639: авто-вибір єдиного branch/warehouse — програмна зміна (не дія
  // користувача). Через setValue({shouldDirty:false}) значення не вмикає dirty-guard.
  const autoSelectedRef = useRef<{ branch: boolean; warehouse: boolean }>({
    branch: false,
    warehouse: false,
  });

  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const setTransitioningBoth = (v: boolean) => {
    transitioningRef.current = v;
    setTransitioning(v);
  };

  // Close status menu on outside click
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

  // Load reference data
  useEffect(() => {
    if (!open) return;
    const cachedBranches = getCached<Branch[]>('cache:branches');
    if (cachedBranches) {
      setBranches(cachedBranches);
    }
    apiFetch<Branch[]>('/branches')
      .then(bs => {
        setBranches(bs);
        setCache('cache:branches', bs);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження філій'));

    const cachedWarehouses = getCached<Warehouse[]>('cache:warehouses');
    if (cachedWarehouses) {
      setWarehouses(cachedWarehouses.filter(w => !w.deletedAt));
    }
    apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(r => {
        const all = Array.isArray(r) ? r : (r.items ?? []);
        const list = all.filter(w => !w.deletedAt);
        setWarehouses(list);
        setCache('cache:warehouses', list);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження складів'));
  }, [open]);

  // Reset on open — чиста база (rhfDirty=false) + скидання refs/локального стану.
  useEffect(() => {
    if (!open) {
      autoSelectedRef.current = { branch: false, warehouse: false };
      return;
    }
    autoSelectedRef.current = { branch: false, warehouse: false };
    dirty.resetDirty();
    setError('');
    setStatusMenuOpen(false);
    setHeaderCollapsed(false);
    setDocNumber('');
    setCurrentStatus('DRAFT');
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    setPurchaseOrderNumber('');
    if (!isEditMode) {
      // reset() ставить чисту базу → rhfDirty=false (edit заповнюється load-ефектом).
      reset(emptyDefaults());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stockDocumentId]);

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  // Токен останнього запиту — stale-guard: якщо docId/open змінились (або компонент
  // розмонтувався) поки fetch у польоті, застаріла відповідь НЕ перезаписує свіжий стан.
  const loadReqRef = useRef(0);

  // Load document in edit mode. silent=true — для reload після XLSX/Excel import позицій:
  // без loading-спінера (форма вже видима). reset() ставить нову «чисту» базу → rhfDirty=false.
  const loadDoc = useCallback(
    (docId: string, silent = false) => {
      const reqId = ++loadReqRef.current;
      const isStale = () => reqId !== loadReqRef.current;
      if (!silent) setLoading(true);
      setError('');
      return apiFetch<StockDocDetail>(`/stock-documents/${docId}`)
        .then(doc => {
          if (isStale()) return;
          setDocNumber(doc.number);
          setCurrentStatus(doc.status);
          reset({
            type: (doc.type ?? 'WRITEOFF') as StockDocumentFormInput['type'],
            branchId: doc.branchId ?? '',
            warehouseId: doc.warehouseId ?? '',
            targetWarehouseId: doc.targetWarehouseId ?? '',
            purchaseOrderId: doc.purchaseOrderId ?? '',
            notes: doc.notes ?? '',
            documentDate: doc.documentDate ? doc.documentDate.slice(0, 10) : kyivToday(),
            lines: (doc.lines ?? []).map(l => ({
              goodId: l.goodId,
              goodName: l.goodName ?? '',
              unit: l.unit ?? 'шт',
              quantity: String(l.quantity),
              price: String(l.price ?? ''),
            })),
          });
          setPurchaseOrderNumber(doc.purchaseOrderNumber ?? '');
          // Завантажені дані — база вже узгоджена; авто-вибір складів не потрібен.
          autoSelectedRef.current = { branch: true, warehouse: true };
        })
        .catch(e => {
          if (isStale()) return;
          setError(e instanceof Error ? e.message : 'Помилка завантаження документа');
        })
        .finally(() => {
          if (isStale()) return;
          if (!silent) setLoading(false);
        });
    },
    [reset],
  );

  useEffect(() => {
    if (!open || !isEditMode || !stockDocumentId) return;
    void loadDoc(stockDocumentId);
    // Invalidate any in-flight load on re-run/unmount — застаріла відповідь ігнорується.
    return () => {
      loadReqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stockDocumentId]);

  // Auto-collapse header when adding lines
  useEffect(() => {
    if (showLineInput) setHeaderCollapsed(true);
  }, [showLineInput]);

  // Auto-select single branch/warehouse — shouldDirty:false не вмикає dirty (Bug #639).
  useEffect(() => {
    if (branches.length === 1 && !autoSelectedRef.current.branch && !getValues('branchId')) {
      autoSelectedRef.current.branch = true;
      setValue('branchId', branches[0].id, { shouldDirty: false });
    }
  }, [branches, getValues, setValue]);

  useEffect(() => {
    if (
      warehouses.length === 1 &&
      !autoSelectedRef.current.warehouse &&
      !getValues('warehouseId')
    ) {
      autoSelectedRef.current.warehouse = true;
      setValue('warehouseId', warehouses[0].id, { shouldDirty: false });
    }
  }, [warehouses, getValues, setValue]);

  // ── Good picker ───────────────────────────────────────────────────────────

  type GoodItem = SearchPickerItem & {
    unit?: string | null;
    barcode?: string | null;
    barcodes?: string[];
  };

  const fetchGoodItems = useCallback(async (q: string): Promise<GoodItem[]> => {
    const data = await apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=20`);
    return data.items.map(g => ({
      id: g.id,
      primary: g.name,
      secondary: g.sku ?? undefined,
      unit: g.unit,
      barcode: g.barcode,
      barcodes: g.barcodes,
    }));
  }, []);

  // ── FSM ───────────────────────────────────────────────────────────────────

  // Memoize allowedTransitions itself для referential stability (інакше fresh fallback
  // array щорендеру) — тоді prev/next useMemo коректно залежить від нього (дзеркалить PO).
  const allowedTransitions = useMemo<readonly string[]>(
    () =>
      isEditMode
        ? (STOCK_DOC_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS)
        : EMPTY_TRANSITIONS,
    [currentStatus, isEditMode],
  );

  const { statusPrevStep, statusNextStep } = useMemo(() => {
    const curIdx = STOCK_DOC_STATUS_ORDER.indexOf(currentStatus);
    let statusPrevStep: string | undefined;
    for (let i = allowedTransitions.length - 1; i >= 0; i--) {
      const s = allowedTransitions[i];
      if (s && STOCK_DOC_STATUS_ORDER.indexOf(s) < curIdx) {
        statusPrevStep = s;
        break;
      }
    }
    const statusNextStep = allowedTransitions.find(
      (s: string) => STOCK_DOC_STATUS_ORDER.indexOf(s) > curIdx,
    );
    return { statusPrevStep, statusNextStep };
  }, [currentStatus, allowedTransitions]);

  const doTransition = async (newStatus: string) => {
    if (!stockDocumentId) return;
    setTransitioningBoth(true);
    setError('');
    try {
      await apiFetch(`/stock-documents/${stockDocumentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus }),
      });
      setCurrentStatus(newStatus);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка переходу статусу');
    } finally {
      setTransitioningBoth(false);
    }
  };

  // ── Lines ─────────────────────────────────────────────────────────────────

  const total = useMemo(
    () =>
      (watchedLines ?? []).reduce((sum, l) => {
        const qty = parseFloat(String(l.quantity)) || 0;
        const price = parseFloat(String(l.price ?? '')) || 0;
        return sum + qty * price;
      }, 0),
    [watchedLines],
  );

  const addLine = () => {
    if (!newLine.goodId) return;
    append({ ...newLine });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' : true;

  // Спільний submit-handler: валідація зі схеми, потім гілка create/update.
  // Рядки йдуть У ТІЛІ (атомарний $transaction на беку) — без окремого /lines-endpoint.
  const onValid = handleSubmit(async (values: StockDocumentFormValues) => {
    // WEB-H3 (Bug #630): синхронний guard проти concurrent double-submit.
    if (savingRef.current || transitioningRef.current) return;
    setSavingBoth(true);
    setError('');
    // Рядки з форми + staging-рядок (newLine) якщо користувач ще не натиснув «+».
    const lineList: StockDocumentFormValues['lines'] = [...values.lines];
    if (newLine.goodId) {
      const q = parseFloat(newLine.quantity);
      lineList.push({
        goodId: newLine.goodId,
        quantity: Number.isFinite(q) && q > 0 ? q : 1,
        price: newLine.price ? parseFloat(newLine.price) || undefined : undefined,
      });
    }
    const payloadLines = lineList.map(l => ({
      goodId: l.goodId,
      quantity: l.quantity,
      price: l.price,
    }));
    try {
      if (isEditMode) {
        // PATCH з lines замінює ВСІ рядки (soft-delete наявних, re-create з тіла).
        await apiFetch(`/stock-documents/${stockDocumentId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            notes: values.notes || undefined,
            documentDate: values.documentDate || undefined,
            lines: payloadLines,
          }),
        });
        if (features.toastEnabled) toast.success('Документ збережено');
        dirty.resetDirty();
        onSaved?.();
        onClose();
      } else {
        const doc = await apiFetch<StockDocResponse>('/stock-documents', {
          method: 'POST',
          body: JSON.stringify({
            type: values.type,
            branchId: values.branchId,
            warehouseId: values.warehouseId,
            targetWarehouseId:
              values.type === 'TRANSFER' ? values.targetWarehouseId || undefined : undefined,
            purchaseOrderId: values.purchaseOrderId || undefined,
            notes: values.notes || undefined,
            documentDate: values.documentDate || undefined,
            lines: payloadLines,
          }),
        });
        if (features.toastEnabled) toast.success(`Документ ${doc.number} створено`);
        dirty.resetDirty();
        onSaved?.(doc);
        onClose();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  });

  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isTransfer = formType === 'TRANSFER';
  const warehouseLabel = isTransfer ? 'Склад-джерело' : 'Склад';

  const headerChips =
    isEditMode && headerCollapsed
      ? [
          formType ? stockDocTypeLabel(formType) : null,
          warehouseId ? (warehouses.find(w => w.id === warehouseId)?.name ?? null) : null,
        ].filter(Boolean)
      : [];

  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
        onSubmit={onValid}
        title={isEditMode ? 'Складський документ' : 'Новий складський документ'}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground shrink-0">
              <span className="font-medium">Номер:</span>
              <span className="text-foreground">
                {isEditMode && docNumber ? docNumber : '— присвоюється автоматично —'}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">Дата документа:</span>
              <div className="w-36">
                <Controller
                  control={control}
                  name="documentDate"
                  render={({ field }) => (
                    <DatePickerInput
                      value={typeof field.value === 'string' ? field.value : ''}
                      onChange={field.onChange}
                      disabled={!canEdit}
                    />
                  )}
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
                  <span className="max-w-20 truncate">
                    {statusPrevStep ? stockDocStatusLabel(statusPrevStep) : '—'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={transitioning || !isEditMode}
                  onClick={() => isEditMode && setStatusMenuOpen(o => !o)}
                  title={STATUS_DESCRIPTIONS[currentStatus]}
                  className={cn(
                    'text-sm font-medium px-2.5 py-1 rounded-full transition-colors',
                    STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground',
                    isEditMode && !transitioning && 'cursor-pointer hover:opacity-80',
                    !isEditMode && 'cursor-default',
                  )}
                >
                  {isEditMode ? stockDocStatusLabel(currentStatus) : stockDocStatusLabel('DRAFT')}
                </button>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep ? stockDocStatusLabel(statusNextStep) : '—'}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </button>
                {statusMenuOpen && allowedTransitions.length > 0 && (
                  <div className="absolute top-full left-0 mt-1 z-50 min-w-40 rounded-lg border border-border bg-surface shadow-lg py-1">
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
                        {TRANSITION_LABELS[s] ?? stockDocStatusLabel(s)}
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
            {isEditMode && (
              <button
                onClick={() => {
                  minimizeModal({
                    kind: 'modal',
                    label: docNumber || 'Документ',
                    modalKey: 'stock-document',
                    restoreProps: { stockDocumentId },
                  });
                  onMinimize?.();
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
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              {isEditMode && allowedTransitions.includes('CANCELLED') && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => doTransition('CANCELLED')}
                  loading={transitioning}
                  disabled={transitioning || saving}
                >
                  Скасувати
                </Button>
              )}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {isEditMode && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.print()}
                    disabled={saving || transitioning}
                    title="Друк"
                  >
                    <Printer size={15} className="mr-1" />
                    Друк
                  </Button>
                  <div className="relative">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSaveAsOpen(v => !v)}
                      disabled={saving || transitioning}
                    >
                      <Download size={15} className="mr-1" />
                      Зберегти як
                      <ChevronDown size={13} className="ml-1" />
                    </Button>
                    {saveAsOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setSaveAsOpen(false)} />
                        <div className="absolute bottom-full mb-1 right-0 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-35">
                          {(['pdf', 'xlsx', 'docx'] as const).map(fmt => (
                            <button
                              key={fmt}
                              type="button"
                              onClick={() => setSaveAsOpen(false)}
                              className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors"
                            >
                              {fmt === 'pdf'
                                ? 'PDF'
                                : fmt === 'xlsx'
                                  ? 'Excel (.xlsx)'
                                  : 'Word (.docx)'}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving || transitioning}
                    title="Поділитись"
                  >
                    <Share2 size={15} className="mr-1" />
                    Поділитись
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving || transitioning}
                    title="Відправити SMS"
                  >
                    <MessageSquare size={15} className="mr-1" />
                    SMS
                  </Button>
                  {/* FSM "Підтвердити" shortcut */}
                  {allowedTransitions.includes('CONFIRMED') && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => doTransition('CONFIRMED')}
                      loading={transitioning}
                      disabled={transitioning || saving}
                    >
                      Підтвердити
                    </Button>
                  )}
                </>
              )}
              {isEditMode ? (
                canEdit && (
                  <Button
                    onClick={onValid}
                    loading={saving}
                    disabled={saving || transitioning}
                    size="sm"
                  >
                    Зберегти зміни
                  </Button>
                )
              ) : (
                <Button
                  onClick={onValid}
                  loading={saving}
                  // TRANSFER потребує targetWarehouseId — інакше схема блокує submit.
                  disabled={
                    saving ||
                    !branchId ||
                    !warehouseId ||
                    (formType === 'TRANSFER' && !watch('targetWarehouseId'))
                  }
                  size="sm"
                >
                  Створити документ
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleModalClose}
                disabled={saving || transitioning}
              >
                Закрити
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col min-h-[70dvh]">
          {/* ── Collapsible header ─────────────────────────────────────── */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
            style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden">
              <div className="space-y-4 pb-1">
                {loading && (
                  <div className="flex justify-center py-4 text-sm text-muted-foreground">
                    Завантаження…
                  </div>
                )}
                {error && (
                  <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                {/* Рядок 2: Тип документа | Філія */}
                <div className="grid grid-cols-2 gap-4">
                  <Controller
                    control={control}
                    name="type"
                    render={({ field }) => (
                      <Select
                        label="Тип документа"
                        required
                        value={field.value}
                        onChange={e => {
                          field.onChange(e.target.value);
                          // зміна типу з TRANSFER на інший скидає targetWarehouseId
                          // (щоб не лишити orphan; superRefine інакше не спрацює бо не-TRANSFER).
                          if (e.target.value !== 'TRANSFER') {
                            setValue('targetWarehouseId', '', { shouldDirty: true });
                          }
                        }}
                        disabled={!canEdit || isEditMode}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        {Object.keys(STOCK_DOC_TYPE_LABELS).map(k => (
                          <option key={k} value={k}>
                            {stockDocTypeLabel(k)}
                          </option>
                        ))}
                      </Select>
                    )}
                  />
                  <Controller
                    control={control}
                    name="branchId"
                    render={({ field }) => (
                      <Select
                        label="Філія"
                        required
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        errorMessage={errors.branchId?.message}
                        disabled={!canEdit || isEditMode}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        <option value="">— Оберіть —</option>
                        {branches.map(b => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  />
                </div>

                {/* Рядок 3: Склад | Склад призначення (тільки для TRANSFER) */}
                <div className="grid gap-4 grid-cols-2">
                  <Controller
                    control={control}
                    name="warehouseId"
                    render={({ field }) => (
                      <Select
                        label={warehouseLabel}
                        required
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        errorMessage={errors.warehouseId?.message}
                        disabled={!canEdit || isEditMode}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        <option value="">— Оберіть —</option>
                        {warehouses.map(w => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  />
                  {isTransfer ? (
                    <Controller
                      control={control}
                      name="targetWarehouseId"
                      render={({ field }) => (
                        <Select
                          label="Склад призначення"
                          required
                          value={typeof field.value === 'string' ? field.value : ''}
                          onChange={field.onChange}
                          errorMessage={errors.targetWarehouseId?.message}
                          disabled={!canEdit || isEditMode}
                          className="h-8 text-[13px] py-0.5 px-2 pr-7"
                        >
                          <option value="">— Оберіть —</option>
                          {warehouses
                            .filter(w => w.id !== warehouseId)
                            .map(w => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                        </Select>
                      )}
                    />
                  ) : (
                    <div />
                  )}
                </div>

                {/* Рядок 4: Замовлення (джерело) — опціонально (Phase D2) */}
                <EntityPickerField
                  label="Замовлення (джерело)"
                  display={purchaseOrderNumber}
                  placeholder="Замовлення постачальнику (необовʼязково)…"
                  className="h-8 text-[13px]"
                  disabled={!canEdit || isEditMode}
                  onPick={() => setPoPickerOpen(true)}
                  onClear={() => {
                    setValue('purchaseOrderId', '', { shouldDirty: true });
                    setPurchaseOrderNumber('');
                  }}
                />

                {/* Рядок 5: Примітки */}
                <Input
                  label="Примітки"
                  {...register('notes')}
                  disabled={!canEdit}
                  placeholder="Додаткова інформація…"
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
          </div>

          {/* ── Header toggle strip ──────────────────────────────────────── */}
          <button
            type="button"
            onClick={() => setHeaderCollapsed(c => !c)}
            className={[
              'flex items-center gap-2 w-full py-1.5 px-2 text-[11px]',
              'hover:bg-secondary/60 transition-colors select-none shrink-0',
              'border-t border-border',
            ].join(' ')}
          >
            {headerCollapsed ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="text-muted-foreground">Шапка документа</span>
            {headerChips.map((chip, i) => (
              <span
                key={i}
                className="bg-secondary text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
              >
                {chip}
              </span>
            ))}
          </button>

          {/* ── Lines table ──────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto">
            <table className="w-full table-fixed text-[12px]">
              <colgroup>
                <col className="w-[42%]" />
                <col className="w-[10%]" />
                <col className="w-[13%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
                <col className="w-[5%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">ТОВАР</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">ОВ</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">К-СТЬ</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    ЦІНА, ₴
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    СУМА, ₴
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fields.map((line, index) => {
                  const qtyRaw = watchedLines?.[index]?.quantity;
                  const priceRaw = watchedLines?.[index]?.price;
                  const qty = parseFloat(String(qtyRaw ?? line.quantity)) || 0;
                  const price = parseFloat(String(priceRaw ?? line.price ?? ''));
                  // goodName/unit — display-only поля, збережені у field-array при append/load,
                  // але поза zod-схемою (payload їх не містить) → читаємо через cast.
                  const display = line as unknown as { goodName?: string; unit?: string };
                  return (
                    <tr key={line.id} className="hover:bg-secondary/20 group">
                      <td className="px-3 py-2">{display.goodName}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{display.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{String(line.quantity)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number.isFinite(price) && price ? String(line.price) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number.isFinite(price) && price ? (qty * price).toFixed(2) : '—'}
                      </td>
                      <td className="px-2 py-2">
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => remove(index)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Add line input row */}
                {canEdit && showLineInput && (
                  <tr className="bg-primary/5">
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => setGoodSearchOpen(true)}
                        className="w-full text-left rounded border border-input bg-background px-2 py-1 text-[12px] hover:border-primary transition-colors"
                      >
                        {newLine.goodName || (
                          <span className="text-muted-foreground">Оберіть товар…</span>
                        )}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 text-right text-[11px] text-muted-foreground">
                      {newLine.unit}
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min="0.001"
                        step="1"
                        value={newLine.quantity}
                        onChange={e => setNewLine(l => ({ ...l, quantity: e.target.value }))}
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={newLine.price}
                        onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                        placeholder="0.00"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground text-[11px]">
                      {(
                        (parseFloat(newLine.quantity) || 0) * (parseFloat(newLine.price) || 0)
                      ).toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={addLine}
                          disabled={!newLine.goodId}
                          className="text-primary hover:text-primary/80 disabled:opacity-30"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowLineInput(false);
                            setNewLine(EMPTY_LINE);
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-secondary/20">
                  <td
                    colSpan={4}
                    className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground"
                  >
                    Разом:
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] font-semibold tabular-nums">
                    {total > 0 ? `${fmtMoney(total)} ₴` : '—'}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {canEdit && !showLineInput && (
              <div className="flex items-center gap-3 mt-2 ml-3">
                <button
                  type="button"
                  onClick={() => setShowLineInput(true)}
                  className="flex items-center gap-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Додати товар
                </button>
                {isEditMode && stockDocumentId && (
                  <>
                    <XlsxImportButton
                      templateType="sd-lines"
                      importUrl={`/xlsx/import/stock-document-lines/${stockDocumentId}`}
                      onImportComplete={() => loadDoc(stockDocumentId, true)}
                    />
                    <button
                      type="button"
                      onClick={() => setExcelWizardOpen(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-border bg-surface text-foreground hover:bg-secondary transition-colors"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Завантажити з Excel
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Good picker for new line */}
      <SearchPickerModal<GoodItem>
        open={goodSearchOpen}
        onClose={() => setGoodSearchOpen(false)}
        title="Оберіть товар"
        fetchItems={fetchGoodItems}
        searchPlaceholder="Назва, артикул / штрих-код…"
        emptyText="Товарів не знайдено"
        scanSubmit={(items, typed) => pickScannedGood(items, typed)}
        onSelect={item => {
          setNewLine(l => ({
            ...l,
            goodId: item.id,
            goodName: item.primary,
            unit: (item as GoodItem).unit ?? 'шт',
          }));
          setGoodSearchOpen(false);
        }}
      />

      {/* Purchase-order (source) picker — опціонально. StockDocument не має поля
          постачальника, тож просто перелічуємо останні замовлення. */}
      <SearchPickerModal
        open={poPickerOpen}
        onClose={() => setPoPickerOpen(false)}
        title="Оберіть замовлення (джерело)"
        searchPlaceholder="Номер замовлення…"
        emptyText="Замовлень не знайдено"
        fetchItems={q =>
          apiFetch<{ items: PurchaseOrderRef[] }>(
            `/purchase-orders?q=${encodeURIComponent(q)}&limit=30`,
          ).then(d =>
            d.items.map(po => ({
              id: po.id,
              primary: po.number,
              secondary: po.supplierName ?? undefined,
            })),
          )
        }
        onSelect={item => {
          setValue('purchaseOrderId', item.id, { shouldDirty: true });
          setPurchaseOrderNumber(item.primary);
          setPoPickerOpen(false);
        }}
      />
      {/* Майстер завантаження товарів з Excel. StockDocument не має контрагента —
          counterpartyId=undefined (mapping тоді не читається, це ок). */}
      {stockDocumentId && (
        <ExcelImportWizard
          open={excelWizardOpen}
          onClose={closeExcelWizard}
          docType="STOCK_DOCUMENT"
          docId={stockDocumentId}
          docNumber={docNumber || undefined}
          counterpartyId={undefined}
          onImportComplete={() => void loadDoc(stockDocumentId, true)}
        />
      )}

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
