'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Receipt } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

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
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', SENT: 'default', PAID: 'success', CANCELLED: 'destructive',
};
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'], SENT: ['PAID', 'CANCELLED'], PAID: [], CANCELLED: [],
};

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
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Рахунки</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} рахунків</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          Новий рахунок
        </Button>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-1.5 mb-5">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => { setStatus(s); setPage(1); }}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
              status === s
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50',
            )}
          >
            {s ? STATUS_LABELS[s] : 'Всі'}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Номер</TableHead>
              <TableHead>Контрагент</TableHead>
              <TableHead>Наряд</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Сума</TableHead>
              <TableHead>Термін оплати</TableHead>
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
            {!loading && invoices.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState icon={Receipt} title="Рахунків не знайдено" />
                </TableCell>
              </TableRow>
            )}
            {!loading && invoices.map(inv => (
              <TableRow key={inv.id}>
                <TableCell className="font-mono font-medium text-gray-900">{inv.number}</TableCell>
                <TableCell className="text-gray-700">{inv.counterpartyName ?? '—'}</TableCell>
                <TableCell className="text-gray-500 text-xs font-mono">{inv.workOrderNumber ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[inv.status] ?? 'secondary'}>
                    {STATUS_LABELS[inv.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-semibold">{fmt(inv.amount)}</TableCell>
                <TableCell className="text-gray-400 text-xs">
                  {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('uk-UA') : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1.5 justify-end">
                    {STATUS_TRANSITIONS[inv.status]?.map(s => (
                      <Button
                        key={s}
                        variant={s === 'CANCELLED' ? 'destructive' : s === 'PAID' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => s === 'PAID' ? setShowPayment(inv) : handleTransition(inv, s)}
                        loading={saving}
                      >
                        {s === 'SENT' ? 'Надіслати' : s === 'PAID' ? 'Оплатити' : 'Скасувати'}
                      </Button>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-1.5 mt-4">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Назад</Button>
          <span className="px-3 py-1.5 text-sm text-gray-500">Стор. {page}</span>
          <Button variant="outline" size="sm" disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Вперед →</Button>
        </div>
      )}

      {/* Create modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Новий рахунок">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Контрагент <span className="text-red-500">*</span></label>
            <Select value={form.counterpartyId} onChange={e => setForm(f => ({ ...f, counterpartyId: e.target.value }))} placeholder="Оберіть контрагента">
              {counterparties.map(c => (
                <option key={c.id} value={c.id}>
                  {c.companyName ?? [c.lastName, c.firstName].filter(Boolean).join(' ')}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Сума, ₴ <span className="text-red-500">*</span></label>
            <Input
              type="number"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              min="0.01"
              step="0.01"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Термін оплати</label>
            <Input
              type="date"
              value={form.dueDate}
              onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
            />
          </div>
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.counterpartyId || !form.amount}
            className="w-full"
          >
            Створити рахунок
          </Button>
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal
        open={!!showPayment}
        onClose={() => setShowPayment(null)}
        title={showPayment ? `Реєстрація оплати по рахунку ${showPayment.number}` : ''}
      >
        {showPayment && (
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
              Сума до оплати: <strong>{fmt(showPayment.amount)}</strong>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Метод оплати <span className="text-red-500">*</span></label>
              <Select value={payForm.method} onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}>
                {payMethods.length > 0
                  ? payMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)
                  : <>
                    <option value="cash">Готівка</option>
                    <option value="card_terminal">Термінал</option>
                    <option value="bank_transfer">Банківський переказ</option>
                  </>
                }
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Сума, ₴</label>
              <Input
                type="number"
                value={payForm.amount}
                onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                placeholder={String(showPayment.amount)}
                min="0.01"
                step="0.01"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Примітки</label>
              <Input
                value={payForm.notes}
                onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <Button onClick={handlePay} loading={saving} className="w-full">
              Підтвердити оплату
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
