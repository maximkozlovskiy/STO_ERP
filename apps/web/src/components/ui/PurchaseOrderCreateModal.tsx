'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  purchaseOrderFormSchema,
  type PurchaseOrderFormInput,
  type PurchaseOrderFormValues,
} from '@sto/shared';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Minus,
  Printer,
  Download,
  Share2,
  MessageSquare,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Zap,
  PackageCheck,
  Wallet,
  Upload,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName, cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import { pickScannedGood } from '@/lib/barcode';
import { PO_STATUS_TRANSITIONS, PO_STATUS_ACTION_LABELS } from '@sto/shared';
import { poStatusLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import { CurrencySelect } from '@/components/ui/CurrencySelect';
import { useBaseCurrency } from '@/hooks/api/useCash';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';
import {
  SupplierPaymentCreateModal,
  type SupplierPaymentPrefill,
} from '@/components/ui/SupplierPaymentCreateModal';
import type { SupplierPayment } from '@/hooks/api/useSupplierPayments';
import { RulePricerModal } from '@/components/ui/purchase-order/RulePricerModal';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { ExcelImportWizard } from '@/components/ui/ExcelImportWizard';
import {
  type Warehouse,
  type Supplier,
  type Good,
  type LocalLine,
  type PODetail,
  type PricingRule,
  STATUS_COLORS,
  STATUS_DESCRIPTIONS,
  PO_STATUS_ORDER,
  EMPTY_TRANSITIONS,
  nextKey,
  EMPTY_LINE,
} from '@/components/ui/purchase-order/types';

// Тип zod-error з результату safeParse (web не має zod як прямої залежності — тягнемо
// його через сам schema, а не `import { z } from 'zod'`).
type SchemaError = Extract<
  ReturnType<typeof purchaseOrderFormSchema.safeParse>,
  { success: false }
>['error'];

// safeParse-помилку показуємо ЗМІСТОВНО: беремо перший zod-issue з його (українським)
// повідомленням зі схеми (напр. «Ціна не може бути відʼємною»), а для рядка-товару
// префіксуємо номером позиції. Раніше показувалось хардкод «Оберіть постачальника та
// склад» — вводило в оману, коли фейл насправді у рядку (порожня ціна/кількість), а
// кнопка вже гарантувала обраний supplier+warehouse (§8.2).
function firstSchemaError(err: SchemaError): string {
  const issue = err.issues[0];
  if (!issue) return 'Перевірте заповнення форми';
  const path = issue.path;
  if (path[0] === 'lines' && typeof path[1] === 'number') {
    return `Рядок ${path[1] + 1}: ${issue.message}`;
  }
  return issue.message;
}

// «Чиста» база форми — reset() до неї на open дає rhfDirty=false (Bug #639: авто-вибір
// складу через setValue({shouldDirty:false}), тому не вмикає dirty-guard).
// contractId лишається окремим useState (auto-fill + explicit null-clear), НЕ у RHF.
const emptyDefaults = (): PurchaseOrderFormInput => ({
  supplierId: '',
  warehouseId: '',
  contractId: '',
  notes: '',
  documentDate: kyivToday(),
  currencyId: '',
  paymentDate: '',
  trackingNumber: '',
  lines: [],
});

// ─── Props ────────────────────────────────────────────────────────────────────

export interface PurchaseOrderCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  purchaseOrderId?: string;
  onMinimize?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PurchaseOrderCreateModal({
  open,
  onClose,
  onSaved,
  purchaseOrderId: purchaseOrderIdProp,
  onMinimize,
}: PurchaseOrderCreateModalProps) {
  const { t } = useTranslation('purchaseOrders');
  const [activePOId, setActivePOId] = useState<string | undefined>(purchaseOrderIdProp);
  const purchaseOrderId = activePOId;
  const isEditMode = !!activePOId;
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
    formState: { errors, isDirty: rhfDirty },
  } = useForm<PurchaseOrderFormInput, unknown, PurchaseOrderFormValues>({
    resolver: i18nZodResolver(purchaseOrderFormSchema),
    defaultValues: emptyDefaults(),
    mode: 'onBlur',
  });
  // Рядки замовлення (goodId/quantity/price/pricedSalePrice + локальні display-поля).
  const { fields, append, remove, update } = useFieldArray({ control, name: 'lines' });
  // Тип елемента field-array (схема має .default([]), тож input-lines nullable → NonNullable).
  type FormLineItem = NonNullable<PurchaseOrderFormInput['lines']>[number];
  const watchedLines = watch('lines');
  const supplierIdValue = watch('supplierId');
  const warehouseIdValue = watch('warehouseId');
  const watchedCurrencyId = watch('currencyId');

  const [supplierDisplay, setSupplierDisplay] = useState('');
  // Мультивалюта (Фаза 3): локальний перелік валют для резолву символу обраної валюти.
  const [currencies, setCurrencies] = useState<
    { id: string; code: string; symbol?: string | null }[]
  >([]);
  const { data: baseCurrency } = useBaseCurrency();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const canPrice = isEditMode && (currentStatus === 'RECEIVED' || currentStatus === 'PARTIAL');
  const [poNumber, setPoNumber] = useState('');
  const [contractId, setContractId] = useState<string | null>(null);
  const [contractNumber, setContractNumber] = useState<string | null>(null);
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [showLineInput, setShowLineInput] = useState(false);
  const [goodSearchOpen, setGoodSearchOpen] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [vatMode, setVatMode] = useState<'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'>('NONE');
  const [vatRate, setVatRate] = useState(0);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [receiveMode, setReceiveMode] = useState(false);
  const [excelWizardOpen, setExcelWizardOpen] = useState(false);
  // Стабільний onClose — GOTCHAS modal-thrashing (нова ідентичність щорендеру ремонтує Modal).
  const closeExcelWizard = useCallback(() => setExcelWizardOpen(false), []);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState(false);
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [rulePricerOpen, setRulePricerOpen] = useState(false);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [pricingRulesLoading, setPricingRulesLoading] = useState(false);
  const [ruleFilterBySupplier, setRuleFilterBySupplier] = useState(true);
  const [error, setError] = useState('');
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentPrefill, setPaymentPrefill] = useState<SupplierPaymentPrefill | null>(null);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierDetailOpen, setSupplierDetailOpen] = useState(false);
  const [supplierDetailData, setSupplierDetailData] = useState<CounterpartyForModal | null>(null);
  const [goodDetailOpen, setGoodDetailOpen] = useState(false);
  const [goodDetailData, setGoodDetailData] = useState<GoodForModal | null>(null);
  const [goodRefData, setGoodRefData] = useState<{
    brands: { id: string; name: string }[];
    units: {
      id: string;
      name: string;
      shortName: string;
      isSystem: boolean;
      coefficient: number;
    }[];
    suppliers: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    }[];
    goodCatTree: CategoryNode[];
  }>({ brands: [], units: [], suppliers: [], goodCatTree: [] });
  const [units, setUnits] = useState<{ id: string; name: string; shortName: string }[]>([]);

  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  // Bug #639: async авто-вибір єдиного складу — програмна зміна (не дія користувача).
  // Через setValue({shouldDirty:false}) значення не вмикає dirty-guard.
  const autoSelectedRef = useRef(false);

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

  // Load warehouses + org VAT settings + units of measure
  useEffect(() => {
    if (!open) return;
    const cached = getCached<Warehouse[]>('cache:warehouses');
    if (cached) {
      setWarehouses(cached.filter(w => !w.deletedAt));
    }
    void apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(r => {
        const all = Array.isArray(r) ? r : (r.items ?? []);
        const list = all.filter(w => !w.deletedAt);
        setWarehouses(list);
        setCache('cache:warehouses', list);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження складів'));
    const cachedUnits = getCached<{ id: string; name: string; shortName: string }[]>('cache:units');
    if (cachedUnits) setUnits(cachedUnits);
    void apiFetch<
      | { id: string; name: string; shortName: string }[]
      | { items: { id: string; name: string; shortName: string }[] }
    >('/units')
      .then(r => {
        const list = Array.isArray(r) ? r : (r.items ?? []);
        setUnits(list);
        setCache('cache:units', list);
      })
      .catch(() => {});
    // sto-review: `/organisations/my` НЕ існує — раніше silent fail приховував що
    // VAT-рядок ніколи не показується. Правильний шлях — `/settings/organisation`
    // (vatMode + defaultVatRateId) + `/settings/tax-rates` (resolve rate by id).
    // Симетрія з CreateWorkOrderModal.tsx:597.
    void Promise.all([
      apiFetch<{ vatMode: string; defaultVatRateId?: string | null }>('/settings/organisation'),
      apiFetch<{ id: string; rate: number; isDefault: boolean }[]>('/settings/tax-rates'),
    ])
      .then(([org, rates]) => {
        setVatMode((org.vatMode as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE') ?? 'NONE');
        const list = Array.isArray(rates) ? rates : [];
        const selected = org.defaultVatRateId
          ? list.find(r => r.id === org.defaultVatRateId)
          : list.find(r => r.isDefault);
        if (selected) setVatRate(Number(selected.rate));
      })
      .catch(err => {
        console.error('[PurchaseOrderCreateModal] VAT settings fetch failed', err);
      });
  }, [open]);

  // Auto-select single warehouse (runs both on cache hit and after fetch resolves).
  // Bug #639: авто-вибір — програмна зміна; setValue({shouldDirty:false}) не вмикає
  // dirty-guard, а autoSelectedRef захищає від повторного авто-вибору/гонки з edit-fetch.
  useEffect(() => {
    if (
      warehouses.length === 1 &&
      !isEditMode &&
      !autoSelectedRef.current &&
      !getValues('warehouseId')
    ) {
      autoSelectedRef.current = true;
      setValue('warehouseId', warehouses[0].id, { shouldDirty: false });
    }
  }, [warehouses, isEditMode, getValues, setValue]);

  // Reset on open — чиста база (rhfDirty=false) + скидання refs/локального стану.
  useEffect(() => {
    if (!open) {
      autoSelectedRef.current = false;
      return;
    }
    autoSelectedRef.current = false;
    dirty.resetDirty();
    setActivePOId(purchaseOrderIdProp);
    setError('');
    setStatusMenuOpen(false);
    setHeaderCollapsed(false);
    setPoNumber('');
    setCurrentStatus('DRAFT');
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    setContractId(null);
    setContractNumber(null);
    setReceiveMode(false);
    setReceiveQtys({});
    if (!isEditMode) {
      // reset() ставить чисту базу → rhfDirty=false (edit заповнюється load-ефектом).
      reset(emptyDefaults());
      setSupplierDisplay('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, purchaseOrderIdProp, isEditMode]);

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  // Мультивалюта: підвантажити перелік валют для резолву символу обраної валюти.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch<{ items: { id: string; code: string; symbol?: string | null }[] }>('/currencies')
      .then(r => {
        if (!cancelled) setCurrencies(r.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Символ обраної валюти для колонок таблиці (fallback — код або базовий символ).
  const selectedCurrency = currencies.find(c => c.id === watchedCurrencyId);
  const currencySymbol =
    selectedCurrency?.symbol || selectedCurrency?.code || baseCurrency?.symbol || '₴';

  // Load PO data in edit mode
  const loadPo = useCallback(
    (id: string, silent = false) => {
      if (!silent) {
        setLoading(true);
        setError('');
      }
      return apiFetch<PODetail>(`/purchase-orders/${id}`)
        .then(po => {
          setPoNumber(po.number);
          setCurrentStatus(po.status);
          // reset() ставить нову «чисту» базу із завантаженого запису → rhfDirty=false.
          // Display-поля (goodName/goodSku/… receivedQty/pricingRuleName) зберігаються
          // у тому ж line-об'єкті — RHF тримає їх у runtime, схема їх не валідує.
          reset({
            supplierId: po.supplierId ?? '',
            warehouseId: po.warehouseId ?? '',
            contractId: po.contractId ?? '',
            notes: po.notes ?? '',
            documentDate: po.documentDate ? po.documentDate.slice(0, 10) : kyivToday(),
            currencyId: po.currencyId ?? '',
            paymentDate: po.paymentDate ? po.paymentDate.slice(0, 10) : '',
            trackingNumber: po.trackingNumber ?? '',
            lines: (po.lines ?? []).map(l => ({
              _key: nextKey(),
              id: l.id,
              goodId: l.goodId,
              goodName: l.goodName ?? '',
              goodSku: l.goodSku,
              goodInternalCode: l.goodInternalCode,
              goodBrandName: l.goodBrandName,
              unit: l.unit ?? 'шт',
              unitShortName: l.unitShortName,
              quantity: String(l.quantity),
              price: String(l.price),
              receivedQty: l.receivedQty,
              pricedSalePrice: l.pricedSalePrice ?? undefined,
              pricingRuleName: l.pricingRuleName ?? null,
            })) as unknown as PurchaseOrderFormInput['lines'],
          });
          setSupplierDisplay(po.supplierName ?? '');
          setContractId(po.contractId ?? null);
          setContractNumber(po.contractNumber ?? null);
        })
        .catch(e => {
          if (!silent) setError(e instanceof Error ? e.message : 'Помилка завантаження замовлення');
        })
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [reset],
  );

  useEffect(() => {
    if (!open || !isEditMode || !purchaseOrderId) return;
    // void: loadPo сам ловить помилку (setError над формою) і ніколи не реджектиться.
    void loadPo(purchaseOrderId);
  }, [open, purchaseOrderId, isEditMode, loadPo]);

  // Auto-collapse header when adding lines
  useEffect(() => {
    if (showLineInput) setHeaderCollapsed(true);
  }, [showLineInput]);

  // ── Supplier picker ───────────────────────────────────────────────────────

  type SupplierItem = SearchPickerItem & { phone?: string | null };

  const fetchSupplierItems = useCallback(async (q: string): Promise<SupplierItem[]> => {
    const url = q.trim()
      ? `/counterparties?q=${encodeURIComponent(q.trim())}&types=SUPPLIER&types=BOTH&limit=30`
      : `/counterparties?types=SUPPLIER&types=BOTH&limit=30`;
    const data = await apiFetch<{ items: Supplier[] }>(url);
    return data.items.map(c => ({
      id: c.id,
      primary: displayCounterpartyName(c),
      secondary: c.phone ?? undefined,
    }));
  }, []);

  const openSupplierDetail = useCallback(async () => {
    const supId = getValues('supplierId');
    if (!supId) return;
    try {
      const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${supId}`);
      setSupplierDetailData(cp);
      setSupplierDetailOpen(true);
    } catch (e: unknown) {
      // Раніше тут був порожній `catch { /* ignore */ }`: при збої картка постачальника
      // просто не відкривалась і користувач не бачив ЖОДНОГО сигналу — клік «у нікуди».
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження постачальника');
    }
  }, [getValues]);

  const openGoodDetail = useCallback(async (goodId: string) => {
    if (!goodId) return;
    type Brand = { id: string; name: string };
    type UnitRef = {
      id: string;
      name: string;
      shortName: string;
      isSystem: boolean;
      coefficient: number;
    };
    type SupplierRef = {
      id: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    };
    try {
      const [good, brandsRes, unitsRes, suppliersRes, goodCatsRes] = await Promise.all([
        apiFetch<GoodForModal>(`/goods/${goodId}`),
        Promise.resolve(getCached<Brand[]>('cache:brands')).then(
          c =>
            c ??
            apiFetch<{ items: Brand[] }>('/brands?limit=200')
              .then(r => r.items)
              .catch(() => [] as Brand[]),
        ),
        Promise.resolve(getCached<UnitRef[]>('cache:units')).then(
          c => c ?? apiFetch<UnitRef[]>('/units').catch(() => [] as UnitRef[]),
        ),
        Promise.resolve(getCached<SupplierRef[]>('cache:suppliers')).then(
          c =>
            c ??
            apiFetch<{ items: SupplierRef[] }>('/counterparties?types=SUPPLIER,BOTH&limit=200')
              .then(r => r.items)
              .catch(() => [] as SupplierRef[]),
        ),
        Promise.resolve(getCached<CategoryNode[]>('cache:good-categories')).then(
          c => c ?? apiFetch<CategoryNode[]>('/good-categories').catch(() => [] as CategoryNode[]),
        ),
      ]);
      setGoodDetailData(good);
      setGoodRefData({
        brands: brandsRes,
        units: unitsRes,
        suppliers: suppliersRes,
        goodCatTree: goodCatsRes,
      });
      setGoodDetailOpen(true);
    } catch (e: unknown) {
      // Раніше порожній `catch { /* ignore */ }`: при збої картка товару не відкривалась
      // мовчки — користувач клікав і нічого не відбувалось.
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження товару');
    }
  }, []);

  // ── Good picker ───────────────────────────────────────────────────────────

  type GoodItem = SearchPickerItem & {
    unit?: string | null;
    purchasePrice?: number | null;
    sku?: string | null;
    internalCode?: string | null;
    brandName?: string | null;
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
      purchasePrice: g.purchasePrice,
      sku: g.sku,
      internalCode: g.internalCode ?? null,
      brandName: g.brandName ?? null,
      barcode: g.barcode,
      barcodes: g.barcodes,
    }));
  }, []);

  // ── FSM ───────────────────────────────────────────────────────────────────

  // Memoize allowedTransitions itself to keep referential stability (each render
  // would otherwise produce a fresh fallback array). This also lets the prev/next
  // useMemo below depend on `allowedTransitions` directly without thrashing.
  const allowedTransitions = useMemo<readonly string[]>(
    () =>
      isEditMode ? (PO_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS) : EMPTY_TRANSITIONS,
    [currentStatus, isEditMode],
  );

  const { statusPrevStep, statusNextStep } = useMemo(() => {
    const curIdx = PO_STATUS_ORDER.indexOf(currentStatus);
    let statusPrevStep: string | undefined;
    for (let i = allowedTransitions.length - 1; i >= 0; i--) {
      const s = allowedTransitions[i];
      if (s && PO_STATUS_ORDER.indexOf(s) < curIdx) {
        statusPrevStep = s;
        break;
      }
    }
    const statusNextStep = allowedTransitions.find(
      (s: string) => PO_STATUS_ORDER.indexOf(s) > curIdx,
    );
    return { statusPrevStep, statusNextStep };
  }, [currentStatus, allowedTransitions]);

  // Усі мутації й завантаження в цьому модалі мають власний catch, який показує помилку:
  // doTransition/handleCreate/handleSave/handleReceive/loadPo → setError у банері над формою,
  // openSupplierDetail/openGoodDetail → toast.error. confirmClose() у handleModalClose лише
  // resolve-иться. Тому в JSX вони викликаються через `void` — чекати проміс нема кому.
  const doTransition = useCallback(
    async (newStatus: string) => {
      if (!purchaseOrderId) return;
      setTransitioningBoth(true);
      setError('');
      try {
        await apiFetch(`/purchase-orders/${purchaseOrderId}/transition`, {
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
    },
    [purchaseOrderId, onSaved],
  );

  // ── Lines ─────────────────────────────────────────────────────────────────

  const total = useMemo(
    () =>
      (watchedLines ?? []).reduce((sum, l) => {
        const qty = parseFloat(String(l.quantity)) || 0;
        const price = parseFloat(String(l.price)) || 0;
        return sum + qty * price;
      }, 0),
    [watchedLines],
  );

  const vatTotal = useMemo(() => {
    if (vatMode === 'NONE' || vatRate === 0) return 0;
    if (vatMode === 'EXCLUSIVE') return (total * vatRate) / 100;
    return total - total / (1 + vatRate / 100);
  }, [total, vatMode, vatRate]);

  // Оплатити постачальнику по цьому замовленню — передзаповнюємо постачальника,
  // PO та ЗАЛИШОК БОРГУ (totalAmount − сума проведених оплат по цьому PO).
  const openPayment = useCallback(async () => {
    if (!activePOId) return;
    let remaining = total; // fallback — сума позицій
    try {
      const [po, paymentsRes] = await Promise.all([
        apiFetch<{ totalAmount: number }>(`/purchase-orders/${activePOId}`),
        apiFetch<{ items: SupplierPayment[] }>(
          `/supplier-payments?purchaseOrderId=${activePOId}&status=CONFIRMED&limit=100`,
        ),
      ]);
      const paid = paymentsRes.items.reduce((sum, p) => sum + Number(p.amount), 0);
      remaining = Math.max(0, Number(po.totalAmount) - paid);
    } catch {
      // мережа/офлайн — лишаємо fallback (сума позицій), користувач відкоригує
    }
    setPaymentPrefill({
      supplierId: getValues('supplierId') || undefined,
      supplierName: supplierDisplay || undefined,
      purchaseOrderId: activePOId,
      purchaseOrderNumber: poNumber || undefined,
      amount: remaining > 0 ? remaining : undefined,
    });
    setPaymentOpen(true);
  }, [activePOId, total, getValues, supplierDisplay, poNumber]);

  const lineSubtotal = (qty: string, price: string) =>
    (parseFloat(qty) || 0) * (parseFloat(price) || 0);

  const numericInputCls =
    'w-full rounded border border-input bg-background px-1.5 py-1 text-[12px] tabular-nums focus:outline-none focus:ring-1 focus:ring-ring';

  // useFieldArray remove за індексом рядка (RHF замінив старий _key-фільтр по setLines).
  const removeLine = (index: number) => remove(index);

  // editingKey тримає RHF field.id (стабільний per-field), editingIndex — позицію у
  // масиві для update(index, ...). editingLine — локальний staging як і раніше.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingLine, setEditingLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);

  // fieldId — стабільний RHF field.id (той самий, за яким рендериться row і матчиться
  // inline-edit нижче). НЕ line._key: field.id ≠ _key, інакше edit-row ніколи не активується.
  const startEdit = (line: LocalLine, index: number, fieldId: string) => {
    setEditingKey(fieldId);
    setEditingIndex(index);
    setEditingLine({
      id: line.id,
      goodId: line.goodId,
      goodName: line.goodName,
      goodSku: line.goodSku,
      goodInternalCode: line.goodInternalCode,
      goodBrandName: line.goodBrandName,
      unit: line.unit,
      unitShortName: line.unitShortName,
      quantity: line.quantity,
      price: line.price,
      receivedQty: line.receivedQty,
      pricedSalePrice: line.pricedSalePrice,
      pricingRuleName: line.pricingRuleName,
    });
  };

  const commitEdit = () => {
    if (editingIndex == null) return;
    // update() перезаписує рядок; identity рядка тримає RHF field.id (не _key), тож
    // _key тут суто вестиж (display/persist-поле) — свіжий ключ безпечний.
    update(editingIndex, {
      ...editingLine,
      _key: nextKey(),
    } as unknown as FormLineItem);
    setEditingKey(null);
    setEditingIndex(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditingIndex(null);
  };

  const addLine = () => {
    if (!newLine.goodId) return;
    append({ ...newLine, _key: nextKey() } as unknown as FormLineItem);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' : true;

  // Повертає id створеного PO (для create-then-open-wizard) або null при помилці/дублі-сабміті.
  // Читаємо валідовані значення вручну через getValues()+safeParse (замість handleSubmit),
  // щоб зберегти контракт «повертає id» — id потрібен openExcelImport.
  const handleCreate = async (): Promise<string | null> => {
    // WEB-H3 (Bug #630): синхронний guard проти concurrent double-submit. `disabled={saving}`
    // спирається на re-render React МІЖ подіями кліку; два click-и в одному tick обидва
    // входять до застосування disabled → 2 POST /purchase-orders. savingRef фліпається
    // синхронно у setSavingBoth → другий вхід одразу повертається.
    if (savingRef.current || transitioningRef.current) return null;
    const parsed = purchaseOrderFormSchema.safeParse(getValues());
    if (!parsed.success) {
      setError(firstSchemaError(parsed.error));
      return null;
    }
    const values = parsed.data;
    setSavingBoth(true);
    setError('');
    try {
      // backend CreatePurchaseOrderDto приймає `lines` у body та створює всі рядки
      // у $transaction (атомарно, з recalc totalAmount). Endpoint POST /purchase-orders/:id/lines
      // НЕ існує — попередній цикл `for ... POST /lines` повертав 404 на кожен виклик і залишав
      // PO як orphan-draft без позицій. Рядки з форми + staging newLine (якщо ще не «+»).
      const stagingLine = newLine.goodId
        ? [
            {
              goodId: newLine.goodId,
              quantity: parseFloat(newLine.quantity) || 1,
              price: parseFloat(newLine.price) || 0,
            },
          ]
        : [];
      const linesPayload = [
        ...values.lines.map(l => ({
          goodId: l.goodId,
          quantity: l.quantity,
          price: l.price,
        })),
        ...stagingLine,
      ];

      const po = await apiFetch<{ id: string; number: string }>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: values.supplierId,
          warehouseId: values.warehouseId,
          currencyId: values.currencyId || undefined,
          notes: values.notes || undefined,
          documentDate: values.documentDate || undefined,
          paymentDate: values.paymentDate || undefined,
          trackingNumber: values.trackingNumber || undefined,
          lines: linesPayload.length > 0 ? linesPayload : undefined,
        }),
      });

      if (features.toastEnabled) toast.success(t('toast.orderCreatedNo', { number: po.number }));
      // Створено успішно — форма чиста; reset тепер відбудеться через loadPo (нова база).
      dirty.resetDirty();
      onSaved?.();
      // Не закриваємо — переходимо в edit mode щоб можна було одразу додавати товари
      setActivePOId(po.id);
      await loadPo(po.id);
      return po.id;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення замовлення');
      return null;
    } finally {
      setSavingBoth(false);
    }
  };

  // Excel-імпорт потребує вже створеного PO (docId). У create-mode спершу створюємо чернетку
  // (handleCreate → activePOId), тоді відкриваємо майстер. У edit-mode — одразу.
  const openExcelImport = async () => {
    if (activePOId) {
      setExcelWizardOpen(true);
      return;
    }
    const id = await handleCreate();
    if (id) setExcelWizardOpen(true);
  };

  const handleSave = async () => {
    if (!purchaseOrderId) return;
    if (savingRef.current || transitioningRef.current) return;
    const parsed = purchaseOrderFormSchema.safeParse(getValues());
    if (!parsed.success) {
      setError(firstSchemaError(parsed.error));
      return;
    }
    const values = parsed.data;
    setSavingBoth(true);
    setError('');
    try {
      // pricedSalePrice — поле схеми (optionalNonNeg); приходить у values.lines.
      const allLines = values.lines.map(l => ({
        goodId: l.goodId,
        quantity: l.quantity,
        price: l.price,
        ...(l.pricedSalePrice != null ? { pricedSalePrice: l.pricedSalePrice } : {}),
      }));
      await apiFetch(`/purchase-orders/${purchaseOrderId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          supplierId: values.supplierId || undefined,
          warehouseId: values.warehouseId || undefined,
          currencyId: values.currencyId || undefined,
          // null → backend clears contractId; UUID → set; undefined → keep current.
          // We always send the explicit value because supplier picker resets contract
          // state to null and backend must persist that clear. contractId лишається
          // окремим useState (auto-fill + explicit null-clear), НЕ у RHF.
          contractId: contractId ?? null,
          notes: values.notes || undefined,
          documentDate: values.documentDate || undefined,
          paymentDate: values.paymentDate || undefined,
          // Порожнє → null (очистити ЕН і зупинити трекінг); непорожнє → встановити/оновити.
          trackingNumber: values.trackingNumber ? values.trackingNumber : null,
          lines: allLines,
        }),
      });

      if (features.toastEnabled) toast.success(t('toast.orderSaved'));
      dirty.resetDirty();
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  };

  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────

  // sto-optimize: warehouse lookup → Map (O(1) замість O(N) на кожен render).
  // На малих списках виграш мізерний, але стабілізує identity при подальшому memo.
  const warehouseById = useMemo(() => {
    const m = new Map<string, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  const handleReceive = async () => {
    if (!purchaseOrderId) return;
    // Bug: `receiveQtys` кейситься по RHF field.id (input рендериться з field-об'єкта, де RHF
    // ПЕРЕЗАПИСУЄ data.id власним синтетичним id). А getValues('lines')[i].id — це РЕАЛЬНИЙ
    // db-lineId (RHF не чіпає значення, лише field-обгортку). Тож читати receiveQtys треба по
    // fields[i].id (синтетичний, збігається з ключем input-а), а lineId на бек слати з
    // getValues (реальний). Раніше обидва бралися з getValues → ключ не збігався → усі позиції
    // фільтрувались → «Вкажіть кількість…» навіть коли користувач ввів кількість.
    const dbLines = (getValues('lines') ?? []) as unknown as LocalLine[];
    const receivedLines = fields
      .map((field, i) => ({
        lineId: dbLines[i]?.id ?? '',
        receivedQty: parseFloat(receiveQtys[field.id] ?? ''),
      }))
      .filter(l => l.lineId && !isNaN(l.receivedQty) && l.receivedQty > 0);
    if (!receivedLines.length) {
      setError('Вкажіть кількість для хоча б однієї позиції');
      return;
    }
    setReceiving(true);
    setError('');
    try {
      await apiFetch(`/purchase-orders/${purchaseOrderId}/receive`, {
        method: 'POST',
        body: JSON.stringify({ lines: receivedLines }),
      });
      setReceiveMode(false);
      setReceiveQtys({});
      // Reload PO to get updated receivedQty and status
      const updated = await apiFetch<{ status: string; number: string }>(
        `/purchase-orders/${purchaseOrderId}`,
      );
      setCurrentStatus(updated.status);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка оприбуткування');
    } finally {
      setReceiving(false);
    }
  };

  const handleApplyPricing = async () => {
    if (!purchaseOrderId) return;
    setApplyingPricing(true);
    setError('');
    try {
      const result = await apiFetch<{ updated: number }>(
        `/purchase-orders/${purchaseOrderId}/apply-pricing`,
        {
          method: 'POST',
        },
      );
      if (features.toastEnabled) toast.success(t('toast.pricedGoods', { count: result.updated }));
      // Reload lines to show pricedSalePrice + pricingRuleName
      if (purchaseOrderId) await loadPo(purchaseOrderId, true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка розцінки';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setApplyingPricing(false);
    }
  };

  const fetchPricingRules = async (bySupplier: boolean) => {
    setPricingRulesLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      const supId = getValues('supplierId');
      if (bySupplier && supId) params.set('supplierId', supId);
      const data = await apiFetch<{
        items: Array<{ id: string; name: string; description: string | null }>;
      }>(`/pricing-rules?${params}`);
      setPricingRules(Array.isArray(data.items) ? data.items : []);
    } catch {
      setPricingRules([]);
    } finally {
      setPricingRulesLoading(false);
    }
  };

  const openRulePricer = async () => {
    setRuleFilterBySupplier(true);
    setRulePricerOpen(true);
    await fetchPricingRules(true);
  };

  const toggleRuleSupplierFilter = async (bySupplier: boolean) => {
    setRuleFilterBySupplier(bySupplier);
    await fetchPricingRules(bySupplier);
  };

  const handleApplyPricingByRule = async (ruleId: string) => {
    if (!purchaseOrderId) return;
    setRulePricerOpen(false);
    setApplyingPricing(true);
    setError('');
    try {
      const result = await apiFetch<{ updated: number }>(
        `/purchase-orders/${purchaseOrderId}/apply-pricing`,
        { method: 'POST', body: JSON.stringify({ ruleId }) },
      );
      if (features.toastEnabled) toast.success(t('toast.pricedGoods', { count: result.updated }));
      if (purchaseOrderId) await loadPo(purchaseOrderId, true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка розцінки';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setApplyingPricing(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleModalClose()}
        onSubmit={() => void (isEditMode ? handleSave() : handleCreate())}
        title={isEditMode ? poNumber || 'Замовлення' : 'Нове замовлення постачальнику'}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground shrink-0">
              <span className="font-medium">Номер:</span>
              <span className="text-foreground">
                {isEditMode && poNumber ? poNumber : '— присвоюється автоматично —'}
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
              <span className="text-[13px] font-medium text-muted-foreground">Дата оплати:</span>
              <div className="w-36">
                {/* Задається на DRAFT; після ORDERED — авто-заповнюється при повному отриманні
                    (RECEIVED) = сьогодні + CounterpartyContract.paymentDeferDays.
                    Backend PATCH /purchase-orders/:id блокує зміни поза DRAFT (тому disabled). */}
                <Controller
                  control={control}
                  name="paymentDate"
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
              <span className="text-[13px] font-medium text-muted-foreground">Накладна (ЕН):</span>
              <div className="w-44">
                <Input
                  {...register('trackingNumber')}
                  placeholder="напр. 204..."
                  disabled={!canEdit}
                  autoComplete="off"
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
                    {statusPrevStep ? poStatusLabel(statusPrevStep) : '—'}
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
                  {poStatusLabel(currentStatus)}
                </button>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep ? poStatusLabel(statusNextStep) : '—'}
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
                        {PO_STATUS_ACTION_LABELS[s] ?? poStatusLabel(s)}
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
                    label: poNumber || 'Замовлення',
                    modalKey: 'purchase-order',
                    restoreProps: { purchaseOrderId },
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
              onClick={() => void handleModalClose()}
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
                  onClick={() => void doTransition('CANCELLED')}
                  loading={transitioning}
                  disabled={transitioning || saving}
                >
                  Скасувати
                </Button>
              )}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {isEditMode && currentStatus !== 'CANCELLED' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openPayment()}
                  disabled={saving || transitioning}
                  title="Створити оплату постачальнику по цьому замовленню"
                >
                  <Wallet size={15} className="mr-1" />
                  Оплатити
                </Button>
              )}
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
                </>
              )}
              {isEditMode ? (
                canEdit && (
                  <Button
                    onClick={() => void handleSave()}
                    loading={saving}
                    disabled={saving || transitioning}
                    size="sm"
                  >
                    Зберегти зміни
                  </Button>
                )
              ) : (
                <Button
                  onClick={() => void handleCreate()}
                  loading={saving}
                  disabled={saving || !supplierIdValue || !warehouseIdValue}
                  size="sm"
                >
                  Створити замовлення
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
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

                {/* Рядок 2: Постачальник | Склад */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <EntityPickerField<SupplierItem>
                      label="Постачальник"
                      required
                      display={supplierDisplay}
                      placeholder="Пошук постачальника…"
                      className="h-8 text-[13px]"
                      disabled={!canEdit}
                      onPick={() => setSupplierPickerOpen(true)}
                      onOpenDetail={supplierIdValue ? () => void openSupplierDetail() : undefined}
                      onSearch={fetchSupplierItems}
                      onSearchSelect={item => {
                        setSupplierDisplay(item.primary);
                        setValue('supplierId', item.id, { shouldDirty: true });
                        // Clear contract when supplier changes
                        setContractId(null);
                        setContractNumber(null);
                      }}
                      onClear={() => {
                        setSupplierDisplay('');
                        setValue('supplierId', '', { shouldDirty: true });
                        setContractId(null);
                        setContractNumber(null);
                      }}
                    />
                    {errors.supplierId && (
                      <p className="text-[12px] text-destructive leading-tight mt-1">
                        {errors.supplierId.message}
                      </p>
                    )}
                  </div>
                  <Controller
                    control={control}
                    name="warehouseId"
                    render={({ field }) => (
                      <Select
                        label="Склад"
                        required
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        errorMessage={errors.warehouseId?.message}
                        disabled={!canEdit}
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
                </div>

                {/* Рядок 3: Договір | Валюта */}
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="Договір"
                    value={contractNumber ?? ''}
                    disabled
                    readOnly
                    placeholder="— автоматично —"
                    className="h-8 text-[13px]"
                  />
                  <Controller
                    control={control}
                    name="currencyId"
                    render={({ field }) => (
                      <CurrencySelect
                        value={typeof field.value === 'string' ? field.value : ''}
                        onChange={id => field.onChange(id)}
                        // Bug #639-клас: авто-дефолт базової валюти — програмна зміна → shouldDirty:false,
                        // щоб незаймана модалка не вважалась брудною (Escape/закриття без хибного guard-у).
                        onAutoDefault={id => setValue('currencyId', id, { shouldDirty: false })}
                        disabled={!canEdit}
                      />
                    )}
                  />
                </div>

                {/* Рядок 4: Опис */}
                <Input
                  label="Опис"
                  {...register('notes')}
                  disabled={!canEdit}
                  placeholder="Додаткова інформація…"
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
          </div>

          {/* ── Header toggle strip ──────────────────────────────────────── */}
          <CollapsibleHeader
            collapsed={headerCollapsed}
            onToggle={() => setHeaderCollapsed(c => !c)}
            chips={[
              { label: supplierDisplay || '— постачальник —', primary: true, maxWidth: 'max-w-50' },
              {
                label: warehouseIdValue
                  ? (warehouseById.get(warehouseIdValue)?.name ?? '— склад —')
                  : '— склад —',
                maxWidth: 'max-w-40',
              },
              ...(contractNumber
                ? [{ label: `Дог. ${contractNumber}`, maxWidth: 'max-w-35' }]
                : []),
            ]}
          />

          {/* ── Lines table ──────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground">Товари</p>
              <div className="flex items-center gap-2">
                {isEditMode && (currentStatus === 'RECEIVED' || currentStatus === 'PARTIAL') && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void openRulePricer()}
                      loading={applyingPricing}
                      disabled={applyingPricing || saving || transitioning}
                      title="Розцінити за обраним правилом"
                    >
                      <Zap size={13} className="mr-1" />
                      За правилом
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleApplyPricing()}
                      loading={applyingPricing}
                      disabled={applyingPricing || saving || transitioning}
                      title="Розцінити товари за правилами автоматично"
                    >
                      <Zap size={13} className="mr-1" />
                      Розцінити
                    </Button>
                  </>
                )}
                {isEditMode &&
                  (currentStatus === 'ORDERED' || currentStatus === 'PARTIAL') &&
                  (receiveMode ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setReceiveMode(false);
                          setReceiveQtys({});
                          setError('');
                        }}
                        disabled={receiving}
                        className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Скасувати
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={receiving}
                        onClick={() => {
                          // receiveQtys кейситься по RHF field.id (той самий ключ, що й input
                          // рендериться нижче: value={receiveQtys[field.id]}). Кількість/залишок
                          // читаємо з даних поля (field як LocalLine). Раніше ключем був l.id з
                          // getValues (реальний db-id) → не збігався з field.id input-а → «все»
                          // не заповнювало жодного видимого поля.
                          const all: Record<string, string> = {};
                          fields.forEach(field => {
                            const l = field as unknown as LocalLine;
                            const max =
                              (parseFloat(String(l.quantity)) || 0) - (l.receivedQty ?? 0);
                            if (max > 0) all[field.id] = String(max);
                          });
                          setReceiveQtys(all);
                        }}
                      >
                        Оприбуткувати все
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleReceive()}
                        loading={receiving}
                        disabled={receiving}
                      >
                        <PackageCheck size={13} className="mr-1" />
                        Підтвердити прийом
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReceiveMode(true)}
                      disabled={saving || transitioning}
                    >
                      <PackageCheck size={13} className="mr-1" />
                      Оприбуткувати
                    </Button>
                  ))}
                {canEdit && isEditMode && activePOId && !receiveMode && (
                  <XlsxImportButton
                    templateType="po-lines"
                    importUrl={`/xlsx/import/purchase-order-lines/${activePOId}`}
                    onImportComplete={() => void loadPo(activePOId, true)}
                  />
                )}
                {/* Майстер Excel-імпорту доступний і на створенні: у create-mode спершу створює
                    чернетку PO (потрібен docId), тоді відкриває майстер. */}
                {canEdit && !receiveMode && (
                  <button
                    type="button"
                    onClick={() => void openExcelImport()}
                    disabled={saving || transitioning}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-border bg-surface text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Завантажити з Excel
                  </button>
                )}
                {canEdit && !showLineInput && !receiveMode && (
                  <button
                    type="button"
                    onClick={() => setShowLineInput(true)}
                    className="flex items-center gap-1 text-[12px] text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Додати
                  </button>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full table-fixed text-[12px]">
                <colgroup>
                  <col />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  {isEditMode && <col className="w-[9%]" />}
                  <col className="w-[10%]" />
                  {vatMode !== 'NONE' && <col className="w-[9%]" />}
                  <col className="w-[10%]" />
                  {canPrice && <col className="w-[10%]" />}
                  {canPrice && <col className="w-[14%]" />}
                  <col className="w-16" />
                </colgroup>
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      Товар
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      К-сть
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      ОВ
                    </th>
                    {isEditMode && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        Отримано
                      </th>
                    )}
                    {receiveMode && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary whitespace-nowrap">
                        До отримання
                      </th>
                    )}
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      Ціна, {currencySymbol}
                    </th>
                    {vatMode !== 'NONE' && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        ПДВ, {currencySymbol}
                      </th>
                    )}
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      Сума, {currencySymbol}
                    </th>
                    {canPrice && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary whitespace-nowrap">
                        Ціна розцінки, {currencySymbol}
                      </th>
                    )}
                    {canPrice && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        Правило розцінки
                      </th>
                    )}
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {fields.map((field, index) => {
                    // Display/persist-поля (goodName/goodSku/unit/receivedQty/pricedSalePrice/
                    // pricingRuleName…) живуть у field-об'єкті поза zod-схемою — читаємо через cast.
                    const line = field as unknown as LocalLine;
                    return editingKey === field.id ? (
                      // ── Inline edit row (same layout as add-line row) ────
                      <tr key={field.id} className="bg-primary/5 border-t-2 border-primary/20">
                        <td className="px-2 py-1.5">
                          <EntityPickerField<GoodItem>
                            display={editingLine.goodName}
                            placeholder="Пошук товару…"
                            ariaLabel="Товар"
                            onSearch={fetchGoodItems}
                            onOpenDetail={
                              editingLine.goodId
                                ? () => void openGoodDetail(editingLine.goodId)
                                : undefined
                            }
                            onSearchSelect={g => {
                              setEditingLine(l => ({
                                ...l,
                                goodId: g.id,
                                goodName: g.primary,
                                goodSku: g.sku ?? null,
                                goodInternalCode: g.internalCode ?? null,
                                goodBrandName: g.brandName ?? null,
                                unit: g.unit ?? l.unit,
                                price: String(g.purchasePrice ?? l.price),
                              }));
                            }}
                            onClear={() =>
                              setEditingLine(l => ({
                                ...l,
                                goodId: '',
                                goodName: '',
                                goodSku: null,
                              }))
                            }
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={editingLine.quantity}
                            onChange={e =>
                              setEditingLine(l => ({ ...l, quantity: e.target.value }))
                            }
                            className={numericInputCls}
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          {units.length > 0 ? (
                            <select
                              value={editingLine.unit}
                              onChange={e => setEditingLine(l => ({ ...l, unit: e.target.value }))}
                              className="w-full rounded border border-input bg-background px-1.5 py-1 text-[11px] text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                              {units.map(u => (
                                <option key={u.id} value={u.shortName}>
                                  {u.shortName}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">
                              {editingLine.unit}
                            </span>
                          )}
                        </td>
                        {isEditMode && (
                          <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                            {line.receivedQty != null ? line.receivedQty : '—'}
                          </td>
                        )}
                        {receiveMode && <td />}
                        <td className="px-1 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={editingLine.price}
                            onChange={e => setEditingLine(l => ({ ...l, price: e.target.value }))}
                            placeholder="0"
                            className={numericInputCls}
                          />
                        </td>
                        {vatMode !== 'NONE' && (
                          <td className="px-2 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                            {vatRate > 0
                              ? (
                                  (lineSubtotal(editingLine.quantity, editingLine.price) *
                                    vatRate) /
                                  100
                                ).toFixed(2)
                              : '—'}
                          </td>
                        )}
                        <td className="px-2 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                          {lineSubtotal(editingLine.quantity, editingLine.price).toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-row gap-2 items-center">
                            <button
                              type="button"
                              onClick={commitEdit}
                              disabled={!editingLine.goodId}
                              title="Зберегти"
                              className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              title="Скасувати"
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      // ── Display row ──────────────────────────────────────
                      <tr
                        key={field.id}
                        className="bg-surface hover:bg-secondary/30 transition-colors group"
                      >
                        <td className="px-3 py-2">
                          <div>{line.goodName}</div>
                          {(line.goodInternalCode || line.goodSku || line.goodBrandName) && (
                            <div className="text-[11px] text-muted-foreground">
                              {[line.goodInternalCode, line.goodSku, line.goodBrandName]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{line.quantity}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {line.unitShortName || line.unit}
                        </td>
                        {isEditMode && (
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {line.receivedQty != null ? line.receivedQty : '—'}
                          </td>
                        )}
                        {receiveMode && (
                          <td className="px-2 py-1.5">
                            {(() => {
                              const maxQty =
                                (parseFloat(String(line.quantity)) || 0) - (line.receivedQty ?? 0);
                              return maxQty > 0 ? (
                                <input
                                  type="number"
                                  min="0"
                                  max={maxQty}
                                  step="1"
                                  // Ключ — RHF field.id (той самий синтетичний id, за яким
                                  // читають handleReceive та «отримати все»); line.id === field.id
                                  // (line — це той самий field через cast), тож усі 3 сайти єдині.
                                  value={receiveQtys[field.id] ?? ''}
                                  onChange={e =>
                                    setReceiveQtys(q => ({ ...q, [field.id]: e.target.value }))
                                  }
                                  placeholder={`макс. ${maxQty}`}
                                  className="w-24 rounded border border-primary/50 bg-primary/5 px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              ) : (
                                <span className="text-[11px] text-success px-2">✓ повністю</span>
                              );
                            })()}
                          </td>
                        )}
                        <td className="px-3 py-2 tabular-nums">{line.price}</td>
                        {vatMode !== 'NONE' && (
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {vatRate > 0
                              ? ((lineSubtotal(line.quantity, line.price) * vatRate) / 100).toFixed(
                                  2,
                                )
                              : '—'}
                          </td>
                        )}
                        <td className="px-3 py-2 tabular-nums">
                          {lineSubtotal(line.quantity, line.price).toFixed(2)}
                        </td>
                        {canPrice && (
                          <td
                            className="px-3 py-2 text-[12px] tabular-nums cursor-text hover:bg-primary/5 transition-colors"
                            title="Клікніть щоб редагувати"
                            onClick={e => {
                              const input = e.currentTarget.querySelector('input');
                              input?.focus();
                            }}
                          >
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={line.pricedSalePrice ?? ''}
                              onChange={e => {
                                const val =
                                  e.target.value === '' ? undefined : parseFloat(e.target.value);
                                // update() перезаписує рядок у useFieldArray, зберігаючи всі
                                // display-поля; pricedSalePrice — число|undefined (схема optionalNonNeg).
                                update(index, {
                                  ...line,
                                  pricedSalePrice: val,
                                });
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                              }}
                              className="w-full bg-transparent text-[12px] tabular-nums outline-none border-b border-transparent focus:border-primary caret-primary placeholder:text-muted-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              placeholder="—"
                            />
                          </td>
                        )}
                        {canPrice && (
                          <td className="px-3 py-2 text-[11px] text-muted-foreground truncate max-w-0">
                            <span title={line.pricingRuleName ?? ''}>
                              {line.pricingRuleName ?? '—'}
                            </span>
                          </td>
                        )}
                        <td className="px-1.5 py-2">
                          {canEdit && (
                            <div className="flex flex-row gap-2 items-center">
                              <button
                                type="button"
                                onClick={() => startEdit(line, index, field.id)}
                                aria-label="Редагувати позицію"
                                title="Редагувати"
                                className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeLine(index)}
                                aria-label="Видалити позицію"
                                title="Видалити"
                                className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Add line input row */}
                  {canEdit && showLineInput && (
                    <tr className="bg-primary/5 border-t-2 border-primary/20">
                      <td className="px-2 py-1.5">
                        <EntityPickerField<GoodItem>
                          display={newLine.goodName}
                          placeholder="Пошук товару…"
                          ariaLabel="Товар"
                          onPick={() => setGoodSearchOpen(true)}
                          onSearch={fetchGoodItems}
                          onOpenDetail={
                            newLine.goodId ? () => void openGoodDetail(newLine.goodId) : undefined
                          }
                          onSearchSelect={g => {
                            setNewLine(l => ({
                              ...l,
                              goodId: g.id,
                              goodName: g.primary,
                              goodSku: g.sku ?? null,
                              goodInternalCode: g.internalCode ?? null,
                              goodBrandName: g.brandName ?? null,
                              unit: g.unit ?? 'шт',
                              price: String(g.purchasePrice ?? ''),
                            }));
                          }}
                          onClear={() => setNewLine(EMPTY_LINE)}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={newLine.quantity}
                          onChange={e => setNewLine(l => ({ ...l, quantity: e.target.value }))}
                          className={numericInputCls}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        {units.length > 0 ? (
                          <select
                            value={newLine.unit}
                            onChange={e => setNewLine(l => ({ ...l, unit: e.target.value }))}
                            className="w-full rounded border border-input bg-background px-1.5 py-1 text-[11px] text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                          >
                            {units.map(u => (
                              <option key={u.id} value={u.shortName}>
                                {u.shortName}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">{newLine.unit}</span>
                        )}
                      </td>
                      {isEditMode && <td />}
                      <td className="px-1 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={newLine.price}
                          onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                          placeholder="0"
                          className={numericInputCls}
                        />
                      </td>
                      {vatMode !== 'NONE' && (
                        <td className="px-2 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                          {vatRate > 0
                            ? (
                                (lineSubtotal(newLine.quantity, newLine.price) * vatRate) /
                                100
                              ).toFixed(2)
                            : '—'}
                        </td>
                      )}
                      <td className="px-2 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                        {lineSubtotal(newLine.quantity, newLine.price).toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-row gap-2 items-center">
                          <button
                            type="button"
                            onClick={addLine}
                            disabled={!newLine.goodId}
                            title="Зберегти рядок"
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
                            title="Скасувати"
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-secondary/50 border-t border-border">
                    <td
                      colSpan={3 + (isEditMode ? 1 : 0) + (receiveMode ? 1 : 0)}
                      className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                    >
                      Разом:
                    </td>
                    {/* Ціна — порожня */}
                    <td />
                    {vatMode !== 'NONE' && (
                      <td className="px-3 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                        {vatTotal.toFixed(2)}
                      </td>
                    )}
                    <td className="px-3 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                      {total.toFixed(2)}
                    </td>
                    {canPrice && <td className="px-3 py-1.5" />}
                    {canPrice && <td className="px-3 py-1.5" />}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      </Modal>

      {/* Supplier picker */}
      <SearchPickerModal<SupplierItem>
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        title="Оберіть постачальника"
        selectedId={supplierIdValue}
        fetchItems={fetchSupplierItems}
        searchPlaceholder="Назва, телефон, компанія..."
        emptyText="Постачальників не знайдено"
        onSelect={item => {
          setSupplierDisplay(item.primary);
          setValue('supplierId', item.id, { shouldDirty: true });
          // Clear stale contract when supplier changes via picker modal
          // (mirrors inline EntityPickerField.onSearchSelect/onClear behaviour;
          // without this the PO would retain a contractId tied to the old supplier).
          setContractId(null);
          setContractNumber(null);
          setSupplierPickerOpen(false);
        }}
      />

      {/* Supplier detail modal */}
      <CounterpartyEditModal
        open={supplierDetailOpen}
        counterparty={supplierDetailData}
        onClose={() => setSupplierDetailOpen(false)}
        onSaved={updated => {
          setSupplierDetailData(updated);
          setSupplierDisplay(
            [updated.lastName, updated.firstName].filter(Boolean).join(' ') ||
              updated.companyName ||
              supplierDisplay,
          );
        }}
      />

      {/* Good detail modal */}
      <GoodEditModal
        open={goodDetailOpen}
        good={goodDetailData}
        onClose={() => setGoodDetailOpen(false)}
        onSaved={updated => setGoodDetailData(updated)}
        brands={goodRefData.brands}
        units={goodRefData.units}
        suppliers={goodRefData.suppliers}
        goodCatTree={goodRefData.goodCatTree}
      />

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
            goodSku: item.sku ?? null,
            goodInternalCode: item.internalCode ?? null,
            goodBrandName: item.brandName ?? null,
            unit: item.unit ?? 'шт',
            price: String(item.purchasePrice ?? ''),
          }));
          setGoodSearchOpen(false);
        }}
      />

      {/* Майстер завантаження товарів з Excel */}
      {activePOId && (
        <ExcelImportWizard
          open={excelWizardOpen}
          onClose={closeExcelWizard}
          docType="PURCHASE_ORDER"
          docId={activePOId}
          docNumber={poNumber || undefined}
          counterpartyId={supplierIdValue || undefined}
          counterpartyName={supplierDisplay}
          existingLineCount={fields.length}
          onImportComplete={() => void loadPo(activePOId, true)}
        />
      )}

      {/* Пікер правила ціноутворення */}
      <RulePricerModal
        open={rulePricerOpen}
        onClose={() => setRulePricerOpen(false)}
        supplierId={supplierIdValue}
        supplierDisplay={supplierDisplay}
        ruleFilterBySupplier={ruleFilterBySupplier}
        onToggleFilter={bySupplier => void toggleRuleSupplierFilter(bySupplier)}
        pricingRules={pricingRules}
        pricingRulesLoading={pricingRulesLoading}
        onSelectRule={ruleId => void handleApplyPricingByRule(ruleId)}
      />

      {/* Оплата постачальнику по цьому замовленню */}
      <SupplierPaymentCreateModal
        open={paymentOpen}
        prefill={paymentPrefill ?? undefined}
        onClose={() => setPaymentOpen(false)}
        onSaved={() => setPaymentOpen(false)}
      />
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
