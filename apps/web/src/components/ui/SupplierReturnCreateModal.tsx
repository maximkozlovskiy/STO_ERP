'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName, cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import { SUPPLIER_RETURN_STATUS_LABELS } from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { CollapsibleHeader } from '@/components/ui/collapsible-header';
import type { SupplierReturn, SupplierReturnLine } from '@/hooks/api/useSupplierReturns';

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
}

interface LocalLine {
  _key: string;
  id?: string;
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

const EMPTY_LINE: Omit<LocalLine, '_key'> = {
  goodId: '',
  goodName: '',
  goodSku: null,
  unit: '',
  unitShortName: null,
  unitOfMeasureId: null,
  quantity: '1',
  price: '',
};

let lineKeyCounter = 0;
function newKey() {
  return `sr_line_${++lineKeyCounter}`;
}

function lineFromApi(l: SupplierReturnLine): LocalLine {
  return {
    _key: newKey(),
    id: l.id,
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
  const features = useUiFeatures();
  const isEdit = !!editId;

  // ── Document state ─────────────────────────────────────────────────────────
  const [status, setStatus] = useState('DRAFT');
  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [documentDate, setDocumentDate] = useState(() => kyivToday());
  const [lines, setLines] = useState<LocalLine[]>([]);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState('');
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [showLineInput, setShowLineInput] = useState(false);
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);

  // ── Reference data ─────────────────────────────────────────────────────────
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [goodPickerOpen, setGoodPickerOpen] = useState(false);
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
  // edit-fetch робить flicker (auto-select встановлює перший склад, потім edit-data
  // перезаписує правильним warehouseId з API).
  useEffect(() => {
    if (warehouses.length === 1 && !warehouseId && !editId) {
      setWarehouseId(warehouses[0].id);
    }
  }, [warehouses, warehouseId, editId]);

  // ── Load existing return ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || !editId) return;
    apiFetch<SupplierReturn>(`/supplier-returns/${editId}`)
      .then(data => {
        if (!mountedRef.current) return;
        setStatus(data.status);
        setSupplierId(data.supplierId);
        setSupplierName(data.supplierName ?? '');
        setWarehouseId(data.warehouseId);
        setNotes(data.notes ?? '');
        setDocumentDate(data.documentDate ?? kyivToday());
        setLines((data.lines ?? []).map(lineFromApi));
      })
      .catch(() => {});
  }, [open, editId]);

  // ── Reset ──────────────────────────────────────────────────────────────────
  const resetForm = useCallback(() => {
    setStatus('DRAFT');
    setSupplierId('');
    setSupplierName('');
    setWarehouseId('');
    setNotes('');
    setDocumentDate(kyivToday());
    setLines([]);
    setError('');
    setHeaderCollapsed(false);
    setShowLineInput(false);
    setNewLine(EMPTY_LINE);
  }, []);

  useEffect(() => {
    if (!open) resetForm();
  }, [open, resetForm]);

  // ── Status transitions ─────────────────────────────────────────────────────
  // Backend FSM is linear-forward: DRAFT → CONFIRMED or DRAFT → CANCELLED; both terminal.
  // No back-transition exists, so prev-step is always disabled — chevron stays for visual symmetry with PO modal.
  const allowedTransitions = STATUS_TRANSITIONS[status] ?? [];
  const statusPrevStep: string | null = null;
  const statusNextStep =
    allowedTransitions.find(s => s !== 'CANCELLED') ?? allowedTransitions[0] ?? null;

  const doTransition = useCallback(
    async (targetStatus: string) => {
      if (!editId) return;
      setTransitioning(true);
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
            targetStatus === 'CONFIRMED' ? 'Повернення підтверджено' : 'Повернення скасовано',
          );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Помилка переходу статусу';
        setError(msg);
        if (features.toastEnabled) toast.error(msg);
      } finally {
        setTransitioning(false);
      }
    },
    [editId, features.toastEnabled, onSaved],
  );

  // ── Lines ──────────────────────────────────────────────────────────────────
  const addLine = useCallback(() => {
    // дублюємо guard з кнопки «+» на випадок keyboard-shortcut / programmatic виклику.
    if (!newLine.goodId) return;
    if ((parseFloat(newLine.quantity) || 0) <= 0) return;
    setLines(prev => {
      if (prev.find(l => l.goodId === newLine.goodId)) return prev;
      return [...prev, { ...newLine, _key: newKey() }];
    });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  }, [newLine]);

  const handleLineChange = useCallback(
    (key: string, field: 'quantity' | 'price', value: string) => {
      setLines(prev => prev.map(l => (l._key === key ? { ...l, [field]: value } : l)));
    },
    [],
  );

  const removeLine = useCallback((key: string) => {
    setLines(prev => prev.filter(l => l._key !== key));
  }, []);

  // ── Warehouse map ──────────────────────────────────────────────────────────
  const warehouseById = useMemo(() => {
    const m = new Map<string, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  const handleWarehouseChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setWarehouseId(e.target.value);
  }, []);

  // ── Totals ─────────────────────────────────────────────────────────────────
  const lineSubtotal = (qty: string, price: string) =>
    (parseFloat(qty) || 0) * (parseFloat(price) || 0);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + lineSubtotal(l.quantity, l.price), 0),
    [lines],
  );

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!supplierId) {
      setError('Оберіть постачальника');
      return;
    }
    if (!warehouseId) {
      setError('Оберіть склад');
      return;
    }
    if (lines.length === 0) {
      setError('Додайте хоча б один товар');
      return;
    }
    for (const l of lines) {
      if ((parseFloat(l.quantity) || 0) <= 0) {
        setError(`Кількість має бути > 0 (${l.goodName})`);
        return;
      }
    }
    setError('');
    setSaving(true);
    try {
      const payload = {
        supplierId,
        warehouseId,
        notes: notes || undefined,
        documentDate,
        lines: lines.map(l => ({
          goodId: l.goodId,
          quantity: parseFloat(l.quantity) || 0,
          price: parseFloat(l.price) || 0,
          // передаємо unitOfMeasureId, інакше backend.update() пересоздає рядки
          // з NULL UoM (soft-delete + createMany з l.unitOfMeasureId ?? null).
          ...(l.unitOfMeasureId ? { unitOfMeasureId: l.unitOfMeasureId } : {}),
        })),
      };
      if (isEdit) {
        await apiFetch(`/supplier-returns/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        if (features.toastEnabled) toast.success('Повернення оновлено');
      } else {
        await apiFetch('/supplier-returns', { method: 'POST', body: JSON.stringify(payload) });
        if (features.toastEnabled) toast.success('Повернення створено');
      }
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [
    supplierId,
    warehouseId,
    notes,
    documentDate,
    lines,
    isEdit,
    editId,
    features.toastEnabled,
    onSaved,
    onClose,
  ]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const isReadOnly = status !== 'DRAFT';
  const canEdit = !isReadOnly;

  const title = isEdit
    ? isReadOnly
      ? 'Повернення постачальнику'
      : 'Редагування повернення'
    : 'Нове повернення постачальнику';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            {/* Date */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">Дата документа:</span>
              <div className="w-36">
                <DatePickerInput
                  value={documentDate}
                  onChange={setDocumentDate}
                  disabled={!canEdit}
                />
              </div>
            </div>

            {/* Status navigation — mirrors PO modal */}
            {isEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[13px] font-medium text-muted-foreground">Статус:</span>
                <button
                  type="button"
                  disabled={transitioning || !statusPrevStep}
                  onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-20 truncate">
                    {statusPrevStep
                      ? (SUPPLIER_RETURN_STATUS_LABELS[statusPrevStep] ?? statusPrevStep)
                      : '—'}
                  </span>
                </button>
                <span
                  className={cn(
                    'text-sm font-medium px-2.5 py-1 rounded-full',
                    STATUS_COLORS[status] ?? 'bg-secondary text-muted-foreground',
                  )}
                >
                  {SUPPLIER_RETURN_STATUS_LABELS[status] ?? status}
                </span>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep
                      ? (SUPPLIER_RETURN_STATUS_LABELS[statusNextStep] ?? statusNextStep)
                      : '—'}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            )}
          </div>
        }
        extraHeaderActions={
          <button
            onClick={onClose}
            className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
            title="Закрити"
            disabled={saving || transitioning}
          >
            <X className="h-4 w-4" />
          </button>
        }
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              {isEdit && status === 'DRAFT' && (
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
            <div className="flex gap-2 items-center">
              {isEdit && status === 'DRAFT' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void doTransition('CONFIRMED')}
                  loading={transitioning}
                  disabled={transitioning || saving || lines.length === 0}
                >
                  Підтвердити
                </Button>
              )}
              {canEdit && (
                <Button
                  onClick={handleSave}
                  loading={saving}
                  disabled={saving || transitioning || !supplierId || !warehouseId}
                  size="sm"
                >
                  {isEdit ? 'Зберегти зміни' : 'Створити повернення'}
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
          {/* ── Collapsible header ──────────────────────────────────────────── */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
            style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden">
              <div className="space-y-4 pb-1">
                {error && (
                  <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                {/* Постачальник | Склад */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-medium text-foreground mb-1">
                      Постачальник <span className="text-destructive">*</span>
                    </label>
                    <EntityPickerField
                      display={supplierName}
                      placeholder="Пошук постачальника…"
                      className="h-8 text-[13px]"
                      disabled={!canEdit}
                      onPick={() => setSupplierPickerOpen(true)}
                      onClear={() => {
                        setSupplierId('');
                        setSupplierName('');
                      }}
                    />
                  </div>
                  <Select
                    label="Склад"
                    required
                    value={warehouseId}
                    onChange={handleWarehouseChange}
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

                {/* Опис */}
                <Input
                  label="Опис"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  disabled={!canEdit}
                  placeholder="Додаткова інформація…"
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
          </div>

          {/* ── Header toggle strip ─────────────────────────────────────────── */}
          <CollapsibleHeader
            collapsed={headerCollapsed}
            onToggle={() => setHeaderCollapsed(c => !c)}
            chips={[
              { label: supplierName || '— постачальник —', primary: true, maxWidth: 'max-w-50' },
              {
                label: warehouseId
                  ? (warehouseById.get(warehouseId)?.name ?? '— склад —')
                  : '— склад —',
                maxWidth: 'max-w-40',
              },
            ]}
          />

          {/* ── Lines table ─────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground">Товари</p>
              <div className="flex items-center gap-2">
                {canEdit && !showLineInput && (
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
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
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
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      Ціна, ₴
                    </th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                      Сума, ₴
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.length === 0 && !showLineInput && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-3 py-8 text-center text-[12px] text-muted-foreground"
                      >
                        {isReadOnly ? 'Рядки відсутні' : 'Натисніть «Додати» для початку'}
                      </td>
                    </tr>
                  )}

                  {lines.map(line => {
                    const sub = lineSubtotal(line.quantity, line.price);
                    return (
                      <tr key={line._key} className="hover:bg-surface-hover/50">
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-[12px]">{line.goodName}</div>
                          {line.goodSku && (
                            <div className="text-[11px] text-muted-foreground">{line.goodSku}</div>
                          )}
                        </td>
                        <td className="px-1 py-1.5">
                          {isReadOnly ? (
                            <span className="tabular-nums px-2">{line.quantity}</span>
                          ) : (
                            <input
                              type="number"
                              min="0.001"
                              step="0.001"
                              value={line.quantity}
                              onChange={e =>
                                handleLineChange(line._key, 'quantity', e.target.value)
                              }
                              className={numericInputCls}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                          {/* Bug #548: показуємо UoM short name з API замість сирого Good.unit */}
                          {line.unitShortName || line.unit}
                        </td>
                        <td className="px-1 py-1.5">
                          {isReadOnly ? (
                            <span className="tabular-nums px-2">
                              {parseFloat(line.price).toFixed(2)}
                            </span>
                          ) : (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={line.price}
                              onChange={e => handleLineChange(line._key, 'price', e.target.value)}
                              className={numericInputCls}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 tabular-nums text-[12px] font-medium">
                          {sub.toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5">
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => removeLine(line._key)}
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
                          placeholder="Пошук товару…"
                          ariaLabel="Товар"
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
                        {lineSubtotal(newLine.quantity, newLine.price).toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={addLine}
                            // блокуємо «+» при порожній К-сть, щоб не плодити рядки,
                            // які handleSave потім reject'не з помилкою «Кількість має бути > 0».
                            disabled={!newLine.goodId || (parseFloat(newLine.quantity) || 0) <= 0}
                            title="Додати рядок"
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

                {/* ── tfoot — single row, matches PO modal standard ─────── */}
                <tfoot>
                  <tr className="bg-secondary/50 border-t border-border">
                    <td
                      colSpan={3}
                      className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                    >
                      Разом:
                    </td>
                    <td />
                    <td className="px-3 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                      {total.toFixed(2)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      </Modal>

      {/* Supplier picker */}
      <SearchPickerModal
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(item: { id: string; primary: string }) => {
          setSupplierId(item.id);
          setSupplierName(item.primary);
          setSupplierPickerOpen(false);
        }}
        title="Оберіть постачальника"
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
        title="Оберіть товар"
        fetchItems={q =>
          apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=30`).then(d =>
            d.items.map(g => ({
              id: g.id,
              primary: g.name,
              secondary: g.sku ?? undefined,
              _sku: g.sku,
              _unit: g.unit ?? '',
              _price: g.purchasePrice ?? 0,
            })),
          )
        }
      />
    </>
  );
}
