'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { toast } from '@/lib/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { kyivToday } from '@/lib/format';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Branch {
  id: string;
  name: string;
}

interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
}

interface Good {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
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

interface SupplierRef {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

interface DocLine {
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

export interface StockDocResponse {
  id: string;
  number: string;
  type: string;
  status: string;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface StockDocumentCreateModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a stock document is successfully created. */
  onSaved: (doc: StockDocResponse) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StockDocumentCreateModal({
  open,
  onClose,
  onSaved,
}: StockDocumentCreateModalProps) {
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // ── Form state ─────────────────────────────────────────────────────────────
  const [form, setForm] = useState({
    type: 'WRITEOFF',
    branchId: '',
    warehouseId: '',
    targetWarehouseId: '',
    notes: '',
    documentDate: kyivToday(),
  });
  const [lines, setLines] = useState<DocLine[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Good picker / detail (per line) ────────────────────────────────────────
  const [goodPickerLine, setGoodPickerLine] = useState<number | null>(null);
  const [goodDetailLine, setGoodDetailLine] = useState<number | null>(null);
  const [goodDetailData, setGoodDetailData] = useState<GoodForModal | null>(null);

  // Reference data for GoodEditModal — loaded lazily on first open
  const [brands, setBrands] = useState<Brand[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [allSuppliers, setAllSuppliers] = useState<SupplierRef[]>([]);
  const [goodCatTree, setGoodCatTree] = useState<CategoryNode[]>([]);
  const [goodRefsLoaded, setGoodRefsLoaded] = useState(false);

  const resetForm = useCallback(() => {
    setForm({
      type: 'WRITEOFF',
      branchId: '',
      warehouseId: '',
      targetWarehouseId: '',
      notes: '',
      documentDate: kyivToday(),
    });
    setLines([]);
    setError('');
    dirty.resetDirty();
  }, [dirty]);

  // Load branches + warehouses when modal opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const apply = (bList: Branch[], wList: Warehouse[]) => {
      if (cancelled) return;
      setBranches(bList);
      setWarehouses(wList);
      setForm(f => {
        const next = { ...f };
        if (!next.branchId && bList.length === 1) next.branchId = bList[0].id;
        const mainW = wList.find(x => x.isMain) ?? (wList.length === 1 ? wList[0] : null);
        if (!next.warehouseId && mainW) next.warehouseId = mainW.id;
        return next;
      });
    };

    const cachedB = getCached<Branch[]>('cache:branches');
    const cachedW = getCached<Warehouse[]>('cache:warehouses');
    if (cachedB && cachedW) apply(cachedB, cachedW);

    Promise.all([
      apiFetch<Branch[] | { items: Branch[] }>('/branches'),
      apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses'),
    ])
      .then(([b, w]) => {
        const bList = Array.isArray(b) ? b : b.items;
        const wList = Array.isArray(w) ? w : w.items;
        setCache('cache:branches', bList);
        setCache('cache:warehouses', wList);
        apply(bList, wList);
      })
      .catch((e: unknown) => {
        if (!cancelled && !cachedB)
          setError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset documentDate to today whenever modal opens
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
        apiFetch<{ items: SupplierRef[] }>('/counterparties?type=SUPPLIER&limit=200').catch(() => ({
          items: [] as SupplierRef[],
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

  // ── Good handlers ──────────────────────────────────────────────────────────
  type GoodItem = SearchPickerItem & { unit: string };

  const fetchGoodItems = useCallback(async (q: string): Promise<GoodItem[]> => {
    const url = q.trim() ? `/goods?q=${encodeURIComponent(q.trim())}&limit=30` : `/goods?limit=30`;
    const data = await apiFetch<{ items: Good[] }>(url);
    return data.items.map(g => ({
      id: g.id,
      primary: g.name,
      secondary: g.sku ?? undefined,
      unit: g.unit,
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
                unitId: '',
                unitShortName: '',
                coefficient: 1,
                goodUoMs: [],
              }
            : x,
        ),
      );
      dirty.markDirty();
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
      if (!Number.isFinite(qty) || qty <= 0) {
        setError('Вкажіть коректну кількість для всіх позицій');
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      const created = await apiFetch<StockDocResponse>('/stock-documents', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          branchId: form.branchId,
          warehouseId: form.warehouseId,
          targetWarehouseId: form.targetWarehouseId || undefined,
          notes: form.notes || undefined,
          documentDate: form.documentDate || undefined,
          // Convert display → base unit before submit (Bug #231).
          lines: validLines.map(l => {
            const coeff = l.coefficient || 1;
            const displayQty = parseFloat(l.quantity);
            const displayPrice = l.price ? parseFloat(l.price) : null;
            return {
              goodId: l.goodId,
              quantity: displayQty * coeff,
              price: displayPrice !== null ? displayPrice / coeff : undefined,
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
        title="Новий складський документ"
        size="lg"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.branchId || !form.warehouseId}
            className="w-full"
          >
            Створити документ
          </Button>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <Select
            label="Тип документа"
            required
            value={form.type}
            onChange={e => {
              setForm(f => ({ ...f, type: e.target.value }));
              dirty.markDirty();
            }}
          >
            <option value="WRITEOFF">Списання</option>
            <option value="TRANSFER">Переміщення між складами</option>
            <option value="OPENING_BALANCE">Початкові залишки</option>
          </Select>

          <Select
            label="Філія"
            required
            value={form.branchId}
            onChange={e => {
              setForm(f => ({ ...f, branchId: e.target.value }));
              dirty.markDirty();
            }}
            placeholder="Оберіть філію"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>

          <Select
            label={form.type === 'TRANSFER' ? 'Склад (джерело)' : 'Склад'}
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

          {form.type === 'TRANSFER' && (
            <Select
              label="Склад призначення"
              required
              value={form.targetWarehouseId}
              onChange={e => {
                setForm(f => ({ ...f, targetWarehouseId: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="Оберіть склад"
            >
              {warehouses
                .filter(w => w.id !== form.warehouseId)
                .map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          )}

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
                  Документ можна створити без позицій і додати їх пізніше
                </p>
              )}
            </div>
          </div>
        </div>
      </Modal>

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
          if (goodDetailLine !== null) {
            setLines(ls =>
              ls.map((x, idx) =>
                idx === goodDetailLine && x.goodId === updated.id
                  ? { ...x, goodName: updated.name, unit: updated.unit }
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
