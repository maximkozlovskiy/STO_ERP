'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Star, Barcode, Package, X, Check } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate } from '@/lib/format';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ModalTabs } from '@/components/ui/modal-tabs';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoodForModal {
  id: string;
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

interface GoodBarcode {
  id: string;
  barcode: string;
  type: string;
  isPrimary: boolean;
}

interface StockBatchDto {
  id: string;
  goodId: string;
  warehouseId: string;
  batchNumber: string | null;
  expiryDate: string | null;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  salePrice: number;
  isActive: boolean;
  createdAt: string;
  purchaseOrderNumber: string | null;
  purchaseOrderLineId: string | null;
  unitOfMeasureId: string | null;
  unitShortName: string | null;
}

interface GoodUoM {
  id: string;
  unitOfMeasureId: string;
  unitName: string;
  unitShortName: string;
  coefficient: number;
  isDefault: boolean;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  volume?: number | null;
  weight?: number | null;
}

interface UoMEditForm {
  coefficient: string;
  width: string;
  height: string;
  depth: string;
  volume: string;
  weight: string;
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

const EMPTY_ADD_UOM_FORM = {
  unitOfMeasureId: '',
  coefficient: '1',
  width: '',
  height: '',
  depth: '',
  volume: '',
  weight: '',
};

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
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // ── Form state ─────────────────────────────────────────────────────────────
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Supplier picker (CounterpartyEditModal) ────────────────────────────────
  const [cpDetailOpen, setCpDetailOpen] = useState(false);
  const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);
  const [supplierDisplay, setSupplierDisplay] = useState('');

  // ── Barcodes tab ───────────────────────────────────────────────────────────
  const [modalBarcodes, setModalBarcodes] = useState<GoodBarcode[]>([]);
  const [modalBarcodesLoading, setModalBarcodesLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');
  const [showAddBarcode, setShowAddBarcode] = useState(false);
  const [addBarcodeForm, setAddBarcodeForm] = useState({ barcode: '', type: 'EAN13' });
  const [addingBarcode2, setAddingBarcode2] = useState(false);
  const [deletingBarcodeId2, setDeletingBarcodeId2] = useState<string | null>(null);
  const modalBarcodeReqRef = useRef(0);

  // ── Batches tab ────────────────────────────────────────────────────────────
  const [modalBatches, setModalBatches] = useState<StockBatchDto[]>([]);
  const [modalBatchesLoading, setModalBatchesLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const modalBatchReqRef = useRef(0);

  // ── UoMs tab ───────────────────────────────────────────────────────────────
  const [modalUoMs, setModalUoMs] = useState<GoodUoM[]>([]);
  const [modalUoMsLoading, setModalUoMsLoading] = useState(false);
  const [uomError, setUomError] = useState('');
  const [showAddUoM, setShowAddUoM] = useState(false);
  const [addUoMForm, setAddUoMForm] = useState(EMPTY_ADD_UOM_FORM);
  const [addingUoM, setAddingUoM] = useState(false);
  const [deletingUoMId, setDeletingUoMId] = useState<string | null>(null);
  const [editingUoMId, setEditingUoMId] = useState<string | null>(null);
  const [editUoMForm, setEditUoMForm] = useState<UoMEditForm>({
    coefficient: '1',
    width: '',
    height: '',
    depth: '',
    volume: '',
    weight: '',
  });
  const [savingUoMId, setSavingUoMId] = useState<string | null>(null);
  const modalUoMReqRef = useRef(0);
  const uomRefDefault = useRef(0);

  // ── Sync form when good changes ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setError('');
    setBarcodeError('');
    setBatchError('');
    setUomError('');
    setShowAddBarcode(false);
    setShowAddUoM(false);
    setAddBarcodeForm({ barcode: '', type: 'EAN13' });
    setAddUoMForm(EMPTY_ADD_UOM_FORM);
    setEditingUoMId(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, good?.id]);

  // ── Load sub-resources when editing existing good ──────────────────────────
  useEffect(() => {
    if (!open || !good) {
      setModalBarcodes([]);
      setModalBatches([]);
      setModalUoMs([]);
      return;
    }
    const bReqId = ++modalBarcodeReqRef.current;
    const btReqId = ++modalBatchReqRef.current;
    const uomReqId = ++modalUoMReqRef.current;

    setModalBarcodes([]);
    setModalBatches([]);
    setModalUoMs([]);
    setModalBarcodesLoading(true);
    setModalBatchesLoading(true);
    setModalUoMsLoading(true);

    apiFetch<GoodBarcode[]>(`/goods/${good.id}/barcodes`)
      .then(data => {
        if (modalBarcodeReqRef.current === bReqId) setModalBarcodes(data);
      })
      .catch(err => {
        if (modalBarcodeReqRef.current === bReqId)
          setBarcodeError(err instanceof Error ? err.message : 'Помилка завантаження штрихкодів');
      })
      .finally(() => {
        if (modalBarcodeReqRef.current === bReqId) setModalBarcodesLoading(false);
      });

    apiFetch<{ items: StockBatchDto[]; total: number }>(`/goods/${good.id}/batches`)
      .then(data => {
        if (modalBatchReqRef.current === btReqId) setModalBatches(data.items);
      })
      .catch(err => {
        if (modalBatchReqRef.current === btReqId)
          setBatchError(err instanceof Error ? err.message : 'Помилка завантаження партій');
      })
      .finally(() => {
        if (modalBatchReqRef.current === btReqId) setModalBatchesLoading(false);
      });

    apiFetch<GoodUoM[]>(`/goods/${good.id}/uoms`)
      .then(data => {
        if (modalUoMReqRef.current === uomReqId) setModalUoMs(data);
      })
      .catch(err => {
        if (modalUoMReqRef.current === uomReqId)
          setUomError(err instanceof Error ? err.message : 'Помилка завантаження одиниць виміру');
      })
      .finally(() => {
        if (modalUoMReqRef.current === uomReqId) setModalUoMsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, good?.id]);

  const refreshUoMs = useCallback((goodId: string) => {
    const reqId = ++modalUoMReqRef.current;
    apiFetch<GoodUoM[]>(`/goods/${goodId}/uoms`)
      .then(data => {
        if (modalUoMReqRef.current === reqId) setModalUoMs(data);
      })
      .catch(() => {
        /* silent — toast already shown */
      });
  }, []);

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

  // ── UoM mutations ──────────────────────────────────────────────────────────
  const addUoM = async () => {
    if (!good || !addUoMForm.unitOfMeasureId) return;
    const coeff = addUoMForm.coefficient ? Number(addUoMForm.coefficient) : 1;
    if (!Number.isFinite(coeff) || coeff <= 0) {
      setUomError('Коефіцієнт має бути більший 0');
      return;
    }
    setUomError('');
    setAddingUoM(true);
    try {
      const created = await apiFetch<GoodUoM>(`/goods/${good.id}/uoms`, {
        method: 'POST',
        body: JSON.stringify({
          unitOfMeasureId: addUoMForm.unitOfMeasureId,
          coefficient: coeff,
          width: addUoMForm.width ? Number(addUoMForm.width) : undefined,
          height: addUoMForm.height ? Number(addUoMForm.height) : undefined,
          depth: addUoMForm.depth ? Number(addUoMForm.depth) : undefined,
          volume: addUoMForm.volume ? Number(addUoMForm.volume) : undefined,
          weight: addUoMForm.weight ? Number(addUoMForm.weight) : undefined,
        }),
      });
      setModalUoMs(prev => [...prev, created]);
      setAddUoMForm(EMPTY_ADD_UOM_FORM);
      setShowAddUoM(false);
      if (features.toastEnabled) toast.success('Одиницю виміру додано');
    } catch (e: unknown) {
      if (features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка додавання одиниці');
      }
    } finally {
      setAddingUoM(false);
    }
  };

  const setDefaultUoM = async (uomId: string) => {
    if (!good) return;
    const reqId = ++uomRefDefault.current;
    try {
      await apiFetch<GoodUoM>(`/goods/${good.id}/uoms/${uomId}/default`, { method: 'PATCH' });
      if (uomRefDefault.current === reqId) {
        setModalUoMs(prev => prev.map(u => ({ ...u, isDefault: u.id === uomId })));
        if (features.toastEnabled) toast.success('Основну одиницю змінено');
      }
    } catch (e: unknown) {
      if (uomRefDefault.current === reqId && features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка встановлення основної одиниці');
      }
    }
  };

  const deleteUoM = async (uomId: string) => {
    if (!good) return;
    if (!(await confirm({ title: 'Видалити одиницю виміру?', variant: 'destructive' }))) return;
    setDeletingUoMId(uomId);
    try {
      await apiFetch<void>(`/goods/${good.id}/uoms/${uomId}`, { method: 'DELETE' });
      refreshUoMs(good.id);
      if (features.toastEnabled) toast.success('Одиницю видалено');
    } catch (e: unknown) {
      if (features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    } finally {
      setDeletingUoMId(null);
    }
  };

  const openEditUoM = (u: GoodUoM) => {
    setEditingUoMId(u.id);
    setEditUoMForm({
      coefficient: String(u.coefficient),
      width: u.width != null ? String(u.width) : '',
      height: u.height != null ? String(u.height) : '',
      depth: u.depth != null ? String(u.depth) : '',
      volume: u.volume != null ? String(u.volume) : '',
      weight: u.weight != null ? String(u.weight) : '',
    });
    setUomError('');
  };

  const cancelEditUoM = () => {
    setEditingUoMId(null);
    setUomError('');
  };

  const saveUoMEdit = async (uomId: string) => {
    if (!good) return;
    if (!editUoMForm.coefficient.trim()) {
      setUomError('Коефіцієнт є обовʼязковим');
      return;
    }
    const coeff = Number(editUoMForm.coefficient);
    if (!Number.isFinite(coeff) || coeff <= 0) {
      setUomError('Коефіцієнт має бути більший 0');
      return;
    }
    setSavingUoMId(uomId);
    setUomError('');
    try {
      await apiFetch<GoodUoM>(`/goods/${good.id}/uoms/${uomId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          coefficient: coeff,
          width: editUoMForm.width ? Number(editUoMForm.width) : undefined,
          height: editUoMForm.height ? Number(editUoMForm.height) : undefined,
          depth: editUoMForm.depth ? Number(editUoMForm.depth) : undefined,
          volume: editUoMForm.volume ? Number(editUoMForm.volume) : undefined,
          weight: editUoMForm.weight ? Number(editUoMForm.weight) : undefined,
        }),
      });
      setEditingUoMId(null);
      refreshUoMs(good.id);
      if (features.toastEnabled) toast.success('Одиницю виміру оновлено');
    } catch (e: unknown) {
      setUomError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingUoMId(null);
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
              placeholder="Обрати постачальника…"
              onOpenDetail={form.preferredSupplierId ? openSupplierDetail : undefined}
              onPick={() => {
                // No picker modal yet — use Select fallback below
              }}
              onClear={() => {
                setSupplierDisplay('');
                setForm(f => ({ ...f, preferredSupplierId: '' }));
                dirty.markDirty();
              }}
              hidePick
            />
            <Select
              value={form.preferredSupplierId}
              onChange={e => {
                const id = e.target.value;
                const s = suppliers.find(x => x.id === id) ?? null;
                setSupplierDisplay(supplierLabel(s));
                setForm(f => ({ ...f, preferredSupplierId: id }));
                dirty.markDirty();
              }}
              className="mt-1"
            >
              <option value="">— Не вказано —</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>
                  {supplierLabel(s)}
                </option>
              ))}
            </Select>
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
                count: modalBarcodes.length,
                content: (
                  <div className="space-y-3">
                    {modalBarcodesLoading && (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        Завантаження...
                      </div>
                    )}
                    {!modalBarcodesLoading && barcodeError && (
                      <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                        {barcodeError}
                      </div>
                    )}
                    {!modalBarcodesLoading && !barcodeError && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] text-muted-foreground">
                            {modalBarcodes.length} штрихкодів
                          </span>
                          {!showAddBarcode && (
                            <Button
                              size="sm"
                              variant="outline"
                              leftIcon={<Plus className="h-3.5 w-3.5" />}
                              onClick={() => setShowAddBarcode(true)}
                            >
                              Додати
                            </Button>
                          )}
                        </div>
                        {showAddBarcode && (
                          <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                              <Input
                                label="Штрихкод"
                                required
                                value={addBarcodeForm.barcode}
                                onChange={e =>
                                  setAddBarcodeForm(f => ({ ...f, barcode: e.target.value }))
                                }
                                placeholder="4820123456789"
                              />
                              <Select
                                label="Тип"
                                value={addBarcodeForm.type}
                                onChange={e =>
                                  setAddBarcodeForm(f => ({ ...f, type: e.target.value }))
                                }
                              >
                                <option value="EAN13">EAN-13</option>
                                <option value="EAN8">EAN-8</option>
                                <option value="CODE128">Code 128</option>
                                <option value="CODE39">Code 39</option>
                                <option value="QR">QR</option>
                              </Select>
                            </div>
                            <div className="flex gap-2 justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setShowAddBarcode(false);
                                  setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                                }}
                              >
                                Скасувати
                              </Button>
                              <Button
                                size="sm"
                                loading={addingBarcode2}
                                disabled={!addBarcodeForm.barcode}
                                onClick={async () => {
                                  setAddingBarcode2(true);
                                  try {
                                    const created = await apiFetch<GoodBarcode>(
                                      `/goods/${good.id}/barcodes`,
                                      {
                                        method: 'POST',
                                        body: JSON.stringify({
                                          barcode: addBarcodeForm.barcode,
                                          type: addBarcodeForm.type,
                                        }),
                                      },
                                    );
                                    setModalBarcodes(prev => [...prev, created]);
                                    setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                                    setShowAddBarcode(false);
                                    toast.success('Штрихкод додано');
                                  } catch (e: unknown) {
                                    toast.error(e instanceof Error ? e.message : 'Помилка');
                                  } finally {
                                    setAddingBarcode2(false);
                                  }
                                }}
                              >
                                Зберегти
                              </Button>
                            </div>
                          </AnimatedBody>
                        )}
                        {modalBarcodes.length > 0 && (
                          <div className="rounded-xl border border-border overflow-hidden">
                            <table className="w-full text-[13px]">
                              <thead className="bg-secondary border-b border-border">
                                <tr>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                    Штрихкод
                                  </th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                    Тип
                                  </th>
                                  <th
                                    className="w-10 px-3 py-2 text-muted-foreground"
                                    title="Основний"
                                  >
                                    <Star className="h-3.5 w-3.5" />
                                  </th>
                                  <th className="w-12" />
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {modalBarcodes.map(bc => (
                                  <tr
                                    key={bc.id}
                                    className="bg-surface hover:bg-secondary/50 transition-colors"
                                  >
                                    <td className="px-3 py-2 font-mono text-foreground">
                                      {bc.barcode}
                                    </td>
                                    <td className="px-3 py-2 text-muted-foreground">{bc.type}</td>
                                    <td className="px-3 py-2 text-center">
                                      {bc.isPrimary && (
                                        <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text" />
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-center">
                                      <button
                                        type="button"
                                        disabled={deletingBarcodeId2 === bc.id}
                                        onClick={async () => {
                                          setDeletingBarcodeId2(bc.id);
                                          try {
                                            await apiFetch(`/goods/${good.id}/barcodes/${bc.id}`, {
                                              method: 'DELETE',
                                            });
                                            setModalBarcodes(prev =>
                                              prev.filter(b => b.id !== bc.id),
                                            );
                                            toast.success('Штрихкод видалено');
                                          } catch (e: unknown) {
                                            toast.error(e instanceof Error ? e.message : 'Помилка');
                                          } finally {
                                            setDeletingBarcodeId2(null);
                                          }
                                        }}
                                        className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                                        title="Видалити"
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {modalBarcodes.length === 0 && !showAddBarcode && (
                          <p className="text-[13px] text-muted-foreground text-center py-4">
                            Штрихкодів немає
                          </p>
                        )}
                      </>
                    )}
                  </div>
                ),
              },
              {
                key: 'batches',
                label: 'Партії',
                icon: <Package className="h-3.5 w-3.5" />,
                count: modalBatches.filter(b => b.remainingQty > 0).length,
                content: (
                  <div className="space-y-3">
                    {modalBatchesLoading && (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        Завантаження...
                      </div>
                    )}
                    {!modalBatchesLoading && batchError && (
                      <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                        {batchError}
                      </div>
                    )}
                    {!modalBatchesLoading && !batchError && modalBatches.length === 0 && (
                      <p className="text-[13px] text-muted-foreground text-center py-4">
                        Партій немає
                      </p>
                    )}
                    {!modalBatchesLoading && !batchError && modalBatches.length > 0 && (
                      <div className="rounded-xl border border-border overflow-hidden">
                        <table className="w-full text-[13px]">
                          <thead className="bg-secondary border-b border-border">
                            <tr>
                              <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                Партія / Накладна
                              </th>
                              <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                                Отримано
                              </th>
                              <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                                Залишок
                              </th>
                              <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                Одиниця
                              </th>
                              <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                                Собів., ₴
                              </th>
                              <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                                Продаж, ₴
                              </th>
                              <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                Дата
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {modalBatches.map(b => (
                              <tr
                                key={b.id}
                                className="bg-surface hover:bg-secondary/50 transition-colors"
                              >
                                <td className="px-3 py-2 text-foreground">
                                  {b.batchNumber ?? b.purchaseOrderNumber ?? '—'}
                                </td>
                                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                                  {b.receivedQty}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {b.remainingQty > 0 ? (
                                    <span className="text-foreground">{b.remainingQty}</span>
                                  ) : (
                                    <span className="text-muted-foreground line-through">
                                      {b.remainingQty}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-muted-foreground text-[12px]">
                                  {b.unitShortName ?? '—'}
                                </td>
                                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                                  {fmtMoney(b.costPrice)}
                                </td>
                                <td className="px-3 py-2 text-right text-foreground tabular-nums">
                                  {fmtMoney(b.salePrice)}
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">
                                  {fmtDate(b.createdAt)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'uoms',
                label: 'Одиниці виміру',
                icon: <Package className="h-3.5 w-3.5" />,
                count: modalUoMs.length,
                content: (
                  <div className="space-y-3">
                    {modalUoMsLoading && (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        Завантаження...
                      </div>
                    )}
                    {!modalUoMsLoading && uomError && (
                      <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                        {uomError}
                      </div>
                    )}
                    {!modalUoMsLoading && !uomError && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] text-muted-foreground">
                            {modalUoMs.length} одиниці
                          </span>
                          {!showAddUoM && (
                            <Button
                              size="sm"
                              variant="outline"
                              leftIcon={<Plus className="h-3.5 w-3.5" />}
                              onClick={() => setShowAddUoM(true)}
                            >
                              Додати
                            </Button>
                          )}
                        </div>
                        {showAddUoM && (
                          <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                            <Select
                              label="Одиниця виміру"
                              required
                              value={addUoMForm.unitOfMeasureId}
                              onChange={e =>
                                setAddUoMForm(f => ({ ...f, unitOfMeasureId: e.target.value }))
                              }
                            >
                              <option value="">— Виберіть одиницю —</option>
                              {units.map(u => (
                                <option key={u.id} value={u.id}>
                                  {u.shortName} ({u.name})
                                </option>
                              ))}
                            </Select>
                            <Input
                              label="Коефіцієнт"
                              type="number"
                              min="0"
                              step="any"
                              value={addUoMForm.coefficient}
                              onChange={e =>
                                setAddUoMForm(f => ({ ...f, coefficient: e.target.value }))
                              }
                              hint="Скільки базових одиниць в одній цій"
                            />
                            <div className="grid grid-cols-3 gap-2">
                              <Input
                                label="Ширина, м"
                                type="number"
                                min="0"
                                step="any"
                                value={addUoMForm.width}
                                onChange={e =>
                                  setAddUoMForm(f => ({ ...f, width: e.target.value }))
                                }
                                placeholder="—"
                              />
                              <Input
                                label="Висота, м"
                                type="number"
                                min="0"
                                step="any"
                                value={addUoMForm.height}
                                onChange={e =>
                                  setAddUoMForm(f => ({ ...f, height: e.target.value }))
                                }
                                placeholder="—"
                              />
                              <Input
                                label="Глибина, м"
                                type="number"
                                min="0"
                                step="any"
                                value={addUoMForm.depth}
                                onChange={e =>
                                  setAddUoMForm(f => ({ ...f, depth: e.target.value }))
                                }
                                placeholder="—"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <Input
                                label="Об'єм, м³"
                                type="number"
                                min="0"
                                step="any"
                                value={addUoMForm.volume}
                                onChange={e =>
                                  setAddUoMForm(f => ({ ...f, volume: e.target.value }))
                                }
                                placeholder="—"
                              />
                              <Input
                                label="Вага, кг"
                                type="number"
                                min="0"
                                step="any"
                                value={addUoMForm.weight}
                                onChange={e =>
                                  setAddUoMForm(f => ({ ...f, weight: e.target.value }))
                                }
                                placeholder="—"
                              />
                            </div>
                            <div className="flex gap-2 justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setShowAddUoM(false);
                                  setAddUoMForm(EMPTY_ADD_UOM_FORM);
                                }}
                              >
                                Скасувати
                              </Button>
                              <Button
                                size="sm"
                                loading={addingUoM}
                                disabled={!addUoMForm.unitOfMeasureId}
                                onClick={() => void addUoM()}
                              >
                                Додати
                              </Button>
                            </div>
                          </AnimatedBody>
                        )}
                        {modalUoMs.length > 0 && (
                          <div className="rounded-xl border border-border overflow-hidden">
                            <table className="w-full text-[13px]">
                              <thead className="bg-secondary border-b border-border">
                                <tr>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                    Одиниця
                                  </th>
                                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                    Коефіцієнт
                                  </th>
                                  <th
                                    className="w-10 px-3 py-2 text-muted-foreground"
                                    title="Основна"
                                  >
                                    <Star className="h-3.5 w-3.5" />
                                  </th>
                                  <th className="w-12" />
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border">
                                {modalUoMs.map(u =>
                                  editingUoMId === u.id ? (
                                    <tr key={u.id} className="bg-primary/5">
                                      <td className="px-3 py-2 text-foreground">
                                        <div>
                                          <p className="font-medium">{u.unitShortName}</p>
                                          <p className="text-[12px] text-muted-foreground">
                                            {u.unitName}
                                          </p>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          autoFocus
                                          type="number"
                                          min="0"
                                          step="any"
                                          value={editUoMForm.coefficient}
                                          onChange={e =>
                                            setEditUoMForm(f => ({
                                              ...f,
                                              coefficient: e.target.value,
                                            }))
                                          }
                                          onKeyDown={e => {
                                            if (e.key === 'Escape') cancelEditUoM();
                                            if (e.key === 'Enter') void saveUoMEdit(u.id);
                                          }}
                                          className="w-24 rounded border border-primary/40 bg-surface px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                        />
                                      </td>
                                      <td className="px-3 py-2 text-center">
                                        {u.isDefault ? (
                                          <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text mx-auto" />
                                        ) : (
                                          <Star className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                                        )}
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="flex items-center justify-end gap-1">
                                          <button
                                            type="button"
                                            disabled={savingUoMId === u.id}
                                            onClick={() => void saveUoMEdit(u.id)}
                                            className="text-success/80 hover:text-success hover:bg-success/10 p-1 rounded transition-colors"
                                            title="Зберегти (Enter)"
                                          >
                                            {savingUoMId === u.id ? (
                                              <span className="text-[11px]">...</span>
                                            ) : (
                                              <Check className="h-3.5 w-3.5" />
                                            )}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={cancelEditUoM}
                                            className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                                            title="Скасувати (Esc)"
                                          >
                                            <X className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ) : (
                                    <tr
                                      key={u.id}
                                      className="bg-surface hover:bg-secondary/50 transition-colors cursor-pointer group"
                                      onClick={() => openEditUoM(u)}
                                    >
                                      <td className="px-3 py-2 text-foreground">
                                        <div>
                                          <p className="font-medium">{u.unitShortName}</p>
                                          <p className="text-[12px] text-muted-foreground">
                                            {u.unitName}
                                          </p>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2 text-muted-foreground tabular-nums">
                                        {u.coefficient !== 1 ? u.coefficient : '—'}
                                      </td>
                                      <td className="px-3 py-2 text-center">
                                        {u.isDefault ? (
                                          <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text mx-auto" />
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={e => {
                                              e.stopPropagation();
                                              void setDefaultUoM(u.id);
                                            }}
                                            className="text-muted-foreground hover:text-warning-text transition-colors mx-auto block"
                                            title="Встановити основною"
                                          >
                                            <Star className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-center">
                                        <button
                                          type="button"
                                          disabled={deletingUoMId === u.id}
                                          onClick={e => {
                                            e.stopPropagation();
                                            void deleteUoM(u.id);
                                          }}
                                          className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                          title="Видалити"
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </button>
                                      </td>
                                    </tr>
                                  ),
                                )}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {modalUoMs.length === 0 && !showAddUoM && (
                          <p className="text-[13px] text-muted-foreground text-center py-4">
                            Додаткових одиниць не додано
                          </p>
                        )}
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...confirmDialogProps} />

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
