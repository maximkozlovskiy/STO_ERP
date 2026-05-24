'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Search, Trash2, BookOpen, Package, Layers } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel } from '@/components/ui/detail-panel';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category { id: string; name: string; children: Category[]; }
interface Work { id: string; categoryId: string; categoryName: string; name: string; normoHours: number; price: number; description: string | null; }
interface PaginatedWorks { items: Work[]; total: number; page: number; limit: number; }
interface Brand { id: string; name: string; }
interface Good { id: string; sku: string | null; name: string; unit: string; purchasePrice: number | null; salePrice: number; category: string | null; barcode: string | null; brandId: string | null; notes: string | null; }
interface PaginatedGoods { items: Good[]; total: number; page: number; limit: number; }
interface ServiceWork { workId: string; workName: string; normoHours: number; price: number; quantity: number; }
interface ServiceGood { goodId: string; goodName: string; unit: string; salePrice: number; quantity: number; }
interface Service { id: string; name: string; description: string | null; price: number | null; works: ServiceWork[]; goods: ServiceGood[]; }
interface PaginatedServices { items: Service[]; total: number; page: number; limit: number; }

type Tab = 'works' | 'goods' | 'services';

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
  const [form, setForm] = useState({ categoryId: '', name: '', normoHours: '', price: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedWork, setSelectedWork] = useState<Work | null>(null);

  useEffect(() => {
    apiFetch<Category[]>('/work-categories').then(setCategories).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження категорій'));
  }, []);

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
        }),
      });
      setModal(false);
      setForm({ categoryId: '', name: '', normoHours: '', price: '', description: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити роботу?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/works/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const flat = flatCategories(categories);
  const totalPages = works ? Math.ceil(works.total / works.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук робіт..." className="pl-9" />
        </div>
        <Select value={selectedCat} onChange={e => { setSelectedCat(e.target.value); setPage(1); }}>
          <option value="">Всі категорії</option>
          {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
        </Select>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setForm({ categoryId: flat[0]?.id ?? '', name: '', normoHours: '', price: '', description: '' }); setError(''); setModal(true); }}>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); remove(w.id); }}
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
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
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
        </div>
      </Modal>
    </div>
  );
}

// ─── Goods Tab ────────────────────────────────────────────────────────────────

function GoodsTab() {
  const [goods, setGoods] = useState<PaginatedGoods | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ sku: '', name: '', unit: 'шт', purchasePrice: '', salePrice: '', category: '', brandId: '', barcode: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedGood, setSelectedGood] = useState<Good | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Brand[]>('/brands').then(setBrands).catch((e: unknown) => console.error('Помилка завантаження брендів', e));
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
          purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
          salePrice,
          category: form.category || undefined,
          brandId: form.brandId || undefined,
          barcode: form.barcode || undefined,
          notes: form.notes || undefined,
        }),
      });
      setModal(false);
      setForm({ sku: '', name: '', unit: 'шт', purchasePrice: '', salePrice: '', category: '', brandId: '', barcode: '', notes: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
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

  const totalPages = goods ? Math.ceil(goods.total / goods.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук за назвою, артикулом, штрихкодом..." className="pl-9" />
        </div>
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
                <TableHead>Од.</TableHead>
                <TableHead>Закупка, ₴</TableHead>
                <TableHead>Продаж, ₴</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && goods?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="p-0">
                    <EmptyState icon={Package} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && goods?.items.map(g => (
                <TableRow
                  key={g.id}
                  className={`cursor-pointer ${selectedGood?.id === g.id ? 'bg-secondary' : ''}`}
                  onClick={() => setSelectedGood(prev => prev?.id === g.id ? null : g)}
                >
                  <TableCell>
                    <p className="text-[13px] font-medium text-foreground">{g.name}</p>
                    {g.sku && <p className="text-[12px] text-muted-foreground mt-0.5">Арт: {g.sku}</p>}
                    {g.barcode && <p className="text-[12px] text-muted-foreground">Штрих: {g.barcode}</p>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.category ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{g.unit}</TableCell>
                  <TableCell className="text-muted-foreground">{g.purchasePrice != null ? g.purchasePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 }) : '—'}</TableCell>
                  <TableCell className="font-medium text-foreground">{g.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); setConfirmDeleteId(g.id); }}
                      className="text-destructive/60 hover:text-destructive"
                      title="Помітити на видалення"
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
          open={!!selectedGood}
          onClose={() => setSelectedGood(null)}
          title={selectedGood?.name ?? ''}
        >
          {selectedGood && (
            <div className="space-y-3 text-sm">
              {selectedGood.sku && (
                <div>
                  <span className="text-muted-foreground">Артикул:</span>{' '}
                  <span className="text-foreground font-mono">{selectedGood.sku}</span>
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
              {selectedGood.notes && (
                <div>
                  <p className="text-muted-foreground mb-1">Нотатки:</p>
                  <p className="text-foreground italic">{selectedGood.notes}</p>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

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

      <Modal open={modal} onClose={() => setModal(false)} title="Новий товар / запчастина"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.salePrice} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
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
            <Input
              label="Одиниця"
              value={form.unit}
              onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
              placeholder="шт"
            />
          </div>
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
    setSaving(true); setError('');
    try {
      await apiFetch<void>(`/services/${id}`, { method: 'DELETE' });
      if (selectedService?.id === id) setSelectedService(null);
      load();
    }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const totalPages = services ? Math.ceil(services.total / services.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">{error}</div>
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
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string }[] = [
  { key: 'works', label: 'Роботи' },
  { key: 'goods', label: 'Товари та запчастини' },
  { key: 'services', label: 'Комплексні послуги' },
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
    </div>
  );
}
