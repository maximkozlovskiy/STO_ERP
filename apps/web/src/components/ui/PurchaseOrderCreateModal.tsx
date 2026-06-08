'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { toast } from '@/lib/toast';
import { displayCounterpartyName } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import type { PurchaseOrder } from '@/hooks/api/usePurchaseOrders';
import { kyivToday } from '@/lib/format';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
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
  sku: string | null;
  unit: string;
  purchasePrice: number | null;
}

interface GoodUoM {
  id: string;
  unitOfMeasureId: string;
  unitName: string;
  unitShortName: string;
  coefficient: number;
  isDefault: boolean;
}

interface Brand {
  id: string;
  name: string;
}

interface Unit {
  id: string;
  name: string;
  shortName: string;
  isSystem: boolean;
  coefficient: number;
}

interface PoLine {
  goodId: string;
  goodName: string;
  quantity: string;
  price: string;
  unit: string;
  unitId: string;
  unitShortName: string;
  coefficient: number;
  goodUoMs: GoodUoM[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PurchaseOrderCreateModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a PO is successfully created. */
  onSaved: (po: PurchaseOrder) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PurchaseOrderCreateModal({
  open,
  onClose,
  onSaved,
}: PurchaseOrderCreateModalProps) {
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // ── Form state ─────────────────────────────────────────────────────────────
  const [form, setForm] = useState({
    supplierId: '',
    warehouseId: '',
    notes: '',
    documentDate: kyivToday(),
  });
  const [supplierDisplay, setSupplierDisplay] = useState('');
  const [lines, setLines] = useState<PoLine[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Supplier picker / detail ───────────────────────────────────────────────
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierDetailOpen, setSupplierDetailOpen] = useState(false);
  const [supplierDetailData, setSupplierDetailData] = useState<CounterpartyForModal | null>(null);

  // ── Good picker / detail (per line index) ──────────────────────────────────
  const [goodPickerLine, setGoodPickerLine] = useState<number | null>(null);
  const [goodDetailLine, setGoodDetailLine] = useState<number | null>(null);
  const [goodDetailData, setGoodDetailData] = useState<GoodForModal | null>(null);

  // Reference data for GoodEditModal — loaded lazily on first open
  const [brands, setBrands] = useState<Brand[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [allSuppliers, setAllSuppliers] = useState<Supplier[]>([]);
  const [goodCatTree, setGoodCatTree] = useState<CategoryNode[]>([]);
  const [goodRefsLoaded, setGoodRefsLoaded] = useState(false);

  const resetForm = useCallback(() => {
    setForm({
      supplierId: '',
      warehouseId: '',
      notes: '',
      documentDate: kyivToday(),
    });
    setSupplierDisplay('');
    setLines([]);
    setError('');
    dirty.resetDirty();
  }, [dirty]);

  // Load warehouses when modal opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const apply = (wList: Warehouse[]) => {
      if (cancelled) return;
      setWarehouses(wList);
      const mainW = wList.find(x => x.isMain) ?? (wList.length === 1 ? wList[0] : null);
      if (mainW) setForm(f => (f.warehouseId ? f : { ...f, warehouseId: mainW.id }));
    };

    const cached = getCached<Warehouse[]>('cache:warehouses');
    if (cached) apply(cached);

    apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(w => {
        const wList = Array.isArray(w) ? w : w.items;
        setCache('cache:warehouses', wList);
        apply(wList);
      })
      .catch((e: unknown) => {
        if (!cancelled && !cached)
          setError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset form whenever modal opens
  useEffect(() => {
    if (open) {
      setForm(f => ({ ...f, documentDate: kyivToday() }));
      setError('');
    }
  }, [open]);

  // Lazily load reference data needed by GoodEditModal
  const ensureGoodRefs = useCallback(async () => {
    if (goodRefsLoaded) return;
    try {
      const [brandsRes, unitsRes, suppliersRes, catsRes] = await Promise.all([
        apiFetch<Brand[] | { items: Brand[] }>('/brands?limit=200').catch(() => [] as Brand[]),
        apiFetch<Unit[] | { items: Unit[] }>('/units-of-measure?limit=200').catch(
          () => [] as Unit[],
        ),
        apiFetch<{ items: Supplier[] }>('/counterparties?type=SUPPLIER&limit=200').catch(() => ({
          items: [] as Supplier[],
        })),
        apiFetch<CategoryNode[]>('/good-categories/tree').catch(() => [] as CategoryNode[]),
      ]);
      setBrands(Array.isArray(brandsRes) ? brandsRes : brandsRes.items);
      setUnits(Array.isArray(unitsRes) ? unitsRes : unitsRes.items);
      setAllSuppliers(suppliersRes.items);
      setGoodCatTree(catsRes);
      setGoodRefsLoaded(true);
    } catch {
      /* non-fatal — modal can still open with empty refs */
    }
  }, [goodRefsLoaded]);

  // ── Supplier handlers ──────────────────────────────────────────────────────
  type SupplierItem = SearchPickerItem & { phone?: string | null };

  const fetchSupplierItems = useCallback(async (q: string): Promise<SupplierItem[]> => {
    const url = q.trim()
      ? `/counterparties?type=SUPPLIER&q=${encodeURIComponent(q.trim())}&limit=30`
      : `/counterparties?type=SUPPLIER&limit=30`;
    const data = await apiFetch<{ items: Supplier[] }>(url);
    return data.items.map(s => ({
      id: s.id,
      primary: displayCounterpartyName(s),
      secondary: s.phone ?? undefined,
      phone: s.phone ?? null,
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

  // ── Good handlers ──────────────────────────────────────────────────────────
  type GoodItem = SearchPickerItem & {
    unit: string;
    purchasePrice: number | null;
  };

  const fetchGoodItems = useCallback(async (q: string): Promise<GoodItem[]> => {
    const url = q.trim() ? `/goods?q=${encodeURIComponent(q.trim())}&limit=30` : `/goods?limit=30`;
    const data = await apiFetch<{ items: Good[] }>(url);
    return data.items.map(g => ({
      id: g.id,
      primary: g.name,
      secondary: g.sku ?? undefined,
      unit: g.unit,
      purchasePrice: g.purchasePrice,
    }));
  }, []);

  const applyGoodSelection = useCallback(
    async (lineIdx: number, picked: GoodItem) => {
      setLines(ls =>
        ls.map((x, idx) =>
          idx === lineIdx
            ? {
                ...x,
                goodId: picked.id,
                goodName: picked.primary,
                unit: picked.unit,
                price: picked.purchasePrice ? String(picked.purchasePrice) : x.price,
                unitId: '',
                unitShortName: '',
                coefficient: 1,
                goodUoMs: [],
              }
            : x,
        ),
      );
      dirty.markDirty();
      // Fetch UoMs for the selected good
      try {
        const uoms = await apiFetch<GoodUoM[]>(`/goods/${picked.id}/uoms`);
        setLines(ls =>
          ls.map(x => {
            if (x.goodId !== picked.id || x.goodUoMs.length > 0) return x;
            const defaultUom = uoms.find(u => u.isDefault) ?? uoms[0];
            return {
              ...x,
              goodUoMs: uoms,
              ...(defaultUom
                ? {
                    unitId: defaultUom.id,
                    unitShortName: defaultUom.unitShortName,
                    coefficient: defaultUom.coefficient || 1,
                  }
                : {}),
            };
          }),
        );
      } catch (err: unknown) {
        if (features.toastEnabled) {
          toast.error('Не вдалося завантажити одиниці виміру');
        } else {
          setError(err instanceof Error ? err.message : 'Не вдалося завантажити одиниці виміру');
        }
      }
    },
    [dirty, features.toastEnabled],
  );

  const openGoodDetail = useCallback(
    async (lineIdx: number) => {
      const line = lines[lineIdx];
      if (!line?.goodId) return;
      await ensureGoodRefs();
      try {
        const good = await apiFetch<GoodForModal>(`/goods/${line.goodId}`);
        setGoodDetailData(good);
        setGoodDetailLine(lineIdx);
      } catch {
        /* ignore */
      }
    },
    [lines, ensureGoodRefs],
  );

  const addLine = () => {
    setLines(l => [
      ...l,
      {
        goodId: '',
        goodName: '',
        quantity: '1',
        price: '',
        unit: '',
        unitId: '',
        unitShortName: '',
        coefficient: 1,
        goodUoMs: [],
      },
    ]);
    dirty.markDirty();
  };

  const removeLine = (i: number) => {
    setLines(l => l.filter((_, idx) => idx !== i));
    dirty.markDirty();
  };

  const updateLineField = (i: number, field: 'quantity' | 'price', value: string) => {
    setLines(l => l.map((x, idx) => (idx === i ? { ...x, [field]: value } : x)));
    dirty.markDirty();
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    const validLines = lines.filter(l => l.goodId);
    for (const l of validLines) {
      const qty = parseFloat(l.quantity);
      const price = parseFloat(l.price);
      if (!Number.isFinite(qty) || qty <= 0) {
        setError('Вкажіть коректну кількість для всіх позицій');
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        setError('Вкажіть коректну ціну для всіх позицій');
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      const created = await apiFetch<PurchaseOrder>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: form.supplierId,
          warehouseId: form.warehouseId,
          notes: form.notes || undefined,
          documentDate: form.documentDate || undefined,
          // Convert display → base unit before submit (Bug #231):
          // l.quantity is in the chosen UoM; coefficient = base_units_per_uom.
          lines: validLines.map(l => {
            const coeff = l.coefficient || 1;
            const displayQty = parseFloat(l.quantity);
            const displayPrice = parseFloat(l.price);
            return {
              goodId: l.goodId,
              quantity: displayQty * coeff,
              price: displayPrice / coeff,
            };
          }),
        }),
      });
      dirty.resetDirty();
      onSaved(created);
      resetForm();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    resetForm();
    onClose();
  }, [dirty, onClose, resetForm]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title="Нове замовлення постачальнику"
        size="xl"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.supplierId || !form.warehouseId}
            className="w-full"
          >
            Створити замовлення
          </Button>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Supplier */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Постачальник <span className="text-destructive-text">*</span>
            </label>
            <EntityPickerField<SupplierItem>
              display={supplierDisplay}
              placeholder="Пошук постачальника…"
              onOpenDetail={form.supplierId ? openSupplierDetail : undefined}
              onPick={() => setSupplierPickerOpen(true)}
              onSearch={fetchSupplierItems}
              onSearchSelect={item => {
                setSupplierDisplay(item.primary);
                setForm(f => ({ ...f, supplierId: item.id }));
                dirty.markDirty();
              }}
              onClear={() => {
                setSupplierDisplay('');
                setForm(f => ({ ...f, supplierId: '' }));
                dirty.markDirty();
              }}
            />
          </div>

          <Select
            label="Склад"
            required
            value={form.warehouseId}
            onChange={e => {
              setForm(f => ({ ...f, warehouseId: e.target.value }));
              dirty.markDirty();
            }}
            placeholder="Оберіть склад"
          >
            {warehouses.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>

          <Input
            label="Примітки"
            value={form.notes}
            onChange={e => {
              setForm(f => ({ ...f, notes: e.target.value }));
              dirty.markDirty();
            }}
            placeholder="Необов'язково"
          />

          <DatePickerInput
            label="Дата документа"
            value={form.documentDate}
            onChange={v => {
              setForm(f => ({ ...f, documentDate: v }));
              dirty.markDirty();
            }}
          />

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Позиції</span>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={addLine}
              >
                Додати
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <EntityPickerField<GoodItem>
                      display={l.goodName}
                      placeholder="Пошук товару…"
                      onOpenDetail={l.goodId ? () => void openGoodDetail(i) : undefined}
                      onPick={() => setGoodPickerLine(i)}
                      onSearch={fetchGoodItems}
                      onSearchSelect={item => void applyGoodSelection(i, item)}
                      onClear={() => {
                        setLines(ls =>
                          ls.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  goodId: '',
                                  goodName: '',
                                  unit: '',
                                  unitId: '',
                                  unitShortName: '',
                                  coefficient: 1,
                                  goodUoMs: [],
                                }
                              : x,
                          ),
                        );
                        dirty.markDirty();
                      }}
                    />
                  </div>
                  <Input
                    type="number"
                    value={l.quantity}
                    onChange={e => updateLineField(i, 'quantity', e.target.value)}
                    placeholder="Кіл."
                    min="0.001"
                    step="0.001"
                    className="w-20 text-xs"
                  />
                  {l.goodUoMs.length > 0 ? (
                    <Select
                      value={l.unitId}
                      onChange={e => {
                        const selectedUom = l.goodUoMs.find(u => u.id === e.target.value);
                        if (!selectedUom) return;
                        const oldCoeff = l.coefficient || 1;
                        const newCoeff = selectedUom.coefficient || 1;
                        // Bug #234: do not clobber user intent when qty is empty/NaN/≤0.
                        const rawQty = parseFloat(l.quantity);
                        const hasValidQty = Number.isFinite(rawQty) && rawQty > 0;
                        const newQty = hasValidQty
                          ? ((rawQty * oldCoeff) / newCoeff).toFixed(3)
                          : null;
                        setLines(ls =>
                          ls.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  unitId: selectedUom.id,
                                  unitShortName: selectedUom.unitShortName,
                                  coefficient: newCoeff,
                                  ...(newQty !== null ? { quantity: newQty } : {}),
                                }
                              : x,
                          ),
                        );
                        dirty.markDirty();
                      }}
                      className="w-20 text-xs"
                    >
                      {l.goodUoMs.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.unitShortName}
                        </option>
                      ))}
                    </Select>
                  ) : l.unit ? (
                    <span className="w-20 text-xs text-muted-foreground self-center px-2 truncate">
                      {l.unit}
                    </span>
                  ) : null}
                  <Input
                    type="number"
                    value={l.price}
                    onChange={e => updateLineField(i, 'price', e.target.value)}
                    placeholder="Ціна"
                    min="0"
                    step="0.01"
                    className="w-24 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    className="h-9 w-9 flex items-center justify-center rounded-lg text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                    aria-label="Видалити рядок"
                    title="Видалити рядок"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Замовлення можна створити без позицій і додати їх пізніше
                </p>
              )}
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
        searchPlaceholder="Назва компанії, телефон..."
        emptyText="Постачальників не знайдено"
        onSelect={item => {
          setSupplierDisplay(item.primary);
          setForm(f => ({ ...f, supplierId: item.id }));
          dirty.markDirty();
          setSupplierPickerOpen(false);
        }}
      />

      {/* Supplier detail (CounterpartyEditModal) */}
      <CounterpartyEditModal
        open={supplierDetailOpen}
        counterparty={supplierDetailData}
        onClose={() => setSupplierDetailOpen(false)}
        onSaved={updated => {
          setSupplierDetailData(updated);
          setSupplierDisplay(displayCounterpartyName(updated));
          setSupplierDetailOpen(false);
        }}
      />

      {/* Good picker */}
      <SearchPickerModal<GoodItem>
        open={goodPickerLine !== null}
        onClose={() => setGoodPickerLine(null)}
        title="Оберіть товар"
        selectedId={goodPickerLine !== null ? lines[goodPickerLine]?.goodId : null}
        fetchItems={fetchGoodItems}
        searchPlaceholder="Назва, артикул..."
        emptyText="Товарів не знайдено"
        onSelect={item => {
          if (goodPickerLine === null) return;
          const idx = goodPickerLine;
          setGoodPickerLine(null);
          void applyGoodSelection(idx, item);
        }}
      />

      {/* Good detail (GoodEditModal) */}
      <GoodEditModal
        open={goodDetailLine !== null}
        good={goodDetailData}
        brands={brands}
        units={units}
        suppliers={allSuppliers}
        goodCatTree={goodCatTree}
        onClose={() => {
          setGoodDetailLine(null);
          setGoodDetailData(null);
        }}
        onSaved={updated => {
          // Sync line name/unit/price if good metadata changed
          if (goodDetailLine !== null) {
            setLines(ls =>
              ls.map((x, idx) =>
                idx === goodDetailLine && x.goodId === updated.id
                  ? {
                      ...x,
                      goodName: updated.name,
                      unit: updated.unit,
                    }
                  : x,
              ),
            );
          }
          setGoodDetailLine(null);
          setGoodDetailData(null);
        }}
      />

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
