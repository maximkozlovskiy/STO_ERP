'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

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

// ─── Modal ───────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; required?: boolean }) {
  return (
    <div className="mb-3">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}{required && ' *'}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
    setSaving(true); setError('');
    try {
      await apiFetch('/works', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: form.categoryId,
          name: form.name,
          normoHours: Number(form.normoHours),
          price: Number(form.price),
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
    try { await apiFetch(`/works/${id}`, { method: 'DELETE' }); load(); } catch {}
  };

  const flat = flatCategories(categories);
  const totalPages = works ? Math.ceil(works.total / works.limit) : 1;

  return (
    <div>
      {!modal && error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center gap-3 mb-4">
        <input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук робіт..."
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={selectedCat} onChange={e => { setSelectedCat(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">Всі категорії</option>
          {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
        </select>
        <button onClick={() => { setForm({ categoryId: flat[0]?.id ?? '', name: '', normoHours: '', price: '', description: '' }); setError(''); setModal(true); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 whitespace-nowrap">+ Робота</button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              {['Назва', 'Категорія', 'Нормо-год', 'Ціна, ₴', ''].map(h => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">Завантаження...</td></tr>
            )}
            {!loading && works?.items.map(w => (
              <tr key={w.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-900">{w.name}</p>
                  {w.description && <p className="text-xs text-gray-400 mt-0.5">{w.description}</p>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{w.categoryName}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{w.normoHours}</td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => remove(w.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">×</button>
                </td>
              </tr>
            ))}
            {!loading && works?.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">Нічого не знайдено</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1 rounded text-sm ${p === page ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{p}</button>
          ))}
        </div>
      )}

      {modal && (
        <Modal title="Нова робота" onClose={() => setModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Категорія *</label>
            <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
            </select>
          </div>
          <Field label="Назва" required value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Заміна масла" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Нормо-год" required value={form.normoHours} onChange={v => setForm(f => ({ ...f, normoHours: v }))} type="number" placeholder="1.5" />
            <Field label="Ціна, ₴" required value={form.price} onChange={v => setForm(f => ({ ...f, price: v }))} type="number" placeholder="500" />
          </div>
          <Field label="Опис" value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} />
          <button onClick={create} disabled={saving || !form.name || !form.categoryId || !form.normoHours || !form.price}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти'}
          </button>
        </Modal>
      )}
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
    setSaving(true); setError('');
    try {
      await apiFetch('/goods', {
        method: 'POST',
        body: JSON.stringify({
          sku: form.sku || undefined,
          name: form.name,
          unit: form.unit || 'шт',
          purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
          salePrice: Number(form.salePrice),
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
    try { await apiFetch(`/goods/${id}`, { method: 'DELETE' }); load(); } catch {}
  };

  const totalPages = goods ? Math.ceil(goods.total / goods.limit) : 1;

  return (
    <div>
      {!modal && error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center gap-3 mb-4">
        <input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук за назвою, артикулом, штрихкодом..."
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button onClick={() => { setError(''); setModal(true); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 whitespace-nowrap">+ Товар</button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              {['Назва / Артикул', 'Категорія', 'Од.', 'Закупка, ₴', 'Продаж, ₴', ''].map(h => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">Завантаження...</td></tr>
            )}
            {!loading && goods?.items.map(g => (
              <tr key={g.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-900">{g.name}</p>
                  {g.sku && <p className="text-xs text-gray-400 mt-0.5">Арт: {g.sku}</p>}
                  {g.barcode && <p className="text-xs text-gray-400">Штрих: {g.barcode}</p>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{g.category ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{g.unit}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{g.purchasePrice != null ? g.purchasePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 }) : '—'}</td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{g.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => remove(g.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">×</button>
                </td>
              </tr>
            ))}
            {!loading && goods?.items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">Нічого не знайдено</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1 rounded text-sm ${p === page ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{p}</button>
          ))}
        </div>
      )}

      {modal && (
        <Modal title="Новий товар / запчастина" onClose={() => setModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <Field label="Назва" required value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Масло моторне 5W-40" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Артикул (SKU)" value={form.sku} onChange={v => setForm(f => ({ ...f, sku: v }))} placeholder="OIL-5W40" />
            <Field label="Одиниця" value={form.unit} onChange={v => setForm(f => ({ ...f, unit: v }))} placeholder="шт" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ціна закупки, ₴" value={form.purchasePrice} onChange={v => setForm(f => ({ ...f, purchasePrice: v }))} type="number" placeholder="350" />
            <Field label="Ціна продажу, ₴" required value={form.salePrice} onChange={v => setForm(f => ({ ...f, salePrice: v }))} type="number" placeholder="500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Категорія" value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} placeholder="Мастила" />
            <Field label="Штрихкод" value={form.barcode} onChange={v => setForm(f => ({ ...f, barcode: v }))} placeholder="4820000000000" />
          </div>
          <Field label="Нотатки" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} />
          <button onClick={create} disabled={saving || !form.name || !form.salePrice}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти'}
          </button>
        </Modal>
      )}
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
      await apiFetch('/services', {
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
    try { await apiFetch(`/services/${id}`, { method: 'DELETE' }); load(); } catch {}
  };

  const totalPages = services ? Math.ceil(services.total / services.limit) : 1;

  return (
    <div>
      {!modal && error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center gap-3 mb-4">
        <input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Пошук послуг..."
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button onClick={() => { setError(''); setModal(true); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 whitespace-nowrap">+ Послуга</button>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              {['Назва', 'Роботи', 'Товари', 'Ціна, ₴', ''].map(h => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">Завантаження...</td></tr>
            )}
            {!loading && services?.items.map(s => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-900">{s.name}</p>
                  {s.description && <p className="text-xs text-gray-400 mt-0.5">{s.description}</p>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{s.works.length > 0 ? s.works.map(w => w.workName).join(', ') : '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{s.goods.length > 0 ? s.goods.map(g => g.goodName).join(', ') : '—'}</td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  {s.price != null ? s.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 }) : 'авто'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => remove(s.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">×</button>
                </td>
              </tr>
            ))}
            {!loading && services?.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">Нічого не знайдено</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1 rounded text-sm ${p === page ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{p}</button>
          ))}
        </div>
      )}

      {modal && (
        <Modal title="Нова комплексна послуга" onClose={() => setModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <Field label="Назва" required value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="ТО-1 (20 000 км)" />
          <Field label="Опис" value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} />
          <Field label="Фіксована ціна, ₴ (не заповнювати = авто)" value={form.price} onChange={v => setForm(f => ({ ...f, price: v }))} type="number" placeholder="2500" />
          <p className="text-xs text-gray-400 mb-3">Роботи та товари можна додати після створення</p>
          <button onClick={create} disabled={saving || !form.name}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти'}
          </button>
        </Modal>
      )}
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
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Каталог</h1>

      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-6 w-fit">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>
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
