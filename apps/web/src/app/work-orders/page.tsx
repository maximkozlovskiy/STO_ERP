'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, ClipboardList, Eye, EyeOff, Search } from 'lucide-react';
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

interface WorkOrder {
  id: string; number: string; status: string;
  vehicleSummary?: string; counterpartyName?: string; branchName?: string;
  totalAmount: number; plannedAt?: string | null; createdAt: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  repairCategory?: 'MAINTENANCE' | 'CURRENT_REPAIR' | 'MAJOR_REPAIR' | 'BODY_REPAIR' | 'DIAGNOSTICS' | 'WARRANTY' | 'SEASONAL' | null;
  dueDate?: string | null;
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

const PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Низький', NORMAL: 'Звичайний', HIGH: 'Високий', URGENT: 'Терміново',
};

const PRIORITY_BADGE: Record<string, BadgeVariant> = {
  LOW: 'secondary', NORMAL: 'default', HIGH: 'warning', URGENT: 'destructive',
};

const CATEGORY_LABELS: Record<string, string> = {
  MAINTENANCE: 'ТО',
  CURRENT_REPAIR: 'Поточний ремонт',
  MAJOR_REPAIR: 'Кап. ремонт',
  BODY_REPAIR: 'Кузовний',
  DIAGNOSTICS: 'Діагностика',
  WARRANTY: 'Гарантійний',
  SEASONAL: 'Сезонне',
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function isOverdue(dueDateIso: string): boolean {
  const due = new Date(dueDateIso);
  due.setHours(23, 59, 59, 999);
  return due < new Date();
}

export default function WorkOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const router = useRouter();

  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);

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
    if (categoryFilter) p.set('repairCategory', categoryFilter);
    if (search) p.set('q', search);
    if (showDeleted) p.set('showDeleted', 'true');
    apiFetch<Paginated>(`/work-orders?${p}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, statusFilter, categoryFilter, search, showDeleted]);

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
        <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Status filter pills */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
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

      {/* Search + category filter + showDeleted controls */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Пошук за номером або клієнтом..."
            className="pl-9"
          />
        </div>

        <Select
          value={categoryFilter}
          onChange={e => { setCategoryFilter(e.target.value); setPage(1); }}
          className="w-52"
        >
          <option value="">Всі категорії</option>
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={() => { setShowDeleted(v => !v); setPage(1); }}
          className={cn(showDeleted && 'border-primary text-primary bg-primary/5')}
        >
          {showDeleted ? <EyeOff className="h-4 w-4 mr-1.5" /> : <Eye className="h-4 w-4 mr-1.5" />}
          {showDeleted ? 'Приховати видалені' : 'Показати видалені'}
        </Button>
      </div>

      {/* Table + DetailPanel */}
      <div className="flex gap-0 rounded-xl border border-border overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto border-r border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Номер</TableHead>
                <TableHead>Клієнт / Авто</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Пріоритет</TableHead>
                <TableHead>Сума, ₴</TableHead>
                <TableHead>Заплановано</TableHead>
                <TableHead>Дедлайн</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={8} className="py-12 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}

              {!loading && data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
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
                <TableRow
                  key={wo.id}
                  onClick={() => setSelectedWO(wo)}
                  className={cn(selectedWO?.id === wo.id && 'bg-primary/5')}
                >
                  <TableCell>
                    <div className="space-y-1">
                      <span className="text-[13px] font-semibold text-primary">{wo.number}</span>
                      {wo.repairCategory && (
                        <p className="text-[11px] text-muted-foreground">
                          {CATEGORY_LABELS[wo.repairCategory] ?? wo.repairCategory}
                        </p>
                      )}
                    </div>
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
                  <TableCell>
                    <Badge variant={PRIORITY_BADGE[wo.priority] ?? 'secondary'}>
                      {PRIORITY_LABELS[wo.priority] ?? wo.priority}
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
                  <TableCell className="text-[12px]">
                    {wo.dueDate ? (
                      <span className={cn(
                        'font-medium',
                        isOverdue(wo.dueDate) ? 'text-warning' : 'text-muted-foreground',
                      )}>
                        {formatDate(wo.dueDate)}
                      </span>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); router.push(`/work-orders/${wo.id}`); }}
                    >
                      Відкрити →
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedWO}
          onClose={() => setSelectedWO(null)}
          title={selectedWO?.number ?? ''}
        >
          {selectedWO && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={STATUS_BADGE[selectedWO.status] ?? 'secondary'} dot>
                  {STATUS_LABELS[selectedWO.status] ?? selectedWO.status}
                </Badge>
                <Badge variant={PRIORITY_BADGE[selectedWO.priority] ?? 'secondary'}>
                  {PRIORITY_LABELS[selectedWO.priority] ?? selectedWO.priority}
                </Badge>
              </div>

              <div className="space-y-2 text-[13px]">
                {selectedWO.repairCategory && (
                  <div>
                    <span className="text-muted-foreground">Категорія</span>
                    <p className="font-medium text-foreground mt-0.5">
                      {CATEGORY_LABELS[selectedWO.repairCategory] ?? selectedWO.repairCategory}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Клієнт</span>
                  <p className="font-medium text-foreground mt-0.5">{selectedWO.counterpartyName ?? '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Автомобіль</span>
                  <p className="font-medium text-foreground mt-0.5">{selectedWO.vehicleSummary ?? '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Сума</span>
                  <p className="font-semibold text-foreground mt-0.5 tabular-nums">
                    {selectedWO.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                  </p>
                </div>
                {selectedWO.dueDate && (
                  <div>
                    <span className="text-muted-foreground">Дедлайн</span>
                    <p className={cn(
                      'font-medium mt-0.5',
                      isOverdue(selectedWO.dueDate) ? 'text-warning' : 'text-foreground',
                    )}>
                      {formatDate(selectedWO.dueDate)}
                      {isOverdue(selectedWO.dueDate) && (
                        <span className="ml-1 text-[11px]">(прострочено)</span>
                      )}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Заплановано</span>
                  <p className="font-medium text-foreground mt-0.5">
                    {selectedWO.plannedAt
                      ? new Date(selectedWO.plannedAt).toLocaleString('uk-UA', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })
                      : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Створено</span>
                  <p className="font-medium text-foreground mt-0.5">
                    {new Date(selectedWO.createdAt).toLocaleString('uk-UA', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>

              <Button
                className="w-full"
                size="sm"
                onClick={() => router.push(`/work-orders/${selectedWO.id}`)}
              >
                Відкрити наряд
              </Button>
            </div>
          )}
        </DetailPanel>
      </div>

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
          <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
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
