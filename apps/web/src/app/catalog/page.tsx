'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Search, Trash2, BookOpen, Package, Layers, Star, Barcode, Ruler, Tag } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel } from '@/components/ui/detail-panel';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { BatchViewerModal } from '@/components/ui/batch-viewer-modal';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { Badge, type BadgeVariant } from '@/components/ui/badge';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category { id: string; name: string; children: Category[]; }
interface Work { id: string; categoryId: string; categoryName: string; name: string; normoHours: number; price: number; description: string | null; isWarranty: boolean; }
interface PaginatedWorks { items: Work[]; total: number; page: number; limit: number; }
interface Brand { id: string; name: string; }
interface Unit { id: string; name: string; shortName: string; isSystem: boolean; coefficient: number; width?: number | null; height?: number | null; depth?: number | null; volume?: number | null; weight?: number | null; }
interface Good { id: string; sku: string | null; name: string; unit: string; unitId: string | null; purchasePrice: number | null; salePrice: number; category: string | null; barcode: string | null; brandId: string | null; notes: string | null; goodType?: string | null; preferredSupplierId?: string | null; preferredSupplierName?: string | null; }
interface Supplier { id: string; firstName: string | null; lastName: string | null; companyName: string | null; }
interface PaginatedGoods { items: Good[]; total: number; page: number; limit: number; }
interface ServiceWork { workId: string; workName: string; normoHours: number; price: number; quantity: number; }
interface ServiceGood { goodId: string; goodName: string; unit: string; salePrice: number; quantity: number; }
interface Service { id: string; name: string; description: string | null; price: number | null; works: ServiceWork[]; goods: ServiceGood[]; }
interface PaginatedServices { items: Service[]; total: number; page: number; limit: number; }
interface GoodBarcode { id: string; barcode: string; type: string; isPrimary: boolean; }

type Tab = 'works' | 'goods' | 'services' | 'units' | 'brands';
type GoodDetailTab = 'info' | 'barcodes' | 'batches';

const GOOD_TYPE_LABELS: Record<string, string> = {
  SPARE_PART: 'Запчастина',
  CONSUMABLE: 'Витратний матеріал',
  MATERIAL: 'Матеріал',
  TOOL: 'Інструмент',
};
const GOOD_TYPE_BADGE: Record<string, BadgeVariant> = {
  SPARE_PART: 'default',
  CONSUMABLE: 'secondary',
  MATERIAL: 'warning',
  TOOL: 'success',
};

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex justify-center gap-1.5 mt-4">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
        <button key={p} onClick={() => onChange(p)}
          className={`h-8 w-8 rounded-lg text-[13px] font-medium border transition-colors ${
            p === page
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary'
          }`}>
          {p}
        </button>
      ))}
    </div>
  );
}

// ─── Works Tab ───────────────────────────────────────────────────────────────

function WorksTab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [works, setWorks] = useState<PaginatedWorks | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCat, setSelectedCat] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ categoryId: '', name: '', normoHours: '', price: '', description: '', isWarranty: false });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedWork, setSelectedWork] = useState<Work | null>(null);
  const [editWork, setEditWork] = useState<Work | null>(null);
  const [editForm, setEditForm] = useState({ categoryId: '', name: '', normoHours: '', price: '', description: '', isWarranty: false });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    apiFetch<Category[]>('/work-categories').then(setCategories).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження категорій'));
  }, []);

  // Sync categoryId when categories load after modal is already open (race condition fix)
  useEffect(() => {
    const first = flatCategories(categories)[0];
    if (!first) return;
    if (modal && !form.categoryId) setForm(f => ({ ...f, categoryId: first.id }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, modal]);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (selectedCat) p.set('categoryId', selectedCat);
    if (q) p.set('q', q);
    apiFetch<PaginatedWorks>(`/works?${p}`).then(setWorks).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, selectedCat, q]);

  useEffect(() => { load(); }, [load]);

  const flatCategories = (cats: Category[], depth = 0): Array<Category & { depth: number }> =>
    cats.flatMap(c => [{ ...c, depth }, ...flatCategories(c.children, depth + 1)]);

  const create = async () => {
    const normo = Number(form.normoHours); const price = Number(form.price);
    if (!Number.isFinite(normo) || normo <= 0) { setError('Норма-годин повинна бути більше нуля'); return; }
    if (!Number.isFinite(price) || price < 0) { setError('Ціна повинна бути невід\'ємним числом'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch<Work>('/works', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: form.categoryId,
          name: form.name,
          normoHours: normo,
          price,
          description: form.description || undefined,
          isWarranty: form.isWarranty,
        }),
      });
      setModal(false);
      setForm({ categoryId: '', name: '', normoHours: '', price: '', description: '', isWarranty: false });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити роботу?')) return;
    setDeletingId(id); setError('');
    try { await apiFetch<void>(`/works/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  const openEditWork = (w: Work) => {
    setEditWork(w);
    setEditForm({ categoryId: w.categoryId, name: w.name, normoHours: String(w.normoHours), price: String(w.price), description: w.description ?? '', isWarranty: w.isWarranty });
    setEditError('');
  };

  const saveEditWork = async () => {
    if (!editWork) return;
    const normo = Number(editForm.normoHours); const price = Number(editForm.price);
    if (!Number.isFinite(normo) || normo <= 0) { setEditError('Норма-годин повинна бути більше нуля'); return; }
    if (!Number.isFinite(price) || price < 0) { setEditError('Ціна повинна бути невід\'ємним числом'); return; }
    setEditSaving(true); setEditError('');
    try {
      await apiFetch<Work>(`/works/${editWork.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ categoryId: editForm.categoryId, name: editForm.name, normoHours: normo, price, description: editForm.description || undefined, isWarranty: editForm.isWarranty }),
      });
      setEditWork(null);
      load();
    } catch (e: unknown) { setEditError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setEditSaving(false); }
  };

  const flat = flatCategories(categories);
  const totalPages = works ? Math.ceil(works.total / works.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук робіт..." className="pl-9" />
        </div>
        <Select value={selectedCat} onChange={e => { setSelectedCat(e.target.value); setPage(1); }}>
          <option value="">Всі категорії</option>
          {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
        </Select>
        <XlsxImportButton
          templateType="works"
          importUrl="/xlsx/import/works"
          onImportComplete={load}
        />
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setForm({ categoryId: flat[0]?.id ?? '', name: '', normoHours: '', price: '', description: '', isWarranty: false }); setError(''); setModal(true); }}>
          Робота
        </Button>
      </div>

      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Назва</TableHead>
                <TableHead>Категорія</TableHead>
                <TableHead>Нормо-год</TableHead>
                <TableHead>Ціна, ₴</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && works?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState icon={BookOpen} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && works?.items.map(w => (
                <TableRow
                  key={w.id}
                  className={`cursor-pointer ${selectedWork?.id === w.id ? 'bg-secondary' : ''}`}
                  onClick={() => setSelectedWork(prev => prev?.id === w.id ? null : w)}
                >
                  <TableCell>
                    <p className="text-[13px] font-medium text-foreground">{w.name}</p>
                    {w.description && <p className="text-[12px] text-muted-foreground mt-0.5">{w.description}</p>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{w.categoryName}</TableCell>
                  <TableCell className="text-muted-foreground">{w.normoHours}</TableCell>
                  <TableCell className="font-medium text-foreground">{w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditWork(w); }}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={e => { e.stopPropagation(); remove(w.id); }}
                        disabled={deletingId === w.id}
                        loading={deletingId === w.id}
                        className="text-destructive/60 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedWork}
          onClose={() => setSelectedWork(null)}
          title={selectedWork?.name ?? ''}
        >
          {selectedWork && (
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-muted-foreground">Категорія:</span>{' '}
                <span className="text-foreground">{selectedWork.categoryName}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Нормо-годин:</span>{' '}
                <span className="text-foreground font-medium">{selectedWork.normoHours}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Ціна:</span>{' '}
                <span className="text-foreground font-semibold">
                  {selectedWork.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                </span>
              </div>
              {selectedWork.isWarranty && (
                <div>
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-warning-subtle text-warning">Гарантійна</span>
                </div>
              )}
              {selectedWork.description && (
                <div>
                  <p className="text-muted-foreground mb-1">Опис:</p>
                  <p className="text-foreground italic">{selectedWork.description}</p>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <Modal open={modal} onClose={() => setModal(false)} title="Нова робота"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.categoryId || !form.normoHours || !form.price} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Select
            label="Категорія"
            required
            value={form.categoryId}
            onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
          >
            {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
          </Select>
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Заміна масла"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Нормо-год"
              required
              type="number"
              value={form.normoHours}
              onChange={e => setForm(f => ({ ...f, normoHours: e.target.value }))}
              placeholder="1.5"
            />
            <Input
              label="Ціна, ₴"
              required
              type="number"
              value={form.price}
              onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
              placeholder="500"
            />
          </div>
          <Input
            label="Опис"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isWarranty}
              onChange={e => setForm(f => ({ ...f, isWarranty: e.target.checked }))}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-foreground">Гарантійна робота (виконується безкоштовно)</span>
          </label>
        </div>
      </Modal>

      <Modal open={!!editWork} onClose={() => setEditWork(null)} title="Редагування роботи"
        footer={
          <>
            <Button onClick={saveEditWork} loading={editSaving} disabled={!editForm.name || !editForm.categoryId || !editForm.normoHours || !editForm.price}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={() => setEditWork(null)}>Скасувати</Button>
          </>
        }
      >
        {editError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{editError}</div>
        )}
        <div className="space-y-4">
          <Select
            label="Категорія"
            required
            value={editForm.categoryId}
            onChange={e => setEditForm(f => ({ ...f, categoryId: e.target.value }))}
          >
            {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
          </Select>
          <Input
            label="Назва"
            required
            value={editForm.name}
            onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Заміна масла"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Нормо-год"
              required
              type="number"
              value={editForm.normoHours}
              onChange={e => setEditForm(f => ({ ...f, normoHours: e.target.value }))}
              placeholder="1.5"
            />
            <Input
              label="Ціна, ₴"
              required
              type="number"
              value={editForm.price}
              onChange={e => setEditForm(f => ({ ...f, price: e.target.value }))}
              placeholder="500"
            />
          </div>
          <Input
            label="Опис"
            value={editForm.description}
            onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editForm.isWarranty}
              onChange={e => setEditForm(f => ({ ...f, isWarranty: e.target.checked }))}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-foreground">Гарантійна робота (виконується безкоштовно)</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}

// ─── Goods Tab ────────────────────────────────────────────────────────────────

function GoodsTab() {
  const [goods, setGoods] = useState<PaginatedGoods | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ sku: '', name: '', unit: 'шт', unitId: '', purchasePrice: '', salePrice: '', category: '', brandId: '', barcode: '', notes: '', goodType: '', preferredSupplierId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedGood, setSelectedGood] = useState<Good | null>(null);
  const [goodDetailTab, setGoodDetailTab] = useState<GoodDetailTab>('info');
  const [barcodes, setBarcodes] = useState<GoodBarcode[]>([]);
  const [barcodesLoading, setBarcodesLoading] = useState(false);
  const [newBarcode, setNewBarcode] = useState('');
  const [newBarcodeType, setNewBarcodeType] = useState('EAN13');
  const [addingBarcode, setAddingBarcode] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editGood, setEditGood] = useState<Good | null>(null);
  const [editGoodForm, setEditGoodForm] = useState({ sku: '', name: '', unit: 'шт', unitId: '', purchasePrice: '', salePrice: '', category: '', brandId: '', notes: '', goodType: '', preferredSupplierId: '' });
  const [editGoodSaving, setEditGoodSaving] = useState(false);
  const [editGoodError, setEditGoodError] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [batchViewerGoodId, setBatchViewerGoodId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200').catch(() => ({ items: [], total: 0 })).then(r => setBrands(r.items));
    apiFetch<Unit[]>('/units').catch(() => []).then(v => { if (Array.isArray(v)) setUnits(v); });
    apiFetch<{ items: Supplier[] }>('/counterparties?types=SUPPLIER,BOTH&limit=200')
      .catch(() => ({ items: [] }))
      .then(r => { if (r && Array.isArray(r.items)) setSuppliers(r.items); });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (q) p.set('q', q);
    apiFetch<PaginatedGoods>(`/goods?${p}`).then(setGoods).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, q]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const salePrice = Number(form.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) { setError('Ціна продажу повинна бути невід\'ємним числом'); return; }
    if (form.purchasePrice) {
      const pp = Number(form.purchasePrice);
      if (!Number.isFinite(pp) || pp < 0) { setError('Ціна закупівлі повинна бути невід\'ємним числом'); return; }
    }
    setSaving(true); setError('');
    try {
      await apiFetch<Good>('/goods', {
        method: 'POST',
        body: JSON.stringify({
          sku: form.sku || undefined,
          name: form.name,
          unit: form.unit || 'шт',
          unitId: form.unitId || undefined,
          purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
          salePrice,
          category: form.category || undefined,
          brandId: form.brandId || undefined,
          barcode: form.barcode || undefined,
          notes: form.notes || undefined,
          goodType: form.goodType || undefined,
          preferredSupplierId: form.preferredSupplierId || undefined,
        }),
      });
      setModal(false);
      setForm({ sku: '', name: '', unit: 'шт', unitId: '', purchasePrice: '', salePrice: '', category: '', brandId: '', barcode: '', notes: '', goodType: '', preferredSupplierId: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const loadBarcodes = useCallback((goodId: string) => {
    setBarcodesLoading(true);
    apiFetch<GoodBarcode[]>(`/goods/${goodId}/barcodes`)
      .then(setBarcodes)
      .catch(() => setBarcodes([]))
      .finally(() => setBarcodesLoading(false));
  }, []);

  const addBarcode = async (goodId: string) => {
    if (!newBarcode.trim()) return;
    setAddingBarcode(true);
    try {
      await apiFetch<GoodBarcode>(`/goods/${goodId}/barcodes`, {
        method: 'POST',
        body: JSON.stringify({ barcode: newBarcode.trim(), type: newBarcodeType }),
      });
      setNewBarcode('');
      loadBarcodes(goodId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка додавання штрихкоду'); }
    finally { setAddingBarcode(false); }
  };

  const deleteBarcode = async (goodId: string, barcodeId: string) => {
    if (!confirm('Видалити штрихкод?')) return;
    try {
      await apiFetch<void>(`/goods/${goodId}/barcodes/${barcodeId}`, { method: 'DELETE' });
      loadBarcodes(goodId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення штрихкоду'); }
  };

  const markForDeletion = async (id: string) => {
    setSaving(true); setError('');
    try {
      await apiFetch<void>(`/goods/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      if (selectedGood?.id === id) setSelectedGood(null);
      load();
    }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const selectGood = (g: Good | null) => {
    setSelectedGood(g);
    setGoodDetailTab('info');
    if (g) loadBarcodes(g.id);
  };

  const openEditGood = (g: Good) => {
    setEditGood(g);
    setEditGoodForm({
      sku: g.sku ?? '', name: g.name, unit: g.unit, unitId: g.unitId ?? '',
      purchasePrice: g.purchasePrice != null ? String(g.purchasePrice) : '',
      salePrice: String(g.salePrice), category: g.category ?? '',
      brandId: g.brandId ?? '', notes: g.notes ?? '', goodType: g.goodType ?? '',
      preferredSupplierId: g.preferredSupplierId ?? '',
    });
    setEditGoodError('');
  };

  const saveEditGood = async () => {
    if (!editGood) return;
    const salePrice = Number(editGoodForm.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) { setEditGoodError('Ціна продажу повинна бути невід\'ємним числом'); return; }
    setEditGoodSaving(true); setEditGoodError('');
    try {
      await apiFetch<Good>(`/goods/${editGood.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sku: editGoodForm.sku || undefined,
          name: editGoodForm.name,
          unit: editGoodForm.unit || 'шт',
          unitId: editGoodForm.unitId || undefined,
          purchasePrice: editGoodForm.purchasePrice ? Number(editGoodForm.purchasePrice) : undefined,
          salePrice,
          category: editGoodForm.category || undefined,
          brandId: editGoodForm.brandId || undefined,
          notes: editGoodForm.notes || undefined,
          goodType: editGoodForm.goodType || undefined,
          preferredSupplierId: editGoodForm.preferredSupplierId || undefined,
        }),
      });
      setEditGood(null);
      load();
    } catch (e: unknown) { setEditGoodError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setEditGoodSaving(false); }
  };

  const totalPages = goods ? Math.ceil(goods.total / goods.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук за назвою, артикулом, штрихкодом..." className="pl-9" />
        </div>
        <XlsxImportButton
          templateType="goods"
          importUrl="/xlsx/import/goods"
          onImportComplete={load}
        />
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setError(''); setModal(true); }}>
          Товар
        </Button>
      </div>

      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Назва / Артикул</TableHead>
                <TableHead>Категорія</TableHead>
                <TableHead>Тип</TableHead>
                <TableHead>Од.</TableHead>
                <TableHead>Закупка, ₴</TableHead>
                <TableHead>Продаж, ₴</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && goods?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState icon={Package} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && goods?.items.map(g => (
                <TableRow
                  key={g.id}
                  className={`cursor-pointer ${selectedGood?.id === g.id ? 'bg-secondary' : ''}`}
                  onClick={() => selectGood(selectedGood?.id === g.id ? null : g)}
                >
                  <TableCell>
                    <p className="text-[13px] font-medium text-foreground">{g.name}</p>
                    {g.sku && <p className="text-[12px] text-muted-foreground mt-0.5">Арт: {g.sku}</p>}
                    {g.barcode && <p className="text-[12px] text-muted-foreground">Штрих: {g.barcode}</p>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.category ?? '—'}</TableCell>
                  <TableCell>
                    {g.goodType
                      ? <Badge variant={GOOD_TYPE_BADGE[g.goodType] ?? 'secondary'}>{GOOD_TYPE_LABELS[g.goodType] ?? g.goodType}</Badge>
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.unit}</TableCell>
                  <TableCell className="text-muted-foreground">{g.purchasePrice != null ? g.purchasePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 }) : '—'}</TableCell>
                  <TableCell className="font-medium text-foreground">{g.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditGood(g); }}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={e => { e.stopPropagation(); setConfirmDeleteId(g.id); }}
                        className="text-destructive/60 hover:text-destructive"
                        title="Помітити на видалення"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedGood}
          onClose={() => selectGood(null)}
          title={selectedGood?.name ?? ''}
        >
          {selectedGood && (
            <div className="space-y-3 text-sm">
              {/* Detail tabs */}
              <div className="flex gap-1 bg-secondary rounded-lg p-0.5 mb-3">
                {([
                  { key: 'info' as const, label: 'Інформація', icon: Package },
                  { key: 'barcodes' as const, label: 'Штрихкоди', icon: Barcode },
                  { key: 'batches' as const, label: 'Партії', icon: Layers },
                ] as const).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => { setGoodDetailTab(key); if (key === 'barcodes') loadBarcodes(selectedGood.id); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] font-medium transition-colors ${goodDetailTab === key ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Info tab */}
              {goodDetailTab === 'info' && (
                <div className="space-y-3">
                  {selectedGood.sku && (
                    <div>
                      <span className="text-muted-foreground">Артикул:</span>{' '}
                      <span className="text-foreground font-mono">{selectedGood.sku}</span>
                    </div>
                  )}
                  {selectedGood.goodType && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Тип:</span>
                      <Badge variant={GOOD_TYPE_BADGE[selectedGood.goodType] ?? 'secondary'}>
                        {GOOD_TYPE_LABELS[selectedGood.goodType] ?? selectedGood.goodType}
                      </Badge>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Одиниця:</span>{' '}
                    <span className="text-foreground">{selectedGood.unit}</span>
                  </div>
                  {selectedGood.purchasePrice != null && (
                    <div>
                      <span className="text-muted-foreground">Ціна закупки:</span>{' '}
                      <span className="text-foreground">
                        {selectedGood.purchasePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Ціна продажу:</span>{' '}
                    <span className="text-foreground font-semibold">
                      {selectedGood.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                    </span>
                  </div>
                  {selectedGood.category && (
                    <div>
                      <span className="text-muted-foreground">Категорія:</span>{' '}
                      <span className="text-foreground">{selectedGood.category}</span>
                    </div>
                  )}
                  {selectedGood.barcode && (
                    <div>
                      <span className="text-muted-foreground">Штрихкод:</span>{' '}
                      <span className="text-foreground font-mono">{selectedGood.barcode}</span>
                    </div>
                  )}
                  {selectedGood.preferredSupplierName && (
                    <div>
                      <span className="text-muted-foreground">Постачальник:</span>{' '}
                      <span className="text-foreground">{selectedGood.preferredSupplierName}</span>
                    </div>
                  )}
                  {selectedGood.notes && (
                    <div>
                      <p className="text-muted-foreground mb-1">Нотатки:</p>
                      <p className="text-foreground italic">{selectedGood.notes}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Batches tab */}
              {goodDetailTab === 'batches' && (
                <div className="space-y-3">
                  <p className="text-[12px] text-muted-foreground">
                    Партії надходження та цінова історія товару.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    leftIcon={<Layers className="h-3.5 w-3.5" />}
                    onClick={() => setBatchViewerGoodId(selectedGood.id)}
                  >
                    Відкрити Batch Viewer
                  </Button>
                </div>
              )}

              {/* Barcodes tab */}
              {goodDetailTab === 'barcodes' && (
                <div className="space-y-3">
                  {barcodesLoading ? (
                    <div className="flex justify-center py-4"><Spinner size="sm" /></div>
                  ) : (
                    <>
                      {barcodes.length === 0 && (
                        <p className="text-[12px] text-muted-foreground text-center py-3">Штрихкоди відсутні</p>
                      )}
                      {barcodes.map(bc => (
                        <div key={bc.id} className="flex items-center justify-between gap-2 bg-secondary rounded-lg px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-mono text-foreground truncate">{bc.barcode}</p>
                            <p className="text-[11px] text-muted-foreground">{bc.type}</p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {bc.isPrimary && (
                              <span title="Основний">
                                <Star className="h-3.5 w-3.5 text-amber-400 fill-current" />
                              </span>
                            )}
                            <button
                              onClick={() => deleteBarcode(selectedGood.id, bc.id)}
                              className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors"
                              title="Видалити"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  {/* Add barcode form */}
                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Додати штрихкод</p>
                    <Input
                      placeholder="Штрихкод"
                      value={newBarcode}
                      onChange={e => setNewBarcode(e.target.value)}
                    />
                    <Select value={newBarcodeType} onChange={e => setNewBarcodeType(e.target.value)}>
                      {['EAN13', 'UPC', 'QR', 'CODE128'].map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={!newBarcode.trim() || addingBarcode}
                      loading={addingBarcode}
                      onClick={() => addBarcode(selectedGood.id)}
                    >
                      Додати
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Batch Viewer Modal */}
      {batchViewerGoodId && (
        <BatchViewerModal
          goodId={batchViewerGoodId}
          open={!!batchViewerGoodId}
          onClose={() => setBatchViewerGoodId(null)}
        />
      )}

      {/* Confirm mark-for-deletion dialog */}
      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Помітити товар на видалення"
        footer={
          <div className="flex gap-2 w-full">
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteId(null)}
              className="flex-1"
            >
              Скасувати
            </Button>
            <Button
              variant="destructive"
              loading={saving}
              onClick={() => confirmDeleteId && markForDeletion(confirmDeleteId)}
              className="flex-1"
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              Помітити на видалення
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">
          Товар буде позначено як видалений (soft delete). Він зникне зі списків, але залишиться в базі даних для архіву.
        </p>
      </Modal>

      <Modal open={!!editGood} onClose={() => setEditGood(null)} title="Редагування товару"
        footer={
          <>
            <Button onClick={saveEditGood} loading={editGoodSaving} disabled={!editGoodForm.name || !editGoodForm.salePrice}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={() => setEditGood(null)}>Скасувати</Button>
          </>
        }
      >
        {editGoodError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{editGoodError}</div>
        )}
        <div className="space-y-4">
          <Input label="Назва" required value={editGoodForm.name} onChange={e => setEditGoodForm(f => ({ ...f, name: e.target.value }))} placeholder="Масло моторне 5W-40" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Артикул (SKU)" value={editGoodForm.sku} onChange={e => setEditGoodForm(f => ({ ...f, sku: e.target.value }))} placeholder="OIL-5W40" />
            {units.length > 0 ? (
              <Select label="Одиниця виміру" value={editGoodForm.unitId} onChange={e => {
                const unit = units.find(u => u.id === e.target.value);
                setEditGoodForm(f => ({ ...f, unitId: e.target.value, unit: unit?.shortName ?? f.unit }));
              }}>
                <option value="">— вписати вручну</option>
                {units.map(u => <option key={u.id} value={u.id}>{u.shortName} ({u.name})</option>)}
              </Select>
            ) : (
              <Input label="Одиниця" value={editGoodForm.unit} onChange={e => setEditGoodForm(f => ({ ...f, unit: e.target.value }))} placeholder="шт" />
            )}
          </div>
          {units.length > 0 && !editGoodForm.unitId && (
            <Input label="Одиниця (вручну)" value={editGoodForm.unit} onChange={e => setEditGoodForm(f => ({ ...f, unit: e.target.value }))} placeholder="шт" />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Ціна закупки, ₴" type="number" value={editGoodForm.purchasePrice} onChange={e => setEditGoodForm(f => ({ ...f, purchasePrice: e.target.value }))} placeholder="350" />
            <Input label="Ціна продажу, ₴" required type="number" value={editGoodForm.salePrice} onChange={e => setEditGoodForm(f => ({ ...f, salePrice: e.target.value }))} placeholder="500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Бренд" value={editGoodForm.brandId} onChange={e => setEditGoodForm(f => ({ ...f, brandId: e.target.value }))}>
              <option value="">—</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Input label="Категорія" value={editGoodForm.category} onChange={e => setEditGoodForm(f => ({ ...f, category: e.target.value }))} placeholder="Мастила" />
          </div>
          <Select label="Тип товару" value={editGoodForm.goodType} onChange={e => setEditGoodForm(f => ({ ...f, goodType: e.target.value }))}>
            <option value="">Не вказано</option>
            <option value="SPARE_PART">Запчастина</option>
            <option value="CONSUMABLE">Витратний матеріал</option>
            <option value="MATERIAL">Матеріал</option>
            <option value="TOOL">Інструмент</option>
          </Select>
          <Select label="Основний постачальник" value={editGoodForm.preferredSupplierId} onChange={e => setEditGoodForm(f => ({ ...f, preferredSupplierId: e.target.value }))}>
            <option value="">— Не вказано —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Input label="Нотатки" value={editGoodForm.notes} onChange={e => setEditGoodForm(f => ({ ...f, notes: e.target.value }))} />
        </div>
      </Modal>

      <Modal open={modal} onClose={() => setModal(false)} title="Новий товар / запчастина"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.salePrice} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Масло моторне 5W-40"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Артикул (SKU)"
              value={form.sku}
              onChange={e => setForm(f => ({ ...f, sku: e.target.value }))}
              placeholder="OIL-5W40"
            />
            {units.length > 0 ? (
              <Select
                label="Одиниця виміру"
                value={form.unitId}
                onChange={e => {
                  const unit = units.find(u => u.id === e.target.value);
                  setForm(f => ({ ...f, unitId: e.target.value, unit: unit?.shortName ?? f.unit }));
                }}
              >
                <option value="">— вписати вручну</option>
                {units.map(u => <option key={u.id} value={u.id}>{u.shortName} ({u.name})</option>)}
              </Select>
            ) : (
              <Input
                label="Одиниця"
                value={form.unit}
                onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                placeholder="шт"
              />
            )}
          </div>
          {units.length > 0 && !form.unitId && (
            <Input
              label="Одиниця (вручну)"
              value={form.unit}
              onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
              placeholder="шт"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ціна закупки, ₴"
              type="number"
              value={form.purchasePrice}
              onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
              placeholder="350"
            />
            <Input
              label="Ціна продажу, ₴"
              required
              type="number"
              value={form.salePrice}
              onChange={e => setForm(f => ({ ...f, salePrice: e.target.value }))}
              placeholder="500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Бренд"
              value={form.brandId}
              onChange={e => setForm(f => ({ ...f, brandId: e.target.value }))}
            >
              <option value="">—</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Input
              label="Категорія"
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="Мастила"
            />
          </div>
          <Select
            label="Тип товару"
            value={form.goodType}
            onChange={e => setForm(f => ({ ...f, goodType: e.target.value }))}
          >
            <option value="">Не вказано</option>
            <option value="SPARE_PART">Запчастина</option>
            <option value="CONSUMABLE">Витратний матеріал</option>
            <option value="MATERIAL">Матеріал</option>
            <option value="TOOL">Інструмент</option>
          </Select>
          <Select
            label="Основний постачальник"
            value={form.preferredSupplierId}
            onChange={e => setForm(f => ({ ...f, preferredSupplierId: e.target.value }))}
          >
            <option value="">— Не вказано —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Input
            label="Штрихкод"
            value={form.barcode}
            onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))}
            placeholder="4820000000000"
          />
          <Input
            label="Нотатки"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          />
        </div>
      </Modal>
    </div>
  );
}

// ─── Services Tab ─────────────────────────────────────────────────────────────

function ServicesTab() {
  const [services, setServices] = useState<PaginatedServices | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', price: '' });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (q) p.set('q', q);
    apiFetch<PaginatedServices>(`/services?${p}`).then(setServices).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, q]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch<Service>('/services', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          price: form.price ? Number(form.price) : undefined,
        }),
      });
      setModal(false);
      setForm({ name: '', description: '', price: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити послугу?')) return;
    setDeletingId(id); setError('');
    try {
      await apiFetch<void>(`/services/${id}`, { method: 'DELETE' });
      if (selectedService?.id === id) setSelectedService(null);
      load();
    }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  const totalPages = services ? Math.ceil(services.total / services.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук послуг..." className="pl-9" />
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setError(''); setModal(true); }}>
          Послуга
        </Button>
      </div>

      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Назва</TableHead>
                <TableHead>Роботи</TableHead>
                <TableHead>Товари</TableHead>
                <TableHead>Ціна, ₴</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && services?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState icon={Layers} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && services?.items.map(s => (
                <TableRow
                  key={s.id}
                  className={`cursor-pointer ${selectedService?.id === s.id ? 'bg-secondary' : ''}`}
                  onClick={() => setSelectedService(prev => prev?.id === s.id ? null : s)}
                >
                  <TableCell>
                    <p className="text-[13px] font-medium text-foreground">{s.name}</p>
                    {s.description && <p className="text-[12px] text-muted-foreground mt-0.5">{s.description}</p>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.works.length > 0 ? s.works.map(w => w.workName).join(', ') : '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{s.goods.length > 0 ? s.goods.map(g => g.goodName).join(', ') : '—'}</TableCell>
                  <TableCell className="font-medium text-foreground">
                    {s.price != null ? s.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 }) : 'авто'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); remove(s.id); }}
                      disabled={deletingId === s.id}
                      loading={deletingId === s.id}
                      className="text-destructive/60 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedService}
          onClose={() => setSelectedService(null)}
          title={selectedService?.name ?? ''}
        >
          {selectedService && (
            <div className="space-y-4 text-sm">
              {selectedService.price != null ? (
                <div>
                  <span className="text-muted-foreground">Ціна:</span>{' '}
                  <span className="text-foreground font-semibold">
                    {selectedService.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                  </span>
                </div>
              ) : (
                <div>
                  <span className="text-muted-foreground">Ціна:</span>{' '}
                  <span className="text-foreground italic">авто (з позицій)</span>
                </div>
              )}

              {selectedService.works.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Роботи ({selectedService.works.length})
                  </p>
                  <div className="space-y-1.5">
                    {selectedService.works.map((w, i) => (
                      <div key={i} className="text-xs bg-secondary rounded-lg px-3 py-2">
                        <p className="font-medium text-foreground">{w.workName}</p>
                        <p className="text-muted-foreground mt-0.5">
                          {w.quantity} × {w.normoHours} нормо-год · {w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedService.goods.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Товари ({selectedService.goods.length})
                  </p>
                  <div className="space-y-1.5">
                    {selectedService.goods.map((g, i) => (
                      <div key={i} className="text-xs bg-secondary rounded-lg px-3 py-2">
                        <p className="font-medium text-foreground">{g.goodName}</p>
                        <p className="text-muted-foreground mt-0.5">
                          {g.quantity} {g.unit} · {g.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <Modal open={modal} onClose={() => setModal(false)} title="Нова комплексна послуга"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="ТО-1 (20 000 км)"
          />
          <Input
            label="Опис"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          />
          <Input
            label="Фіксована ціна, ₴ (не заповнювати = авто)"
            type="number"
            value={form.price}
            onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
            placeholder="2500"
          />
          <p className="text-[12px] text-muted-foreground">Роботи та товари можна додати після створення</p>
        </div>
      </Modal>
    </div>
  );
}

// ─── Units Tab ────────────────────────────────────────────────────────────────

function UnitsTab() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: '', shortName: '', coefficient: '1', width: '', height: '', depth: '', volume: '', weight: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<Unit[]>('/units')
      .then(setUnits)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name.trim() || !form.shortName.trim()) { setError('Усі поля є обов\'язковими'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch<Unit>('/units', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          shortName: form.shortName.trim(),
          coefficient: form.coefficient ? Number(form.coefficient) : undefined,
          width: form.width ? Number(form.width) : undefined,
          height: form.height ? Number(form.height) : undefined,
          depth: form.depth ? Number(form.depth) : undefined,
          volume: form.volume ? Number(form.volume) : undefined,
          weight: form.weight ? Number(form.weight) : undefined,
        }),
      });
      setModal(false);
      setForm({ name: '', shortName: '', coefficient: '1', width: '', height: '', depth: '', volume: '', weight: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити одиницю виміру?')) return;
    try {
      await apiFetch<void>(`/units/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
  };

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[13px] text-muted-foreground">Одиниці виміру, що використовуються в каталозі товарів</p>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setError(''); setModal(true); }}>
          Одиниця
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Скорочення</TableHead>
              <TableHead>Назва</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center">
                  <div className="flex justify-center"><Spinner size="md" /></div>
                </TableCell>
              </TableRow>
            )}
            {!loading && units.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState icon={Ruler} title="Одиниці відсутні" />
                </TableCell>
              </TableRow>
            )}
            {!loading && units.map(u => (
              <TableRow key={u.id}>
                <TableCell className="font-medium text-foreground">{u.shortName}</TableCell>
                <TableCell className="text-muted-foreground">{u.name}</TableCell>
                <TableCell>
                  {u.isSystem
                    ? <span className="text-[11px] px-1.5 py-0.5 bg-info-subtle text-info rounded">системна</span>
                    : <span className="text-[11px] px-1.5 py-0.5 bg-secondary text-muted-foreground rounded">власна</span>}
                </TableCell>
                <TableCell className="text-right">
                  {!u.isSystem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(u.id)}
                      className="text-destructive/60 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title="Нова одиниця виміру"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.shortName} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Input
            label="Скорочення"
            required
            value={form.shortName}
            onChange={e => setForm(f => ({ ...f, shortName: e.target.value }))}
            placeholder="шт"
          />
          <Input
            label="Повна назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="штука"
          />
          <Input
            label="Коефіцієнт"
            type="number"
            value={form.coefficient}
            onChange={e => setForm(f => ({ ...f, coefficient: e.target.value }))}
            placeholder="1"
            hint="Коефіцієнт перерахунку до базової одиниці"
          />
          <div className="grid grid-cols-3 gap-2">
            <Input label="Ширина, м" type="number" value={form.width} onChange={e => setForm(f => ({ ...f, width: e.target.value }))} placeholder="0.0" />
            <Input label="Висота, м" type="number" value={form.height} onChange={e => setForm(f => ({ ...f, height: e.target.value }))} placeholder="0.0" />
            <Input label="Глибина, м" type="number" value={form.depth} onChange={e => setForm(f => ({ ...f, depth: e.target.value }))} placeholder="0.0" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Об'єм, м³" type="number" value={form.volume} onChange={e => setForm(f => ({ ...f, volume: e.target.value }))} placeholder="0.0" />
            <Input label="Вага, кг" type="number" value={form.weight} onChange={e => setForm(f => ({ ...f, weight: e.target.value }))} placeholder="0.0" />
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── Brands Tab ───────────────────────────────────────────────────────────────

function BrandsTab() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [form, setForm] = useState({ name: '' });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200')
      .then(r => setBrands(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditBrand(null); setForm({ name: '' }); setError(''); setModal(true); };
  const openEdit = (b: Brand) => { setEditBrand(b); setForm({ name: b.name }); setError(''); setModal(true); };

  const save = async () => {
    if (!form.name.trim()) { setError('Назва є обов\'язковою'); return; }
    setSaving(true); setError('');
    try {
      if (editBrand) {
        await apiFetch<Brand>(`/brands/${editBrand.id}`, { method: 'PATCH', body: JSON.stringify({ name: form.name.trim() }) });
      } else {
        await apiFetch<Brand>('/brands', { method: 'POST', body: JSON.stringify({ name: form.name.trim() }) });
      }
      setModal(false);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити бренд? Товари з цим брендом не будуть видалені.')) return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/brands/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[13px] text-muted-foreground">Бренди та виробники запчастин і товарів</p>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
          Бренд
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва бренду</TableHead>
              <TableHead className="text-right">Дії</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={2} className="py-10 text-center">
                  <div className="flex justify-center"><Spinner size="md" /></div>
                </TableCell>
              </TableRow>
            )}
            {!loading && brands.length === 0 && (
              <TableRow>
                <TableCell colSpan={2} className="p-0">
                  <EmptyState icon={Tag} title="Бренди відсутні" description="Додайте перший бренд" />
                </TableCell>
              </TableRow>
            )}
            {!loading && brands.map(b => (
              <TableRow key={b.id}>
                <TableCell className="font-medium text-foreground">{b.name}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(b)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={deletingId === b.id}
                      onClick={() => remove(b.id)}
                      className="text-destructive/60 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editBrand ? 'Редагувати бренд' : 'Новий бренд'}
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name.trim()} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <Input
          label="Назва бренду"
          required
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="наприклад: Bosch, NGK, Brembo"
          autoFocus
        />
      </Modal>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string }[] = [
  { key: 'works', label: 'Роботи' },
  { key: 'goods', label: 'Товари та запчастини' },
  { key: 'services', label: 'Комплексні послуги' },
  { key: 'units', label: 'Одиниці виміру' },
  { key: 'brands', label: 'Бренди' },
];

export default function CatalogPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER']);
  const [tab, setTab] = useState<Tab>('works');

  return (
    <div className="page-container">
      <h1 className="page-title mb-6">Каталог</h1>

      <div className="flex gap-1 bg-secondary rounded-lg p-1 mb-6 w-fit">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-[13px] font-medium transition-colors ${tab === t.key ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'works' && <WorksTab />}
      {tab === 'goods' && <GoodsTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'brands' && <BrandsTab />}
    </div>
  );
}
