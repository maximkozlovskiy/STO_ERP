'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  stockDocumentFormSchema,
  type StockDocumentFormInput,
  type StockDocumentFormValues,
} from '@sto/shared';
import { ChevronDown, ChevronUp, Plus, Trash2, Upload } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DeletedDocumentBanner } from '@/components/ui/DeletedDocumentBanner';
import { getCached, setCache } from '@/lib/ref-cache';
import { lineAmount, sumLineAmounts } from '@/lib/utils';
import { fmtDateTime, fmtMoney, fmtQty, kyivToday } from '@/lib/format';
import { pickScannedGood } from '@/lib/barcode';
import {
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_STATUS_TRANSITIONS,
  STOCK_DOC_TYPE_LABELS,
} from '@sto/shared';
import { stockDocStatusLabel, stockDocTypeLabel } from '@/i18n/enumLabel';
import i18n from '@/i18n/config';
import { Modal } from '@/components/ui/modal';
import { DocLinesHeader, DocLinesEmptyRow } from '@/components/ui/doc-lines-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { ExcelImportWizard } from '@/components/ui/ExcelImportWizard';
import {
  DocumentCancelAction,
  DocumentCardHeaderActions,
  DocumentEditActions,
} from '@/components/ui/document-card-actions';
import {
  DocumentHeaderField,
  DocumentNumberField,
  DocumentStatusStepper,
  FormDateInput,
} from '@/components/ui/document-card-header';

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
  /** Мітка часу проведення (ISO); лише для CONFIRMED. */
  confirmedAt?: string | null;
  /** Заповнене — документ позначено на видалення (приходить лише з `?withDeleted=true`). */
  deletedAt?: string | null;
  lines?: StockDocLine[];
}

interface StockDocLine {
  id: string;
  goodId: string;
  goodName?: string | null;
  goodSku?: string | null;
  unit?: string | null;
  quantity: number;
  price?: number;
}

// Локальний елемент рядка форми (useFieldArray). goodName/goodSku/unit — лише для відображення
// (не валідуються схемою). quantity/price — рядки web-стану; схема коерсить у числа.
interface LocalLine {
  goodId: string;
  goodName: string;
  goodSku: string;
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

// Статуси з підказкою (тексти — stockDocuments:card.statusDescription.<STATUS>).
const DESCRIBED_STATUSES: readonly string[] = ['DRAFT', 'CONFIRMED', 'CANCELLED'];

const STOCK_DOC_STATUS_ORDER = Object.keys(STOCK_DOC_STATUS_LABELS);
const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

const EMPTY_LINE: LocalLine = {
  goodId: '',
  goodName: '',
  goodSku: '',
  unit: 'шт',
  quantity: '1',
  price: '',
};

// «Чиста» база форми — reset() до неї на open дає rhfDirty=false (Bug #639: авто-вибір
// branch/warehouse через setValue({shouldDirty:false}), тому не вмикає dirty-guard).
const emptyDefaults = (
  type: StockDocumentFormInput['type'] = 'WRITEOFF',
): StockDocumentFormInput => ({
  type,
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
  /** Type preselected for a NEW document (the list's active type tab). */
  defaultType?: string;
  onMinimize?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StockDocumentCreateModal({
  open,
  onClose,
  onSaved,
  stockDocumentId,
  defaultType,
  onMinimize,
}: StockDocumentCreateModalProps) {
  const { t } = useTranslation('stockDocuments');
  const isEditMode = !!stockDocumentId;
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

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
  // Документ позначено на видалення → картка лише на перегляд (вантажиться з withDeleted).
  const [isDeleted, setIsDeleted] = useState(false);
  // Коли документ проведено (рішення власника №29: дата й час під таблицею проведеного документа).
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  // Id документа, який справді завантажено у форму (Bug #844).
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
  // Документ ще не завантажено (або завантаження не вдалось): у формі стоять типові значення
  // «чернетки», а не цей документ. Жодних дій — інакше «Підтвердити» провело б документ, якого
  // користувач не бачить (Bug #844). Разом із «видалено» це дає картку лише на перегляд.
  const notLoaded = !!stockDocumentId && loadedDocId !== stockDocumentId;
  const viewOnly = isDeleted || notLoaded;
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();

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
      .catch(e =>
        setError(e instanceof Error ? e.message : i18n.t('stockDocuments:card.branchesLoadError')),
      );

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
      .catch(e =>
        setError(
          e instanceof Error ? e.message : i18n.t('stockDocuments:card.warehousesLoadError'),
        ),
      );
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
    setSaveAsOpen(false);
    setHeaderCollapsed(false);
    setDocNumber('');
    setCurrentStatus('DRAFT');
    setIsDeleted(false);
    setConfirmedAt(null);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    setPurchaseOrderNumber('');
    if (!isEditMode) {
      // reset() ставить чисту базу → rhfDirty=false (edit заповнюється load-ефектом).
      // Тип звіряємо з ВЛАСНИМИ ключами мапи (ті самі, що дають варіанти поля), не через
      // `in`: той пропускає успадковані ключі об'єкта («toString»), і в полі опинявся б
      // тип, якого немає серед варіантів.
      reset(
        emptyDefaults(
          defaultType && Object.keys(STOCK_DOC_TYPE_LABELS).includes(defaultType)
            ? (defaultType as StockDocumentFormInput['type'])
            : undefined,
        ),
      );
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
      if (!silent) {
        setLoading(true);
        setLoadedDocId(null);
      }
      setError('');
      return apiFetch<StockDocDetail>(`/stock-documents/${docId}?withDeleted=true`)
        .then(doc => {
          if (isStale()) return;
          setDocNumber(doc.number);
          setCurrentStatus(doc.status);
          setIsDeleted(!!doc.deletedAt);
          setConfirmedAt(doc.confirmedAt ?? null);
          setLoadedDocId(docId);
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
              goodSku: l.goodSku ?? '',
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
          setError(e instanceof Error ? e.message : i18n.t('stockDocuments:card.loadError'));
        })
        .finally(() => {
          if (isStale()) return;
          if (!silent) setLoading(false);
        });
    },
    [reset],
  );

  // Імпорт з XLSX / майстра пише рядки в базу ОДРАЗУ, без «Зберегти». Тому крім перечитування
  // документа треба сповістити сторінку (onSaved): інакше після закриття картки хрестиком список
  // («Позицій») і «Зведення» бокової панелі показують числа до імпорту (Bug #838).
  const handleLinesImported = useCallback(
    (docId: string) => {
      void loadDoc(docId, true);
      onSaved?.();
    },
    [loadDoc, onSaved],
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
      // Видалений документ переходів не має: сервер відповість 404 на будь-яку зміну.
      isEditMode && !viewOnly
        ? (STOCK_DOC_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS)
        : EMPTY_TRANSITIONS,
    [currentStatus, isEditMode, viewOnly],
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
    // Стрілки ◀/▶ лежать у тому ж контейнері, що й меню: клік по них меню не закриває, а відкрите
    // меню під підтвердженням з'їло б його перший Escape.
    setStatusMenuOpen(false);
    if (!stockDocumentId || viewOnly) return;
    if (transitioningRef.current) return;
    // Проведення незворотне (рухи складу), скасування — теж: питаємо перед запитом.
    const action =
      newStatus === 'CONFIRMED'
        ? t('confirm.transitionConfirm')
        : newStatus === 'CANCELLED'
          ? t('confirm.transitionCancel')
          : stockDocStatusLabel(newStatus);
    if (!(await confirm({ title: t('confirm.transition', { action, number: docNumber }) }))) return;
    setTransitioningBoth(true);
    setError('');
    try {
      const updated = await apiFetch<{ confirmedAt?: string | null } | undefined>(
        `/stock-documents/${stockDocumentId}/transition`,
        {
          method: 'POST',
          body: JSON.stringify({ status: newStatus }),
        },
      );
      setCurrentStatus(newStatus);
      // Мітку проведення ставить сервер; відповідь переходу — повний документ.
      if (updated && 'confirmedAt' in updated) setConfirmedAt(updated.confirmedAt ?? null);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.transitionError'));
    } finally {
      setTransitioningBoth(false);
    }
  };

  // ── Lines ─────────────────────────────────────────────────────────────────

  // BR-WO-007 (те саме правило, що в наряді): «Разом» — сума округлених до копійки рядків
  // (`lineAmount`), як сервер пише суму рядка. Сирий добуток давав 0,3 × 100,05 = «30.01» замість
  // 30.02 і три рядки 0,3 × 111,11 = «100,00» замість 99,99 (клас Bug #811).
  const total = useMemo(
    () =>
      sumLineAmounts(
        (watchedLines ?? []).map(l => ({
          qty: parseFloat(String(l.quantity)) || 0,
          price: parseFloat(String(l.price ?? '')) || 0,
        })),
      ),
    [watchedLines],
  );

  const addLine = () => {
    if (!newLine.goodId) return;
    append({ ...newLine });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' && !viewOnly : true;

  // Спільний submit-handler: валідація зі схеми, потім гілка create/update.
  // Рядки йдуть У ТІЛІ (атомарний $transaction на беку) — без окремого /lines-endpoint.
  //
  // У JSX onValid/doTransition/handleModalClose/loadDoc викликаються через `void`: кожен
  // має власний catch, який пише текст відмови у setError (банер над формою), а RHF
  // handleSubmit і confirmClose() не реджектяться. Чекати їх проміс нема кому.
  const onValid = handleSubmit(async (values: StockDocumentFormValues) => {
    // WEB-H3 (Bug #630): синхронний guard проти concurrent double-submit.
    if (savingRef.current || transitioningRef.current) return;
    // Ctrl+Enter у модалці кличе цей самий обробник — видалений документ не зберігаємо.
    if (viewOnly) return;
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
        if (features.toastEnabled) toast.success(t('toast.documentSaved'));
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
        if (features.toastEnabled)
          toast.success(t('toast.documentCreatedNo', { number: doc.number }));
        dirty.resetDirty();
        onSaved?.(doc);
        onClose();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.saveError'));
    } finally {
      setSavingBoth(false);
    }
  });

  // Меню статусу й «Зберегти як» — шари над карткою: Escape закриває лише їх (Bug #932, клас Bug #924).
  // Меню видно лише за наявності переходів: інакше перехоплювач «ковтав» би Escape без меню.
  const statusMenuShown = statusMenuOpen && allowedTransitions.length > 0;
  useEscapeLayer(statusMenuShown, () => setStatusMenuOpen(false));
  useEscapeLayer(saveAsOpen, () => setSaveAsOpen(false));
  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isTransfer = formType === 'TRANSFER';
  const warehouseLabel = isTransfer ? t('card.sourceWarehouse') : t('columns.warehouse');

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
        onClose={() => void handleModalClose()}
        onSubmit={() => void onValid()}
        title={isEditMode ? t('card.title') : t('card.titleNew')}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <DocumentNumberField
              label={t('card.number')}
              value={isEditMode && docNumber ? docNumber : t('card.autoNumber')}
            />
            <DocumentHeaderField label={t('card.documentDate')}>
              <FormDateInput control={control} name="documentDate" disabled={!canEdit} />
            </DocumentHeaderField>
            <DocumentStatusStepper
              stepLabel={stockDocStatusLabel}
              label={t('card.status')}
              menuRef={statusMenuRef}
              active={isEditMode}
              busy={transitioning}
              locked={viewOnly}
              prev={statusPrevStep}
              statusLabel={
                isEditMode ? stockDocStatusLabel(currentStatus) : stockDocStatusLabel('DRAFT')
              }
              next={statusNextStep}
              onStep={s => void doTransition(s)}
              menuShown={statusMenuShown}
              setMenuOpen={setStatusMenuOpen}
              transitions={allowedTransitions}
              transitionLabel={s =>
                t(`card.transition.${s}`, { defaultValue: stockDocStatusLabel(s) })
              }
              statusColor={STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground'}
              statusTitle={
                DESCRIBED_STATUSES.includes(currentStatus)
                  ? t(`card.statusDescription.${currentStatus}`)
                  : undefined
              }
            />
          </div>
        }
        extraHeaderActions={
          <DocumentCardHeaderActions
            minimizeLabel={t('card.minimize')}
            onMinimize={onMinimize}
            closeCard={onClose}
            onClose={() => void handleModalClose()}
            disabled={saving || transitioning}
            minimize={
              isEditMode && !notLoaded
                ? {
                    label: docNumber || t('card.minimizedLabel'),
                    modalKey: 'stock-document',
                    restoreProps: { stockDocumentId },
                  }
                : null
            }
          />
        }
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              <DocumentCancelAction
                label={t('card.transition.CANCELLED')}
                transitions={allowedTransitions}
                onTransition={doTransition}
                busy={transitioning}
                saving={saving}
              />
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {/* Незнайдений документ (notLoaded) друкувати й зберігати нічого (TECH-DEBT §9 п.4);
                  видалений — друкується, як і досі. */}
              {isEditMode ? (
                <DocumentEditActions
                  save={canEdit ? { label: t('card.saveChanges'), onSave: onValid } : null}
                  showFile={!notLoaded}
                  showShare={!viewOnly}
                  labels={{
                    print: t('card.print'),
                    saveAs: t('card.saveAs'),
                    share: t('card.share'),
                    shareTitle: t('card.share'),
                    smsTitle: t('card.smsTitle'),
                  }}
                  saveAsOpen={saveAsOpen}
                  setSaveAsOpen={setSaveAsOpen}
                  saving={saving}
                  busy={transitioning}
                >
                  {/* FSM "Підтвердити" shortcut */}
                  {allowedTransitions.includes('CONFIRMED') && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => void doTransition('CONFIRMED')}
                      loading={transitioning}
                      disabled={transitioning || saving}
                    >
                      {t('card.transition.CONFIRMED')}
                    </Button>
                  )}
                </DocumentEditActions>
              ) : (
                <Button
                  onClick={() => void onValid()}
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
                  {t('card.create')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleModalClose()}
                disabled={saving || transitioning}
              >
                {t('common:close')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col min-h-[70dvh]">
          {isDeleted && <DeletedDocumentBanner className="mb-3 shrink-0" />}
          {/* ── Collapsible header ─────────────────────────────────────── */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
            style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden">
              <div className="space-y-4 pb-1">
                {loading && (
                  <div className="flex justify-center py-4 text-sm text-muted-foreground">
                    {t('common:loading')}
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
                        label={t('card.docType')}
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
                        label={t('card.branch')}
                        required
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        errorMessage={errors.branchId?.message}
                        disabled={!canEdit || isEditMode}
                        className="h-8 text-[13px] py-0.5 px-2 pr-7"
                      >
                        <option value="">{t('card.choose')}</option>
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
                        <option value="">{t('card.choose')}</option>
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
                          label={t('card.targetWarehouse')}
                          required
                          value={typeof field.value === 'string' ? field.value : ''}
                          onChange={field.onChange}
                          errorMessage={errors.targetWarehouseId?.message}
                          disabled={!canEdit || isEditMode}
                          className="h-8 text-[13px] py-0.5 px-2 pr-7"
                        >
                          <option value="">{t('card.choose')}</option>
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
                  label={t('card.sourceOrder')}
                  display={purchaseOrderNumber}
                  placeholder={t('card.sourceOrderPlaceholder')}
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
                  label={t('card.notes')}
                  {...register('notes')}
                  disabled={!canEdit}
                  placeholder={t('card.notesPlaceholder')}
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
            <span className="text-muted-foreground">{t('common:documentHeader')}</span>
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
            <DocLinesHeader
              title={t('card.goods')}
              onAdd={canEdit && !showLineInput ? () => setShowLineInput(true) : undefined}
            >
              {canEdit && isEditMode && stockDocumentId && (
                <>
                  <XlsxImportButton
                    templateType="sd-lines"
                    importUrl={`/xlsx/import/stock-document-lines/${stockDocumentId}`}
                    onImportComplete={() => handleLinesImported(stockDocumentId)}
                  />
                  <button
                    type="button"
                    onClick={() => setExcelWizardOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-border bg-surface text-foreground hover:bg-secondary transition-colors"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {t('card.importExcel')}
                  </button>
                </>
              )}
            </DocLinesHeader>
            <table className="w-full table-fixed text-[12px]">
              <colgroup>
                <col className="w-[32%]" />
                <col className="w-[14%]" />
                <col className="w-[8%]" />
                <col className="w-[11%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[5%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colGood')}
                  </th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colSku')}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colUnit')}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colQty')}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colPrice')}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colSum')}
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {/* Незавантажений документ (notLoaded) підказки не має: рядків ми ще не знаємо. */}
                {fields.length === 0 && !showLineInput && !notLoaded && (
                  <DocLinesEmptyRow colSpan={7} canEdit={canEdit} />
                )}
                {fields.map((line, index) => {
                  const qtyRaw = watchedLines?.[index]?.quantity;
                  const priceRaw = watchedLines?.[index]?.price;
                  const qty = parseFloat(String(qtyRaw ?? line.quantity)) || 0;
                  const price = parseFloat(String(priceRaw ?? line.price ?? ''));
                  // goodName/unit — display-only поля, збережені у field-array при append/load,
                  // але поза zod-схемою (payload їх не містить) → читаємо через cast.
                  const display = line as unknown as {
                    goodName?: string;
                    goodSku?: string;
                    unit?: string;
                  };
                  return (
                    <tr key={line.id} className="hover:bg-secondary/20 group">
                      <td className="px-3 py-2">{display.goodName}</td>
                      <td
                        className="px-3 py-2 truncate text-muted-foreground"
                        title={display.goodSku}
                      >
                        {display.goodSku || '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{display.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number.isFinite(price) && price ? String(line.price) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number.isFinite(price) && price ? lineAmount(qty, price).toFixed(2) : '—'}
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
                          <span className="text-muted-foreground">
                            {t('card.pickGoodPlaceholder')}
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 truncate text-[11px] text-muted-foreground">
                      {newLine.goodSku}
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
                      {lineAmount(
                        parseFloat(newLine.quantity) || 0,
                        parseFloat(newLine.price) || 0,
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
                    colSpan={5}
                    className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground"
                  >
                    {t('card.total')}
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] font-semibold tabular-nums">
                    {total > 0 ? `${fmtMoney(total)} ₴` : '—'}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
            {currentStatus === 'CONFIRMED' && confirmedAt && (
              <p className="px-3 py-2 text-[12px] text-muted-foreground tabular-nums">
                {t('card.confirmedAt', { date: fmtDateTime(confirmedAt) })}
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* Good picker for new line */}
      <SearchPickerModal<GoodItem>
        open={goodSearchOpen}
        onClose={() => setGoodSearchOpen(false)}
        title={t('common:goodPicker.title')}
        fetchItems={fetchGoodItems}
        searchPlaceholder={t('card.goodSearchPlaceholder')}
        emptyText={t('card.goodsEmpty')}
        scanSubmit={(items, typed) => pickScannedGood(items, typed)}
        onSelect={item => {
          setNewLine(l => ({
            ...l,
            goodId: item.id,
            goodName: item.primary,
            goodSku: item.secondary ?? '',
            unit: item.unit ?? 'шт',
          }));
          setGoodSearchOpen(false);
        }}
      />

      {/* Purchase-order (source) picker — опціонально. StockDocument не має поля
          постачальника, тож просто перелічуємо останні замовлення. */}
      <SearchPickerModal
        open={poPickerOpen}
        onClose={() => setPoPickerOpen(false)}
        title={t('card.pickSourceOrder')}
        searchPlaceholder={t('card.orderSearchPlaceholder')}
        emptyText={t('card.ordersEmpty')}
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
          existingLineCount={fields.length}
          onImportComplete={() => handleLinesImported(stockDocumentId)}
        />
      )}

      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...confirmDialogProps} />
    </>
  );
}
