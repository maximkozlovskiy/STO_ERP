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
import { cn } from '@/lib/utils';

interface WorkOrder {
  id: string; number: string; status: string;
  vehicleSummary?: string; counterpartyName?: string; branchName?: string;
  totalAmount: number; plannedAt?: string | null; createdAt: string;
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

const STATUS_TABS: Array<[string, string]> = [
  ['', 'Всі'],
  ['IN_PROGRESS', 'В роботі'],
  ['APPROVED', 'Затверджено'],
  ['ESTIMATE', 'Кошторис'],
  ['DRAFT', 'Чернетка'],
  ['COMPLETED', 'Виконано'],
  ['INVOICED', 'Виставлено'],
  ['PAID', 'Оплачено'],
  ['ON_HOLD', 'Призупинено'],
  ['CANCELLED', 'Скасовано'],
  ['ARCHIVED', 'Архів'],
];

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
  const [formError, setFormError] = useState('');

  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [form, setForm] = useState({
    branchId: '', vehicleId: '', counterpartyId: '',
    description: '', inMileage: '', plannedAt: '',
  });

  useEffect(() => {
    apiFetch<Branch[]>('/branches').then(setBranches)
      .catch((e: unknown) => setFormError(e instanceof Error ? e.message : 'Не вдалося завантажити філії'));
    apiFetch<{ items: Counterparty[] }>('/counterparties?limit=200')
      .then(r => setCounterparties(r.items))
      .catch((e: unknown) => setFormError(e instanceof Error ? e.message : 'Не вдалося завантажити контрагентів'));
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
    const mileage = form.inMileage ? Number(form.inMileage) : undefined;
    if (mileage !== undefined && (!Number.isFinite(mileage) || mileage < 0)) {
      setError('Пробіг повинен бути невід\'ємним числом');
      return;
    }
    setSaving(true); setError('');
    try {
      const wo = await apiFetch<WorkOrder>('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          branchId: form.branchId,
          vehicleId: form.vehicleId,
          counterpartyId: form.counterpartyId,
          description: form.description || undefined,
          inMileage: mileage,
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
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Наряди</h1>
          <p className="page-subtitle">
            {data ? `${data.total} записів` : 'Завантаження...'}
          </p>
        </div>
        <Button onClick={() => { setError(''); setModal(true); }} leftIcon={<Plus />}>
          Новий наряд
        </Button>
      </div>

      {!modal && error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Status filter pills */}
      <div className="flex gap-1.5 mb-5 flex-wrap">
        {STATUS_TABS.map(([v, l]) => (
          <button
            key={v}
            onClick={() => { setStatusFilter(v); setPage(1); }}
            className={cn(
              'px-3 py-1 rounded-full text-[12px] font-medium border transition-all duration-100',
              statusFilter === v
                ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                : 'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground',
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Table */}
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
              <TableCell colSpan={6} className="py-12 text-center">
                <div className="flex justify-center"><Spinner size="md" /></div>
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
                  size="sm"
                />
              </TableCell>
            </TableRow>
          )}

          {!loading && data?.items.map(wo => (
            <TableRow key={wo.id} onClick={() => router.push(`/work-orders/${wo.id}`)}>
              <TableCell>
                <span className="text-[13px] font-semibold text-primary">{wo.number}</span>
              </TableCell>
              <TableCell>
                <p className="text-[13px] font-medium text-foreground">{wo.counterpartyName ?? '—'}</p>
                <p className="text-[12px] text-muted-foreground mt-0.5">{wo.vehicleSummary ?? '—'}</p>
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_BADGE[wo.status] ?? 'secondary'} dot>
                  {STATUS_LABELS[wo.status] ?? wo.status}
                </Badge>
              </TableCell>
              <TableCell className="font-medium text-foreground tabular-nums">
                {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
              </TableCell>
              <TableCell className="text-muted-foreground text-[12px]">
                {wo.plannedAt
                  ? new Date(wo.plannedAt).toLocaleString('uk-UA', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })
                  : '—'}
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm">Відкрити →</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={cn(
                'h-8 w-8 rounded-lg text-[13px] font-medium border transition-colors',
                p === page
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
              )}
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
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.branchId || !form.vehicleId || !form.counterpartyId}
            className="w-full sm:w-auto"
          >
            Створити наряд
          </Button>
        }
      >
        {formError && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">
            {formError}
          </div>
        )}

        <div className="space-y-4">
          <Select
            label="Клієнт"
            required
            value={form.counterpartyId}
            onChange={e => {
              setForm(f => ({ ...f, counterpartyId: e.target.value, vehicleId: '' }));
              loadVehicles(e.target.value);
            }}
          >
            <option value="">— Оберіть —</option>
            {counterparties.map(c => (
              <option key={c.id} value={c.id}>{cpName(c)}</option>
            ))}
          </Select>

          <Select
            label="Автомобіль"
            required
            value={form.vehicleId}
            onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
            disabled={!form.counterpartyId}
          >
            <option value="">— Оберіть —</option>
            {vehicles.map(v => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model}{v.licensePlate ? ` (${v.licensePlate})` : ''}
              </option>
            ))}
          </Select>

          <Select
            label="Філія"
            required
            value={form.branchId}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
          >
            <option value="">— Оберіть —</option>
            {branches.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>

          <Input
            label="Опис"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Заміна масла, колодок..."
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Пробіг (вхід), км"
              type="number"
              value={form.inMileage}
              onChange={e => setForm(f => ({ ...f, inMileage: e.target.value }))}
              placeholder="50000"
            />
            <Input
              label="Заплановано"
              type="datetime-local"
              value={form.plannedAt}
              onChange={e => setForm(f => ({ ...f, plannedAt: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
