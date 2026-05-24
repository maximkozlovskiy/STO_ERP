'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
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
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', ORDERED: 'default', PARTIAL: 'warning', RECEIVED: 'success', CANCELLED: 'destructive',
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

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [form, setForm] = useState({ supplierId: '', warehouseId: '', notes: '' });
  const [lines, setLines] = useState<{ goodId: string; quantity: string; price: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const [receiveLines, setReceiveLines] = useState<{ lineId: string; receivedQty: string }[]>([]);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status) params.set('status', status);
      const data = await apiFetch<Paginated>(`/purchase-orders?${params}`);
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
        apiFetch<{ items: Supplier[] } | Supplier[]>('/counterparties?type=SUPPLIER&limit=100'),
        apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses'),
        apiFetch<{ items: Good[] } | Good[]>('/goods?limit=200'),
      ]).then(([s, w, g]) => {
        setSuppliers(Array.isArray(s) ? s : s.items);
        setWarehouses(Array.isArray(w) ? w : w.items);
        setGoods(Array.isArray(g) ? g : g.items);
      }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    }
  }, [showCreate]);

  const handleCreate = async () => {
    const validLines = lines.filter(l => l.goodId);
    for (const l of validLines) {
      const qty = parseFloat(l.quantity); const price = parseFloat(l.price);
      if (!Number.isFinite(qty) || qty <= 0) { setError('Вкажіть коректну кількість для всіх позицій'); return; }
      if (!Number.isFinite(price) || price < 0) { setError('Вкажіть коректну ціну для всіх позицій'); return; }
    }
    setSaving(true);
    try {
      await apiFetch<PurchaseOrder>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: form.supplierId, warehouseId: form.warehouseId, notes: form.notes || undefined,
          lines: validLines.map(l => ({
            goodId: l.goodId,
            quantity: parseFloat(l.quantity),
            price: parseFloat(l.price),
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
    setSaving(true); setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${po.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка переходу статусу'); }
    finally { setSaving(false); }
  };

  const openReceive = (po: PurchaseOrder) => {
    setReceiveLines(po.lines.map(l => ({ lineId: l.id!, receivedQty: '' })));
    setShowReceive(po);
  };

  const handleReceive = async () => {
    if (!showReceive) return;
    const receivedLines = receiveLines
      .filter(l => parseFloat(l.receivedQty) > 0)
      .map(l => ({ lineId: l.lineId, receivedQty: parseFloat(l.receivedQty) }));
    if (!receivedLines.length) { setError('Вкажіть кількість для хоча б однієї позиції'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${showReceive.id}/receive`, {
        method: 'POST', body: JSON.stringify({ lines: receivedLines }),
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
    <div className="page-container">
      {error && (
        <div className="mb-4 text-sm text-[hsl(0_84%_42%)] bg-destructive-subtle border border-destructive/20 rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Замовлення постачальникам</h1>
          <p className="page-subtitle">{total} замовлень</p>
        </div>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Нове замовлення
        </Button>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-1.5 mb-5">
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

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Номер</TableHead>
              <TableHead>Постачальник</TableHead>
              <TableHead>Склад</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Сума</TableHead>
              <TableHead>Дата</TableHead>
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
            {!loading && orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState icon={ShoppingCart} title="Замовлень не знайдено" />
                </TableCell>
              </TableRow>
            )}
            {!loading && orders.map(po => (
              <TableRow key={po.id}>
                <TableCell className="font-mono font-medium text-foreground">{po.number}</TableCell>
                <TableCell className="text-foreground-muted">{po.supplierName ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{po.warehouseName ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[po.status] ?? 'secondary'}>
                    {STATUS_LABELS[po.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-medium">{fmt(po.totalAmount)}</TableCell>
                <TableCell className="text-foreground-faint text-xs">{new Date(po.createdAt).toLocaleDateString('uk-UA')}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => setShowDetail(po)}>
                    Деталі
                  </Button>
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
          <span className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground">{page}</span>
          <Button variant="outline" size="sm" disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Вперед →</Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Нове замовлення постачальнику"
        size="lg"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.supplierId || !form.warehouseId}
            className="w-full"
          >
            Створити замовлення
          </Button>
        }
      >
        <div className="space-y-4">
          <Select
            label="Постачальник"
            required
            value={form.supplierId}
            onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
            placeholder="Оберіть постачальника"
          >
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Select
            label="Склад"
            required
            value={form.warehouseId}
            onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))}
            placeholder="Оберіть склад"
          >
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          <Input
            label="Примітки"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Необов'язково"
          />

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Позиції</span>
              <Button variant="ghost" size="sm" onClick={addLine}>+ Додати</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <select
                    value={l.goodId}
                    onChange={e => {
                      const g = goods.find(g => g.id === e.target.value);
                      updateLine(i, 'goodId', e.target.value);
                      if (g?.purchasePrice) updateLine(i, 'price', String(g.purchasePrice));
                    }}
                    className="flex-1 px-2 py-1.5 border border-border rounded text-xs bg-surface text-foreground"
                  >
                    <option value="">Товар</option>
                    {goods.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <Input
                    type="number"
                    value={l.quantity}
                    onChange={e => updateLine(i, 'quantity', e.target.value)}
                    placeholder="Кіл."
                    min="0.001"
                    step="0.001"
                    className="w-20 text-xs"
                  />
                  <Input
                    type="number"
                    value={l.price}
                    onChange={e => updateLine(i, 'price', e.target.value)}
                    placeholder="Ціна"
                    min="0"
                    step="0.01"
                    className="w-24 text-xs"
                  />
                  <button onClick={() => removeLine(i)} className="text-destructive/60 hover:text-destructive text-sm px-1">×</button>
                </div>
              ))}
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">Замовлення можна створити без позицій і додати їх пізніше</p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `Замовлення ${showDetail.number}` : ''}
        size="lg"
        footer={
          showDetail && STATUS_TRANSITIONS[showDetail.status]?.length > 0 ? (
            <div className="flex flex-wrap gap-2 w-full">
              {STATUS_TRANSITIONS[showDetail.status]?.map(s => (
                <Button
                  key={s}
                  variant={s === 'CANCELLED' ? 'destructive' : 'default'}
                  size="sm"
                  onClick={() => s === 'RECEIVED' && ['ORDERED', 'PARTIAL'].includes(showDetail.status)
                    ? openReceive(showDetail)
                    : handleTransition(showDetail, s)}
                  loading={saving}
                >
                  {STATUS_ACTION_LABELS[s] ?? STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>
                {STATUS_LABELS[showDetail.status]}
              </Badge>
              <span className="text-muted-foreground text-sm">{showDetail.supplierName}</span>
              <span className="text-foreground-faint text-sm">→ {showDetail.warehouseName}</span>
            </div>

            {/* Lines table */}
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground">Товар</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Замовлено</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Отримано</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Ціна</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Сума</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {showDetail.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                      <td className="px-3 py-2 text-right">{l.quantity} {l.unit}</td>
                      <td className={cn('px-3 py-2 text-right font-medium', (l.receivedQty ?? 0) >= l.quantity ? 'text-success' : 'text-warning')}>
                        {l.receivedQty ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right">{fmt(l.price)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmt(l.amount ?? l.quantity * l.price)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-secondary">
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-right font-medium text-foreground-muted">Разом:</td>
                    <td className="px-3 py-2 text-right font-bold text-foreground">{fmt(showDetail.totalAmount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Receive modal */}
      <Modal
        open={!!showReceive}
        onClose={() => setShowReceive(null)}
        title={showReceive ? `Прийом по замовленню ${showReceive.number}` : ''}
        size="lg"
        footer={
          <Button onClick={handleReceive} loading={saving} className="w-full">
            Підтвердити прийом
          </Button>
        }
      >
        {showReceive && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Вкажіть кількість, яку фактично отримано по кожній позиції</p>
            <div className="space-y-3">
              {showReceive.lines.map((line, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-secondary rounded-lg">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-foreground">{line.goodName}</div>
                    <div className="text-xs text-muted-foreground">
                      Замовлено: {line.quantity} {line.unit} · Отримано раніше: {line.receivedQty ?? 0}
                    </div>
                  </div>
                  <Input
                    type="number"
                    value={receiveLines[i]?.receivedQty ?? ''}
                    onChange={e => setReceiveLines(ls => ls.map((l, idx) => idx === i ? { ...l, receivedQty: e.target.value } : l))}
                    placeholder={`макс. ${line.quantity - (line.receivedQty ?? 0)}`}
                    min="0"
                    max={line.quantity - (line.receivedQty ?? 0)}
                    step="0.001"
                    className="w-28 text-right"
                  />
                  <span className="text-xs text-muted-foreground">{line.unit}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
