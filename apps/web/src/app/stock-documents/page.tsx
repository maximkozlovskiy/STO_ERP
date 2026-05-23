'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Branch { id: string; name: string; }
interface Warehouse { id: string; name: string; }
interface Good { id: string; name: string; sku: string | null; unit: string; }
interface DocLine {
  id?: string; goodId: string; goodName?: string; goodSku?: string | null;
  unit?: string; quantity: number; price: number | null;
}
interface StockDoc {
  id: string; number: string; type: string; status: string;
  branchId: string; branchName?: string;
  warehouseId: string; warehouseName?: string;
  targetWarehouseId?: string | null; targetWarehouseName?: string | null;
  notes: string | null; confirmedAt: string | null;
  lines: DocLine[];
  createdAt: string; updatedAt: string;
}
interface Paginated { items: StockDoc[]; total: number; page: number; limit: number; }

const TYPE_LABELS: Record<string, string> = {
  WRITEOFF: 'Списання', TRANSFER: 'Переміщення', OPENING_BALANCE: 'Поч. залишки',
};
const TYPE_COLORS: Record<string, string> = {
  WRITEOFF: 'bg-red-100 text-red-700',
  TRANSFER: 'bg-blue-100 text-blue-700',
  OPENING_BALANCE: 'bg-purple-100 text-purple-700',
};
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', CONFIRMED: 'Підтверджено', CANCELLED: 'Скасовано',
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  CONFIRMED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-600',
};

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-2xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export default function StockDocumentsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const [docs, setDocs] = useState<StockDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<StockDoc | null>(null);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);

  const [form, setForm] = useState({
    type: 'WRITEOFF', branchId: '', warehouseId: '', targetWarehouseId: '', notes: '',
  });
  const [lines, setLines] = useState<{ goodId: string; quantity: string; price: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);
      const data: Paginated = await apiFetch(`/stock-documents?${params}`);
      setDocs(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (showCreate) {
      Promise.all([
        apiFetch('/branches'),
        apiFetch('/warehouses'),
        apiFetch('/goods?limit=200'),
      ]).then(([b, w, g]) => {
        setBranches(b.items ?? b);
        setWarehouses(w.items ?? w);
        setGoods(g.items ?? g);
      }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    }
  }, [showCreate]);

  const handleCreate = async () => {
    setSaving(true);
    try {
      await apiFetch('/stock-documents', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          branchId: form.branchId,
          warehouseId: form.warehouseId,
          targetWarehouseId: form.targetWarehouseId || undefined,
          notes: form.notes || undefined,
          lines: lines.filter(l => l.goodId).map(l => ({
            goodId: l.goodId,
            quantity: parseFloat(l.quantity) || 1,
            price: l.price ? parseFloat(l.price) : undefined,
          })),
        }),
      });
      setShowCreate(false);
      setForm({ type: 'WRITEOFF', branchId: '', warehouseId: '', targetWarehouseId: '', notes: '' });
      setLines([]);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally { setSaving(false); }
  };

  const handleTransition = async (doc: StockDoc, newStatus: string) => {
    const label = newStatus === 'CONFIRMED' ? 'підтвердити' : 'скасувати';
    if (!confirm(`Бажаєте ${label} документ ${doc.number}?`)) return;
    try {
      await apiFetch(`/stock-documents/${doc.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка зміни статусу'); }
  };

  const addLine = () => setLines(l => [...l, { goodId: '', quantity: '1', price: '' }]);
  const updateLine = (i: number, field: string, value: string) =>
    setLines(l => l.map((x, idx) => idx === i ? { ...x, [field]: value } : x));
  const removeLine = (i: number) => setLines(l => l.filter((_, idx) => idx !== i));

  const types = ['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'];
  const statuses = ['', 'DRAFT', 'CONFIRMED', 'CANCELLED'];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Складські документи</h1>
          <p className="text-gray-500 text-sm mt-0.5">{total} документів</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Новий документ
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="flex gap-2">
          {types.map(t => (
            <button key={t}
              onClick={() => { setTypeFilter(t); setPage(1); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                typeFilter === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t ? TYPE_LABELS[t] : 'Всі типи'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {statuses.map(s => (
            <button key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {s ? STATUS_LABELS[s] : 'Всі статуси'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Завантаження...</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Номер</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Тип</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Склад</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Статус</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Позицій</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Дата</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {docs.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-400">Документів не знайдено</td></tr>
              ) : docs.map(doc => (
                <tr key={doc.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono font-medium text-gray-900">{doc.number}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${TYPE_COLORS[doc.type]}`}>
                      {TYPE_LABELS[doc.type]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {doc.warehouseName}
                    {doc.targetWarehouseName && <span className="text-gray-400"> → {doc.targetWarehouseName}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[doc.status]}`}>
                      {STATUS_LABELS[doc.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">{doc.lines.length}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(doc.createdAt).toLocaleDateString('uk-UA')}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => setShowDetail(doc)}
                      className="text-blue-600 hover:text-blue-800 text-xs font-medium">
                      Деталі
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-2 mt-4">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50">← Назад</button>
          <span className="px-3 py-1.5 text-sm text-gray-500">Стор. {page}</span>
          <button disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50">Вперед →</button>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <Modal title="Новий складський документ" onClose={() => setShowCreate(false)} wide>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Тип документа *</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="WRITEOFF">Списання</option>
                <option value="TRANSFER">Переміщення між складами</option>
                <option value="OPENING_BALANCE">Початкові залишки</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Філія *</label>
              <select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="">Оберіть філію</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {form.type === 'TRANSFER' ? 'Склад (джерело)' : 'Склад'} *
              </label>
              <select value={form.warehouseId} onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="">Оберіть склад</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            {form.type === 'TRANSFER' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Склад призначення *</label>
                <select value={form.targetWarehouseId} onChange={e => setForm(f => ({ ...f, targetWarehouseId: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg text-sm">
                  <option value="">Оберіть склад</option>
                  {warehouses.filter(w => w.id !== form.warehouseId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Примітки</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={2} className="w-full px-3 py-2 border rounded-lg text-sm resize-none" />
            </div>

            {/* Lines */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-gray-700">Позиції</label>
                <button onClick={addLine} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ Додати</button>
              </div>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <select value={l.goodId} onChange={e => updateLine(i, 'goodId', e.target.value)}
                      className="flex-1 px-2 py-1.5 border rounded text-xs">
                      <option value="">Товар</option>
                      {goods.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <input type="number" value={l.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)}
                      placeholder="Кіл." min="0.001" step="0.001"
                      className="w-20 px-2 py-1.5 border rounded text-xs" />
                    <input type="number" value={l.price} onChange={e => updateLine(i, 'price', e.target.value)}
                      placeholder="Ціна" min="0" step="0.01"
                      className="w-24 px-2 py-1.5 border rounded text-xs" />
                    <button onClick={() => removeLine(i)} className="text-red-400 hover:text-red-600 text-sm">×</button>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={handleCreate}
              disabled={!form.branchId || !form.warehouseId || saving}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Збереження...' : 'Створити документ'}
            </button>
          </div>
        </Modal>
      )}

      {/* Detail modal */}
      {showDetail && (
        <Modal title={`${TYPE_LABELS[showDetail.type]} ${showDetail.number}`} onClose={() => setShowDetail(null)} wide>
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${TYPE_COLORS[showDetail.type]}`}>
                {TYPE_LABELS[showDetail.type]}
              </span>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[showDetail.status]}`}>
                {STATUS_LABELS[showDetail.status]}
              </span>
              <span className="text-gray-500 text-sm">{showDetail.warehouseName}</span>
              {showDetail.targetWarehouseName && (
                <span className="text-gray-400 text-sm">→ {showDetail.targetWarehouseName}</span>
              )}
            </div>

            <table className="w-full text-xs border border-gray-100 rounded-lg overflow-hidden">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-gray-500">Товар</th>
                  <th className="text-left px-3 py-2 text-gray-500">Артикул</th>
                  <th className="text-right px-3 py-2 text-gray-500">Кількість</th>
                  <th className="text-right px-3 py-2 text-gray-500">Ціна</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {showDetail.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-gray-900">{l.goodName}</td>
                    <td className="px-3 py-2 text-gray-400 font-mono">{l.goodSku ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-medium">{l.quantity} {l.unit}</td>
                    <td className="px-3 py-2 text-right">{l.price != null ? l.price.toFixed(2) + ' ₴' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {showDetail.notes && (
              <p className="text-sm text-gray-500 italic">{showDetail.notes}</p>
            )}

            {showDetail.confirmedAt && (
              <p className="text-xs text-gray-400">
                Підтверджено: {new Date(showDetail.confirmedAt).toLocaleString('uk-UA')}
              </p>
            )}

            {/* FSM actions */}
            {showDetail.status === 'DRAFT' && (
              <div className="flex gap-2 pt-2 border-t">
                <button
                  onClick={() => handleTransition(showDetail, 'CONFIRMED')}
                  className="flex-1 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
                >
                  Підтвердити документ
                </button>
                <button
                  onClick={() => handleTransition(showDetail, 'CANCELLED')}
                  className="px-4 py-2 bg-red-50 text-red-600 text-sm font-medium rounded-lg hover:bg-red-100 transition-colors"
                >
                  Скасувати
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
