'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName, cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import { SUPPLIER_RETURN_STATUS_LABELS, SUPPLIER_RETURN_STATUS_BADGE } from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@sto/shared';
import type { SupplierReturn, SupplierReturnLine } from '@/hooks/api/useSupplierReturns';

interface SupplierPickerItem {
  id: string;
  primary: string;
}

interface GoodPickerItem {
  id: string;
  primary: string;
  secondary?: string;
  _sku?: string | null;
  _unit?: string;
  _price?: number;
}

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
  quantity: string;
  price: string;
}

const EMPTY_LINE: Omit<LocalLine, '_key'> = {
  goodId: '',
  goodName: '',
  goodSku: null,
  unit: '',
  quantity: '1',
  price: '',
};

let lineKeyCounter = 0;
function newKey() {
  return `line_${++lineKeyCounter}`;
}

function lineFromApi(l: SupplierReturnLine): LocalLine {
  return {
    _key: newKey(),
    id: l.id,
    goodId: l.goodId,
    goodName: l.goodName ?? '',
    goodSku: l.goodSku ?? null,
    unit: l.unit ?? '',
    quantity: String(l.quantity),
    price: String(l.price),
  };
}

function lineSubtotal(quantity: string, price: string) {
  return (parseFloat(quantity) || 0) * (parseFloat(price) || 0);
}

const numericInputCls =
  'w-full rounded border border-input bg-background px-2 py-1 text-[11px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editId?: string | null;
}

export function SupplierReturnCreateModal({ open, onClose, onSaved, editId }: Props) {
  const features = useUiFeatures();
  const isEdit = !!editId;

  const [status, setStatus] = useState('DRAFT');
  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [documentDate, setDocumentDate] = useState(() => kyivToday());
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  const [showLineInput, setShowLineInput] = useState(false);
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);

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

  // Collapse header when adding a line
  useEffect(() => {
    if (showLineInput) setHeaderCollapsed(true);
  }, [showLineInput]);

  // Load warehouses
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

  // Auto-select single warehouse
  useEffect(() => {
    if (warehouses.length === 1 && !warehouseId) {
      setWarehouseId(warehouses[0].id);
    }
  }, [warehouses, warehouseId]);

  // Load existing return when editing
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

  const addLine = useCallback(() => {
    if (!newLine.goodId) return;
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

  const handleRemoveLine = useCallback((key: string) => {
    setLines(prev => prev.filter(l => l._key !== key));
  }, []);

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
      if ((parseFloat(l.price) || 0) < 0) {
        setError(`Ціна не може бути від'ємною (${l.goodName})`);
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
        })),
      };
      if (isEdit) {
        await apiFetch(`/supplier-returns/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/supplier-returns', { method: 'POST', body: JSON.stringify(payload) });
      }
      if (features.toastEnabled)
        toast.success(isEdit ? 'Повернення оновлено' : 'Повернення створено');
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

  const handleConfirm = useCallback(async () => {
    if (!editId) return;
    setConfirming(true);
    try {
      await apiFetch(`/supplier-returns/${editId}/confirm`, { method: 'POST' });
      if (features.toastEnabled) toast.success('Повернення підтверджено');
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка підтвердження';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setConfirming(false);
    }
  }, [editId, features.toastEnabled, onSaved, onClose]);

  const handleCancel = useCallback(async () => {
    if (!editId) return;
    setCancelling(true);
    try {
      await apiFetch(`/supplier-returns/${editId}/cancel`, { method: 'POST' });
      if (features.toastEnabled) toast.success('Повернення скасовано');
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка скасування';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setCancelling(false);
    }
  }, [editId, features.toastEnabled, onSaved, onClose]);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + lineSubtotal(l.quantity, l.price), 0),
    [lines],
  );

  const warehouseById = useMemo(() => {
    const m = new Map<string, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  const handleWarehouseChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setWarehouseId(e.target.value);
  }, []);

  const isReadOnly = status !== 'DRAFT';
  const canEdit = !isReadOnly;

  const title = isEdit
    ? isReadOnly
      ? 'Повернення постачальнику'
      : 'Редагування повернення'
    : 'Нове повернення постачальнику';

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        size="content"
        footer={
          <div className="flex items-center justify-between gap-2 w-full">
            <div className="flex gap-2">
              {isEdit && status === 'DRAFT' && (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleCancel}
                    loading={cancelling}
                    disabled={saving || confirming}
                  >
                    Скасувати
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleConfirm}
                    loading={confirming}
                    disabled={saving || cancelling || lines.length === 0}
                  >
                    Підтвердити
                  </Button>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                {isReadOnly ? 'Закрити' : 'Скасувати'}
              </Button>
              {canEdit && (
                <Button size="sm" onClick={handleSave} loading={saving} disabled={confirming}>
                  {isEdit ? 'Зберегти' : 'Створити повернення'}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col min-h-[60dvh]">
          {/* ── Collapsible header ───────────────────────────────────────── */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
            style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden">
              <div className="space-y-3 pb-1">
                {isEdit && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Статус:</span>
                    <Badge variant={SUPPLIER_RETURN_STATUS_BADGE[status] as BadgeVariant}>
                      {SUPPLIER_RETURN_STATUS_LABELS[status] ?? status}
                    </Badge>
                  </div>
                )}

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

                {/* Дата | Примітки */}
                <div className="grid grid-cols-2 gap-4">
                  <DatePickerInput
                    label="Дата документа"
                    value={documentDate}
                    onChange={setDocumentDate}
                    disabled={!canEdit}
                  />
                  <Input
                    label="Примітки"
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Необов'язково"
                    disabled={!canEdit}
                    className="h-8 text-[13px]"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ── Header toggle strip ──────────────────────────────────────── */}
          <div
            className={cn(
              'flex items-center gap-2 py-1.5 border-b border-border text-[12px] text-muted-foreground cursor-pointer select-none shrink-0',
              'hover:text-foreground transition-colors',
            )}
            onClick={() => setHeaderCollapsed(c => !c)}
          >
            <span className="font-medium text-foreground/60 text-[11px] uppercase tracking-wide">
              Шапка документа
            </span>
            {headerCollapsed && (
              <>
                {supplierName && (
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground text-[11px] max-w-40 truncate">
                    {supplierName}
                  </span>
                )}
                {warehouseId && (
                  <span className="px-2 py-0.5 rounded-full bg-secondary text-foreground text-[11px] max-w-32 truncate">
                    {warehouseById.get(warehouseId)?.name ?? ''}
                  </span>
                )}
              </>
            )}
            <span className="ml-auto text-[11px]">
              {headerCollapsed ? 'Розгорнути ↓' : 'Згорнути ↑'}
            </span>
          </div>

          {/* ── Товари ──────────────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-medium text-foreground">Товари</span>
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

            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full table-fixed text-[12px]">
                <colgroup>
                  <col />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-14" />
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
                    const subtotal = lineSubtotal(line.quantity, line.price);
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
                          {line.unit}
                        </td>
                        <td className="px-1 py-1.5">
                          {isReadOnly ? (
                            <span className="tabular-nums px-2">
                              {parseFloat(line.price).toLocaleString('uk-UA', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
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
                          {subtotal.toLocaleString('uk-UA', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="px-2 py-1.5">
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => handleRemoveLine(line._key)}
                              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Inline add row */}
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
                        {newLine.unit}
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
                            disabled={!newLine.goodId}
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
      <SearchPickerModal<SupplierPickerItem>
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={item => {
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
      <SearchPickerModal<GoodPickerItem>
        open={goodPickerOpen}
        onClose={() => setGoodPickerOpen(false)}
        onSelect={item => {
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
