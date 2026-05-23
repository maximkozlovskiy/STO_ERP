'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface WorkOrder {
  id: string; number: string; status: string;
  vehicleSummary?: string; counterpartyName?: string; branchName?: string;
  totalAmount: number; plannedAt?: string | null;
  createdAt: string;
}
interface Paginated { items: WorkOrder[]; total: number; page: number; limit: number; }
interface Branch { id: string; name: string; }
interface Vehicle { id: string; make: string; model: string; licensePlate: string | null; }
interface Counterparty { id: string; firstName: string | null; lastName: string | null; companyName: string | null; }

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ESTIMATE: 'Кошторис', APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі', ON_HOLD: 'Призупинено', COMPLETED: 'Виконано',
  INVOICED: 'Виставлено', PAID: 'Оплачено', ARCHIVED: 'Архів', CANCELLED: 'Скасовано',
};

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600', ESTIMATE: 'bg-yellow-100 text-yellow-700',
  APPROVED: 'bg-blue-100 text-blue-700', IN_PROGRESS: 'bg-purple-100 text-purple-700',
  ON_HOLD: 'bg-orange-100 text-orange-700', COMPLETED: 'bg-green-100 text-green-700',
  INVOICED: 'bg-teal-100 text-teal-700', PAID: 'bg-emerald-100 text-emerald-700',
  ARCHIVED: 'bg-gray-100 text-gray-400', CANCELLED: 'bg-red-100 text-red-600',
};

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

export default function WorkOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const router = useRouter();

  const [data, setData] = useState<Paginated | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [form, setForm] = useState({ branchId: '', vehicleId: '', counterpartyId: '', description: '', inMileage: '', plannedAt: '' });

  useEffect(() => {
    apiFetch<Branch[]>('/branches').then(setBranches).catch(() => setError('Не вдалося завантажити філії'));
    apiFetch<{ items: Counterparty[] }>('/counterparties?limit=200')
      .then(r => setCounterparties(r.items))
      .catch(() => setError('Не вдалося завантажити контрагентів'));
  }, []);

  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter) p.set('status', statusFilter);
    apiFetch<Paginated>(`/work-orders?${p}`).then(setData).catch(e => setError(e?.message ?? 'Помилка завантаження'));
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const loadVehicles = (counterpartyId: string) => {
    if (!counterpartyId) return;
    apiFetch<Array<{ id: string }>>(`/counterparties/${counterpartyId}/garages`)
      .then(garages => {
        const garagesArr = Array.isArray(garages) ? garages : [];
        return Promise.all(
          garagesArr.map(g => apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}`).catch(() => [] as Vehicle[]))
        );
      })
      .then(results => setVehicles(results.flat()))
      .catch(() => {});
  };

  const cpName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? '';

  const create = async () => {
    setSaving(true); setError('');
    try {
      const wo = await apiFetch<WorkOrder>('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          branchId: form.branchId,
          vehicleId: form.vehicleId,
          counterpartyId: form.counterpartyId,
          description: form.description || undefined,
          inMileage: form.inMileage ? Number(form.inMileage) : undefined,
          plannedAt: form.plannedAt || undefined,
        }),
      });
      setModal(false);
      router.push(`/work-orders/${wo.id}`);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Наряди</h1>
        <button onClick={() => { setError(''); setModal(true); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Новий наряд
        </button>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {[['', 'Всі'], ...Object.entries(STATUS_LABELS)].map(([v, l]) => (
          <button key={v} onClick={() => { setStatusFilter(v); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${statusFilter === v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
            {l}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              {['Номер', 'Клієнт / Авто', 'Статус', 'Сума, ₴', 'Запланов.', ''].map(h => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data?.items.map(wo => (
              <tr key={wo.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <button onClick={() => router.push(`/work-orders/${wo.id}`)} className="text-sm font-medium text-blue-600 hover:underline">
                    {wo.number}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-gray-900">{wo.counterpartyName ?? '—'}</p>
                  <p className="text-xs text-gray-400">{wo.vehicleSummary ?? '—'}</p>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${STATUS_COLORS[wo.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {STATUS_LABELS[wo.status] ?? wo.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {wo.plannedAt ? new Date(wo.plannedAt).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => router.push(`/work-orders/${wo.id}`)} className="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50">
                    Картка →
                  </button>
                </td>
              </tr>
            ))}
            {data?.items.length === 0 && (
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
        <Modal title="Новий наряд" onClose={() => setModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Клієнт *</label>
            <select value={form.counterpartyId} onChange={e => { setForm(f => ({ ...f, counterpartyId: e.target.value, vehicleId: '' })); loadVehicles(e.target.value); }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Оберіть —</option>
              {counterparties.map(c => <option key={c.id} value={c.id}>{cpName(c)}</option>)}
            </select>
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Автомобіль *</label>
            <select value={form.vehicleId} onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={!form.counterpartyId}>
              <option value="">— Оберіть —</option>
              {vehicles.map(v => <option key={v.id} value={v.id}>{v.make} {v.model}{v.licensePlate ? ` (${v.licensePlate})` : ''}</option>)}
            </select>
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Філія *</label>
            <select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Оберіть —</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Опис</label>
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Заміна масла, колодок..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Пробіг (вхід), км</label>
              <input type="number" value={form.inMileage} onChange={e => setForm(f => ({ ...f, inMileage: e.target.value }))}
                placeholder="50000"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Заплановано</label>
              <input type="datetime-local" value={form.plannedAt} onChange={e => setForm(f => ({ ...f, plannedAt: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <button onClick={create} disabled={saving || !form.branchId || !form.vehicleId || !form.counterpartyId}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Створення...' : 'Створити наряд'}
          </button>
        </Modal>
      )}
    </div>
  );
}
