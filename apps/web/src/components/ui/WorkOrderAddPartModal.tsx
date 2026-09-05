'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';

interface Good {
  id: string;
  name: string;
  sku?: string;
  salePrice: number;
}

interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
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

interface Supplier {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

interface GoodUoM {
  id: string;
  // backend `/goods/:id/uoms` returns both GoodUoM.id (PK) і unitOfMeasureId (FK у UnitOfMeasure).
  // Парт-API очікує саме UnitOfMeasure.id (commit 1facbb67) — без цього поля у interface
  // TS не сигналізує, що Select option має використовувати unitOfMeasureId (бачте Bug #396).
  unitOfMeasureId: string;
  unitShortName: string;
  coefficient: number;
  isDefault: boolean;
}

interface WorkOrderAddPartModalProps {
  open: boolean;
  workOrderId: string;
  warehouses: Warehouse[];
  /** Initial warehouse (preserved across consecutive part additions) */
  initialWarehouseId?: string;
  onClose: () => void;
  onAdded: () => void;
  /** Optional reference data for the GoodEditModal opened from the picker */
  brands?: Brand[];
  units?: Unit[];
  suppliers?: Supplier[];
  goodCatTree?: CategoryNode[];
}

const EMPTY_FORM = {
  goodId: '',
  warehouseId: '',
  quantity: '1',
  price: '',
  unitOfMeasureId: '',
};

export function WorkOrderAddPartModal({
  open,
  workOrderId,
  warehouses,
  initialWarehouseId = '',
  onClose,
  onAdded,
  brands = [],
  units = [],
  suppliers = [],
  goodCatTree = [],
}: WorkOrderAddPartModalProps) {
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const [form, setForm] = useState({ ...EMPTY_FORM, warehouseId: initialWarehouseId });
  const [saving, setSaving] = useState(false);
  // WEB-H3 (Bug #636, клас Bug #630): синхронний guard проти concurrent double-submit.
  // Кнопка «Додати» disabled лише за !goodId/!warehouseId/!quantity (не saving) → два
  // same-tick кліки → 2× POST /parts → дубль запчастини + подвійне резервування залишку.
  const savingRef = useRef(false);
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const [error, setError] = useState('');
  const [goodDisplay, setGoodDisplay] = useState('');
  const [goodUoMs, setGoodUoMs] = useState<GoodUoM[]>([]);
  const [stockAvailable, setStockAvailable] = useState<number | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

  // Good detail modal
  const [goodDetailOpen, setGoodDetailOpen] = useState(false);
  const [goodDetailData, setGoodDetailData] = useState<GoodForModal | null>(null);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM, warehouseId: initialWarehouseId });
      setGoodDisplay('');
      setGoodUoMs([]);
      setError('');
      setStockAvailable(null);
      dirty.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWarehouseId]);

  // Stock indicator
  useEffect(() => {
    if (!features.stockIndicatorEnabled || !form.goodId || !form.warehouseId) {
      setStockAvailable(null);
      return;
    }
    let cancelled = false;
    setStockLoading(true);
    apiFetch<{ items: { available: number }[] }>(
      `/stock-items?goodId=${form.goodId}&warehouseId=${form.warehouseId}&limit=1`,
    )
      .then(r => {
        if (cancelled) return;
        setStockAvailable(r.items[0]?.available ?? 0);
      })
      .catch(() => {
        if (!cancelled) setStockAvailable(null);
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [features.stockIndicatorEnabled, form.goodId, form.warehouseId]);

  // Race guard: швидка зміна товару A→B не повинна дати повільнішій відповіді A
  // (UoM-списку) перезаписати UoM обраного B.
  const uomReqRef = useRef(0);
  const selectGood = useCallback(
    (item: Good) => {
      const reqId = ++uomReqRef.current;
      setGoodDisplay(item.name);
      setForm(f => ({
        ...f,
        goodId: item.id,
        price: item.salePrice ? String(item.salePrice) : f.price,
        unitOfMeasureId: '',
      }));
      setGoodUoMs([]);
      dirty.markDirty();
      apiFetch<GoodUoM[]>(`/goods/${item.id}/uoms`)
        .then(uoms => {
          if (reqId === uomReqRef.current) setGoodUoMs(uoms);
        })
        .catch(() => {
          if (reqId === uomReqRef.current) setGoodUoMs([]);
        });
    },
    [dirty],
  );

  const clearGood = useCallback(() => {
    // bump reqRef: скасовуємо будь-яку in-flight UoM-відповідь, щоб вона не
    // репопулювала список після очищення товару.
    uomReqRef.current += 1;
    setForm(f => ({ ...f, goodId: '', price: '', unitOfMeasureId: '' }));
    setGoodDisplay('');
    setGoodUoMs([]);
    dirty.markDirty();
  }, [dirty]);

  const openGoodDetail = useCallback(async () => {
    if (!form.goodId) return;
    try {
      const g = await apiFetch<GoodForModal>(`/goods/${form.goodId}`);
      setGoodDetailData(g);
      setGoodDetailOpen(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження товару');
    }
  }, [form.goodId]);

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    onClose();
  }, [dirty, onClose]);

  const handleAdd = async () => {
    if (savingRef.current) return;
    setSavingBoth(true);
    setError('');
    try {
      await apiFetch(`/work-orders/${workOrderId}/parts`, {
        method: 'POST',
        body: JSON.stringify({
          goodId: form.goodId,
          warehouseId: form.warehouseId,
          quantity: Number(form.quantity),
          price: form.price ? Number(form.price) : undefined,
          unitOfMeasureId: form.unitOfMeasureId || undefined,
        }),
      });
      dirty.resetDirty();
      if (features.toastEnabled) toast.success('Запчастину додано');
      onAdded();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSavingBoth(false);
    }
  };

  // Compose 'good chosen' UI: when nothing chosen — show SearchCombobox.
  // When chosen — show EntityPickerField (with detail/clear buttons).
  return (
    <>
      <Modal open={open} onClose={handleClose} title="Додати запчастину">
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}

          {!form.goodId ? (
            <SearchCombobox<Good>
              label="Товар"
              required
              placeholder="Назва, артикул, штрих-код..."
              value={form.goodId}
              displayValue={goodDisplay}
              onSelect={selectGood}
              onClear={clearGood}
              fetchItems={q =>
                apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=10`).then(r =>
                  r.items.map(g => ({ ...g, primary: g.name, secondary: g.sku })),
                )
              }
            />
          ) : (
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Товар <span className="text-destructive">*</span>
              </label>
              <EntityPickerField
                display={goodDisplay}
                placeholder="Обрати товар…"
                onOpenDetail={openGoodDetail}
                onPick={clearGood}
                onClear={clearGood}
              />
            </div>
          )}

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Склад <span className="text-destructive">*</span>
            </label>
            <Select
              value={form.warehouseId}
              onChange={e => {
                setForm(f => ({ ...f, warehouseId: e.target.value }));
                dirty.markDirty();
              }}
            >
              <option value="">— Оберіть —</option>
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            {features.stockIndicatorEnabled && form.goodId && form.warehouseId && (
              <p
                className={cn(
                  'mt-1.5 text-[12px]',
                  stockLoading
                    ? 'text-muted-foreground'
                    : stockAvailable === null
                      ? 'text-muted-foreground'
                      : stockAvailable > 0
                        ? 'text-success'
                        : 'text-destructive',
                )}
              >
                {stockLoading
                  ? 'Перевірка залишку...'
                  : stockAvailable === null
                    ? ''
                    : stockAvailable > 0
                      ? `Доступно: ${stockAvailable} шт.`
                      : 'Немає в наявності'}
              </p>
            )}
          </div>

          {goodUoMs.length > 0 && (
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Одиниця виміру
              </label>
              <Select
                value={form.unitOfMeasureId}
                onChange={e => {
                  setForm(f => ({ ...f, unitOfMeasureId: e.target.value }));
                  dirty.markDirty();
                }}
              >
                <option value="">— Базова —</option>
                {goodUoMs.map(u => (
                  // value=unitOfMeasureId (UnitOfMeasure.id), не u.id (GoodUoM.id).
                  // Backend addPart робить findFirst({ unitOfMeasureId: dto.unitOfMeasureId, goodId, orgId }) —
                  // GoodUoM.id у це поле ніколи не матчиться → silent-stored null без помилки.
                  <option key={u.id} value={u.unitOfMeasureId}>
                    {u.unitShortName}
                    {u.coefficient !== 1 ? ` (коеф. ${u.coefficient})` : ''}
                    {u.isDefault ? ' ★' : ''}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Кількість вводиться в обраній одиниці. Для складу перераховується автоматично.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Кількість <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                value={form.quantity}
                onChange={e => {
                  setForm(f => ({ ...f, quantity: e.target.value }));
                  dirty.markDirty();
                }}
                min="0.001"
                step="0.001"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Ціна, ₴
              </label>
              <Input
                type="number"
                value={form.price}
                onChange={e => {
                  setForm(f => ({ ...f, price: e.target.value }));
                  dirty.markDirty();
                }}
              />
            </div>
          </div>

          <Button
            onClick={handleAdd}
            loading={saving}
            disabled={
              !form.goodId ||
              !form.warehouseId ||
              !form.quantity ||
              (features.stockIndicatorEnabled &&
                stockAvailable !== null &&
                stockAvailable < Number(form.quantity))
            }
            className="w-full"
          >
            Додати
          </Button>
        </div>
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />

      <GoodEditModal
        open={goodDetailOpen}
        good={goodDetailData}
        brands={brands}
        units={units}
        suppliers={suppliers}
        goodCatTree={goodCatTree}
        onClose={() => setGoodDetailOpen(false)}
        onSaved={updated => {
          setGoodDetailData(updated);
          setGoodDisplay(updated.name);
          setGoodDetailOpen(false);
        }}
      />
    </>
  );
}
