'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, FileText } from 'lucide-react';
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
const TYPE_BADGE: Record<string, BadgeVariant> = {
  WRITEOFF: 'destructive', TRANSFER: 'default', OPENING_BALANCE: 'secondary',
};
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', CONFIRMED: 'Підтверджено', CANCELLED: 'Скасовано',
};
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', CONFIRMED: 'success', CANCELLED: 'destructive',
};

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
      const data = await apiFetch<Paginated>(`/stock-documents?${params}`);
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
        apiFetch<Branch[] | { items: Branch[] }>('/branches'),
        apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses'),
        apiFetch<{ items: Good[] } | Good[]>('/goods?limit=200'),
      ]).then(([b, w, g]) => {
        setBranches(Array.isArray(b) ? b : b.items);
        setWarehouses(Array.isArray(w) ? w : w.items);
        setGoods(Array.isArray(g) ? g : g.items);
      }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження довідників'));
    }
  }, [showCreate]);

  const handleCreate = async () => {
    setSaving(true);
    try {
      await apiFetch<StockDoc>('/stock-documents', {
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
    setSaving(true);
    setError('');
    try {
      await apiFetch<StockDoc>(`/stock-documents/${doc.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка зміни статусу'); }
    finally { setSaving(false); }
  };

  const addLine = () => setLines(l => [...l, { goodId: '', quantity: '1', price: '' }]);
  const updateLine = (i: number, field: string, value: string) =>
    setLines(l => l.map((x, idx) => idx === i ? { ...x, [field]: value } : x));
  const removeLine = (i: number) => setLines(l => l.filter((_, idx) => idx !== i));

  const types = ['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'];
  const statuses = ['', 'DRAFT', 'CONFIRMED', 'CANCELLED'];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Складські документи</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} документів</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          Новий документ
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="flex gap-1.5">
          {types.map(t => (
            <button
              key={t}
              onClick={() => { setTypeFilter(t); setPage(1); }}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                typeFilter === t
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50',
              )}
            >
              {t ? TYPE_LABELS[t] : 'Всі типи'}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                statusFilter === s
                  ? 'bg-gray-700 text-white border-gray-700'
                  : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50',
              )}
            >
              {s ? STATUS_LABELS[s] : 'Всі статуси'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Номер</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead>Склад</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Позицій</TableHead>
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
            {!loading && docs.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState icon={FileText} title="Документів не знайдено" />
                </TableCell>
              </TableRow>
            )}
            {!loading && docs.map(doc => (
              <TableRow key={doc.id}>
                <TableCell className="font-mono font-medium text-gray-900">{doc.number}</TableCell>
                <TableCell>
                  <Badge variant={TYPE_BADGE[doc.type] ?? 'secondary'}>
                    {TYPE_LABELS[doc.type]}
                  </Badge>
                </TableCell>
                <TableCell className="text-gray-600">
                  {doc.warehouseName}
                  {doc.targetWarehouseName && <span className="text-gray-400"> → {doc.targetWarehouseName}</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[doc.status] ?? 'secondary'}>
                    {STATUS_LABELS[doc.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-gray-500">{doc.lines.length}</TableCell>
                <TableCell className="text-gray-400 text-xs">{new Date(doc.createdAt).toLocaleDateString('uk-UA')}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => setShowDetail(doc)}>
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
          <span className="px-3 py-1.5 text-sm text-gray-500">Стор. {page}</span>
          <Button variant="outline" size="sm" disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Вперед →</Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Новий складський документ"
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Тип документа <span className="text-red-500">*</span></label>
            <Select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="WRITEOFF">Списання</option>
              <option value="TRANSFER">Переміщення між складами</option>
              <option value="OPENING_BALANCE">Початкові залишки</option>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Філія <span className="text-red-500">*</span></label>
            <Select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))} placeholder="Оберіть філію">
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {form.type === 'TRANSFER' ? 'Склад (джерело)' : 'Склад'} <span className="text-red-500">*</span>
            </label>
            <Select value={form.warehouseId} onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))} placeholder="Оберіть склад">
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          {form.type === 'TRANSFER' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Склад призначення <span className="text-red-500">*</span></label>
              <Select value={form.targetWarehouseId} onChange={e => setForm(f => ({ ...f, targetWarehouseId: e.target.value }))} placeholder="Оберіть склад">
                {warehouses.filter(w => w.id !== form.warehouseId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Примітки</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Позиції</label>
              <Button variant="ghost" size="sm" onClick={addLine}>+ Додати</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <select
                    value={l.goodId}
                    onChange={e => updateLine(i, 'goodId', e.target.value)}
                    className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs"
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
                  <button onClick={() => removeLine(i)} className="text-red-400 hover:text-red-600 text-sm px-1">×</button>
                </div>
              ))}
            </div>
          </div>

          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.branchId || !form.warehouseId}
            className="w-full"
          >
            Створити документ
          </Button>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `${TYPE_LABELS[showDetail.type]} ${showDetail.number}` : ''}
        size="lg"
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant={TYPE_BADGE[showDetail.type] ?? 'secondary'}>{TYPE_LABELS[showDetail.type]}</Badge>
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>{STATUS_LABELS[showDetail.status]}</Badge>
              <span className="text-gray-500 text-sm">{showDetail.warehouseName}</span>
              {showDetail.targetWarehouseName && (
                <span className="text-gray-400 text-sm">→ {showDetail.targetWarehouseName}</span>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border border-gray-100">
              <table className="w-full text-xs">
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
            </div>

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
                <Button
                  onClick={() => handleTransition(showDetail, 'CONFIRMED')}
                  loading={saving}
                  className="flex-1"
                >
                  Підтвердити документ
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleTransition(showDetail, 'CANCELLED')}
                  loading={saving}
                >
                  Скасувати
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
