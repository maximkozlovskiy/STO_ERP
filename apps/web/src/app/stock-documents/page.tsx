'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, FileText, Eye, EyeOff } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel } from '@/components/ui/detail-panel';
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
  deletedAt?: string | null;
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
  const [showDeleted, setShowDeleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedDoc, setSelectedDoc] = useState<StockDoc | null>(null);
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
      if (showDeleted) params.set('showDeleted', 'true');
      const data = await apiFetch<Paginated>(`/stock-documents?${params}`);
      setDocs(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, statusFilter, showDeleted]);

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
    const validLines = lines.filter(l => l.goodId);
    for (const l of validLines) {
      const qty = parseFloat(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) { setError('Вкажіть коректну кількість для всіх позицій'); return; }
    }
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
          lines: validLines.map(l => ({
            goodId: l.goodId,
            quantity: parseFloat(l.quantity),
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
    <div className="page-container">
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Складські документи</h1>
          <p className="page-subtitle">{total} документів</p>
        </div>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Новий документ
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Type filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">Тип</span>
          {types.map(t => (
            <button
              key={t}
              onClick={() => { setTypeFilter(t); setPage(1); }}
              className={cn(
                'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
                typeFilter === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
              )}
            >
              {t ? TYPE_LABELS[t] : 'Всі'}
            </button>
          ))}
        </div>
        {/* Divider */}
        <div className="h-6 w-px bg-border" />
        {/* Status filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">Статус</span>
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={cn(
                'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
                statusFilter === s
                  ? 'bg-foreground text-primary-foreground border-foreground'
                  : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
              )}
            >
              {s ? STATUS_LABELS[s] : 'Всі'}
            </button>
          ))}
        </div>
        {/* Show deleted */}
        <button
          onClick={() => { setShowDeleted(v => !v); setPage(1); }}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
            showDeleted
              ? 'bg-destructive/10 text-destructive border-destructive/30'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
          )}
        >
          {showDeleted ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          Показати видалені
        </button>
      </div>

      {/* Table + DetailPanel */}
      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl">
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
                <TableRow
                  key={doc.id}
                  className={cn(
                    'cursor-pointer',
                    selectedDoc?.id === doc.id && 'bg-secondary',
                    doc.deletedAt && 'opacity-60',
                  )}
                  onClick={() => setSelectedDoc(prev => prev?.id === doc.id ? null : doc)}
                >
                  <TableCell className="font-mono font-medium text-foreground">
                    {doc.number}
                    {doc.deletedAt && (
                      <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">видалено</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_BADGE[doc.type] ?? 'secondary'}>
                      {TYPE_LABELS[doc.type]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-foreground-muted">
                    {doc.warehouseName}
                    {doc.targetWarehouseName && <span className="text-muted-foreground"> → {doc.targetWarehouseName}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[doc.status] ?? 'secondary'}>
                      {STATUS_LABELS[doc.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{doc.lines.length}</TableCell>
                  <TableCell className="text-foreground-faint text-xs">{new Date(doc.createdAt).toLocaleDateString('uk-UA')}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); setShowDetail(doc); }}
                    >
                      Деталі
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Detail panel */}
        <DetailPanel
          open={!!selectedDoc}
          onClose={() => setSelectedDoc(null)}
          title={selectedDoc ? selectedDoc.number : ''}
        >
          {selectedDoc && (
            <div className="space-y-4">
              {/* Badges */}
              <div className="flex flex-wrap gap-1.5">
                <Badge variant={TYPE_BADGE[selectedDoc.type] ?? 'secondary'}>
                  {TYPE_LABELS[selectedDoc.type]}
                </Badge>
                <Badge variant={STATUS_BADGE[selectedDoc.status] ?? 'secondary'}>
                  {STATUS_LABELS[selectedDoc.status]}
                </Badge>
              </div>

              {/* Meta */}
              <div className="space-y-2 text-sm">
                {selectedDoc.branchName && (
                  <div>
                    <span className="text-muted-foreground">Філія:</span>{' '}
                    <span className="text-foreground">{selectedDoc.branchName}</span>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Склад:</span>{' '}
                  <span className="text-foreground">{selectedDoc.warehouseName}</span>
                </div>
                {selectedDoc.targetWarehouseName && (
                  <div>
                    <span className="text-muted-foreground">Склад призначення:</span>{' '}
                    <span className="text-foreground">{selectedDoc.targetWarehouseName}</span>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Створено:</span>{' '}
                  <span className="text-foreground">{new Date(selectedDoc.createdAt).toLocaleDateString('uk-UA')}</span>
                </div>
                {selectedDoc.confirmedAt && (
                  <div>
                    <span className="text-muted-foreground">Підтверджено:</span>{' '}
                    <span className="text-foreground">{new Date(selectedDoc.confirmedAt).toLocaleString('uk-UA')}</span>
                  </div>
                )}
              </div>

              {/* Lines */}
              {selectedDoc.lines.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Позиції ({selectedDoc.lines.length})
                  </p>
                  <div className="space-y-1.5">
                    {selectedDoc.lines.map((l, i) => (
                      <div key={i} className="text-xs bg-secondary rounded-lg px-3 py-2">
                        <p className="font-medium text-foreground">{l.goodName ?? l.goodId}</p>
                        <p className="text-muted-foreground mt-0.5">
                          {l.quantity} {l.unit}
                          {l.price != null && <span> · {l.price.toFixed(2)} ₴</span>}
                        </p>
                        {l.goodSku && <p className="text-muted-foreground font-mono">Арт: {l.goodSku}</p>}
                      </div>
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
        title="Новий складський документ"
        size="lg"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.branchId || !form.warehouseId}
            className="w-full"
          >
            Створити документ
          </Button>
        }
      >
        <div className="space-y-4">
          <Select
            label="Тип документа"
            required
            value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
          >
            <option value="WRITEOFF">Списання</option>
            <option value="TRANSFER">Переміщення між складами</option>
            <option value="OPENING_BALANCE">Початкові залишки</option>
          </Select>
          <Select
            label="Філія"
            required
            value={form.branchId}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
            placeholder="Оберіть філію"
          >
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select
            label={form.type === 'TRANSFER' ? 'Склад (джерело)' : 'Склад'}
            required
            value={form.warehouseId}
            onChange={e => setForm(f => ({ ...f, warehouseId: e.target.value }))}
            placeholder="Оберіть склад"
          >
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          {form.type === 'TRANSFER' && (
            <Select
              label="Склад призначення"
              required
              value={form.targetWarehouseId}
              onChange={e => setForm(f => ({ ...f, targetWarehouseId: e.target.value }))}
              placeholder="Оберіть склад"
            >
              {warehouses.filter(w => w.id !== form.warehouseId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}
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
                    onChange={e => updateLine(i, 'goodId', e.target.value)}
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
            </div>
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `${TYPE_LABELS[showDetail.type]} ${showDetail.number}` : ''}
        size="lg"
        footer={
          showDetail?.status === 'DRAFT' ? (
            <div className="flex gap-2 w-full">
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
          ) : undefined
        }
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant={TYPE_BADGE[showDetail.type] ?? 'secondary'}>{TYPE_LABELS[showDetail.type]}</Badge>
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>{STATUS_LABELS[showDetail.status]}</Badge>
              <span className="text-muted-foreground text-sm">{showDetail.warehouseName}</span>
              {showDetail.targetWarehouseName && (
                <span className="text-foreground-faint text-sm">→ {showDetail.targetWarehouseName}</span>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground">Товар</th>
                    <th className="text-left px-3 py-2 text-muted-foreground">Артикул</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Кількість</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Ціна</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {showDetail.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                      <td className="px-3 py-2 text-foreground-faint font-mono">{l.goodSku ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-medium">{l.quantity} {l.unit}</td>
                      <td className="px-3 py-2 text-right">{l.price != null ? l.price.toFixed(2) + ' ₴' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}

            {showDetail.confirmedAt && (
              <p className="text-xs text-foreground-faint">
                Підтверджено: {new Date(showDetail.confirmedAt).toLocaleString('uk-UA')}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
