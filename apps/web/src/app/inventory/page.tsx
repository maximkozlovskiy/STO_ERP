'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Warehouse { id: string; name: string; }
interface StockItem {
  id: string; goodId: string; goodName: string; goodSku: string | null; unit: string;
  salePrice: number; warehouseId: string; warehouseName: string;
  quantity: number; reserved: number; available: number;
  minStock: number | null; isLow: boolean;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
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

export default function InventoryPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST']);

  const [items, setItems] = useState<StockItem[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const [showLow, setShowLow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lowItems, setLowItems] = useState<StockItem[]>([]);
  const [showLowModal, setShowLowModal] = useState(false);
  const [error, setError] = useState('');

  const loadWarehouses = useCallback(async () => {
    try {
      const data = await apiFetch('/warehouses');
      setWarehouses(data.items ?? data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка завантаження складів'); }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      if (q) params.set('q', q);
      const data = await apiFetch(`/stock-items?${params}`);
      setItems(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [warehouseId, q]);

  const loadLow = useCallback(async () => {
    try {
      const data = await apiFetch('/stock-items/low');
      setLowItems(data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка завантаження'); }
  }, []);

  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const displayed = showLow ? items.filter(i => i.isLow) : items;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Залишки на складах</h1>
          <p className="text-gray-500 text-sm mt-0.5">{items.length} позицій</p>
        </div>
        <button
          onClick={() => { loadLow(); setShowLowModal(true); }}
          className="px-4 py-2 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
        >
          ⚠ Нижче мінімуму
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Пошук по назві..."
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
        />
        <select
          value={warehouseId}
          onChange={e => setWarehouseId(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Всі склади</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showLow}
            onChange={e => setShowLow(e.target.checked)}
            className="rounded"
          />
          Тільки з низьким залишком
        </label>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Завантаження...</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Товар</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Артикул</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Склад</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Кількість</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Резерв</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Доступно</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Ціна продажу</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Мін. залишок</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {displayed.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-gray-400">Позицій не знайдено</td></tr>
              ) : displayed.map(item => (
                <tr key={item.id} className={`hover:bg-gray-50 transition-colors ${item.isLow ? 'bg-amber-50/50' : ''}`}>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {item.isLow && <span className="text-amber-500 mr-1">⚠</span>}
                    {item.goodName}
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{item.goodSku ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{item.warehouseName}</td>
                  <td className="px-4 py-3 text-right font-medium">{item.quantity} {item.unit}</td>
                  <td className="px-4 py-3 text-right text-orange-600">{item.reserved > 0 ? item.reserved : '—'}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${item.available <= 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {item.available} {item.unit}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmt(item.salePrice)}</td>
                  <td className="px-4 py-3">
                    {item.minStock != null ? (
                      <span className={`text-xs px-2 py-1 rounded-full ${item.isLow ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                        ≥ {item.minStock} {item.unit}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Low stock modal */}
      {showLowModal && (
        <Modal title="Товари нижче мінімального залишку" onClose={() => setShowLowModal(false)}>
          {lowItems.length === 0 ? (
            <p className="text-gray-500 text-center py-4">Все гаразд — критичних позицій немає</p>
          ) : (
            <div className="space-y-2">
              {lowItems.map((item, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-amber-50 rounded-lg border border-amber-100">
                  <div>
                    <div className="font-medium text-gray-900 text-sm">{item.goodName}</div>
                    <div className="text-xs text-gray-500">{item.warehouseName}</div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-semibold text-red-600">{item.quantity} {item.unit}</div>
                    <div className="text-gray-400">мін: {item.minStock}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
