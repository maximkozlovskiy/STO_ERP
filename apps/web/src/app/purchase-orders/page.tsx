'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Supplier { id: string; firstName?: string; lastName?: string; companyName?: string; }
interface Warehouse { id: string; name: string; }
interface Good { id: string; name: string; sku: string | null; unit: string; purchasePrice: number | null; }
interface POLine {
  id?: string; goodId: string; goodName?: string; goodSku?: string | null; unit?: string;
  quantity: number; price: number; amount?: number; receivedQty?: number;
}
interface PurchaseOrder {
  id: string; number: string; status: string;
  supplierId: string; supplierName?: string;
  warehouseId: string; warehouseName?: string;
  totalAmount: number; notes: string | null;
  lines: POLine[];
  createdAt: string; updatedAt: string;
}
interface Paginated { items: PurchaseOrder[]; total: number; page: number; limit: number; }

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ORDERED: 'Замовлено', PARTIAL: 'Частково', RECEIVED: 'Отримано', CANCELLED: 'Скасовано',
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  ORDERED: 'bg-blue-100 text-blue-700',
  PARTIAL: 'bg-amber-100 text-amber-700',
  RECEIVED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-600',
};
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [], CANCELLED: [],
};
const STATUS_ACTION_LABELS: Record<string, string> = {
  ORDERED: 'Підтвердити замовлення', RECEIVED: 'Позначити отриманим',
  CANCELLED: 'Скасувати', PARTIAL: 'Часткове отримання',
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

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

export default function PurchaseOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<PurchaseOrder | null>(null);
  const [showReceive, setShowReceive] = useState<PurchaseOrder | null>(null);

  // Create form
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [form, setForm] = useState({ supplierId: '', warehouseId: '', notes: '' });
  const [lines, setLines] = useState<{ goodId: string; quantity: string; price: string }[]>([]);
  const [saving, setSaving] = useState(false);

  // Receive form
  const [receiveLines, setReceiveLines] = useState<{ lineId: string; receivedQty: string }[]>([]);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status) params.set('status', status);
      const data: Paginated = await apiFetch(`/purchase-orders?${params}`);
      setOrders(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (showCreate) {
      Promise.all([
        apiFetch('/counterparties?type=SUPPLIER&limit=100'),
        apiFetch('/warehouses'),
        apiFetch('/goods?limit=200'),
      ]).then(([s, w, g]) => {
        setSuppliers(s.items ?? s);
        setWarehouses(w.items ?? w);
        setGoods(g.items ?? g);
      }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    }
  }, [showCreate]);

  const handleCreate = async () => {
    setSaving(true);
    try {
      await apiFetch('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: form.supplierId, warehouseId: form.warehouseId, notes: form.notes || undefined,
          lines: lines.filter(l => l.goodId).map(l => ({
            goodId: l.goodId, quantity: parseFloat(l.quantity) || 1, price: parseFloat(l.price) || 0,
          })),
        }),
      });
      setShowCreate(false);
      setForm({ supplierId: '', warehouseId: '', notes: '' });
      setLines([]);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally { setSaving(false); }
  };

  const handleTransition = async (po: PurchaseOrder, newStatus: string) => {
    if (!confirm(`Перевести замовлення ${po.number} → ${STATUS_LABELS[newStatus]}?`)) return;
    try {
      await apiFetch(`/purchase-orders/${po.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка переходу статусу'); }
  };

  const openReceive = (po: PurchaseOrder) => {
    setReceiveLines(po.lines.map(l => ({ lineId: l.id!, receivedQty: '' })));
    setShowReceive(po);
  };

  const handleReceive = async () => {
    if (!showReceive) return;
    const lines = receiveLines
      .filter(l => parseFloat(l.receivedQty) > 0)
      .map(l => ({ lineId: l.lineId, receivedQty: parseFloat(l.receivedQty) }));
    if (!lines.length) { setError('Вкажіть кількість для хоча б однієї позиції'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch(`/purchase-orders/${showReceive.id}/receive`, {
        method: 'POST', body: JSON.stringify({ lines }),
      });
      setShowReceive(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка прийому товару'); }
    finally { setSaving(false); }
  };

  const addLine = () => setLines(l => [...l, { goodId: '', quantity: '1', price: '' }]);
  const updateLine = (i: number, field: string, value: string) =>
    setLines(l => l.map((x, idx) => idx === i ? { ...x, [field]: value } : x));
  const removeLine = (i: number) => setLines(l => l.filter((_, idx) => idx !== i));

  const statuses = ['', 'DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Замовлення постачальникам</h1>
          <p className="text-gray-500 text-sm mt-0.5">{total} замовлень</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Нове замовлення
        </button>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-2 mb-5">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => { setStatus(s); setPage(1); }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              status === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s ? STATUS_LABELS[s] : 'Всі'}
          </button>
        ))}
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
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Постачальник</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Склад</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Статус</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Сума</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Дата</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-400">Замовлень не знайдено</td></tr>
              ) : orders.map(po => (
                <tr key={po.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono font-medium text-gray-900">{po.number}</td>
                  <td className="px-4 py-3 text-gray-700">{po.supplierName ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{po.warehouseName ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[po.status]}`}>
                      {STATUS_LABELS[po.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium">{fmt(po.totalAmount)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(po.createdAt).toLocaleDateString('uk-UA')}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setShowDetail(po)}
                      className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                    >
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
        <Modal title="Нове замовлення постачальнику" onClose={() => setShowCreate(false)} wide>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник *</label>
              <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="">Оберіть постачальника</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Склад *</label>
              <select value={form.warehouseId} onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="">Оберіть склад</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
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
                    <select value={l.goodId} onChange={e => {
                      const g = goods.find(g => g.id === e.target.value);
                      updateLine(i, 'goodId', e.target.value);
                      if (g?.purchasePrice) updateLine(i, 'price', String(g.purchasePrice));
                    }} className="flex-1 px-2 py-1.5 border rounded text-xs">
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
                {lines.length === 0 && (
                  <p className="text-xs text-gray-400">Замовлення можна створити без позицій і додати їх пізніше</p>
                )}
              </div>
            </div>

            <button
              onClick={handleCreate}
              disabled={!form.supplierId || !form.warehouseId || saving}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Збереження...' : 'Створити замовлення'}
            </button>
          </div>
        </Modal>
      )}

      {/* Detail modal */}
      {showDetail && (
        <Modal title={`Замовлення ${showDetail.number}`} onClose={() => setShowDetail(null)} wide>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[showDetail.status]}`}>
                {STATUS_LABELS[showDetail.status]}
              </span>
              <span className="text-gray-500 text-sm">{showDetail.supplierName}</span>
              <span className="text-gray-400 text-sm">→ {showDetail.warehouseName}</span>
            </div>

            {/* Lines table */}
            <table className="w-full text-xs border border-gray-100 rounded-lg overflow-hidden">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-gray-500">Товар</th>
                  <th className="text-right px-3 py-2 text-gray-500">Замовлено</th>
                  <th className="text-right px-3 py-2 text-gray-500">Отримано</th>
                  <th className="text-right px-3 py-2 text-gray-500">Ціна</th>
                  <th className="text-right px-3 py-2 text-gray-500">Сума</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {showDetail.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-gray-900">{l.goodName}</td>
                    <td className="px-3 py-2 text-right">{l.quantity} {l.unit}</td>
                    <td className={`px-3 py-2 text-right font-medium ${(l.receivedQty ?? 0) >= l.quantity ? 'text-green-600' : 'text-amber-600'}`}>
                      {l.receivedQty ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right">{fmt(l.price)}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmt(l.amount ?? l.quantity * l.price)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-right font-medium">Разом:</td>
                  <td className="px-3 py-2 text-right font-bold">{fmt(showDetail.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>

            {showDetail.notes && (
              <p className="text-sm text-gray-500 italic">{showDetail.notes}</p>
            )}

            {/* FSM actions */}
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              {STATUS_TRANSITIONS[showDetail.status]?.map(s => (
                <button key={s}
                  onClick={() => s === 'RECEIVED' && ['ORDERED', 'PARTIAL'].includes(showDetail.status)
                    ? openReceive(showDetail)
                    : handleTransition(showDetail, s)}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    s === 'CANCELLED' ? 'bg-red-50 text-red-600 hover:bg-red-100' :
                    s === 'RECEIVED' ? 'bg-green-600 text-white hover:bg-green-700' :
                    'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {STATUS_ACTION_LABELS[s] ?? STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* Receive modal */}
      {showReceive && (
        <Modal title={`Прийом по замовленню ${showReceive.number}`} onClose={() => setShowReceive(null)} wide>
          <div className="space-y-4">
            <p className="text-sm text-gray-500">Вкажіть кількість, яку фактично отримано по кожній позиції</p>
            <div className="space-y-3">
              {showReceive.lines.map((line, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">{line.goodName}</div>
                    <div className="text-xs text-gray-500">
                      Замовлено: {line.quantity} {line.unit} · Отримано раніше: {line.receivedQty ?? 0}
                    </div>
                  </div>
                  <input
                    type="number"
                    value={receiveLines[i]?.receivedQty ?? ''}
                    onChange={e => setReceiveLines(ls => ls.map((l, idx) => idx === i ? { ...l, receivedQty: e.target.value } : l))}
                    placeholder={`макс. ${line.quantity - (line.receivedQty ?? 0)}`}
                    min="0"
                    max={line.quantity - (line.receivedQty ?? 0)}
                    step="0.001"
                    className="w-28 px-2 py-1.5 border rounded text-sm text-right"
                  />
                  <span className="text-xs text-gray-400">{line.unit}</span>
                </div>
              ))}
            </div>
            <button
              onClick={handleReceive}
              className="w-full py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
            >
              Підтвердити прийом
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
