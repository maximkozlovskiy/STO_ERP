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

function totalFromLines(lines: LocalLine[]) {
  return lines.reduce((sum, l) => {
    const q = parseFloat(l.quantity) || 0;
    const p = parseFloat(l.price) || 0;
    return sum + q * p;
  }, 0);
}

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
  const [warehouseName, setWarehouseName] = useState('');
  const [notes, setNotes] = useState('');
  const [documentDate, setDocumentDate] = useState(() => kyivToday());
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

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
        setWarehouseName(data.warehouseName ?? '');
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
    setWarehouseName('');
    setNotes('');
    setDocumentDate(kyivToday());
    setLines([]);
    setError('');
  }, []);

  useEffect(() => {
    if (!open) resetForm();
  }, [open, resetForm]);

  const handleAddGood = useCallback((item: GoodPickerItem) => {
    setLines(prev => {
      const exists = prev.find(l => l.goodId === item.id);
      if (exists) return prev;
      return [
        ...prev,
        {
          _key: newKey(),
          goodId: item.id,
          goodName: item.primary,
          goodSku: item._sku ?? null,
          unit: item._unit ?? '',
          quantity: '1',
          price: String(item._price ?? 0),
        },
      ];
    });
    setGoodPickerOpen(false);
  }, []);

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
    // Validate inline — `validate` and `buildPayload` use current state captured at
    // call-time через closure (callback recreated on lines/supplier/warehouse changes).
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

  // sto-optimize: total — O(N) reduce, було computed на кожен render (typing → state →
  // render → total recompute). Memoize → лише при зміні lines.
  const total = useMemo(() => totalFromLines(lines), [lines]);
  const isReadOnly = status !== 'DRAFT';

  // sto-optimize: warehouse lookup → Map (стабільна identity для onChange handler);
  // дозволяє замінити inline `warehouses.find()` на `O(1)` get.
  const warehouseById = useMemo(() => {
    const m = new Map<string, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  // sto-optimize: stable onChange — інакше recreated на кожен render навіть коли
  // warehouseById identity не змінювалась.
  const handleWarehouseChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const w = warehouseById.get(e.target.value);
      setWarehouseId(e.target.value);
      setWarehouseName(w?.name ?? '');
    },
    [warehouseById],
  );
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
        size="xl"
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
              {!isReadOnly && (
                <Button size="sm" onClick={handleSave} loading={saving} disabled={confirming}>
                  {isEdit ? 'Зберегти' : 'Створити'}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Status badge */}
          {isEdit && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Статус:</span>
              <Badge variant={SUPPLIER_RETURN_STATUS_BADGE[status] as BadgeVariant}>
                {SUPPLIER_RETURN_STATUS_LABELS[status] ?? status}
              </Badge>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Header fields */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Постачальник <span className="text-destructive">*</span>
              </label>
              <EntityPickerField
                display={supplierName}
                placeholder="Оберіть постачальника..."
                onClear={() => {
                  setSupplierId('');
                  setSupplierName('');
                }}
                onPick={() => setSupplierPickerOpen(true)}
                disabled={isReadOnly}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Склад <span className="text-destructive">*</span>
              </label>
              <select
                value={warehouseId}
                onChange={handleWarehouseChange}
                disabled={isReadOnly}
                className={cn(
                  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none',
                  'focus:ring-2 focus:ring-ring focus:ring-offset-1',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <option value="">Оберіть склад...</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Дата документа
              </label>
              <DatePickerInput
                value={documentDate}
                onChange={setDocumentDate}
                disabled={isReadOnly}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Примітки
              </label>
              <Input
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Необов'язково"
                disabled={isReadOnly}
              />
            </div>
          </div>

          {/* Lines table */}
          <div className="mt-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">Товари</span>
              {!isReadOnly && (
                <Button variant="outline" size="sm" onClick={() => setGoodPickerOpen(true)}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Додати товар
                </Button>
              )}
            </div>

            {lines.length === 0 ? (
              <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                {isReadOnly ? 'Рядки відсутні' : 'Натисніть "Додати товар" для початку'}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <colgroup>
                    <col className="w-auto" />
                    <col className="w-28" />
                    <col className="w-28" />
                    <col className="w-28" />
                    {!isReadOnly && <col className="w-10" />}
                  </colgroup>
                  <thead className="border-b border-border bg-surface-hover">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Товар
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                        Кількість
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                        Ціна, ₴
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                        Сума, ₴
                      </th>
                      {!isReadOnly && <th />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lines.map(line => {
                      const qty = parseFloat(line.quantity) || 0;
                      const price = parseFloat(line.price) || 0;
                      return (
                        <tr key={line._key} className="hover:bg-surface-hover/50">
                          <td className="px-3 py-2">
                            <div className="font-medium">{line.goodName}</div>
                            {line.goodSku && (
                              <div className="text-xs text-muted-foreground">{line.goodSku}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {isReadOnly ? (
                              <span className="tabular-nums">{qty}</span>
                            ) : (
                              <Input
                                type="number"
                                min="0.001"
                                step="0.001"
                                value={line.quantity}
                                onChange={e =>
                                  handleLineChange(line._key, 'quantity', e.target.value)
                                }
                                className="w-24 text-right tabular-nums"
                              />
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {isReadOnly ? (
                              <span className="tabular-nums">
                                {price.toLocaleString('uk-UA', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                              </span>
                            ) : (
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={line.price}
                                onChange={e => handleLineChange(line._key, 'price', e.target.value)}
                                className="w-28 text-right tabular-nums"
                              />
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">
                            {(qty * price).toLocaleString('uk-UA', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                          {!isReadOnly && (
                            <td className="px-2 py-2">
                              <button
                                type="button"
                                onClick={() => handleRemoveLine(line._key)}
                                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t border-border bg-surface-hover">
                    <tr>
                      <td
                        colSpan={3}
                        className="px-3 py-2 text-right text-sm font-medium text-muted-foreground"
                      >
                        Разом:
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {total.toLocaleString('uk-UA', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      {!isReadOnly && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
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
        onSelect={handleAddGood}
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
