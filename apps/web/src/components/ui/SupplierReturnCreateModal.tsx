'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  supplierReturnFormSchema,
  type SupplierReturnFormInput,
  type SupplierReturnFormValues,
} from '@sto/shared';
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { CollapsibleDocumentHeader, DocumentCardBody } from '@/components/ui/document-card-body';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName, cn, lineAmount, roundMoney } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import { pickScannedGood } from '@/lib/barcode';
import { supplierReturnStatusLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { DocLinesHeader, DocLinesEmptyRow } from '@/components/ui/doc-lines-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DocumentCloseButton } from '@/components/ui/document-card-actions';
import { FieldWithError, FormWarehouseSelect } from '@/components/ui/document-card-header';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import type { SupplierReturn, SupplierReturnLine } from '@/hooks/api/useSupplierReturns';

/**
 * Повернення постачальнику (створення / редагування / FSM-переходи).
 *
 * `void` перед `handleSave()`, `handleModalClose()`, `doTransition()` у JSX: `handleSave`
 * (RHF handleSubmit) і `doTransition` мають власний try/catch, що пише текст відмови у
 * `error` (баннер у шапці модалки) і в `toast.error`, плюс `finally`, який знімає
 * saving/transitioning guard; у `handleModalClose` єдиний `await` — `dirty.confirmClose()`,
 * який ніколи не реджектиться (резолвиться з DirtyConfirmDialog). Проміс обробника
 * нікому не потрібен — відмова вже на екрані.
 */

// ─── Status config ─────────────────────────────────────────────────────────────
// Mirrors backend SR_TRANSITIONS in apps/api/src/modules/supplier-returns/supplier-returns.service.ts

const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  CONFIRMED: 'bg-success/15 text-success',
  CANCELLED: 'bg-destructive/10 text-destructive',
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Warehouse {
  id: string;
  name: string;
  deletedAt?: string | null;
}

interface Supplier {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

interface Good {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  purchasePrice: number | null;
  barcode?: string | null;
  barcodes?: string[];
}

interface PurchaseOrderRef {
  id: string;
  number: string;
  status?: string;
  supplierId?: string;
  supplierName?: string;
}

// Локальний елемент рядка форми (useFieldArray). goodName/goodSku/unit/unitShortName/
// unitOfMeasureId — display/persist-поля поза zod-схемою (payload містить лише
// goodId/quantity/price/unitOfMeasureId). quantity/price — рядки web-стану (схема коерсить).
interface LocalLine {
  goodId: string;
  goodName: string;
  goodSku?: string | null;
  unit: string;
  unitShortName?: string | null;
  // зберігаємо unitOfMeasureId, інакше при PATCH backend пересоздає рядки
  // з NULL UoM (update() робить soft-delete + createMany з l.unitOfMeasureId ?? null).
  unitOfMeasureId?: string | null;
  quantity: string;
  price: string;
}

const EMPTY_LINE: LocalLine = {
  goodId: '',
  goodName: '',
  goodSku: null,
  unit: '',
  unitShortName: null,
  unitOfMeasureId: null,
  quantity: '1',
  price: '',
};

function lineFromApi(l: SupplierReturnLine): LocalLine {
  return {
    goodId: l.goodId,
    goodName: l.goodName ?? '',
    goodSku: l.goodSku ?? null,
    unit: l.unit ?? '',
    unitShortName: l.unitShortName ?? null,
    unitOfMeasureId: l.unitOfMeasureId ?? null,
    quantity: String(l.quantity),
    price: String(l.price),
  };
}

// «Чиста» база форми — reset() до неї на open дає rhfDirty=false (Bug #639: авто-вибір
// складу через setValue({shouldDirty:false}), тому не вмикає dirty-guard).
const emptyDefaults = (): SupplierReturnFormInput => ({
  supplierId: '',
  warehouseId: '',
  purchaseOrderId: '',
  notes: '',
  documentDate: kyivToday(),
  lines: [],
});

const numericInputCls =
  'w-full rounded border border-input bg-background px-1.5 py-1 text-[12px] tabular-nums focus:outline-none focus:ring-1 focus:ring-ring';

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editId?: string | null;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function SupplierReturnCreateModal({ open, onClose, onSaved, editId }: Props) {
  const { t } = useTranslation('purchaseOrders');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const isEdit = !!editId;

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
  } = useForm<SupplierReturnFormInput, unknown, SupplierReturnFormValues>({
    resolver: i18nZodResolver(supplierReturnFormSchema),
    defaultValues: emptyDefaults(),
    mode: 'onBlur',
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watchedLines = watch('lines');
  const supplierId = watch('supplierId');
  const warehouseId = watch('warehouseId');

  // Display-стан (поза формою): статус документа, display-текст постачальника/PO.
  const [status, setStatus] = useState('DRAFT');
  // Документ позначено на видалення → картка лише на перегляд (вантажиться з withDeleted).
  const [isDeleted, setIsDeleted] = useState(false);
  // id повернення, дані якого зараз у формі. Доки не збігається з editId, у картці ще стоять
  // статус і рядки ПОПЕРЕДНЬОГО документа — зберігати, проводити й скасовувати не можна.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');

  // ── UI state ───────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  // WEB-H3 (Bug #630): синхронні ref-и проти concurrent double-submit. `disabled={saving}`
  // спирається на re-render React МІЖ подіями кліку; два click-и в одному tick обидва
  // входять до застосування disabled → 2 POST /supplier-returns (2 документи повернення).
  // Ref фліпається синхронно ДО React state-flush → другий вхід одразу повертається.
  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  // Bug #639: async авто-вибір єдиного складу — програмна зміна. Через
  // setValue({shouldDirty:false}) значення не вмикає dirty-guard.
  const autoSelectedRef = useRef(false);
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const setTransitioningBoth = (v: boolean) => {
    transitioningRef.current = v;
    setTransitioning(v);
  };
  const [error, setError] = useState('');
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [showLineInput, setShowLineInput] = useState(false);
  const [newLine, setNewLine] = useState<LocalLine>(EMPTY_LINE);

  // ── Reference data ─────────────────────────────────────────────────────────
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [goodPickerOpen, setGoodPickerOpen] = useState(false);
  const [poPickerOpen, setPoPickerOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Collapse header when adding a line — mirrors PO modal behaviour
  useEffect(() => {
    if (showLineInput) setHeaderCollapsed(true);
  }, [showLineInput]);

  // ── Load warehouses ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const cached = getCached<Warehouse[]>('cache:warehouses');
    if (cached) {
      setWarehouses(cached.filter(w => !w.deletedAt));
      return;
    }
    apiFetch<Warehouse[]>('/warehouses')
      .then(data => {
        if (!mountedRef.current) return;
        const active = data.filter(w => !w.deletedAt);
        setCache('cache:warehouses', active);
        setWarehouses(active);
      })
      .catch(() => {});
  }, [open]);

  // Auto-select single warehouse — Bug #550: guard with !editId, інакше race з
  // edit-fetch робить flicker. Bug #639: shouldDirty:false — програмна установка
  // warehouseId не вмикає dirty-guard (Escape без правки не показує діалог).
  useEffect(() => {
    if (
      warehouses.length === 1 &&
      !editId &&
      !autoSelectedRef.current &&
      !getValues('warehouseId')
    ) {
      autoSelectedRef.current = true;
      setValue('warehouseId', warehouses[0].id, { shouldDirty: false });
    }
  }, [warehouses, editId, getValues, setValue]);

  // ── Load existing return ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || !editId) return;
    // Картку закрили чи відкрили для іншого повернення до відповіді — відповідь відкидається.
    let cancelled = false;
    setLoadedId(null);
    apiFetch<SupplierReturn>(`/supplier-returns/${editId}?withDeleted=true`)
      .then(data => {
        if (!mountedRef.current || cancelled) return;
        setLoadedId(editId);
        setStatus(data.status);
        setIsDeleted(!!data.deletedAt);
        setSupplierName(data.supplierName ?? '');
        setPurchaseOrderNumber(data.purchaseOrderNumber ?? '');
        // reset() ставить нову «чисту» базу з наявного запису → rhfDirty=false.
        reset({
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          purchaseOrderId: data.purchaseOrderId ?? '',
          notes: data.notes ?? '',
          documentDate: data.documentDate ?? kyivToday(),
          lines: (data.lines ?? []).map(lineFromApi),
        });
      })
      .catch((e: unknown) => {
        if (!mountedRef.current || cancelled) return;
        // Раніше помилка ковталась: картка лишалась порожньою формою «чернетки» без пояснення.
        setError(e instanceof Error ? e.message : t('errors.returnLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId, reset]);

  // ── Reset on open/close ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      autoSelectedRef.current = false;
      return;
    }
    autoSelectedRef.current = false;
    dirty.resetDirty();
    setError('');
    setIsDeleted(false);
    setHeaderCollapsed(false);
    setShowLineInput(false);
    setNewLine(EMPTY_LINE);
    if (!isEdit) {
      setStatus('DRAFT');
      setSupplierName('');
      setPurchaseOrderNumber('');
      reset(emptyDefaults());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  // ── Status transitions ─────────────────────────────────────────────────────
  // Backend FSM is linear-forward: DRAFT → CONFIRMED or DRAFT → CANCELLED; both terminal.
  // Видалений документ переходів не має: сервер відповість 404 на будь-яку зміну.
  // Документ ще не завантажено (або завантаження впало) — у формі чужі дані: лише перегляд.
  const notLoaded = isEdit && loadedId !== editId;
  const allowedTransitions = isDeleted || notLoaded ? [] : (STATUS_TRANSITIONS[status] ?? []);
  const statusPrevStep: string | null = null;
  const statusNextStep =
    allowedTransitions.find(s => s !== 'CANCELLED') ?? allowedTransitions[0] ?? null;

  const doTransition = useCallback(
    async (targetStatus: string) => {
      if (!editId || isDeleted || notLoaded) return;
      if (savingRef.current || transitioningRef.current) return;
      setTransitioningBoth(true);
      setError('');
      try {
        const endpoint =
          targetStatus === 'CONFIRMED'
            ? `/supplier-returns/${editId}/confirm`
            : `/supplier-returns/${editId}/cancel`;
        await apiFetch(endpoint, { method: 'POST' });
        setStatus(targetStatus);
        onSaved();
        if (features.toastEnabled)
          toast.success(
            targetStatus === 'CONFIRMED'
              ? t('supplierReturn.confirmed')
              : t('supplierReturn.cancelled'),
          );
      } catch (e) {
        const msg = e instanceof Error ? e.message : t('card.transitionError');
        setError(msg);
        if (features.toastEnabled) toast.error(msg);
      } finally {
        setTransitioningBoth(false);
      }
    },
    [editId, isDeleted, notLoaded, features.toastEnabled, onSaved, t],
  );

  // ── Lines ──────────────────────────────────────────────────────────────────
  const addLine = useCallback(() => {
    // дублюємо guard з кнопки «+» на випадок keyboard-shortcut / programmatic виклику.
    if (!newLine.goodId) return;
    if ((parseFloat(newLine.quantity) || 0) <= 0) return;
    // Повтор товару — окремий рядок (BR-PO-008, рішення власника 2026-10-13): той самий товар
    // можна повертати двома рядками з різною ціною чи кількістю. Раніше повтор мовчки
    // відкидався тут, а сервер зливав рядки — перший зникав разом із кількістю.
    append({ ...newLine });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  }, [newLine, append]);

  // ── Warehouse map ──────────────────────────────────────────────────────────
  const warehouseById = useMemo(() => {
    const m = new Map<string, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  // ── Totals ─────────────────────────────────────────────────────────────────
  // Сума рядка округлюється до копійки так само, як на сервері (`money(quantity * price)`), а
  // підсумок складається з округлених рядків: сирий добуток давав розбіжність на копійку
  // (0,3 × 100,05 показувалось «30.01», збережено 30.02) - тим помітнішу, чим більше рядків
  // (повтори товару, BR-PO-008).
  const lineSubtotal = (qty: string, price: string) =>
    lineAmount(parseFloat(qty) || 0, parseFloat(price) || 0);

  const total = useMemo(
    () =>
      roundMoney(
        (watchedLines ?? []).reduce(
          (sum, l) => sum + lineSubtotal(String(l.quantity ?? ''), String(l.price ?? '')),
          0,
        ),
      ),
    [watchedLines],
  );

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = handleSubmit(async (values: SupplierReturnFormValues) => {
    // WEB-H3 (Bug #630): синхронний guard проти concurrent double-submit.
    if (savingRef.current || transitioningRef.current) return;
    // Ctrl+Enter у модалці кличе цей самий обробник — видалений документ не зберігаємо.
    if (isDeleted || notLoaded) return;
    if (values.lines.length === 0) {
      setError(t('supplierReturn.addOneGood'));
      return;
    }
    setError('');
    setSavingBoth(true);
    try {
      // unitOfMeasureId — display/persist-поле поза схемою; читаємо з поточних значень
      // форми (getValues) щоб не загубити при PATCH (backend пересоздає рядки з NULL UoM).
      const rawLines = (getValues('lines') ?? []) as unknown as LocalLine[];
      const payload = {
        supplierId: values.supplierId,
        warehouseId: values.warehouseId,
        // PO-джерело персиститься лише при CREATE (create-only, Phase D2).
        ...(!isEdit && values.purchaseOrderId ? { purchaseOrderId: values.purchaseOrderId } : {}),
        notes: values.notes || undefined,
        documentDate: values.documentDate,
        lines: values.lines.map((l, i) => ({
          goodId: l.goodId,
          quantity: l.quantity,
          price: l.price,
          ...(rawLines[i]?.unitOfMeasureId ? { unitOfMeasureId: rawLines[i].unitOfMeasureId } : {}),
        })),
      };
      if (isEdit) {
        await apiFetch(`/supplier-returns/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        if (features.toastEnabled) toast.success(t('toast.returnUpdated'));
      } else {
        await apiFetch('/supplier-returns', { method: 'POST', body: JSON.stringify(payload) });
        if (features.toastEnabled) toast.success(t('toast.returnCreated'));
      }
      dirty.resetDirty();
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('card.saveError');
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSavingBoth(false);
    }
  });

  // close-guard: під час save/transition Escape/backdrop не мають закривати модалку.
  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const isReadOnly = status !== 'DRAFT' || isDeleted || notLoaded;
  const canEdit = !isReadOnly;

  const title = isEdit
    ? isReadOnly
      ? t('tabs.returns')
      : t('supplierReturn.editTitle')
    : t('supplierReturn.newTitle');

  // ── Render ─────────────────────────────────────────────────────────────────
  // Зняти замовлення-джерело: поле форми й номер у полі вибору.
  const clearSourceOrder = () => {
    setValue('purchaseOrderId', '', { shouldDirty: true });
    setPurchaseOrderNumber('');
  };

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleModalClose()}
        onSubmit={() => void handleSave()}
        title={title}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            {/* Date */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">
                {t('card.documentDate')}
              </span>
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

            {/* Status navigation — mirrors PO modal */}
            {isEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[13px] font-medium text-muted-foreground">
                  {t('card.status')}
                </span>
                <button
                  type="button"
                  disabled={transitioning || !statusPrevStep}
                  onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-20 truncate">
                    {statusPrevStep ? supplierReturnStatusLabel(statusPrevStep) : '—'}
                  </span>
                </button>
                <span
                  className={cn(
                    'text-sm font-medium px-2.5 py-1 rounded-full',
                    STATUS_COLORS[status] ?? 'bg-secondary text-muted-foreground',
                  )}
                >
                  {supplierReturnStatusLabel(status)}
                </span>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep ? supplierReturnStatusLabel(statusNextStep) : '—'}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            )}
          </div>
        }
        extraHeaderActions={
          <button
            onClick={() => void handleModalClose()}
            className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
            title={t('common:close')}
            disabled={saving || transitioning}
          >
            <X className="h-4 w-4" />
          </button>
        }
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              {isEdit && status === 'DRAFT' && !isDeleted && !notLoaded && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void doTransition('CANCELLED')}
                  loading={transitioning}
                  disabled={transitioning || saving}
                >
                  {t('common:cancel')}
                </Button>
              )}
            </div>
            <div className="flex gap-2 items-center">
              {isEdit && status === 'DRAFT' && !isDeleted && !notLoaded && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void doTransition('CONFIRMED')}
                  loading={transitioning}
                  disabled={transitioning || saving || fields.length === 0}
                >
                  {t('common:confirm')}
                </Button>
              )}
              {canEdit && (
                <Button
                  onClick={() => void handleSave()}
                  loading={saving}
                  disabled={saving || transitioning || !supplierId || !warehouseId}
                  size="sm"
                >
                  {isEdit ? t('card.saveChanges') : t('supplierReturn.create')}
                </Button>
              )}
              <DocumentCloseButton onClose={handleModalClose} disabled={saving || transitioning} />
            </div>
          </div>
        }
      >
        <DocumentCardBody
          errorTestId="supplier-return-card-error"
          deleted={isDeleted}
          error={error}
        >
          {/* ── Collapsible header ─────────────────────────────────────── */}
          <CollapsibleDocumentHeader collapsed={headerCollapsed}>
            {/* Постачальник | Склад */}
            <div className="grid grid-cols-2 gap-4">
              <FieldWithError error={errors.supplierId?.message}>
                <EntityPickerField
                  label={t('columns.supplier')}
                  required
                  display={supplierName}
                  placeholder={t('card.supplierSearch')}
                  className="h-8 text-[13px]"
                  disabled={!canEdit}
                  onPick={() => setSupplierPickerOpen(true)}
                  onClear={() => {
                    setValue('supplierId', '', { shouldDirty: true });
                    setSupplierName('');
                  }}
                />
              </FieldWithError>
              <FormWarehouseSelect
                control={control}
                name="warehouseId"
                label={t('columns.warehouse')}
                chooseLabel={t('card.choose')}
                warehouses={warehouses}
                disabled={!canEdit}
              />
            </div>

            {/* Замовлення (джерело) — опціонально (Phase D2) */}
            <EntityPickerField
              label={t('supplierReturn.sourceOrder')}
              display={purchaseOrderNumber}
              placeholder={t('supplierReturn.sourceOrderPlaceholder')}
              className="h-8 text-[13px]"
              disabled={!canEdit || isEdit}
              onPick={() => setPoPickerOpen(true)}
              onClear={clearSourceOrder}
            />

            {/* Опис */}
            <Input
              label={t('card.notes')}
              {...register('notes')}
              disabled={!canEdit}
              placeholder={t('card.notesPlaceholder')}
              className="h-8 text-[13px]"
            />
          </CollapsibleDocumentHeader>

          {/* ── Header toggle strip ─────────────────────────────────────────── */}
          <CollapsibleHeader
            collapsed={headerCollapsed}
            onToggle={() => setHeaderCollapsed(c => !c)}
            chips={[
              {
                label: supplierName || t('card.chipSupplier'),
                primary: true,
                maxWidth: 'max-w-50',
              },
              {
                label: warehouseId
                  ? (warehouseById.get(warehouseId)?.name ?? t('card.chipWarehouse'))
                  : t('card.chipWarehouse'),
                maxWidth: 'max-w-40',
              },
            ]}
          />

          {/* ── Lines table ─────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto">
            <DocLinesHeader
              title={t('card.goods')}
              onAdd={canEdit && !showLineInput ? () => setShowLineInput(true) : undefined}
            />

            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full table-fixed text-[12px]">
                <colgroup>
                  <col />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-16" />
                </colgroup>
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colGood')}
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colQty')}
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colUnit')}
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colPrice', { currency: '₴' })}
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colSum', { currency: '₴' })}
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {fields.length === 0 && !showLineInput && (
                    <DocLinesEmptyRow colSpan={6} canEdit={canEdit} />
                  )}

                  {fields.map((line, index) => {
                    const display = line as unknown as {
                      goodName?: string;
                      goodSku?: string | null;
                      unit?: string;
                      unitShortName?: string | null;
                    };
                    const qty = String(watchedLines?.[index]?.quantity ?? '');
                    const price = String(watchedLines?.[index]?.price ?? '');
                    const sub = lineSubtotal(qty, price);
                    return (
                      <tr key={line.id} className="hover:bg-surface-hover/50">
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-[12px]">{display.goodName}</div>
                          {display.goodSku && (
                            <div className="text-[11px] text-muted-foreground">
                              {display.goodSku}
                            </div>
                          )}
                        </td>
                        <td className="px-1 py-1.5">
                          {isReadOnly ? (
                            <span className="tabular-nums px-2">{qty}</span>
                          ) : (
                            <input
                              type="number"
                              min="0.001"
                              step="0.001"
                              {...register(`lines.${index}.quantity`)}
                              className={numericInputCls}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                          {/* Bug #548: показуємо UoM short name з API замість сирого Good.unit */}
                          {display.unitShortName || display.unit}
                        </td>
                        <td className="px-1 py-1.5">
                          {isReadOnly ? (
                            <span className="tabular-nums px-2">
                              {fmtMoney(parseFloat(price) || 0)}
                            </span>
                          ) : (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              {...register(`lines.${index}.price`)}
                              className={numericInputCls}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 tabular-nums text-[12px] font-medium">
                          {fmtMoney(sub)}
                        </td>
                        <td className="px-2 py-1.5">
                          {canEdit && (
                            <button
                              type="button"
                              // Назва з номером рядка: той самий товар може стояти кількома
                              // рядками (BR-PO-008), і за назвою товару їх не розрізнити.
                              aria-label={t('supplierReturn.deleteRowAria', { n: index + 1 })}
                              title={t('supplierReturn.deleteRow')}
                              onClick={() => remove(index)}
                              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {/* ── Inline add row — identical layout to data rows ────── */}
                  {canEdit && showLineInput && (
                    <tr className="bg-primary/5 border-t-2 border-primary/20">
                      <td className="px-2 py-1.5">
                        <EntityPickerField
                          display={newLine.goodName}
                          placeholder={t('card.goodSearch')}
                          ariaLabel={t('card.colGood')}
                          onPick={() => setGoodPickerOpen(true)}
                          onClear={() => setNewLine(EMPTY_LINE)}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={newLine.quantity}
                          onChange={e => setNewLine(l => ({ ...l, quantity: e.target.value }))}
                          className={numericInputCls}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                        {/* Bug #548: новий рядок з goods picker має лише unit (не unitShortName), fallback OK */}
                        {newLine.unitShortName || newLine.unit}
                      </td>
                      <td className="px-1 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={newLine.price}
                          onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                          placeholder="0"
                          className={numericInputCls}
                        />
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                        {fmtMoney(lineSubtotal(newLine.quantity, newLine.price))}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={addLine}
                            // блокуємо «+» при порожній К-сть, щоб не плодити рядки,
                            // які схема потім reject'не з помилкою «Кількість має бути > 0».
                            disabled={!newLine.goodId || (parseFloat(newLine.quantity) || 0) <= 0}
                            title={t('supplierReturn.addRow')}
                            className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowLineInput(false);
                              setNewLine(EMPTY_LINE);
                            }}
                            title={t('common:cancel')}
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>

                {/* ── tfoot — single row, matches PO modal standard ─────── */}
                <tfoot>
                  <tr className="bg-secondary/50 border-t border-border">
                    <td
                      colSpan={3}
                      className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                    >
                      {t('card.total')}
                    </td>
                    <td />
                    <td className="px-3 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                      {fmtMoney(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </DocumentCardBody>
      </Modal>

      {/* Supplier picker */}
      <SearchPickerModal
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(item: { id: string; primary: string }) => {
          setValue('supplierId', item.id, { shouldDirty: true });
          setSupplierName(item.primary);
          setSupplierPickerOpen(false);
        }}
        title={t('card.pickSupplier')}
        fetchItems={q =>
          apiFetch<{ items: Supplier[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&types=SUPPLIER&types=BOTH&limit=30`,
          ).then(d => d.items.map(c => ({ id: c.id, primary: displayCounterpartyName(c) })))
        }
      />

      {/* Good picker */}
      <SearchPickerModal
        open={goodPickerOpen}
        onClose={() => setGoodPickerOpen(false)}
        onSelect={(item: {
          id: string;
          primary: string;
          secondary?: string;
          _sku?: string | null;
          _unit?: string;
          _price?: number;
          barcode?: string | null;
          barcodes?: string[];
        }) => {
          setNewLine(l => ({
            ...l,
            goodId: item.id,
            goodName: item.primary,
            goodSku: item._sku ?? null,
            unit: item._unit ?? '',
            price: String(item._price ?? ''),
          }));
          setGoodPickerOpen(false);
        }}
        title={t('common:goodPicker.title')}
        searchPlaceholder={t('card.goodPickerSearch')}
        scanSubmit={(items, typed) => pickScannedGood(items, typed)}
        fetchItems={q =>
          apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=30`).then(d =>
            d.items.map(g => ({
              id: g.id,
              primary: g.name,
              secondary: g.sku ?? undefined,
              _sku: g.sku,
              _unit: g.unit ?? '',
              _price: g.purchasePrice ?? 0,
              barcode: g.barcode,
              barcodes: g.barcodes,
            })),
          )
        }
      />

      {/* Purchase-order (source) picker — опціонально. Список скоупиться до обраного
          постачальника client-side, бо /purchase-orders не приймає ?supplierId=. */}
      <SearchPickerModal
        open={poPickerOpen}
        onClose={() => setPoPickerOpen(false)}
        onSelect={(item: { id: string; primary: string }) => {
          setValue('purchaseOrderId', item.id, { shouldDirty: true });
          setPurchaseOrderNumber(item.primary);
          setPoPickerOpen(false);
        }}
        title={t('supplierReturn.pickSourceOrder')}
        searchPlaceholder={t('supplierReturn.orderNumberSearch')}
        emptyText={t('empty.ordersNotFound')}
        fetchItems={q =>
          apiFetch<{ items: PurchaseOrderRef[] }>(
            `/purchase-orders?q=${encodeURIComponent(q)}&limit=30`,
          ).then(d =>
            d.items
              .filter(po => !supplierId || po.supplierId === supplierId)
              .map(po => ({
                id: po.id,
                primary: po.number,
                secondary: po.supplierName ?? undefined,
              })),
          )
        }
      />
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
