'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Receipt, Search } from 'lucide-react';
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
import { DetailPanel } from '@/components/ui/detail-panel';
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
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedInv, setSelectedInv] = useState<Invoice | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showPayment, setShowPayment] = useState<Invoice | null>(null);

  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [payMethods, setPayMethods] = useState<{ code: string; name: string }[]>([]);
  const [form, setForm] = useState({ counterpartyId: '', amount: '', dueDate: '' });
  const [payForm, setPayForm] = useState({ method: 'cash', amount: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status) params.set('status', status);
      if (search) params.set('q', search);
      const data = await apiFetch<Paginated>(`/invoices?${params}`);
      setInvoices(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally { setLoading(false); }
  }, [page, status, search]);

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
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) { setError('Введіть коректну суму'); return; }
    setSaving(true);
    try {
      await apiFetch<Invoice>('/invoices', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: form.counterpartyId,
          amount: amt,
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
    setSavingId(inv.id);
    setError('');
    try {
      await apiFetch<void>(`/invoices/${inv.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      // Sync selectedInv if it matches
      if (selectedInv?.id === inv.id) {
        setSelectedInv(prev => prev ? { ...prev, status: newStatus } : null);
      }
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка зміни статусу'); }
    finally { setSavingId(null); }
  };

  const handlePay = async () => {
    if (!showPayment) return;
    const rawAmt = parseFloat(payForm.amount);
    const amt = (!payForm.amount || !Number.isFinite(rawAmt)) ? showPayment.amount : rawAmt;
    setSaving(true);
    try {
      await apiFetch<{ id: string }>('/payments', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: showPayment.counterpartyId,
          invoiceId: showPayment.id,
          amount: amt,
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
    <div className="page-container">
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Рахунки</h1>
          <p className="page-subtitle">{total} рахунків</p>
        </div>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Новий рахунок
        </Button>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => { setStatus(s); setPage(1); }}
            className={cn(
              'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
              status === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
            )}
          >
            {s ? STATUS_LABELS[s] : 'Всі'}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-5">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Пошук за номером або контрагентом..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Table + DetailPanel */}
      <div className="flex gap-0 rounded-xl border border-border overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto border-r border-border">
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
                <TableRow
                  key={inv.id}
                  onClick={() => setSelectedInv(inv)}
                  className={cn(selectedInv?.id === inv.id && 'bg-primary/5')}
                >
                  <TableCell className="font-mono font-medium text-foreground">{inv.number}</TableCell>
                  <TableCell className="text-foreground-muted">{inv.counterpartyName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground text-xs font-mono">{inv.workOrderNumber ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[inv.status] ?? 'secondary'}>
                      {STATUS_LABELS[inv.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-semibold">{fmt(inv.amount)}</TableCell>
                  <TableCell className="text-foreground-faint text-xs">
                    {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('uk-UA') : '—'}
                  </TableCell>
                  <TableCell>
                    <div
                      className="flex gap-1.5 justify-end"
                      onClick={e => e.stopPropagation()}
                    >
                      {STATUS_TRANSITIONS[inv.status]?.map(s => (
                        <Button
                          key={s}
                          variant={s === 'CANCELLED' ? 'destructive' : s === 'PAID' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => s === 'PAID' ? setShowPayment(inv) : handleTransition(inv, s)}
                          loading={savingId === inv.id}
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

        <DetailPanel
          open={!!selectedInv}
          onClose={() => setSelectedInv(null)}
          title={selectedInv?.number ?? ''}
        >
          {selectedInv && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_BADGE[selectedInv.status] ?? 'secondary'}>
                  {STATUS_LABELS[selectedInv.status] ?? selectedInv.status}
                </Badge>
              </div>

              <div className="space-y-2 text-[13px]">
                <div>
                  <span className="text-muted-foreground">Контрагент</span>
                  <p className="font-medium text-foreground mt-0.5">{selectedInv.counterpartyName ?? '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Наряд</span>
                  <p className="font-medium text-foreground mt-0.5 font-mono">{selectedInv.workOrderNumber ?? '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Сума</span>
                  <p className="font-semibold text-foreground mt-0.5">{fmt(selectedInv.amount)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Термін оплати</span>
                  <p className="font-medium text-foreground mt-0.5">
                    {selectedInv.dueDate ? new Date(selectedInv.dueDate).toLocaleDateString('uk-UA') : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Створено</span>
                  <p className="font-medium text-foreground mt-0.5">
                    {new Date(selectedInv.createdAt).toLocaleString('uk-UA', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>

              {/* Action buttons in panel */}
              {STATUS_TRANSITIONS[selectedInv.status]?.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-border">
                  <p className="text-[12px] text-muted-foreground font-medium uppercase tracking-wide">Дії</p>
                  <div className="flex flex-col gap-2">
                    {STATUS_TRANSITIONS[selectedInv.status].map(s => (
                      <Button
                        key={s}
                        variant={s === 'CANCELLED' ? 'destructive' : s === 'PAID' ? 'default' : 'outline'}
                        size="sm"
                        className="w-full"
                        onClick={() => s === 'PAID' ? setShowPayment(selectedInv) : handleTransition(selectedInv, s)}
                        loading={savingId === selectedInv.id}
                      >
                        {s === 'SENT' ? 'Надіслати' : s === 'PAID' ? 'Оплатити' : 'Скасувати'}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-1.5 mt-4">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Назад</Button>
          <span className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground">{page}</span>
          <Button variant="outline" size="sm" disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Вперед →</Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Новий рахунок"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.counterpartyId || !form.amount}
            className="w-full"
          >
            Створити рахунок
          </Button>
        }
      >
        <div className="space-y-4">
          <Select
            label="Контрагент"
            required
            value={form.counterpartyId}
            onChange={e => setForm(f => ({ ...f, counterpartyId: e.target.value }))}
            placeholder="Оберіть контрагента"
          >
            {counterparties.map(c => (
              <option key={c.id} value={c.id}>
                {c.companyName ?? [c.lastName, c.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Input
            label="Сума, ₴"
            required
            type="number"
            value={form.amount}
            onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
            min="0.01"
            step="0.01"
            placeholder="0.00"
          />
          <Input
            label="Термін оплати"
            type="date"
            value={form.dueDate}
            onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
          />
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal
        open={!!showPayment}
        onClose={() => setShowPayment(null)}
        title={showPayment ? `Реєстрація оплати по рахунку ${showPayment.number}` : ''}
        footer={
          <Button onClick={handlePay} loading={saving} className="w-full">
            Підтвердити оплату
          </Button>
        }
      >
        {showPayment && (
          <div className="space-y-4">
            <div className="p-3 bg-info-subtle rounded-lg text-sm text-info-text">
              Сума до оплати: <strong>{fmt(showPayment.amount)}</strong>
            </div>
            <Select
              label="Метод оплати"
              required
              value={payForm.method}
              onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}
            >
              {payMethods.length > 0
                ? payMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)
                : <>
                  <option value="cash">Готівка</option>
                  <option value="card_terminal">Термінал</option>
                  <option value="bank_transfer">Банківський переказ</option>
                </>
              }
            </Select>
            <Input
              label="Сума, ₴"
              type="number"
              value={payForm.amount}
              onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
              placeholder={String(showPayment.amount)}
              min="0.01"
              step="0.01"
            />
            <Input
              label="Примітки"
              value={payForm.notes}
              onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
