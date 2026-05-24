'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkOrderLine {
  id: string; workId: string; workName?: string;
  employeeId: string; employeeName?: string;
  liftId?: string | null; normoHours: number; price: number; amount: number; notes?: string | null;
}
interface WorkOrderPart {
  id: string; goodId: string; goodName?: string;
  warehouseId: string; quantity: number; price: number; amount: number;
}
interface WorkOrderDetail {
  id: string; number: string; status: string;
  branchId: string; branchName?: string;
  vehicleId: string; vehicleSummary?: string;
  counterpartyId: string; counterpartyName?: string;
  description?: string | null; inMileage?: number | null; outMileage?: number | null;
  plannedAt?: string | null; completedAt?: string | null;
  totalLabor: number; totalParts: number; totalAmount: number; paidAmount: number;
  lines: WorkOrderLine[]; parts: WorkOrderPart[];
}
interface Work { id: string; name: string; normoHours: number; price: number; }
interface Employee { id: string; firstName: string; lastName: string; }
interface Good { id: string; name: string; salePrice: number; }
interface Warehouse { id: string; name: string; }

// ─── Constants ───────────────────────────────────────────────────────────────

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
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
};
const TRANSITION_LABELS: Record<string, string> = {
  ESTIMATE: 'Кошторис', APPROVED: 'Затвердити', IN_PROGRESS: 'В роботу',
  ON_HOLD: 'Призупинити', COMPLETED: 'Виконано', INVOICED: 'Виставити рахунок',
  PAID: 'Оплачено', ARCHIVED: 'В архів', CANCELLED: 'Скасувати', DRAFT: 'Повернути в чернетку',
};
const TRANSITION_COLORS: Record<string, string> = {
  IN_PROGRESS: 'bg-purple-600 hover:bg-purple-700',
  COMPLETED: 'bg-green-600 hover:bg-green-700',
  PAID: 'bg-emerald-600 hover:bg-emerald-700',
  CANCELLED: 'bg-red-500 hover:bg-red-600',
  APPROVED: 'bg-blue-600 hover:bg-blue-700',
};

// ─── Modals ───────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkOrderCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [lineModal, setLineModal] = useState(false);
  const [partModal, setPartModal] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refsError, setRefsError] = useState('');

  const [lineForm, setLineForm] = useState({ workId: '', employeeId: '', normoHours: '', price: '', notes: '' });
  const [partForm, setPartForm] = useState({ goodId: '', warehouseId: '', quantity: '1', price: '' });

  const load = useCallback(() => {
    apiFetch<WorkOrderDetail>(`/work-orders/${id}`)
      .then(setWo)
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження наряду'));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    apiFetch<{ items: Work[] }>('/works?limit=200').then(r => setWorks(r.items)).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    apiFetch<{ items: Employee[] }>('/employees?limit=200').then((r: { items?: Employee[] } | Employee[]) => setEmployees(Array.isArray(r) ? r : r.items ?? [])).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    apiFetch<{ items: Good[] }>('/goods?limit=200').then(r => setGoods(r.items)).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    apiFetch<Warehouse[]>('/warehouses').then(setWarehouses).catch((e: unknown) => setRefsError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
  }, []);

  const selectWork = (workId: string) => {
    const w = works.find(x => x.id === workId);
    setLineForm(f => ({ ...f, workId, normoHours: w ? String(w.normoHours) : f.normoHours, price: w ? String(w.price) : f.price }));
  };

  const selectGood = (goodId: string) => {
    const g = goods.find(x => x.id === goodId);
    setPartForm(f => ({ ...f, goodId, price: g ? String(g.salePrice) : f.price }));
  };

  const addLine = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch(`/work-orders/${id}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          workId: lineForm.workId,
          employeeId: lineForm.employeeId,
          normoHours: lineForm.normoHours ? Number(lineForm.normoHours) : undefined,
          price: lineForm.price ? Number(lineForm.price) : undefined,
          notes: lineForm.notes || undefined,
        }),
      });
      setLineModal(false);
      setLineForm({ workId: '', employeeId: '', normoHours: '', price: '', notes: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removeLine = async (lineId: string) => {
    if (!confirm('Видалити роботу?')) return;
    try { await apiFetch(`/work-orders/${id}/lines/${lineId}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
  };

  const addPart = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch(`/work-orders/${id}/parts`, {
        method: 'POST',
        body: JSON.stringify({
          goodId: partForm.goodId,
          warehouseId: partForm.warehouseId,
          quantity: Number(partForm.quantity),
          price: partForm.price ? Number(partForm.price) : undefined,
        }),
      });
      setPartModal(false);
      setPartForm({ goodId: '', warehouseId: '', quantity: '1', price: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removePart = async (partId: string) => {
    if (!confirm('Видалити запчастину?')) return;
    try { await apiFetch(`/work-orders/${id}/parts/${partId}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
  };

  const transition = async (newStatus: string) => {
    const label = STATUS_LABELS[newStatus];
    if (!confirm(`Перевести наряд у статус "${label}"?`)) return;
    setTransitioning(true); setError('');
    try {
      await apiFetch(`/work-orders/${id}/transition`, { method: 'POST', body: JSON.stringify({ status: newStatus }) });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка переходу'); }
    finally { setTransitioning(false); }
  };

  if (!wo) return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      {error
        ? <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>
        : <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />}
    </div>
  );

  const canEdit = ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(wo.status);
  const allowedTransitions = TRANSITIONS[wo.status] ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      {refsError && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">Довідники: {refsError}</p>}
      {/* Header */}
      <div className="flex items-start gap-4">
        <button onClick={() => router.back()} className="mt-1 text-gray-400 hover:text-gray-600 text-sm">← Назад</button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{wo.number}</h1>
            <span className={`text-sm font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[wo.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABELS[wo.status] ?? wo.status}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{wo.counterpartyName} · {wo.vehicleSummary}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-gray-900">{wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
          <p className="text-xs text-gray-400">загальна сума</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-white rounded-xl border p-5 grid grid-cols-2 gap-3 text-sm">
        {wo.branchName && <div><p className="text-xs text-gray-400">Філія</p><p className="text-gray-900">{wo.branchName}</p></div>}
        {wo.inMileage != null && <div><p className="text-xs text-gray-400">Пробіг (вхід)</p><p className="text-gray-900">{wo.inMileage.toLocaleString('uk-UA')} км</p></div>}
        {wo.outMileage != null && <div><p className="text-xs text-gray-400">Пробіг (вихід)</p><p className="text-gray-900">{wo.outMileage.toLocaleString('uk-UA')} км</p></div>}
        {wo.plannedAt && <div><p className="text-xs text-gray-400">Заплановано</p><p className="text-gray-900">{new Date(wo.plannedAt).toLocaleString('uk-UA')}</p></div>}
        {wo.description && <div className="col-span-2"><p className="text-xs text-gray-400">Опис</p><p className="text-gray-900">{wo.description}</p></div>}
      </div>

      {/* FSM Buttons */}
      {allowedTransitions.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {allowedTransitions.map(s => (
            <button key={s} onClick={() => transition(s)} disabled={transitioning}
              className={`px-4 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-60 ${TRANSITION_COLORS[s] ?? 'bg-gray-500 hover:bg-gray-600'}`}>
              {TRANSITION_LABELS[s] ?? s}
            </button>
          ))}
        </div>
      )}

      {/* Totals */}
      <div className="bg-white rounded-xl border p-5 grid grid-cols-3 gap-4 text-sm">
        <div><p className="text-xs text-gray-400">Роботи</p><p className="text-lg font-semibold text-gray-900">{wo.totalLabor.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p></div>
        <div><p className="text-xs text-gray-400">Запчастини</p><p className="text-lg font-semibold text-gray-900">{wo.totalParts.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p></div>
        <div><p className="text-xs text-gray-400">Оплачено</p><p className={`text-lg font-semibold ${wo.paidAmount >= wo.totalAmount ? 'text-green-600' : 'text-gray-900'}`}>{wo.paidAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p></div>
      </div>

      {/* Lines */}
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Роботи</h2>
          {canEdit && <button onClick={() => { setError(''); setLineModal(true); }} className="text-sm text-blue-600 hover:underline">+ Робота</button>}
        </div>
        {wo.lines.length === 0
          ? <p className="text-sm text-gray-400">Роботи не додані</p>
          : (
            <div className="divide-y border rounded-lg overflow-hidden">
              {wo.lines.map(l => (
                <div key={l.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{l.workName}</p>
                    <p className="text-xs text-gray-400">{l.employeeName} · {l.normoHours} год</p>
                    {l.notes && <p className="text-xs text-gray-400 mt-0.5">{l.notes}</p>}
                  </div>
                  <div className="text-right mr-3">
                    <p className="text-sm font-medium text-gray-900">{l.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                    <p className="text-xs text-gray-400">{l.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} × {l.normoHours}</p>
                  </div>
                  {canEdit && <button onClick={() => removeLine(l.id)} className="text-xs text-red-400 hover:text-red-600 px-1">×</button>}
                </div>
              ))}
            </div>
          )}
      </div>

      {/* Parts */}
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Запчастини та матеріали</h2>
          {canEdit && <button onClick={() => { setError(''); setPartModal(true); }} className="text-sm text-blue-600 hover:underline">+ Запчастина</button>}
        </div>
        {wo.parts.length === 0
          ? <p className="text-sm text-gray-400">Запчастини не додані</p>
          : (
            <div className="divide-y border rounded-lg overflow-hidden">
              {wo.parts.map(p => (
                <div key={p.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{p.goodName}</p>
                    <p className="text-xs text-gray-400">{p.quantity} шт × {p.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                  </div>
                  <div className="text-right mr-3">
                    <p className="text-sm font-medium text-gray-900">{p.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                  </div>
                  {canEdit && <button onClick={() => removePart(p.id)} className="text-xs text-red-400 hover:text-red-600 px-1">×</button>}
                </div>
              ))}
            </div>
          )}
      </div>

      {/* Add Line Modal */}
      {lineModal && (
        <Modal title="Додати роботу" onClose={() => setLineModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Робота *</label>
            <select value={lineForm.workId} onChange={e => selectWork(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Оберіть —</option>
              {works.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Виконавець *</label>
            <select value={lineForm.employeeId} onChange={e => setLineForm(f => ({ ...f, employeeId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Оберіть —</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Нормо-год</label>
              <input type="number" value={lineForm.normoHours} onChange={e => setLineForm(f => ({ ...f, normoHours: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ціна, ₴</label>
              <input type="number" value={lineForm.price} onChange={e => setLineForm(f => ({ ...f, price: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Нотатки</label>
            <input value={lineForm.notes} onChange={e => setLineForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button onClick={addLine} disabled={saving || !lineForm.workId || !lineForm.employeeId}
            className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? '...' : 'Додати'}
          </button>
        </Modal>
      )}

      {/* Add Part Modal */}
      {partModal && (
        <Modal title="Додати запчастину" onClose={() => setPartModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Товар *</label>
            <select value={partForm.goodId} onChange={e => selectGood(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Оберіть —</option>
              {goods.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Склад *</label>
            <select value={partForm.warehouseId} onChange={e => setPartForm(f => ({ ...f, warehouseId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Оберіть —</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Кількість *</label>
              <input type="number" value={partForm.quantity} onChange={e => setPartForm(f => ({ ...f, quantity: e.target.value }))} min="0.001" step="0.001"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ціна, ₴</label>
              <input type="number" value={partForm.price} onChange={e => setPartForm(f => ({ ...f, price: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <button onClick={addPart} disabled={saving || !partForm.goodId || !partForm.warehouseId || !partForm.quantity}
            className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? '...' : 'Додати'}
          </button>
        </Modal>
      )}
    </div>
  );
}
