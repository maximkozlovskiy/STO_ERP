'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
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
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { getCached, setCache } from '@/lib/ref-cache';
import { cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import {
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_STATUS_TRANSITIONS,
  STOCK_DOC_TYPE_LABELS,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';

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
}

interface StockDocDetail {
  id: string;
  number: string;
  status: string;
  type: string;
  branchId: string;
  warehouseId: string;
  targetWarehouseId?: string | null;
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

interface LocalLine {
  _key: string;
  id?: string;
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
  const { minimizeModal } = useTabBarContext();

  const [form, setForm] = useState({
    type: 'WRITEOFF',
    branchId: '',
    warehouseId: '',
    targetWarehouseId: '',
    notes: '',
    documentDate: kyivToday(),
  });
  const [branches, setBranches] = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [docNumber, setDocNumber] = useState('');
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [showLineInput, setShowLineInput] = useState(false);
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

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setError('');
    setStatusMenuOpen(false);
    setHeaderCollapsed(false);
    setDocNumber('');
    setCurrentStatus('DRAFT');
    setLines([]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    if (!isEditMode) {
      setForm({
        type: 'WRITEOFF',
        branchId: '',
        warehouseId: '',
        targetWarehouseId: '',
        notes: '',
        documentDate: kyivToday(),
      });
    }
  }, [open, stockDocumentId]);

  // Load document in edit mode
  useEffect(() => {
    if (!open || !isEditMode || !stockDocumentId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<StockDocDetail>(`/stock-documents/${stockDocumentId}`)
      .then(doc => {
        if (cancelled) return;
        setDocNumber(doc.number);
        setCurrentStatus(doc.status);
        setForm({
          type: doc.type ?? 'WRITEOFF',
          branchId: doc.branchId ?? '',
          warehouseId: doc.warehouseId ?? '',
          targetWarehouseId: doc.targetWarehouseId ?? '',
          notes: doc.notes ?? '',
          documentDate: doc.documentDate ? doc.documentDate.slice(0, 10) : kyivToday(),
        });
        setLines(
          (doc.lines ?? []).map(l => ({
            _key: nextKey(),
            id: l.id,
            goodId: l.goodId,
            goodName: l.goodName ?? '',
            unit: l.unit ?? 'шт',
            quantity: String(l.quantity),
            price: String(l.price ?? ''),
          })),
        );
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження документа');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, stockDocumentId]);

  // Auto-collapse header when adding lines
  useEffect(() => {
    if (showLineInput) setHeaderCollapsed(true);
  }, [showLineInput]);

  // Auto-select single branch/warehouse
  useEffect(() => {
    if (branches.length === 1) {
      setForm(f => (f.branchId ? f : { ...f, branchId: branches[0].id }));
    }
  }, [branches]);

  useEffect(() => {
    if (warehouses.length === 1) {
      setForm(f => (f.warehouseId ? f : { ...f, warehouseId: warehouses[0].id }));
    }
  }, [warehouses]);

  // ── Good picker ───────────────────────────────────────────────────────────

  type GoodItem = SearchPickerItem & { unit?: string | null };

  const fetchGoodItems = useCallback(async (q: string): Promise<GoodItem[]> => {
    const data = await apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=20`);
    return data.items.map(g => ({
      id: g.id,
      primary: g.name,
      secondary: g.sku ?? undefined,
      unit: g.unit,
    }));
  }, []);

  // ── FSM ───────────────────────────────────────────────────────────────────

  const allowedTransitions = isEditMode
    ? (STOCK_DOC_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS)
    : EMPTY_TRANSITIONS;

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
  }, [currentStatus, isEditMode]);

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
      lines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const price = parseFloat(l.price) || 0;
        return sum + qty * price;
      }, 0),
    [lines],
  );

  const removeLine = (key: string) => setLines(prev => prev.filter(l => l._key !== key));

  const addLine = () => {
    if (!newLine.goodId) return;
    setLines(prev => [...prev, { ...newLine, _key: nextKey() }]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' : true;

  const handleCreate = async () => {
    if (!form.branchId || !form.warehouseId) {
      setError('Оберіть філію та склад');
      return;
    }
    // Bug #462: для типу TRANSFER бекенд вимагає targetWarehouseId. Без цієї перевірки
    // POST йде з incomplete payload і повертає 400 — погана UX.
    if (form.type === 'TRANSFER' && !form.targetWarehouseId) {
      setError('Для переміщення оберіть склад призначення');
      return;
    }
    setSavingBoth(true);
    setError('');
    try {
      const doc = await apiFetch<StockDocResponse>('/stock-documents', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          branchId: form.branchId,
          warehouseId: form.warehouseId,
          targetWarehouseId:
            form.type === 'TRANSFER' ? form.targetWarehouseId || undefined : undefined,
          notes: form.notes || undefined,
          documentDate: form.documentDate || undefined,
          lines: (newLine.goodId ? [...lines, { ...newLine, _key: nextKey() }] : lines).map(l => ({
            goodId: l.goodId,
            quantity: parseFloat(l.quantity) || 1,
            price: parseFloat(l.price) || undefined,
          })),
        }),
      });

      if (features.toastEnabled) toast.success(`Документ ${doc.number} створено`);
      onSaved?.(doc);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення документа');
    } finally {
      setSavingBoth(false);
    }
  };

  const handleSave = async () => {
    if (!stockDocumentId) return;
    setSavingBoth(true);
    setError('');
    try {
      // Backend has no separate POST /stock-documents/:id/lines endpoint.
      // PATCH with lines replaces ALL lines (soft-deletes existing, re-creates from body).
      // We always send the full current list so no lines are lost.
      const allLines = lines.map(l => ({
        goodId: l.goodId,
        quantity: parseFloat(l.quantity) || 1,
        price: parseFloat(l.price) || undefined,
      }));
      await apiFetch(`/stock-documents/${stockDocumentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          notes: form.notes || undefined,
          documentDate: form.documentDate || undefined,
          lines: allLines,
        }),
      });

      if (features.toastEnabled) toast.success('Документ збережено');
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

  const isTransfer = form.type === 'TRANSFER';

  const warehouseLabel = isTransfer ? 'Склад-джерело' : 'Склад';

  const headerChips =
    isEditMode && headerCollapsed
      ? [
          form.type ? (STOCK_DOC_TYPE_LABELS[form.type] ?? form.type) : null,
          form.warehouseId ? (warehouses.find(w => w.id === form.warehouseId)?.name ?? null) : null,
        ].filter(Boolean)
      : [];

  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
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
                    {statusPrevStep
                      ? (STOCK_DOC_STATUS_LABELS[statusPrevStep] ?? statusPrevStep)
                      : '—'}
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
                  {isEditMode
                    ? (STOCK_DOC_STATUS_LABELS[currentStatus] ?? currentStatus)
                    : (STOCK_DOC_STATUS_LABELS['DRAFT'] ?? 'Чернетка')}
                </button>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep
                      ? (STOCK_DOC_STATUS_LABELS[statusNextStep] ?? statusNextStep)
                      : '—'}
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
                        {TRANSITION_LABELS[s] ?? STOCK_DOC_STATUS_LABELS[s] ?? s}
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
                  // Bug #462: TRANSFER potrebue targetWarehouseId — інакше backend 400.
                  disabled={
                    saving ||
                    !form.branchId ||
                    !form.warehouseId ||
                    (form.type === 'TRANSFER' && !form.targetWarehouseId)
                  }
                  size="sm"
                >
                  Створити документ
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

                {/* Рядок 2: Тип документа | Філія */}
                <div className="grid grid-cols-2 gap-4">
                  <Select
                    label="Тип документа"
                    required
                    value={form.type}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                    disabled={!canEdit || isEditMode}
                    className="h-8 text-[13px] py-0.5 px-2 pr-7"
                  >
                    {Object.entries(STOCK_DOC_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="Філія"
                    required
                    value={form.branchId}
                    onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
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
                </div>

                {/* Рядок 3: Склад | Склад призначення (тільки для TRANSFER) */}
                <div className={cn('grid gap-4', isTransfer ? 'grid-cols-2' : 'grid-cols-2')}>
                  <Select
                    label={warehouseLabel}
                    required
                    value={form.warehouseId}
                    onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))}
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
                  {isTransfer ? (
                    <Select
                      label="Склад призначення"
                      required
                      value={form.targetWarehouseId}
                      onChange={e => setForm(f => ({ ...f, targetWarehouseId: e.target.value }))}
                      disabled={!canEdit || isEditMode}
                      className="h-8 text-[13px] py-0.5 px-2 pr-7"
                    >
                      <option value="">— Оберіть —</option>
                      {warehouses
                        .filter(w => w.id !== form.warehouseId)
                        .map(w => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                    </Select>
                  ) : (
                    <div />
                  )}
                </div>

                {/* Рядок 4: Примітки */}
                <Input
                  label="Примітки"
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
                {lines.map(line => (
                  <tr key={line._key} className="hover:bg-secondary/20 group">
                    <td className="px-3 py-2">{line.goodName}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{line.unit}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.price || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {line.price
                        ? (
                            (parseFloat(line.quantity) || 0) * (parseFloat(line.price) || 0)
                          ).toFixed(2)
                        : '—'}
                    </td>
                    <td className="px-2 py-2">
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => removeLine(line._key)}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}

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
                    {total > 0 ? `${total.toFixed(2)} ₴` : '—'}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {canEdit && !showLineInput && (
              <button
                type="button"
                onClick={() => setShowLineInput(true)}
                className="flex items-center gap-1.5 mt-2 ml-3 text-[12px] text-primary hover:text-primary/80 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Додати товар
              </button>
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
        searchPlaceholder="Назва, артикул…"
        emptyText="Товарів не знайдено"
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
    </>
  );
}
