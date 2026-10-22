'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { pickScannedGood } from '@/lib/barcode';
import { fmtQty } from '@/lib/format';
import {
  freeOf,
  isPartWarehouse,
  pickPartWarehouse,
  type StockByWarehouseRow,
  type WarehouseFree,
} from '@/lib/part-warehouse';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { usePendingOpen } from '@/hooks/usePendingOpen';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';

/**
 * Додавання запчастини в наряд.
 *
 * `void` перед `handleAdd()` / `handleClose()` / `openGoodDetail()` у JSX: кожен має власний
 * try/catch — `handleAdd` пише текст відмови у `error` (рендериться над формою) і в
 * `toast.error`, `openGoodDetail` показує `toast.error` при збої завантаження картки товару,
 * а єдиний `await` у `handleClose` — `dirty.confirmClose()`, який ніколи не реджектиться.
 * Користувач уже бачить результат, тож проміс обробника нікому не потрібен.
 *
 * Склад (BR-WO-029): біля кожного складу — вільна кількість обраного товару
 * (`GET /goods/stock-totals`, дозволено й механіку); щойно товар обрано, склад підставляється за
 * `pickPartWarehouse`. `initialWarehouseId` — склад до вибору товару. Ручний вибір складу
 * автовибір не перезаписує, доки не змінено товар. Нестача вільного залишку додавання не блокує
 * (товар під замовлення, BR-WO-021) — індикатор лише показує її.
 */

interface Good {
  id: string;
  name: string;
  sku?: string;
  salePrice: number;
  /** Базова одиниця товару — нею рахується вільний залишок. */
  unit?: string | null;
  barcode?: string | null;
  barcodes?: string[];
}

interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
  type?: string;
  deletedAt?: string | null;
}

/**
 * Вільна кількість обраного товару по складах; `goodId` — щоб відповідь іншого товару не підмінила.
 * `free: null` — залишки отримати не вдалося: підписи без кількості, склад — як «вільної немає».
 */
interface GoodFreeStock {
  goodId: string;
  free: WarehouseFree[] | null;
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
  const { t } = useTranslation('workOrders');
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
  const [goodUnit, setGoodUnit] = useState('');
  const [goodUoMs, setGoodUoMs] = useState<GoodUoM[]>([]);
  const [goodStock, setGoodStock] = useState<GoodFreeStock | null>(null);
  const [stockLoading, setStockLoading] = useState(false);
  // BR-WO-029: товар, для якого ще чекаємо автовибору складу; ручний вибір складу знімає.
  const autoPickGoodRef = useRef<string | null>(null);

  const warehouseOptions = useMemo(() => warehouses.filter(isPartWarehouse), [warehouses]);

  // Good detail modal
  const [goodDetailOpen, setGoodDetailOpen] = useState(false);
  const [goodDetailData, setGoodDetailData] = useState<GoodForModal | null>(null);
  const closeGoodDetail = useCallback(() => setGoodDetailOpen(false), []);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM, warehouseId: initialWarehouseId });
      setGoodDisplay('');
      setGoodUnit('');
      setGoodUoMs([]);
      setError('');
      setGoodStock(null);
      autoPickGoodRef.current = null;
      dirty.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWarehouseId]);

  // Вільний залишок обраного товару по складах — один запит на товар, не на кожен склад.
  useEffect(() => {
    if (!form.goodId) {
      setGoodStock(null);
      setStockLoading(false);
      return;
    }
    const goodId = form.goodId;
    let cancelled = false;
    setStockLoading(true);
    apiFetch<{ goodId: string; byWarehouse?: StockByWarehouseRow[] }[]>(
      `/goods/stock-totals?ids=${goodId}`,
    )
      .then(rows => {
        if (cancelled) return;
        const row = rows.find(r => r.goodId === goodId);
        setGoodStock({
          goodId,
          free: (row?.byWarehouse ?? []).map(w => ({
            warehouseId: w.warehouseId,
            available: freeOf(w),
          })),
        });
      })
      .catch(() => {
        // Без відповіді склад однаково підставляється (основний), інакше поле лишилось би порожнім
        // назавжди — до BR-WO-029 воно мало склад одразу.
        if (!cancelled) setGoodStock({ goodId, free: null });
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.goodId]);

  useEffect(() => {
    if (!goodStock || autoPickGoodRef.current !== goodStock.goodId) return;
    if (warehouseOptions.length === 0) return;
    autoPickGoodRef.current = null;
    const warehouseId = pickPartWarehouse(goodStock.free ?? [], warehouseOptions);
    setForm(f => (f.goodId === goodStock.goodId ? { ...f, warehouseId } : f));
  }, [goodStock, warehouseOptions]);

  const stockOfGood = goodStock && goodStock.goodId === form.goodId ? goodStock.free : null;
  const freeOn = (warehouseId: string): number =>
    stockOfGood?.find(w => w.warehouseId === warehouseId)?.available ?? 0;

  // Race guard: швидка зміна товару A→B не повинна дати повільнішій відповіді A
  // (UoM-списку) перезаписати UoM обраного B.
  const uomReqRef = useRef(0);
  const selectGood = useCallback(
    (item: Good) => {
      const reqId = ++uomReqRef.current;
      autoPickGoodRef.current = item.id;
      setGoodDisplay(item.name);
      setGoodUnit(item.unit ?? '');
      setForm(f => ({
        ...f,
        goodId: item.id,
        warehouseId: '',
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
    autoPickGoodRef.current = null;
    setForm(f => ({ ...f, goodId: '', price: '', unitOfMeasureId: '' }));
    setGoodDisplay('');
    setGoodUnit('');
    setGoodUoMs([]);
    dirty.markDirty();
  }, [dirty]);

  // Картка відкривається після запиту: Escape під час нього скасовує відкриття, а не закриває
  // вікно-власника (Bug #935).
  const openAfterLoad = usePendingOpen(open);

  const openGoodDetail = useCallback(async () => {
    if (!form.goodId) return;
    try {
      await openAfterLoad(
        () => apiFetch<GoodForModal>(`/goods/${form.goodId}`),
        g => {
          setGoodDetailData(g);
          setGoodDetailOpen(true);
        },
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('addPart.loadGoodError'));
    }
  }, [form.goodId, openAfterLoad, t]);

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
      if (features.toastEnabled) toast.success(t('toast.partAdded'));
      onAdded();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('common:error');
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
      <Modal open={open} onClose={() => void handleClose()} title={t('addPart.title')}>
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}

          {!form.goodId ? (
            <SearchCombobox<Good>
              label={t('addPart.good')}
              required
              placeholder={t('addPart.searchPlaceholder')}
              value={form.goodId}
              displayValue={goodDisplay}
              onSelect={selectGood}
              onClear={clearGood}
              fetchItems={q =>
                apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=10`).then(r =>
                  r.items.map(g => ({ ...g, primary: g.name, secondary: g.sku })),
                )
              }
              scanSubmit={(items, typed) => pickScannedGood(items, typed)}
            />
          ) : (
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                {t('addPart.good')} <span className="text-destructive">*</span>
              </label>
              <EntityPickerField
                display={goodDisplay}
                placeholder={t('addPart.pickGood')}
                onOpenDetail={() => void openGoodDetail()}
                onPick={clearGood}
                onClear={clearGood}
              />
            </div>
          )}

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('addPart.warehouse')} <span className="text-destructive">*</span>
            </label>
            <Select
              aria-label={t('addPart.warehouse')}
              value={form.warehouseId}
              onChange={e => {
                autoPickGoodRef.current = null;
                setForm(f => ({ ...f, warehouseId: e.target.value }));
                dirty.markDirty();
              }}
            >
              <option value="">{t('addLine.choose')}</option>
              {warehouseOptions.map(w => (
                <option key={w.id} value={w.id}>
                  {stockOfGood ? `${w.name} — ${fmtQty(freeOn(w.id))}` : w.name}
                </option>
              ))}
            </Select>
            {features.stockIndicatorEnabled && form.goodId && form.warehouseId && (
              <p
                data-testid="part-stock-indicator"
                className={cn(
                  'mt-1.5 text-[12px]',
                  stockLoading || !stockOfGood
                    ? 'text-muted-foreground'
                    : freeOn(form.warehouseId) > 0
                      ? 'text-success'
                      : 'text-destructive',
                )}
              >
                {stockLoading
                  ? t('addPart.checkingStock')
                  : !stockOfGood
                    ? ''
                    : freeOn(form.warehouseId) > 0
                      ? `${t('addPart.free', { qty: fmtQty(freeOn(form.warehouseId)) })}${goodUnit ? ` ${goodUnit}` : ''}`
                      : t('addPart.noFree')}
              </p>
            )}
          </div>

          {goodUoMs.length > 0 && (
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                {t('addPart.unit')}
              </label>
              <Select
                value={form.unitOfMeasureId}
                onChange={e => {
                  setForm(f => ({ ...f, unitOfMeasureId: e.target.value }));
                  dirty.markDirty();
                }}
              >
                <option value="">{t('addPart.baseUnit')}</option>
                {goodUoMs.map(u => (
                  // value=unitOfMeasureId (UnitOfMeasure.id), не u.id (GoodUoM.id).
                  // Backend addPart робить findFirst({ unitOfMeasureId: dto.unitOfMeasureId, goodId, orgId }) —
                  // GoodUoM.id у це поле ніколи не матчиться → silent-stored null без помилки.
                  <option key={u.id} value={u.unitOfMeasureId}>
                    {u.unitShortName}
                    {u.coefficient !== 1
                      ? ` (${t('addPart.coefficient', { value: u.coefficient })})`
                      : ''}
                    {u.isDefault ? ' ★' : ''}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">{t('addPart.unitHint')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                {t('addPart.quantity')} <span className="text-destructive">*</span>
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
                {t('card.colPrice')}
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
            onClick={() => void handleAdd()}
            loading={saving}
            disabled={!form.goodId || !form.warehouseId || !form.quantity}
            className="w-full"
          >
            {t('common:add')}
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
        onClose={closeGoodDetail}
        onSaved={updated => {
          setGoodDetailData(updated);
          setGoodDisplay(updated.name);
          closeGoodDetail();
        }}
      />
    </>
  );
}
