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
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category { id: string; name: string; children: Category[]; }
interface Work { id: string; categoryId: string; categoryName: string; name: string; normoHours: number; price: number; description: string | null; }
interface PaginatedWorks { items: Work[]; total: number; page: number; limit: number; }
interface Good { id: string; sku: string | null; name: string; unit: string; purchasePrice: number | null; salePrice: number; category: string | null; barcode: string | null; notes: string | null; }
interface PaginatedGoods { items: Good[]; total: number; page: number; limit: number; }
interface ServiceWork { workId: string; workName: string; normoHours: number; price: number; quantity: number; }
interface ServiceGood { goodId: string; goodName: string; unit: string; salePrice: number; quantity: number; }
interface Service { id: string; name: string; description: string | null; price: number | null; works: ServiceWork[]; goods: ServiceGood[]; }
interface PaginatedServices { items: Service[]; total: number; page: number; limit: number; }

type Tab = 'works' | 'goods' | 'services';

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
    if (isNaN(normo) || normo <= 0) { setError('Норма-годин повинна бути більше нуля'); return; }
    if (isNaN(price) || price < 0) { setError('Ціна повинна бути невід\'ємним числом'); return; }
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
          {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
        </Select>
        <Button onClick={() => { setForm({ categoryId: flat[0]?.id ?? '', name: '', normoHours: '', price: '', description: '' }); setError(''); setModal(true); }}>
          <Plus className="h-4 w-4" />
          Робота
        </Button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
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
              <TableRow key={w.id}>
                <TableCell>
                  <p className="text-[13px] font-medium text-foreground">{w.name}</p>
                  {w.description && <p className="text-[12px] text-muted-foreground mt-0.5">{w.description}</p>}
                </TableCell>
                <TableCell className="text-muted-foreground">{w.categoryName}</TableCell>
                <TableCell className="text-muted-foreground">{w.normoHours}</TableCell>
                <TableCell className="font-medium text-foreground">{w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => remove(w.id)} className="text-red-400 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${p === page ? 'bg-(--color-primary) text-white border-(--color-primary)' : 'border-(--color-border) text-foreground-muted bg-white hover:bg-(--color-secondary)'}`}>
              {p}
            </button>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="Нова робота">
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Категорія <span className="text-red-500">*</span></label>
            <Select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}>
              {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Заміна масла" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Нормо-год <span className="text-red-500">*</span></label>
              <Input type="number" value={form.normoHours} onChange={e => setForm(f => ({ ...f, normoHours: e.target.value }))} placeholder="1.5" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна, ₴ <span className="text-red-500">*</span></label>
              <Input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="500" />
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Опис</label>
            <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.name || !form.categoryId || !form.normoHours || !form.price}
            className="w-full"
          >
            Зберегти
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ─── Goods Tab ────────────────────────────────────────────────────────────────

function GoodsTab() {
  const [goods, setGoods] = useState<PaginatedGoods | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ sku: '', name: '', unit: 'шт', purchasePrice: '', salePrice: '', category: '', barcode: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (q) p.set('q', q);
    apiFetch<PaginatedGoods>(`/goods?${p}`).then(setGoods).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, q]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const salePrice = Number(form.salePrice);
    if (isNaN(salePrice) || salePrice < 0) { setError('Ціна продажу повинна бути невід\'ємним числом'); return; }
    if (form.purchasePrice) {
      const pp = Number(form.purchasePrice);
      if (isNaN(pp) || pp < 0) { setError('Ціна закупівлі повинна бути невід\'ємним числом'); return; }
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
          barcode: form.barcode || undefined,
          notes: form.notes || undefined,
        }),
      });
      setModal(false);
      setForm({ sku: '', name: '', unit: 'шт', purchasePrice: '', salePrice: '', category: '', barcode: '', notes: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити товар?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/goods/${id}`, { method: 'DELETE' }); load(); }
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
        <Button onClick={() => { setError(''); setModal(true); }}>
          <Plus className="h-4 w-4" />
          Товар
        </Button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
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
              <TableRow key={g.id}>
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
                  <Button variant="ghost" size="sm" onClick={() => remove(g.id)} className="text-red-400 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${p === page ? 'bg-(--color-primary) text-white border-(--color-primary)' : 'border-(--color-border) text-foreground-muted bg-white hover:bg-(--color-secondary)'}`}>
              {p}
            </button>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="Новий товар / запчастина">
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Масло моторне 5W-40" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Артикул (SKU)</label>
              <Input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} placeholder="OIL-5W40" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Одиниця</label>
              <Input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="шт" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна закупки, ₴</label>
              <Input type="number" value={form.purchasePrice} onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))} placeholder="350" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна продажу, ₴ <span className="text-red-500">*</span></label>
              <Input type="number" value={form.salePrice} onChange={e => setForm(f => ({ ...f, salePrice: e.target.value }))} placeholder="500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Категорія</label>
              <Input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="Мастила" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">Штрихкод</label>
              <Input value={form.barcode} onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))} placeholder="4820000000000" />
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Нотатки</label>
            <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <Button onClick={create} loading={saving} disabled={!form.name || !form.salePrice} className="w-full">
            Зберегти
          </Button>
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
    try { await apiFetch<void>(`/services/${id}`, { method: 'DELETE' }); load(); }
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
        <Button onClick={() => { setError(''); setModal(true); }}>
          <Plus className="h-4 w-4" />
          Послуга
        </Button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
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
              <TableRow key={s.id}>
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
                  <Button variant="ghost" size="sm" onClick={() => remove(s.id)} className="text-red-400 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${p === page ? 'bg-(--color-primary) text-white border-(--color-primary)' : 'border-(--color-border) text-foreground-muted bg-white hover:bg-(--color-secondary)'}`}>
              {p}
            </button>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="Нова комплексна послуга">
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="ТО-1 (20 000 км)" />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Опис</label>
            <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Фіксована ціна, ₴ (не заповнювати = авто)</label>
            <Input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="2500" />
          </div>
          <p className="text-[12px] text-muted-foreground">Роботи та товари можна додати після створення</p>
          <Button onClick={create} loading={saving} disabled={!form.name} className="w-full">
            Зберегти
          </Button>
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
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="page-title mb-6">Каталог</h1>

      <div className="flex gap-1 bg-(--color-secondary) rounded-lg p-1 mb-6 w-fit">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-[13px] font-medium transition-colors ${tab === t.key ? 'bg-white text-foreground shadow-sm' : 'text-foreground-muted hover:text-foreground'}`}
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
