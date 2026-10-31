'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, useFieldArray } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { validationText } from '@/lib/validation';
import {
  purchaseOrderFormSchema,
  type PurchaseOrderFormInput,
  type PurchaseOrderFormValues,
  DEFAULT_GOOD_UNIT,
} from '@sto/shared';
import { Plus, Trash2, Pencil, Check, X, Zap, PackageCheck, Wallet, Upload } from 'lucide-react';
import { apiFetch, apiPost } from '@/lib/api-client';
import { newIdempotencyKey } from '@/lib/idempotency-key';
import { PURCHASE_DOCUMENT_ROLES } from '@/lib/purchase-roles';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { usePendingOpen } from '@/hooks/usePendingOpen';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName, lineAmount, sumLineAmounts } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import { pickScannedGood } from '@/lib/barcode';
import { PO_STATUS_TRANSITIONS, PO_STATUS_ACTION_LABELS, PO_PAYABLE_STATUSES } from '@sto/shared';
import { poStatusLabel } from '@/i18n/enumLabel';
import i18n from '@/i18n/config';
import { Modal } from '@/components/ui/modal';
import { DocLinesHeader, DocLinesEmptyRow } from '@/components/ui/doc-lines-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import {
  DocumentCancelAction,
  DocumentCardHeaderActions,
  DocumentCloseButton,
  DocumentEditActions,
} from '@/components/ui/document-card-actions';
import {
  DocumentHeaderField,
  DocumentNumberField,
  DocumentStatusStepper,
  FieldWithError,
  FormCurrencySelect,
  FormDateInput,
  FormWarehouseSelect,
} from '@/components/ui/document-card-header';
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
import {
  SupplierApiOrderBlock,
  useSentOrderForce,
} from '@/components/ui/purchase-order/SupplierApiOrderBlock';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { CollapsibleDocumentHeader, DocumentCardBody } from '@/components/ui/document-card-body';
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
  if (!issue) return i18n.t('purchaseOrders:card.checkForm');
  const path = issue.path;
  // issue.message — ключ перекладу спільної схеми, не текст (Bug #934).
  const message = validationText(issue.message);
  if (path[0] === 'lines' && typeof path[1] === 'number') {
    return i18n.t('purchaseOrders:card.lineError', { n: path[1] + 1, message });
  }
  return message;
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

/**
 * Кому показано «Оплатити»: ролі POST /supplier-payments (і довідників картки оплати). Картку
 * замовлення відкриває ще й комірник — йому кнопка давала порожню картку оплати й чотири 403
 * (Bug #851).
 */
const SUPPLIER_PAYMENT_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'ACCOUNTANT'];
/**
 * Кому відкривається картка постачальника (`GET /counterparties/:id`). Комірник обирає
 * постачальника зі звуженого списку (BR-CP-014), а картку контрагента не читає й не змінює.
 */
const COUNTERPARTY_CARD_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'];

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
  const { employee } = useAuth();
  const canPaySupplier = SUPPLIER_PAYMENT_ROLES.includes(employee?.role ?? '');
  const canOpenSupplierCard = COUNTERPARTY_CARD_ROLES.includes(employee?.role ?? '');
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

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
  // Ключ прийому (BR-PO-014): новий на кожне відкриття прийому й після успішного прийому.
  const receiveKeyRef = useRef('');
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [rulePricerOpen, setRulePricerOpen] = useState(false);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [pricingRulesLoading, setPricingRulesLoading] = useState(false);
  const [ruleFilterBySupplier, setRuleFilterBySupplier] = useState(true);
  const [error, setError] = useState('');
  // Документ позначено на видалення → картка лише на перегляд. Прапорець прив'язано до id
  // завантаженого документа, тож інший документ у тій самій модалці його не успадковує.
  const [deletedDocId, setDeletedDocId] = useState<string | null>(null);
  // Id документа, який справді завантажено у форму (Bug #844).
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
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
    goodCatTree: CategoryNode[];
  }>({ brands: [], units: [], goodCatTree: [] });
  const [units, setUnits] = useState<{ id: string; name: string; shortName: string }[]>([]);

  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  const { run: runSentOrder, dialogProps: sentOrderDialogProps } = useSentOrderForce();
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
      .catch(e =>
        setError(
          e instanceof Error ? e.message : i18n.t('purchaseOrders:card.warehousesLoadError'),
        ),
      );
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
    // Картку відкрили заново (інше замовлення або нове) — відповідь попереднього завантаження
    // більше не потрібна; індикатор завантаження знімаємо, бо його finally вже не спрацює.
    loadReqRef.current++;
    setLoading(false);
    dirty.resetDirty();
    setActivePOId(purchaseOrderIdProp);
    setError('');
    setStatusMenuOpen(false);
    setSaveAsOpen(false);
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
  // Токен останнього завантаження: відповідь на запит, після якого картку закрили чи відкрили
  // для іншого замовлення, відкидається. Без нього пізня відповідь заповнювала форму чужими
  // рядками (і «Зберегти» слало їх у поточне замовлення) та знімала позначку «видалено».
  const loadReqRef = useRef(0);
  const loadPo = useCallback(
    (id: string, silent = false) => {
      const reqId = ++loadReqRef.current;
      const isStale = () => reqId !== loadReqRef.current;
      if (!silent) {
        setLoading(true);
        setError('');
        setLoadedDocId(null);
      }
      return apiFetch<PODetail>(`/purchase-orders/${id}?withDeleted=true`)
        .then(po => {
          if (isStale()) return;
          setDeletedDocId(po.deletedAt ? id : null);
          setLoadedDocId(id);
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
              unit: l.unit ?? DEFAULT_GOOD_UNIT,
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
          if (isStale()) return;
          if (!silent)
            setError(e instanceof Error ? e.message : i18n.t('purchaseOrders:card.loadError'));
        })
        .finally(() => {
          if (isStale()) return;
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
    // Комірнику телефон не приходить (BR-CP-014) — тоді другим рядком ЄДРПОУ.
    return data.items.map(c => ({
      id: c.id,
      primary: displayCounterpartyName(c),
      secondary: c.phone ?? c.edrpou ?? undefined,
    }));
  }, []);

  // Картки постачальника й товару відкриваються після запиту: Escape під час нього скасовує
  // відкриття, а не закриває замовлення (Bug #935).
  const openAfterLoad = usePendingOpen(open);

  const openSupplierDetail = useCallback(async () => {
    const supId = getValues('supplierId');
    if (!supId) return;
    try {
      await openAfterLoad(
        () => apiFetch<CounterpartyForModal>(`/counterparties/${supId}`),
        cp => {
          setSupplierDetailData(cp);
          setSupplierDetailOpen(true);
        },
      );
    } catch (e: unknown) {
      // Раніше тут був порожній `catch { /* ignore */ }`: при збої картка постачальника
      // просто не відкривалась і користувач не бачив ЖОДНОГО сигналу — клік «у нікуди».
      toast.error(e instanceof Error ? e.message : t('card.supplierLoadError'));
    }
  }, [getValues, openAfterLoad, t]);

  const openGoodDetail = useCallback(
    async (goodId: string) => {
      if (!goodId) return;
      type Brand = { id: string; name: string };
      type UnitRef = {
        id: string;
        name: string;
        shortName: string;
        isSystem: boolean;
        coefficient: number;
      };
      const loadGood = () =>
        Promise.all([
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
          Promise.resolve(getCached<CategoryNode[]>('cache:good-categories')).then(
            c =>
              c ?? apiFetch<CategoryNode[]>('/good-categories').catch(() => [] as CategoryNode[]),
          ),
        ]);
      try {
        await openAfterLoad(loadGood, ([good, brandsRes, unitsRes, goodCatsRes]) => {
          setGoodDetailData(good);
          setGoodRefData({
            brands: brandsRes,
            units: unitsRes,
            goodCatTree: goodCatsRes,
          });
          setGoodDetailOpen(true);
        });
      } catch (e: unknown) {
        // Раніше порожній `catch { /* ignore */ }`: при збої картка товару не відкривалась
        // мовчки — користувач клікав і нічого не відбувалось.
        toast.error(e instanceof Error ? e.message : t('card.goodLoadError'));
      }
    },
    [openAfterLoad, t],
  );

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
  const isDeleted = isEditMode && !!purchaseOrderId && deletedDocId === purchaseOrderId;
  // Документ ще не завантажено (або завантаження не вдалось): у формі стоять типові значення
  // «чернетки», а не цей документ. Жодних дій — інакше «Підтвердити» провело б документ, якого
  // користувач не бачить (Bug #844). Разом із «видалено» це дає картку лише на перегляд.
  const notLoaded = isEditMode && loadedDocId !== purchaseOrderId;
  // BR-PO-015: бухгалтер відкриває картку лише на перегляд — без змін, переходів, прийому й передачі
  // в API (сервер відмовив би 403); «Оплатити» лишається (оплата — його робота, BR-SUPPAY-015).
  const roleViewOnly = isEditMode && !PURCHASE_DOCUMENT_ROLES.includes(employee?.role ?? '');
  const viewOnly = isDeleted || notLoaded || roleViewOnly;
  const allowedTransitions = useMemo<readonly string[]>(
    () =>
      // Видалений документ переходів не має: сервер відповість 404 на будь-яку зміну.
      isEditMode && !viewOnly
        ? (PO_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS)
        : EMPTY_TRANSITIONS,
    [currentStatus, isEditMode, viewOnly],
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
      // Стрілки ◀/▶ лежать у тому ж контейнері, що й меню: клік по них меню не закриває, а відкрите
      // меню під підтвердженням з'їло б його перший Escape.
      setStatusMenuOpen(false);
      if (!purchaseOrderId || viewOnly) return;
      setTransitioningBoth(true);
      setError('');
      try {
        const transition = (force: boolean) =>
          apiFetch(`/purchase-orders/${purchaseOrderId}/transition`, {
            method: 'POST',
            body: JSON.stringify(force ? { status: newStatus, force } : { status: newStatus }),
          });
        if (newStatus === 'CANCELLED') {
          // Замовлення вже в постачальника — підтвердження й повтор із force (BR-SCON-014).
          const res = await runSentOrder(purchaseOrderId, 'cancel', transition);
          if (!res.done) return;
        } else {
          await transition(false);
        }
        setCurrentStatus(newStatus);
        onSaved?.();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t('card.transitionError'));
      } finally {
        setTransitioningBoth(false);
      }
    },
    [purchaseOrderId, viewOnly, onSaved, runSentOrder, t],
  );

  // ── Lines ─────────────────────────────────────────────────────────────────

  // BR-WO-007 (те саме правило, що в наряді): «Разом» — сума округлених до копійки рядків, як
  // сервер складає `totalAmount` (`money(quantity * price)` на рядок). Сирий добуток давав
  // 0,3 × 100,05 = «30.01» замість 30.02 і три рядки 0,3 × 111,11 = «100.00» замість 99.99
  // (клас Bug #811).
  const total = useMemo(
    () =>
      sumLineAmounts(
        (watchedLines ?? []).map(l => ({
          qty: parseFloat(String(l.quantity)) || 0,
          price: parseFloat(String(l.price)) || 0,
        })),
      ),
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
    lineAmount(parseFloat(qty) || 0, parseFloat(price) || 0);

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

  const canEdit = isEditMode ? currentStatus === 'DRAFT' && !viewOnly : true;

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
      setError(e instanceof Error ? e.message : t('card.createError'));
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
    // Ctrl+Enter у модалці кличе цей самий обробник — видалений документ не зберігаємо.
    if (!purchaseOrderId || viewOnly) return;
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
      setError(e instanceof Error ? e.message : t('card.saveError'));
    } finally {
      setSavingBoth(false);
    }
  };

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
      setError(t('errors.receiveNoQty'));
      return;
    }
    setReceiving(true);
    setError('');
    try {
      // BR-PO-014: ключ — на відкриття прийому; повтор того самого прийому (подвійний клік,
      // обрив відповіді) віддає збережену відповідь, а не приймає товар удруге.
      await apiPost(
        `/purchase-orders/${purchaseOrderId}/receive`,
        { lines: receivedLines },
        {
          'Idempotency-Key': receiveKeyRef.current,
        },
      );
      receiveKeyRef.current = newIdempotencyKey();
      setReceiveMode(false);
      setReceiveQtys({});
      // Перечитати замовлення ЦІЛКОМ (рядки й статус): лише статус лишав у рядках `receivedQty`
      // до прийому — «Отримано 0» при «Частково», а другий захід із тієї ж картки рахував
      // «До отримання» від застарілого значення й отримував 400 (Bug #887).
      await loadPo(purchaseOrderId, true);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.receiveError'));
    } finally {
      setReceiving(false);
    }
  };

  // Імпорт з XLSX / майстра пише рядки в базу ОДРАЗУ, без «Зберегти». Тому крім перечитування
  // замовлення треба сповістити сторінку: інакше після закриття картки хрестиком список (сума)
  // і «Зведення» бокової панелі показують числа до імпорту (Bug #838). Лише в картці, відкритій
  // на наявному замовленні (`purchaseOrderId`): у режимі створення `onSaved` сторінки картку
  // закриває, а щойно створеної чернетки в панелі ще немає.
  const handleLinesImported = (poId: string) => {
    void loadPo(poId, true);
    if (purchaseOrderId) onSaved?.();
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
      const msg = e instanceof Error ? e.message : t('card.pricingError');
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
      const msg = e instanceof Error ? e.message : t('card.pricingError');
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
        title={isEditMode ? poNumber || t('counters.purchaseOrder') : t('card.newTitle')}
        size="content"
        hideClose
        headerContent={
          // flex-wrap: п'ять полів шапки на вікні 1280 px не вміщались в один рядок — «Статус»
          // виходив за край картки й був недосяжний; тепер він переноситься на другий рядок.
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <DocumentNumberField
              label={t('card.number')}
              value={isEditMode && poNumber ? poNumber : t('card.autoNumber')}
            />
            <DocumentHeaderField label={t('card.documentDate')}>
              <FormDateInput control={control} name="documentDate" disabled={!canEdit} />
            </DocumentHeaderField>
            <DocumentHeaderField label={t('card.paymentDate')}>
              {/* Задається на DRAFT; після ORDERED — авто-заповнюється при повному отриманні
                    (RECEIVED) = сьогодні + CounterpartyContract.paymentDeferDays.
                    Backend PATCH /purchase-orders/:id блокує зміни поза DRAFT (тому disabled). */}
              <FormDateInput control={control} name="paymentDate" disabled={!canEdit} />
            </DocumentHeaderField>
            <DocumentHeaderField label={t('card.trackingNumber')} width="w-44">
              <Input
                {...register('trackingNumber')}
                placeholder={t('card.trackingPlaceholder')}
                disabled={!canEdit}
                autoComplete="off"
              />
            </DocumentHeaderField>
            <DocumentStatusStepper
              stepLabel={poStatusLabel}
              label={t('card.status')}
              menuRef={statusMenuRef}
              active={isEditMode}
              busy={transitioning}
              locked={viewOnly}
              prev={statusPrevStep}
              statusLabel={poStatusLabel(currentStatus)}
              next={statusNextStep}
              onStep={s => void doTransition(s)}
              menuShown={statusMenuShown}
              setMenuOpen={setStatusMenuOpen}
              transitions={allowedTransitions}
              transitionLabel={s =>
                t(`card.transition.${s}`, {
                  defaultValue: PO_STATUS_ACTION_LABELS[s] ?? poStatusLabel(s),
                })
              }
              statusColor={STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground'}
              statusTitle={t(`card.statusDescription.${currentStatus}`, {
                defaultValue: STATUS_DESCRIPTIONS[currentStatus],
              })}
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
                    label: poNumber || t('counters.purchaseOrder'),
                    modalKey: 'purchase-order',
                    restoreProps: { purchaseOrderId },
                  }
                : null
            }
          />
        }
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              <DocumentCancelAction
                label={t('common:cancel')}
                transitions={allowedTransitions}
                onTransition={doTransition}
                busy={transitioning}
                saving={saving}
              />
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {/* BR-SUPPAY-015: оплату приймає лише замовлення «Замовлено» / «Частково» / «Отримано». */}
              {isEditMode &&
                PO_PAYABLE_STATUSES.includes(currentStatus) &&
                !isDeleted &&
                !notLoaded &&
                canPaySupplier && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void openPayment()}
                    disabled={saving || transitioning}
                    title={t('card.payTitle')}
                  >
                    <Wallet size={15} className="mr-1" />
                    {t('card.pay')}
                  </Button>
                )}
              {/* Незнайдений документ (notLoaded) друкувати й зберігати нічого (TECH-DEBT §9 п.4);
                  видалений — друкується, як і досі. */}
              {isEditMode ? (
                <DocumentEditActions
                  save={canEdit ? { label: t('card.saveChanges'), onSave: handleSave } : null}
                  showFile={!notLoaded}
                  showShare={!viewOnly}
                  labels={{
                    print: t('card.print'),
                    saveAs: t('card.saveAs'),
                    share: t('card.share'),
                    shareTitle: t('card.share'),
                    smsTitle: t('card.sendSms'),
                  }}
                  saveAsOpen={saveAsOpen}
                  setSaveAsOpen={setSaveAsOpen}
                  saving={saving}
                  busy={transitioning}
                />
              ) : (
                <Button
                  onClick={() => void handleCreate()}
                  loading={saving}
                  disabled={saving || !supplierIdValue || !warehouseIdValue}
                  size="sm"
                >
                  {t('card.create')}
                </Button>
              )}
              <DocumentCloseButton onClose={handleModalClose} disabled={saving || transitioning} />
            </div>
          </div>
        }
      >
        <DocumentCardBody errorTestId="po-card-error" deleted={isDeleted} error={error}>
          {/* ── Collapsible header ─────────────────────────────────────── */}
          <CollapsibleDocumentHeader collapsed={headerCollapsed} loading={loading}>
            {/* Рядок 2: Постачальник | Склад */}
            <div className="grid grid-cols-2 gap-4">
              <FieldWithError error={errors.supplierId?.message}>
                <EntityPickerField<SupplierItem>
                  label={t('columns.supplier')}
                  required
                  display={supplierDisplay}
                  placeholder={t('card.supplierSearch')}
                  className="h-8 text-[13px]"
                  disabled={!canEdit}
                  onPick={() => setSupplierPickerOpen(true)}
                  onOpenDetail={
                    supplierIdValue && canOpenSupplierCard
                      ? () => void openSupplierDetail()
                      : undefined
                  }
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

            {/* Рядок 3: Договір | Валюта */}
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('card.contract')}
                value={contractNumber ?? ''}
                disabled
                readOnly
                placeholder={t('card.contractAuto')}
                className="h-8 text-[13px]"
              />
              <FormCurrencySelect
                control={control}
                name="currencyId"
                disabled={!canEdit}
                onAutoDefault={id => setValue('currencyId', id, { shouldDirty: false })}
              />
            </div>

            {/* Рядок 4: Опис */}
            <Input
              label={t('card.notes')}
              {...register('notes')}
              disabled={!canEdit}
              placeholder={t('card.notesPlaceholder')}
              className="h-8 text-[13px]"
            />

            {/* Передача в API постачальника (BR-SCON-009…014) */}
            {isEditMode && purchaseOrderId && !viewOnly && (
              <SupplierApiOrderBlock
                purchaseOrderId={purchaseOrderId}
                poStatus={currentStatus}
                unsavedChanges={rhfDirty}
                onChanged={() => {
                  void loadPo(purchaseOrderId, true);
                  onSaved?.();
                }}
              />
            )}
          </CollapsibleDocumentHeader>

          {/* ── Header toggle strip ──────────────────────────────────────── */}
          <CollapsibleHeader
            collapsed={headerCollapsed}
            onToggle={() => setHeaderCollapsed(c => !c)}
            chips={[
              {
                label: supplierDisplay || t('card.chipSupplier'),
                primary: true,
                maxWidth: 'max-w-50',
              },
              {
                label: warehouseIdValue
                  ? (warehouseById.get(warehouseIdValue)?.name ?? t('card.chipWarehouse'))
                  : t('card.chipWarehouse'),
                maxWidth: 'max-w-40',
              },
              ...(contractNumber
                ? [
                    {
                      label: t('card.chipContract', { number: contractNumber }),
                      maxWidth: 'max-w-35',
                    },
                  ]
                : []),
            ]}
          />

          {/* ── Lines table ──────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto">
            <DocLinesHeader
              title={t('card.goods')}
              onAdd={
                canEdit && !showLineInput && !receiveMode ? () => setShowLineInput(true) : undefined
              }
            >
              {isEditMode &&
                !viewOnly &&
                (currentStatus === 'RECEIVED' || currentStatus === 'PARTIAL') && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void openRulePricer()}
                      loading={applyingPricing}
                      disabled={applyingPricing || saving || transitioning}
                      title={t('card.priceByRuleTitle')}
                    >
                      <Zap size={13} className="mr-1" />
                      {t('card.priceByRule')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleApplyPricing()}
                      loading={applyingPricing}
                      disabled={applyingPricing || saving || transitioning}
                      title={t('card.priceAutoTitle')}
                    >
                      <Zap size={13} className="mr-1" />
                      {t('card.priceAuto')}
                    </Button>
                  </>
                )}
              {isEditMode &&
                !viewOnly &&
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
                      {t('common:cancel')}
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
                          const max = (parseFloat(String(l.quantity)) || 0) - (l.receivedQty ?? 0);
                          if (max > 0) all[field.id] = String(max);
                        });
                        setReceiveQtys(all);
                      }}
                    >
                      {t('card.receiveAll')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleReceive()}
                      loading={receiving}
                      disabled={receiving}
                    >
                      <PackageCheck size={13} className="mr-1" />
                      {t('receive.confirmButton')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      receiveKeyRef.current = newIdempotencyKey();
                      setReceiveMode(true);
                    }}
                    disabled={saving || transitioning}
                  >
                    <PackageCheck size={13} className="mr-1" />
                    {t('card.receive')}
                  </Button>
                ))}
              {canEdit && isEditMode && activePOId && !receiveMode && (
                <XlsxImportButton
                  templateType="po-lines"
                  importUrl={`/xlsx/import/purchase-order-lines/${activePOId}`}
                  onImportComplete={() => handleLinesImported(activePOId)}
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
                  {t('card.excelUpload')}
                </button>
              )}
            </DocLinesHeader>
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
                      {t('card.colGood')}
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colQty')}
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colUnit')}
                    </th>
                    {isEditMode && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        {t('card.colReceived')}
                      </th>
                    )}
                    {receiveMode && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary whitespace-nowrap">
                        {t('card.colToReceive')}
                      </th>
                    )}
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colPrice', { currency: currencySymbol })}
                    </th>
                    {vatMode !== 'NONE' && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        {t('card.colVat', { currency: currencySymbol })}
                      </th>
                    )}
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      {t('card.colSum', { currency: currencySymbol })}
                    </th>
                    {canPrice && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary whitespace-nowrap">
                        {t('card.colPricedPrice', { currency: currencySymbol })}
                      </th>
                    )}
                    {canPrice && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        {t('card.colPricingRule')}
                      </th>
                    )}
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {/* Незавантажений документ (notLoaded) підказки не має: рядків ми ще не знаємо. */}
                  {fields.length === 0 && !showLineInput && !notLoaded && (
                    <DocLinesEmptyRow
                      colSpan={
                        6 + (isEditMode ? 1 : 0) + (vatMode !== 'NONE' ? 1 : 0) + (canPrice ? 2 : 0)
                      }
                      canEdit={canEdit}
                    />
                  )}
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
                            placeholder={t('card.goodSearch')}
                            ariaLabel={t('card.colGood')}
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
                              ? fmtMoney(
                                  (lineSubtotal(editingLine.quantity, editingLine.price) *
                                    vatRate) /
                                    100,
                                )
                              : '—'}
                          </td>
                        )}
                        <td className="px-2 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                          {fmtMoney(lineSubtotal(editingLine.quantity, editingLine.price))}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-row gap-2 items-center">
                            <button
                              type="button"
                              onClick={commitEdit}
                              disabled={!editingLine.goodId}
                              title={t('common:save')}
                              className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              title={t('common:cancel')}
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
                                  placeholder={t('receive.maxPlaceholder', { max: maxQty })}
                                  className="w-24 rounded border border-primary/50 bg-primary/5 px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              ) : (
                                <span className="text-[11px] text-success px-2">
                                  {t('card.fullyReceived')}
                                </span>
                              );
                            })()}
                          </td>
                        )}
                        <td className="px-3 py-2 tabular-nums">
                          {fmtMoney(parseFloat(String(line.price)) || 0)}
                        </td>
                        {vatMode !== 'NONE' && (
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {vatRate > 0
                              ? fmtMoney((lineSubtotal(line.quantity, line.price) * vatRate) / 100)
                              : '—'}
                          </td>
                        )}
                        <td className="px-3 py-2 tabular-nums">
                          {fmtMoney(lineSubtotal(line.quantity, line.price))}
                        </td>
                        {canPrice && (
                          <td
                            className="px-3 py-2 text-[12px] tabular-nums cursor-text hover:bg-primary/5 transition-colors"
                            title={t('card.clickToEdit')}
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
                              disabled={viewOnly}
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
                                if (e.key === 'Enter') e.currentTarget.blur();
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
                                aria-label={t('card.editLineAria')}
                                title={t('common:edit')}
                                className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeLine(index)}
                                aria-label={t('card.deleteLineAria')}
                                title={t('common:delete')}
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
                          placeholder={t('card.goodSearch')}
                          ariaLabel={t('card.colGood')}
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
                              unit: g.unit ?? DEFAULT_GOOD_UNIT,
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
                            ? fmtMoney(
                                (lineSubtotal(newLine.quantity, newLine.price) * vatRate) / 100,
                              )
                            : '—'}
                        </td>
                      )}
                      <td className="px-2 py-1.5 tabular-nums text-muted-foreground text-[11px]">
                        {fmtMoney(lineSubtotal(newLine.quantity, newLine.price))}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-row gap-2 items-center">
                          <button
                            type="button"
                            onClick={addLine}
                            disabled={!newLine.goodId}
                            title={t('card.saveRow')}
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
                <tfoot>
                  <tr className="bg-secondary/50 border-t border-border">
                    <td
                      colSpan={3 + (isEditMode ? 1 : 0) + (receiveMode ? 1 : 0)}
                      className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                    >
                      {t('card.total')}
                    </td>
                    {/* Ціна — порожня */}
                    <td />
                    {vatMode !== 'NONE' && (
                      <td className="px-3 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                        {fmtMoney(vatTotal)}
                      </td>
                    )}
                    <td className="px-3 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                      {fmtMoney(total)}
                    </td>
                    {canPrice && <td className="px-3 py-1.5" />}
                    {canPrice && <td className="px-3 py-1.5" />}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </DocumentCardBody>
      </Modal>

      {/* Supplier picker */}
      <SearchPickerModal<SupplierItem>
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        title={t('card.pickSupplier')}
        selectedId={supplierIdValue}
        fetchItems={fetchSupplierItems}
        searchPlaceholder={t('card.supplierPickerSearch')}
        emptyText={t('card.suppliersNotFound')}
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
        goodCatTree={goodRefData.goodCatTree}
      />

      {/* Good picker for new line */}
      <SearchPickerModal<GoodItem>
        open={goodSearchOpen}
        onClose={() => setGoodSearchOpen(false)}
        title={t('common:goodPicker.title')}
        fetchItems={fetchGoodItems}
        searchPlaceholder={t('card.goodPickerSearch')}
        emptyText={t('card.goodsNotFound')}
        scanSubmit={(items, typed) => pickScannedGood(items, typed)}
        onSelect={item => {
          setNewLine(l => ({
            ...l,
            goodId: item.id,
            goodName: item.primary,
            goodSku: item.sku ?? null,
            goodInternalCode: item.internalCode ?? null,
            goodBrandName: item.brandName ?? null,
            unit: item.unit ?? DEFAULT_GOOD_UNIT,
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
          onImportComplete={() => handleLinesImported(activePOId)}
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
      <ConfirmDialog {...sentOrderDialogProps} />
    </>
  );
}
