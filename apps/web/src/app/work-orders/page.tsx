'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, ClipboardList } from 'lucide-react';
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

const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', ESTIMATE: 'warning', APPROVED: 'default',
  IN_PROGRESS: 'default', ON_HOLD: 'warning', COMPLETED: 'success',
  INVOICED: 'default', PAID: 'success', ARCHIVED: 'secondary', CANCELLED: 'destructive',
};

export default function WorkOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const router = useRouter();

  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [form, setForm] = useState({
    branchId: '', vehicleId: '', counterpartyId: '',
    description: '', inMileage: '', plannedAt: '',
  });

  useEffect(() => {
    apiFetch<Branch[]>('/branches').then(setBranches)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Не вдалося завантажити філії'));
    apiFetch<{ items: Counterparty[] }>('/counterparties?limit=200')
      .then(r => setCounterparties(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Не вдалося завантажити контрагентів'));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter) p.set('status', statusFilter);
    apiFetch<Paginated>(`/work-orders?${p}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const loadVehicles = (counterpartyId: string) => {
    if (!counterpartyId) return;
    apiFetch<Array<{ id: string }>>(`/counterparties/${counterpartyId}/garages`)
      .then(garages => {
        const garagesArr = Array.isArray(garages) ? garages : [];
        return Promise.all(
          garagesArr.map(g =>
            apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}`).catch(() => [] as Vehicle[])
          ),
        );
      })
      .then(results => setVehicles(results.flat()))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження автомобілів'));
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
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Наряди</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data ? `${data.total} записів` : 'Завантаження...'}
          </p>
        </div>
        <Button onClick={() => { setError(''); setModal(true); }}>
          <Plus className="h-4 w-4" />
          Новий наряд
        </Button>
      </div>

      {/* Error banner */}
      {!modal && error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Status filter tabs */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {([['', 'Всі'], ...Object.entries(STATUS_LABELS)] as [string, string][]).map(([v, l]) => (
          <button
            key={v}
            onClick={() => { setStatusFilter(v); setPage(1); }}
            className={[
              'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
              statusFilter === v
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50',
            ].join(' ')}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Номер</TableHead>
              <TableHead>Клієнт / Авто</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>Сума, ₴</TableHead>
              <TableHead>Заплановано</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}

            {!loading && data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={ClipboardList}
                    title="Нарядів не знайдено"
                    description={statusFilter ? 'Спробуйте змінити фільтр статусу' : 'Створіть перший наряд, натиснувши кнопку вище'}
                  />
                </TableCell>
              </TableRow>
            )}

            {!loading && data?.items.map(wo => (
              <TableRow key={wo.id}>
                <TableCell>
                  <button
                    onClick={() => router.push(`/work-orders/${wo.id}`)}
                    className="text-sm font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    {wo.number}
                  </button>
                </TableCell>
                <TableCell>
                  <p className="font-medium text-gray-900">{wo.counterpartyName ?? '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{wo.vehicleSummary ?? '—'}</p>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[wo.status] ?? 'secondary'}>
                    {STATUS_LABELS[wo.status] ?? wo.status}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium text-gray-900">
                  {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                </TableCell>
                <TableCell className="text-gray-500">
                  {wo.plannedAt
                    ? new Date(wo.plannedAt).toLocaleString('uk-UA', {
                        day: '2-digit', month: '2-digit',
                        hour: '2-digit', minute: '2-digit',
                      })
                    : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => router.push(`/work-orders/${wo.id}`)}
                  >
                    Картка →
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={[
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                p === page
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50',
              ].join(' ')}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Новий наряд"
        description="Заповніть дані для створення наряду"
      >
        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Клієнт <span className="text-red-500">*</span>
            </label>
            <Select
              value={form.counterpartyId}
              onChange={e => {
                setForm(f => ({ ...f, counterpartyId: e.target.value, vehicleId: '' }));
                loadVehicles(e.target.value);
              }}
              placeholder="— Оберіть —"
            >
              {counterparties.map(c => (
                <option key={c.id} value={c.id}>{cpName(c)}</option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Автомобіль <span className="text-red-500">*</span>
            </label>
            <Select
              value={form.vehicleId}
              onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
              disabled={!form.counterpartyId}
              placeholder="— Оберіть —"
            >
              {vehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {v.make} {v.model}{v.licensePlate ? ` (${v.licensePlate})` : ''}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Філія <span className="text-red-500">*</span>
            </label>
            <Select
              value={form.branchId}
              onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
              placeholder="— Оберіть —"
            >
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Опис</label>
            <Input
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Заміна масла, колодок..."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Пробіг (вхід), км
              </label>
              <Input
                type="number"
                value={form.inMileage}
                onChange={e => setForm(f => ({ ...f, inMileage: e.target.value }))}
                placeholder="50000"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Заплановано</label>
              <Input
                type="datetime-local"
                value={form.plannedAt}
                onChange={e => setForm(f => ({ ...f, plannedAt: e.target.value }))}
              />
            </div>
          </div>

          <Button
            onClick={create}
            loading={saving}
            disabled={!form.branchId || !form.vehicleId || !form.counterpartyId}
            className="w-full mt-2"
          >
            Створити наряд
          </Button>
        </div>
      </Modal>
    </div>
  );
}
