'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
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
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName, cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import { PO_STATUS_LABELS, PO_STATUS_TRANSITIONS, PO_STATUS_ACTION_LABELS } from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  phone?: string | null;
}

interface Good {
  id: string;
  name: string;
  internalCode?: string | null;
  sku: string | null;
  brandName?: string | null;
  unit: string | null;
  purchasePrice: number | null;
}

interface PODetail {
  id: string;
  number: string;
  status: string;
  supplierId: string;
  supplierName?: string | null;
  warehouseId: string;
  warehouseName?: string | null;
  contractId?: string | null;
  contractNumber?: string | null;
  notes?: string | null;
  documentDate?: string | null;
  createdAt?: string | Date | null;
  lines?: POLine[];
}

interface LocalLine {
  _key: string;
  id?: string;
  goodId: string;
  goodName: string;
  goodSku?: string | null;
  goodInternalCode?: string | null;
  goodBrandName?: string | null;
  unit: string;
  // Bug #498: backend повертає unitShortName з UoM relation (purchase-orders.service.ts:771).
  // Parent page.tsx рендерить line.unitShortName ?? line.unit; цей modal раніше показував
  // тільки сирий unit (drift display).
  unitShortName?: string | null;
  quantity: string;
  price: string;
  receivedQty?: number;
  pricedSalePrice?: number | null;
  pricingRuleName?: string | null;
}

interface POLine {
  id: string;
  goodId: string;
  goodName?: string | null;
  goodSku?: string | null;
  goodInternalCode?: string | null;
  goodBrandName?: string | null;
  unit?: string | null;
  unitShortName?: string | null;
  quantity: number;
  price: number;
  receivedQty?: number;
  pricedSalePrice?: number | null;
  pricingRuleName?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  ORDERED: 'bg-primary-subtle text-primary',
  PARTIAL: 'bg-warning-subtle text-warning',
  RECEIVED: 'bg-success-subtle text-success',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};

const STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — замовлення підготовлено, ще не відправлено постачальнику',
  ORDERED: 'Замовлено — замовлення відправлено, очікується постачання',
  PARTIAL: 'Частково отримано — частина товарів вже надійшла',
  RECEIVED: 'Отримано — всі товари оприбутковано',
  CANCELLED: 'Скасовано — замовлення скасовано',
};

const PO_STATUS_ORDER = Object.keys(PO_STATUS_LABELS);
const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

const nextKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}`;

const EMPTY_LINE: Omit<LocalLine, '_key'> = {
  goodId: '',
  goodName: '',
  unit: 'шт',
  quantity: '1',
  price: '',
};

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
  const [activePOId, setActivePOId] = useState<string | undefined>(purchaseOrderIdProp);
  const purchaseOrderId = activePOId;
  const isEditMode = !!activePOId;
  const features = useUiFeatures();
  const { minimizeModal } = useTabBarContext();

  const [form, setForm] = useState({
    supplierId: '',
    warehouseId: '',
    notes: '',
    documentDate: kyivToday(),
  });
  const [supplierDisplay, setSupplierDisplay] = useState('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const canPrice = isEditMode && (currentStatus === 'RECEIVED' || currentStatus === 'PARTIAL');
  const [poNumber, setPoNumber] = useState('');
  const [contractId, setContractId] = useState<string | null>(null);
  const [contractNumber, setContractNumber] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [lines, setLines] = useState<LocalLine[]>([]);
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
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState(false);
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [rulePricerOpen, setRulePricerOpen] = useState(false);
  const [pricingRules, setPricingRules] = useState<
    Array<{ id: string; name: string; description: string | null }>
  >([]);
  const [pricingRulesLoading, setPricingRulesLoading] = useState(false);
  const [ruleFilterBySupplier, setRuleFilterBySupplier] = useState(true);
  const [error, setError] = useState('');
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

  // Auto-select single warehouse (runs both on cache hit and after fetch resolves)
  useEffect(() => {
    if (warehouses.length === 1) {
      setForm(f => (f.warehouseId ? f : { ...f, warehouseId: warehouses[0].id }));
    }
  }, [warehouses]);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setActivePOId(purchaseOrderIdProp);
    setError('');
    setStatusMenuOpen(false);
    setHeaderCollapsed(false);
    setPoNumber('');
    setCurrentStatus('DRAFT');
    setLines([]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    setContractId(null);
    setContractNumber(null);
    setCreatedAt(null);
    setReceiveMode(false);
    setReceiveQtys({});
    if (!isEditMode) {
      setForm({ supplierId: '', warehouseId: '', notes: '', documentDate: kyivToday() });
      setSupplierDisplay('');
    }
  }, [open, purchaseOrderIdProp, isEditMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
          setForm({
            supplierId: po.supplierId ?? '',
            warehouseId: po.warehouseId ?? '',
            notes: po.notes ?? '',
            documentDate: po.documentDate ? po.documentDate.slice(0, 10) : kyivToday(),
          });
          setSupplierDisplay(po.supplierName ?? '');
          setContractId(po.contractId ?? null);
          setContractNumber(po.contractNumber ?? null);
          setCreatedAt(po.createdAt ? new Date(po.createdAt).toLocaleDateString('uk-UA') : null);
          setLines(
            (po.lines ?? []).map(l => ({
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
              pricedSalePrice: l.pricedSalePrice ?? null,
              pricingRuleName: l.pricingRuleName ?? null,
            })),
          );
        })
        .catch(e => {
          if (!silent) setError(e instanceof Error ? e.message : 'Помилка завантаження замовлення');
        })
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!open || !isEditMode || !purchaseOrderId) return;
    let cancelled = false;
    loadPo(purchaseOrderId).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
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
    if (!form.supplierId) return;
    try {
      const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${form.supplierId}`);
      setSupplierDetailData(cp);
      setSupplierDetailOpen(true);
    } catch {
      /* ignore */
    }
  }, [form.supplierId]);

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
    } catch {
      /* ignore */
    }
  }, []);

  // ── Good picker ───────────────────────────────────────────────────────────

  type GoodItem = SearchPickerItem & {
    unit?: string | null;
    purchasePrice?: number | null;
    sku?: string | null;
    internalCode?: string | null;
    brandName?: string | null;
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
    }));
  }, []);

  const handleGoodSelect = useCallback((item: GoodItem) => {
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
      lines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const price = parseFloat(l.price) || 0;
        return sum + qty * price;
      }, 0),
    [lines],
  );

  const vatTotal = useMemo(() => {
    if (vatMode === 'NONE' || vatRate === 0) return 0;
    if (vatMode === 'EXCLUSIVE') return (total * vatRate) / 100;
    return total - total / (1 + vatRate / 100);
  }, [total, vatMode, vatRate]);

  const lineSubtotal = (qty: string, price: string) =>
    (parseFloat(qty) || 0) * (parseFloat(price) || 0);

  const numericInputCls =
    'w-full rounded border border-input bg-background px-1.5 py-1 text-[12px] tabular-nums focus:outline-none focus:ring-1 focus:ring-ring';

  const removeLine = (key: string) => setLines(prev => prev.filter(l => l._key !== key));

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);

  const startEdit = (line: LocalLine) => {
    setEditingKey(line._key);
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
    });
  };

  const commitEdit = () => {
    if (!editingKey) return;
    setLines(prev =>
      prev.map(l => (l._key === editingKey ? { ...editingLine, _key: editingKey } : l)),
    );
    setEditingKey(null);
  };

  const cancelEdit = () => setEditingKey(null);

  const addLine = () => {
    if (!newLine.goodId) return;
    setLines(prev => [...prev, { ...newLine, _key: nextKey() }]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' : true;

  const handleCreate = async () => {
    if (!form.supplierId || !form.warehouseId) {
      setError('Оберіть постачальника та склад');
      return;
    }
    setSavingBoth(true);
    setError('');
    try {
      // Bug #460: backend CreatePurchaseOrderDto приймає `lines` у body та створює всі рядки
      // у $transaction (атомарно, з recalc totalAmount). Endpoint POST /purchase-orders/:id/lines
      // НЕ існує — попередній цикл `for ... POST /lines` повертав 404 на кожен виклик і залишав
      // PO як orphan-draft без позицій.
      const allLines = newLine.goodId ? [...lines, { ...newLine, _key: nextKey() }] : lines;
      const linesPayload = allLines.map(l => ({
        goodId: l.goodId,
        quantity: parseFloat(l.quantity) || 1,
        price: parseFloat(l.price) || 0,
      }));

      const po = await apiFetch<{ id: string; number: string }>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: form.supplierId,
          warehouseId: form.warehouseId,
          notes: form.notes || undefined,
          documentDate: form.documentDate || undefined,
          lines: linesPayload.length > 0 ? linesPayload : undefined,
        }),
      });

      if (features.toastEnabled) toast.success(`Замовлення ${po.number} створено`);
      onSaved?.();
      // Не закриваємо — переходимо в edit mode щоб можна було одразу додавати товари
      setActivePOId(po.id);
      await loadPo(po.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення замовлення');
    } finally {
      setSavingBoth(false);
    }
  };

  const handleSave = async () => {
    if (!purchaseOrderId) return;
    if (!form.supplierId || !form.warehouseId) {
      setError('Оберіть постачальника та склад');
      return;
    }
    setSavingBoth(true);
    setError('');
    try {
      const allLines = lines.map(l => ({
        goodId: l.goodId,
        quantity: parseFloat(l.quantity) || 1,
        price: parseFloat(l.price) || 0,
        ...(l.pricedSalePrice != null ? { pricedSalePrice: l.pricedSalePrice } : {}),
      }));
      await apiFetch(`/purchase-orders/${purchaseOrderId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          supplierId: form.supplierId || undefined,
          warehouseId: form.warehouseId || undefined,
          // null → backend clears contractId; UUID → set; undefined → keep current.
          // We always send the explicit value because supplier picker resets contract
          // state to null and backend must persist that clear.
          contractId: contractId ?? null,
          notes: form.notes || undefined,
          documentDate: form.documentDate || undefined,
          lines: allLines,
        }),
      });

      if (features.toastEnabled) toast.success('Замовлення збережено');
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  };

  const handleModalClose = useCallback(() => {
    if (savingRef.current || transitioningRef.current) return;
    onClose();
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
    const receivedLines = lines
      .map(l => ({ lineId: l.id!, receivedQty: parseFloat(receiveQtys[l.id ?? ''] ?? '') }))
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
      const updated = await apiFetch<{ status: string; number: string; lines?: typeof lines }>(
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
      if (features.toastEnabled) toast.success(`Розцінено ${result.updated} товарів`);
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
      if (bySupplier && form.supplierId) params.set('supplierId', form.supplierId);
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
      if (features.toastEnabled) toast.success(`Розцінено ${result.updated} товарів`);
      if (purchaseOrderId) await loadPo(purchaseOrderId, true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка розцінки';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setApplyingPricing(false);
    }
  };

  // sto-optimize: memoize array of chips — раніше recompute + .filter() на кожен
  // typing keystroke у Input полях форми (notes тощо), навіть коли header згорнуто
  // у false.
  const headerChips = useMemo(
    () =>
      headerCollapsed
        ? [
            supplierDisplay || null,
            form.warehouseId ? (warehouseById.get(form.warehouseId)?.name ?? null) : null,
            contractNumber ? `Дог. ${contractNumber}` : null,
          ].filter(Boolean)
        : [],
    [headerCollapsed, supplierDisplay, form.warehouseId, warehouseById, contractNumber],
  );

  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
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
                  <span className="max-w-20 truncate">
                    {statusPrevStep ? (PO_STATUS_LABELS[statusPrevStep] ?? statusPrevStep) : '—'}
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
                  {PO_STATUS_LABELS[currentStatus] ?? currentStatus}
                </button>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep ? (PO_STATUS_LABELS[statusNextStep] ?? statusNextStep) : '—'}
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
                        {PO_STATUS_ACTION_LABELS[s] ?? PO_STATUS_LABELS[s] ?? s}
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
                </>
              )}
              {isEditMode ? (
                canEdit && (
                  <Button
                    onClick={handleSave}
                    loading={saving}
                    disabled={saving || transitioning}
                    size="sm"
                  >
                    Зберегти зміни
                  </Button>
                )
              ) : (
                <Button
                  onClick={handleCreate}
                  loading={saving}
                  disabled={saving || !form.supplierId || !form.warehouseId}
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
                    <label className="block text-[13px] font-medium text-foreground mb-1">
                      Постачальник <span className="text-destructive">*</span>
                    </label>
                    <EntityPickerField<SupplierItem>
                      display={supplierDisplay}
                      placeholder="Пошук постачальника…"
                      className="h-8 text-[13px]"
                      disabled={!canEdit}
                      onPick={() => setSupplierPickerOpen(true)}
                      onOpenDetail={form.supplierId ? openSupplierDetail : undefined}
                      onSearch={fetchSupplierItems}
                      onSearchSelect={item => {
                        setSupplierDisplay(item.primary);
                        setForm(f => ({ ...f, supplierId: item.id }));
                        // Clear contract when supplier changes
                        setContractId(null);
                        setContractNumber(null);
                      }}
                      onClear={() => {
                        setSupplierDisplay('');
                        setForm(f => ({ ...f, supplierId: '' }));
                        setContractId(null);
                        setContractNumber(null);
                      }}
                    />
                  </div>
                  <Select
                    label="Склад"
                    required
                    value={form.warehouseId}
                    onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))}
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
                </div>

                {/* Рядок 3: Договір */}
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="Договір"
                    value={contractNumber ?? ''}
                    disabled
                    readOnly
                    placeholder="— автоматично —"
                    className="h-8 text-[13px]"
                  />
                </div>

                {/* Рядок 4: Опис */}
                <Input
                  label="Опис"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
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
                label: form.warehouseId
                  ? (warehouseById.get(form.warehouseId)?.name ?? '— склад —')
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
                          const all: Record<string, string> = {};
                          lines.forEach(l => {
                            const max =
                              (parseFloat(String(l.quantity)) || 0) - (l.receivedQty ?? 0);
                            if (max > 0) all[l.id ?? ''] = String(max);
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
                      Ціна, ₴
                    </th>
                    {vatMode !== 'NONE' && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                        ПДВ, ₴
                      </th>
                    )}
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      Сума, ₴
                    </th>
                    {canPrice && (
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary whitespace-nowrap">
                        Ціна розцінки, ₴
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
                  {lines.map(line =>
                    editingKey === line._key ? (
                      // ── Inline edit row (same layout as add-line row) ────
                      <tr key={line._key} className="bg-primary/5 border-t-2 border-primary/20">
                        <td className="px-2 py-1.5">
                          <EntityPickerField<GoodItem>
                            display={editingLine.goodName}
                            placeholder="Пошук товару…"
                            ariaLabel="Товар"
                            onSearch={fetchGoodItems}
                            onOpenDetail={
                              editingLine.goodId
                                ? () => openGoodDetail(editingLine.goodId)
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
                        key={line._key}
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
                                  value={receiveQtys[line.id ?? ''] ?? ''}
                                  onChange={e =>
                                    setReceiveQtys(q => ({ ...q, [line.id ?? '']: e.target.value }))
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
                              const input = (e.currentTarget as HTMLTableCellElement).querySelector(
                                'input',
                              );
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
                                  e.target.value === '' ? null : parseFloat(e.target.value);
                                setLines(ls =>
                                  ls.map(l =>
                                    l._key === line._key ? { ...l, pricedSalePrice: val } : l,
                                  ),
                                );
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
                                onClick={() => startEdit(line)}
                                aria-label="Редагувати позицію"
                                title="Редагувати"
                                className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeLine(line._key)}
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
                    ),
                  )}

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
                            newLine.goodId ? () => openGoodDetail(newLine.goodId) : undefined
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
        selectedId={form.supplierId}
        fetchItems={fetchSupplierItems}
        searchPlaceholder="Назва, телефон, компанія..."
        emptyText="Постачальників не знайдено"
        onSelect={item => {
          setSupplierDisplay(item.primary);
          setForm(f => ({ ...f, supplierId: item.id }));
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
        searchPlaceholder="Назва, артикул…"
        emptyText="Товарів не знайдено"
        onSelect={item => {
          setNewLine(l => ({
            ...l,
            goodId: item.id,
            goodName: item.primary,
            goodSku: (item as GoodItem).sku ?? null,
            goodInternalCode: (item as GoodItem).internalCode ?? null,
            goodBrandName: (item as GoodItem).brandName ?? null,
            unit: (item as GoodItem).unit ?? 'шт',
            price: String((item as GoodItem).purchasePrice ?? ''),
          }));
          setGoodSearchOpen(false);
        }}
      />

      {/* Пікер правила ціноутворення */}
      <Modal
        open={rulePricerOpen}
        onClose={() => setRulePricerOpen(false)}
        title="Оберіть правило розцінки"
        size="md"
      >
        <div className="flex flex-col gap-3" style={{ minHeight: '200px' }}>
          {/* Фільтр по постачальнику */}
          {form.supplierId && (
            <div className="flex items-center gap-2 text-[13px]">
              <button
                type="button"
                onClick={() => void toggleRuleSupplierFilter(true)}
                className={cn(
                  'px-3 py-1 rounded-full border text-xs font-medium transition-colors',
                  ruleFilterBySupplier
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50',
                )}
              >
                {supplierDisplay || 'Постачальник'}
              </button>
              <button
                type="button"
                onClick={() => void toggleRuleSupplierFilter(false)}
                className={cn(
                  'px-3 py-1 rounded-full border text-xs font-medium transition-colors',
                  !ruleFilterBySupplier
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50',
                )}
              >
                Всі правила
              </button>
            </div>
          )}
          {pricingRulesLoading ? (
            <div className="flex justify-center py-10">
              <Spinner size="sm" />
            </div>
          ) : pricingRules.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">
              {ruleFilterBySupplier && form.supplierId
                ? 'Немає правил для цього постачальника'
                : 'Немає активних правил ціноутворення'}
            </p>
          ) : (
            <div className="space-y-1 overflow-y-auto" style={{ maxHeight: '380px' }}>
              {pricingRules.map(rule => (
                <button
                  key={rule.id}
                  type="button"
                  onClick={() => void handleApplyPricingByRule(rule.id)}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-border bg-surface hover:border-primary hover:bg-primary/5 transition-colors"
                >
                  <div className="text-sm font-medium text-foreground">{rule.name}</div>
                  {rule.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">{rule.description}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
