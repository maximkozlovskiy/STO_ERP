'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, Users } from 'lucide-react';
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

interface Counterparty {
  id: string; type: string;
  firstName: string | null; lastName: string | null; companyName: string | null;
  phone: string | null; email: string | null; edrpou: string | null;
  vatPayer: boolean; balance: number; createdAt: string;
}
interface Paginated { items: Counterparty[]; total: number; page: number; limit: number; }

const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', SUPPLIER: 'Постачальник', BOTH: 'Обидва' };
const TYPE_BADGE: Record<string, BadgeVariant> = { CLIENT: 'default', SUPPLIER: 'secondary', BOTH: 'warning' };
const TYPE_FILTER_OPTIONS = [['', 'Всі'], ['CLIENT', 'Клієнти'], ['SUPPLIER', 'Постачальники'], ['BOTH', 'Обидва']] as const;

export default function CrmPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const router = useRouter();
  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '',
  });

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('q', search);
    if (typeFilter) params.set('type', typeFilter);
    apiFetch<Paginated>(`/counterparties?${params}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, search, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('Некоректний email'); return;
    }
    if (form.edrpou && !/^\d{8}$/.test(form.edrpou)) {
      setError('ЄДРПОУ повинен містити рівно 8 цифр'); return;
    }
    if (form.phone && !/^\+?[\d\s\-()+]{7,20}$/.test(form.phone)) {
      setError('Некоректний номер телефону'); return;
    }
    setSaving(true); setError('');
    try {
      await apiFetch<Counterparty>('/counterparties', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
        }),
      });
      setModal(false);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const displayName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? '—';

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Контрагенти</h1>
          <p className="page-subtitle">
            {data ? `${data.total} записів` : 'Завантаження...'}
          </p>
        </div>
        <Button
          leftIcon={<Plus />}
          onClick={() => {
            setForm({ type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '' });
            setError(''); setModal(true);
          }}
        >
          Додати
        </Button>
      </div>

      {!modal && error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <Input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Пошук за ім'ям, телефоном, ЄДРПОУ..."
          leftElement={<Search />}
          className="flex-1"
        />
        <Select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="w-44"
        >
          {TYPE_FILTER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Контрагент</TableHead>
            <TableHead>Тип</TableHead>
            <TableHead>Телефон</TableHead>
            <TableHead>ЄДРПОУ</TableHead>
            <TableHead>Баланс, ₴</TableHead>
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
                <EmptyState icon={Users} title="Нічого не знайдено" description="Спробуйте змінити параметри пошуку" size="sm" />
              </TableCell>
            </TableRow>
          )}
          {!loading && data?.items.map(cp => (
            <TableRow key={cp.id} onClick={() => router.push(`/crm/${cp.id}`)}>
              <TableCell>
                <p className="text-[13px] font-medium text-primary">{displayName(cp)}</p>
                {cp.email && <p className="text-[12px] text-muted-foreground mt-0.5">{cp.email}</p>}
              </TableCell>
              <TableCell>
                <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>
                  {TYPE_LABELS[cp.type]}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-[13px]">{cp.phone ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground text-[13px]">{cp.edrpou ?? '—'}</TableCell>
              <TableCell className={cn(
                'font-semibold tabular-nums text-[13px]',
                cp.balance < 0 ? 'text-[hsl(0_84%_42%)]' : cp.balance > 0 ? 'text-[hsl(142_71%_30%)]' : 'text-muted-foreground',
              )}>
                {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm">Картка →</Button>
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
        title="Новий контрагент"
        footer={
          <Button onClick={create} loading={saving}>Зберегти</Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Тип"
            required
            value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
          >
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>

          {form.type !== 'SUPPLIER' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ім'я"
                value={form.firstName}
                onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                placeholder="Іван"
              />
              <Input
                label="Прізвище"
                value={form.lastName}
                onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                placeholder="Коваль"
              />
            </div>
          )}

          <Input
            label="Назва компанії"
            value={form.companyName}
            onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
            placeholder="ТОВ «Авто»"
          />

          <Input
            label="Телефон"
            value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            placeholder="+38 (067) 123-45-67"
          />

          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
          />

          <Input
            label="ЄДРПОУ"
            value={form.edrpou}
            onChange={e => setForm(f => ({ ...f, edrpou: e.target.value }))}
            placeholder="12345678"
          />
        </div>
      </Modal>
    </div>
  );
}
