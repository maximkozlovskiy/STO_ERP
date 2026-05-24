'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Counterparty { id: string; firstName?: string; lastName?: string; companyName?: string; }
interface Invoice {
  id: string; number: string; status: string;
  counterpartyId: string; counterpartyName?: string;
  workOrderId?: string | null; workOrderNumber?: string | null;
  amount: number; dueDate?: string | null;
  createdAt: string; updatedAt: string;
}
interface Paginated { items: Invoice[]; total: number; page: number; limit: number; }

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', SENT: 'Надіслано', PAID: 'Оплачено', CANCELLED: 'Скасовано',
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  SENT: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-600',
};
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'], SENT: ['PAID', 'CANCELLED'], PAID: [], CANCELLED: [],
};

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

export default function InvoicesPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [showPayment, setShowPayment] = useState<Invoice | null>(null);

  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [payMethods, setPayMethods] = useState<{ code: string; name: string }[]>([]);
  const [form, setForm] = useState({ counterpartyId: '', amount: '', dueDate: '' });
  const [payForm, setPayForm] = useState({ method: 'cash', amount: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status) params.set('status', status);
      const data = await apiFetch<Paginated>(`/invoices?${params}`);
      setInvoices(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally { setLoading(false); }
  }, [page, status]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (showCreate) {
      apiFetch<{ items: Counterparty[] }>('/counterparties?limit=200').then(d => setCounterparties(d.items))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження контрагентів'));
    }
  }, [showCreate]);

  useEffect(() => {
    if (showPayment) {
      apiFetch<{ code: string; name: string; isActive: boolean }[]>('/payment-methods')
        .then(d => setPayMethods(d.filter(m => m.isActive)))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження способів оплати'));
    }
  }, [showPayment]);

  const handleCreate = async () => {
    setSaving(true);
    try {
      await apiFetch<Invoice>('/invoices', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: form.counterpartyId,
          amount: parseFloat(form.amount),
          dueDate: form.dueDate || undefined,
        }),
      });
      setShowCreate(false);
      setForm({ counterpartyId: '', amount: '', dueDate: '' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally { setSaving(false); }
  };

  const handleTransition = async (inv: Invoice, newStatus: string) => {
    if (!confirm(`Перевести рахунок ${inv.number} → ${STATUS_LABELS[newStatus]}?`)) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch<void>(`/invoices/${inv.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка зміни статусу'); }
    finally { setSaving(false); }
  };

  const handlePay = async () => {
    if (!showPayment) return;
    setSaving(true);
    try {
      await apiFetch<{ id: string }>('/payments', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: showPayment.counterpartyId,
          invoiceId: showPayment.id,
          amount: parseFloat(payForm.amount) || showPayment.amount,
          method: payForm.method,
          notes: payForm.notes || undefined,
        }),
      });
      setShowPayment(null);
      setPayForm({ method: 'cash', amount: '', notes: '' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка оплати');
    } finally { setSaving(false); }
  };

  const statuses = ['', 'DRAFT', 'SENT', 'PAID', 'CANCELLED'];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Рахунки</h1>
          <p className="text-gray-500 text-sm mt-0.5">{total} рахунків</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          + Новий рахунок
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        {statuses.map(s => (
          <button key={s} onClick={() => { setStatus(s); setPage(1); }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              status === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {s ? STATUS_LABELS[s] : 'Всі'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Завантаження...</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Номер</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Контрагент</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Наряд</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Статус</th>
                <th className="text-right px-4 py-3 text-gray-500 font-medium">Сума</th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium">Термін оплати</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invoices.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-400">Рахунків не знайдено</td></tr>
              ) : invoices.map(inv => (
                <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono font-medium text-gray-900">{inv.number}</td>
                  <td className="px-4 py-3 text-gray-700">{inv.counterpartyName ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs font-mono">{inv.workOrderNumber ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[inv.status]}`}>
                      {STATUS_LABELS[inv.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{fmt(inv.amount)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('uk-UA') : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      {STATUS_TRANSITIONS[inv.status]?.map(s => (
                        <button key={s}
                          onClick={() => s === 'PAID' ? setShowPayment(inv) : handleTransition(inv, s)}
                          className={`text-xs font-medium px-2 py-1 rounded transition-colors ${
                            s === 'CANCELLED' ? 'text-red-500 hover:text-red-700' :
                            s === 'PAID' ? 'bg-green-100 text-green-700 hover:bg-green-200' :
                            'text-blue-600 hover:text-blue-800'
                          }`}>
                          {s === 'SENT' ? 'Надіслати' : s === 'PAID' ? 'Оплатити' : 'Скасувати'}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > limit && (
        <div className="flex justify-center gap-2 mt-4">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50">← Назад</button>
          <span className="px-3 py-1.5 text-sm text-gray-500">Стор. {page}</span>
          <button disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50">Вперед →</button>
        </div>
      )}

      {showCreate && (
        <Modal title="Новий рахунок" onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Контрагент *</label>
              <select value={form.counterpartyId} onChange={e => setForm(f => ({ ...f, counterpartyId: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="">Оберіть контрагента</option>
                {counterparties.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.companyName ?? [c.lastName, c.firstName].filter(Boolean).join(' ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Сума, ₴ *</label>
              <input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                min="0.01" step="0.01" placeholder="0.00"
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Термін оплати</label>
              <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <button onClick={handleCreate} disabled={!form.counterpartyId || !form.amount || saving}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {saving ? 'Збереження...' : 'Створити рахунок'}
            </button>
          </div>
        </Modal>
      )}

      {showPayment && (
        <Modal title={`Реєстрація оплати по рахунку ${showPayment.number}`} onClose={() => setShowPayment(null)}>
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
              Сума до оплати: <strong>{fmt(showPayment.amount)}</strong>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Метод оплати *</label>
              <select value={payForm.method} onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm">
                {payMethods.length > 0
                  ? payMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)
                  : <>
                    <option value="cash">Готівка</option>
                    <option value="card_terminal">Термінал</option>
                    <option value="bank_transfer">Банківський переказ</option>
                  </>
                }
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Сума, ₴</label>
              <input type="number" value={payForm.amount}
                onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                placeholder={String(showPayment.amount)} min="0.01" step="0.01"
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Примітки</label>
              <input type="text" value={payForm.notes} onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <button onClick={handlePay} disabled={saving}
              className="w-full py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors">
              {saving ? 'Збереження...' : 'Підтвердити оплату'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
