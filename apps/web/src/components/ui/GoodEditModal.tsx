'use client';

import { useState, useEffect, useCallback } from 'react';
import { Barcode, Package, TrendingUp } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ModalTabs } from '@/components/ui/modal-tabs';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';
import { GoodBarcodeTab } from '@/components/ui/GoodBarcodeTab';
import { GoodBatchesTab } from '@/components/ui/GoodBatchesTab';
import { GoodUoMTab } from '@/components/ui/GoodUoMTab';
import { GoodPriceHistoryTab } from '@/components/ui/GoodPriceHistoryTab';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoodForModal {
  id: string;
  internalCode?: string | null;
  sku: string | null;
  name: string;
  unit: string;
  unitId: string | null;
  purchasePrice: number | null;
  salePrice: number;
  category: string | null;
  goodCategoryId?: string | null;
  goodCategoryName?: string | null;
  barcode: string | null;
  brandId: string | null;
  notes: string | null;
  goodType?: string | null;
  preferredSupplierId?: string | null;
  preferredSupplierName?: string | null;
  deletedAt?: string | null;
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

interface GoodEditModalProps {
  open: boolean;
  /** null = create new */
  good: GoodForModal | null;
  onClose: () => void;
  onSaved: (good: GoodForModal) => void;
  /** Reference data — passed in to avoid re-fetching */
  brands: Brand[];
  units: Unit[];
  suppliers: Supplier[];
  goodCatTree: CategoryNode[];
}

const EMPTY_FORM = {
  sku: '',
  name: '',
  unit: 'шт',
  unitId: '',
  purchasePrice: '',
  salePrice: '',
  category: '',
  goodCategoryId: '',
  brandId: '',
  barcode: '',
  notes: '',
  goodType: '',
  preferredSupplierId: '',
};

function flatCategories(cats: CategoryNode[], depth = 0): Array<CategoryNode & { depth: number }> {
  return cats.flatMap(c => [{ ...c, depth }, ...flatCategories(c.children, depth + 1)]);
}

function supplierLabel(s: Supplier | undefined | null): string {
  if (!s) return '';
  return s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ');
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GoodEditModal({
  open,
  good,
  onClose,
  onSaved,
  brands,
  units,
  suppliers,
  goodCatTree,
}: GoodEditModalProps) {
  const isEdit = !!good;
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // ── Form state ─────────────────────────────────────────────────────────────
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Supplier picker (CounterpartyEditModal) ────────────────────────────────
  const [cpDetailOpen, setCpDetailOpen] = useState(false);
  const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);
  const [supplierDisplay, setSupplierDisplay] = useState('');

  // ── Sub-resource counts (for tab badges) ───────────────────────────────────
  // Children fetch their own data; we mirror the count for the strip badge.
  const [barcodeCount, setBarcodeCount] = useState(0);
  const [batchesActiveCount, setBatchesActiveCount] = useState(0);
  const [uomCount, setUomCount] = useState(0);
  const [priceHistoryCount, setPriceHistoryCount] = useState(0);

  // ── Sync form when good changes ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setError('');
    dirty.resetDirty();

    if (good) {
      setForm({
        sku: good.sku ?? '',
        name: good.name,
        unit: good.unit,
        unitId: good.unitId ?? '',
        purchasePrice: good.purchasePrice != null ? String(good.purchasePrice) : '',
        salePrice: String(good.salePrice),
        category: good.category ?? '',
        goodCategoryId: good.goodCategoryId ?? '',
        brandId: good.brandId ?? '',
        barcode: good.barcode ?? '',
        notes: good.notes ?? '',
        goodType: good.goodType ?? '',
        preferredSupplierId: good.preferredSupplierId ?? '',
      });
      setSupplierDisplay(good.preferredSupplierName ?? '');
    } else {
      setForm(EMPTY_FORM);
      setSupplierDisplay('');
    }
    // Reset count badges on entity switch — child tabs will repopulate on mount.
    setBarcodeCount(0);
    setBatchesActiveCount(0);
    setUomCount(0);
    setPriceHistoryCount(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, good?.id]);

  // ── Supplier picker handlers ───────────────────────────────────────────────
  const openSupplierDetail = useCallback(async () => {
    if (!form.preferredSupplierId) return;
    try {
      const cp = await apiFetch<CounterpartyForModal>(
        `/counterparties/${form.preferredSupplierId}`,
      );
      setCpDetailData(cp);
      setCpDetailOpen(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження постачальника');
    }
  }, [form.preferredSupplierId]);

  // Stable onSearch reference — prevents EntityPickerField from re-attaching
  // its outside-click listener on every parent render.
  const searchSuppliers = useCallback(
    async (q: string) =>
      apiFetch<{ items: Supplier[] }>(
        `/counterparties?type=SUPPLIER&q=${encodeURIComponent(q)}&limit=30`,
      ).then(r => r.items.map(s => ({ id: s.id, primary: supplierLabel(s) }))),
    [],
  );

  // ── Close handler ──────────────────────────────────────────────────────────
  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    onClose();
  }, [dirty, onClose]);

  // ── Save (create or update) ────────────────────────────────────────────────
  const save = async () => {
    if (form.purchasePrice) {
      const pp = Number(form.purchasePrice);
      if (!Number.isFinite(pp) || pp < 0) {
        setError("Ціна закупівлі повинна бути невід'ємним числом");
        return;
      }
    }
    if (form.salePrice) {
      const sp = Number(form.salePrice);
      if (!Number.isFinite(sp) || sp < 0) {
        setError("Ціна продажу повинна бути невід'ємним числом");
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        sku: form.sku || undefined,
        name: form.name,
        unit: form.unit || 'шт',
        unitId: form.unitId || undefined,
        purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
        salePrice: form.salePrice ? Number(form.salePrice) : undefined,
        category: form.category || undefined,
        goodCategoryId: form.goodCategoryId || undefined,
        brandId: form.brandId || undefined,
        barcode: !isEdit ? form.barcode || undefined : undefined,
        notes: form.notes || undefined,
        goodType: form.goodType || undefined,
        preferredSupplierId: form.preferredSupplierId || undefined,
      };
      const saved = isEdit
        ? await apiFetch<GoodForModal>(`/goods/${good!.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await apiFetch<GoodForModal>('/goods', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
      dirty.resetDirty();
      onSaved(saved);
      if (features.toastEnabled) {
        toast.success(isEdit ? 'Товар оновлено' : 'Товар створено');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={isEdit ? 'Редагування товару' : 'Новий товар / запчастина'}
        size={isEdit ? 'lg' : 'xl'}
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name}>
            {isEdit ? 'Зберегти' : 'Зберегти та продовжити'}
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 text-[13px]">
            <span className="text-muted-foreground">Внутрішній код:</span>
            {good?.internalCode ? (
              <span className="font-mono font-medium text-foreground">{good.internalCode}</span>
            ) : (
              <span className="text-muted-foreground italic">присвоюється автоматично</span>
            )}
          </div>
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => {
              setForm(f => ({ ...f, name: e.target.value }));
              dirty.markDirty();
            }}
            placeholder="Масло моторне 5W-40"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Артикул (SKU)"
              value={form.sku}
              onChange={e => {
                setForm(f => ({ ...f, sku: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="OIL-5W40"
            />
            {units.length > 0 ? (
              <Select
                label="Одиниця виміру"
                value={form.unitId}
                onChange={e => {
                  const unit = units.find(u => u.id === e.target.value);
                  setForm(f => ({
                    ...f,
                    unitId: e.target.value,
                    unit: unit?.shortName ?? f.unit,
                  }));
                  dirty.markDirty();
                }}
              >
                <option value="">— вписати вручну</option>
                {units.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.shortName} ({u.name})
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                label="Одиниця"
                value={form.unit}
                onChange={e => {
                  setForm(f => ({ ...f, unit: e.target.value }));
                  dirty.markDirty();
                }}
                placeholder="шт"
              />
            )}
          </div>
          {units.length > 0 && !form.unitId && (
            <Input
              label="Одиниця (вручну)"
              value={form.unit}
              onChange={e => {
                setForm(f => ({ ...f, unit: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="шт"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ціна закупки, ₴"
              type="number"
              min="0"
              value={form.purchasePrice}
              onChange={e => {
                setForm(f => ({ ...f, purchasePrice: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="350"
            />
            <Input
              label="Ціна продажу, ₴"
              type="number"
              min="0"
              value={form.salePrice}
              onChange={e => {
                setForm(f => ({ ...f, salePrice: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Бренд"
              value={form.brandId}
              onChange={e => {
                setForm(f => ({ ...f, brandId: e.target.value }));
                dirty.markDirty();
              }}
            >
              <option value="">—</option>
              {brands.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            {goodCatTree.length > 0 ? (
              <Select
                label="Категорія товарів"
                value={form.goodCategoryId}
                onChange={e => {
                  setForm(f => ({ ...f, goodCategoryId: e.target.value }));
                  dirty.markDirty();
                }}
              >
                <option value="">— Не вказано —</option>
                {flatCategories(goodCatTree).map(c => (
                  <option key={c.id} value={c.id}>
                    {' '.repeat(c.depth * 2)}
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                label="Категорія"
                value={form.category}
                onChange={e => {
                  setForm(f => ({ ...f, category: e.target.value }));
                  dirty.markDirty();
                }}
                placeholder="Мастила"
              />
            )}
          </div>
          <Select
            label="Тип товару"
            value={form.goodType}
            onChange={e => {
              setForm(f => ({ ...f, goodType: e.target.value }));
              dirty.markDirty();
            }}
          >
            <option value="">Не вказано</option>
            <option value="SPARE_PART">Запчастина</option>
            <option value="CONSUMABLE">Витратний матеріал</option>
            <option value="MATERIAL">Матеріал</option>
            <option value="TOOL">Інструмент</option>
          </Select>

          {/* Supplier — EntityPickerField */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Основний постачальник
            </label>
            <EntityPickerField
              display={supplierDisplay}
              placeholder="Пошук постачальника…"
              ariaLabel="Основний постачальник"
              onOpenDetail={form.preferredSupplierId ? openSupplierDetail : undefined}
              onPick={() => {}}
              onSearch={searchSuppliers}
              onSearchSelect={item => {
                setSupplierDisplay(item.primary);
                setForm(f => ({ ...f, preferredSupplierId: item.id }));
                dirty.markDirty();
              }}
              onClear={() => {
                setSupplierDisplay('');
                setForm(f => ({ ...f, preferredSupplierId: '' }));
                dirty.markDirty();
              }}
              hidePick
            />
          </div>

          {!isEdit && (
            <Input
              label="Штрихкод"
              value={form.barcode}
              onChange={e => {
                setForm(f => ({ ...f, barcode: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="4820000000000"
            />
          )}
          <Input
            label="Нотатки"
            value={form.notes}
            onChange={e => {
              setForm(f => ({ ...f, notes: e.target.value }));
              dirty.markDirty();
            }}
          />
        </div>

        {/* Tabs — only in edit mode */}
        {isEdit && good && (
          <ModalTabs
            tabs={[
              {
                key: 'barcodes',
                label: 'Штрихкоди',
                icon: <Barcode className="h-3.5 w-3.5" />,
                count: barcodeCount,
                content: <GoodBarcodeTab goodId={good.id} onCountChange={setBarcodeCount} />,
              },
              {
                key: 'batches',
                label: 'Партії',
                icon: <Package className="h-3.5 w-3.5" />,
                count: batchesActiveCount,
                content: <GoodBatchesTab goodId={good.id} onCountChange={setBatchesActiveCount} />,
              },
              {
                key: 'uoms',
                label: 'Одиниці виміру',
                icon: <Package className="h-3.5 w-3.5" />,
                count: uomCount,
                content: <GoodUoMTab goodId={good.id} units={units} onCountChange={setUomCount} />,
              },
              {
                key: 'price-history',
                label: 'Ціни',
                icon: <TrendingUp className="h-3.5 w-3.5" />,
                count: priceHistoryCount,
                content: (
                  <GoodPriceHistoryTab goodId={good.id} onCountChange={setPriceHistoryCount} />
                ),
              },
            ]}
          />
        )}
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />

      <CounterpartyEditModal
        open={cpDetailOpen}
        counterparty={cpDetailData}
        onClose={() => setCpDetailOpen(false)}
        onSaved={updated => {
          setCpDetailData(updated);
          setSupplierDisplay(
            updated.companyName ??
              [updated.lastName, updated.firstName].filter(Boolean).join(' ') ??
              '',
          );
          setCpDetailOpen(false);
        }}
      />
    </>
  );
}
