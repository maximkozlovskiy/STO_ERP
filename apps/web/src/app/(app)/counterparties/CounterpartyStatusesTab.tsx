'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Pencil, Trash2, Tag, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CounterpartyStatus {
  id: string;
  name: string;
  color: string;
  counterpartyCount: number;
  deletedAt?: string | null;
}

const DEFAULT_COLOR = '#6b7280';

// Пресет-палітра для швидкого вибору (керує кольором badge-мітки у картці контрагента).
const PRESET_COLORS = [
  '#ef4444', // червоний — Чорний список / Проблемний
  '#f59e0b', // бурштиновий — VIP
  '#10b981', // зелений — Постійний
  '#3b82f6', // синій
  '#8b5cf6', // фіолетовий
  '#ec4899', // рожевий
  '#6b7280', // сірий (default)
  '#0ea5e9', // блакитний
];

// ─── Statuses Tab (кастомні мітки контрагентів) ─────────────────────────────────

export default function CounterpartyStatusesTab() {
  const { confirm, dialogProps } = useConfirm();
  const [statuses, setStatuses] = useState<CounterpartyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [modal, setModal] = useState(false);
  const [editStatus, setEditStatus] = useState<CounterpartyStatus | null>(null);
  const [form, setForm] = useState({ name: '', color: DEFAULT_COLOR });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  // race-guard для swift showDeleted toggles — outdated response відкидається.
  const loadReqRef = useRef(0);

  const load = useCallback(
    (opts?: { fromCache?: boolean; withDeleted?: boolean }) => {
      const fromCache = opts?.fromCache ?? false;
      const withDeleted = opts?.withDeleted ?? showDeleted;
      const cached =
        fromCache && !withDeleted
          ? getCached<CounterpartyStatus[]>('cache:counterparty-statuses')
          : null;
      if (cached) {
        setStatuses(cached);
        setLoading(false);
      } else setLoading(true);
      const url = withDeleted
        ? '/counterparty-statuses?showDeleted=true'
        : '/counterparty-statuses';
      const reqId = ++loadReqRef.current;
      apiFetch<{ items: CounterpartyStatus[]; total: number }>(url)
        .then(r => {
          if (loadReqRef.current !== reqId) return;
          setStatuses(r.items);
          if (!withDeleted) setCache('cache:counterparty-statuses', r.items);
        })
        .catch((e: unknown) => {
          if (loadReqRef.current !== reqId) return;
          if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження');
        })
        .finally(() => {
          if (loadReqRef.current === reqId) setLoading(false);
        });
    },
    [showDeleted],
  );

  useEffect(() => {
    load({ fromCache: !showDeleted });
  }, [load, showDeleted]);

  const openCreate = () => {
    setEditStatus(null);
    setForm({ name: '', color: DEFAULT_COLOR });
    setError('');
    setModal(true);
  };
  const openEdit = (s: CounterpartyStatus) => {
    setEditStatus(s);
    setForm({ name: s.name, color: s.color ?? DEFAULT_COLOR });
    setError('');
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Назва є обов'язковою");
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = { name: form.name.trim(), color: form.color };
      if (editStatus) {
        await apiFetch<CounterpartyStatus>(`/counterparty-statuses/${editStatus.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<CounterpartyStatus>('/counterparty-statuses', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: CounterpartyStatus) => {
    if (
      !(await confirm({
        title: 'Помітити статус на видалення?',
        message: s.counterpartyCount
          ? `Статус призначено ${s.counterpartyCount} контрагентам — мітка зникне з їхніх карток. Можна відновити.`
          : 'Статус можна відновити пізніше.',
        variant: 'destructive',
      }))
    )
      return;
    setDeletingId(s.id);
    try {
      await apiFetch<void>(`/counterparty-statuses/${s.id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setDeletingId(null);
    }
  };

  const restore = async (id: string) => {
    // in-flight guard: duplicate POSTs → 2nd+ returns 404 → false-error in UI.
    if (restoringIds.has(id)) return;
    setError('');
    setRestoringIds(prev => new Set(prev).add(id));
    try {
      await apiFetch<CounterpartyStatus>(`/counterparty-statuses/${id}/restore`, {
        method: 'POST',
      });
      load();
      toast.success('Статус відновлено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка відновлення');
    } finally {
      setRestoringIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const activeCount = statuses.filter(s => !s.deletedAt).length;
  const deletedCount = statuses.filter(s => !!s.deletedAt).length;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">
          Кастомні мітки контрагентів (VIP, Постійний, Проблемний, Чорний список)
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => setShowDeleted(d => !d)}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            Статус
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва статусу</TableHead>
              <TableHead>Контрагентів</TableHead>
              <TableHead className="text-right">
                {activeCount > 0 && (
                  <span className="text-[12px] text-muted-foreground font-normal">
                    {activeCount} активних
                    {deletedCount > 0 && !showDeleted && ` · ${deletedCount} архів`}
                  </span>
                )}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading && statuses.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="p-0">
                  <EmptyState
                    icon={Tag}
                    title="Статуси відсутні"
                    description="Додайте перший статус-мітку"
                  />
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              statuses.map(s => {
                const isDeleted = !!s.deletedAt;
                return (
                  <TableRow
                    key={s.id}
                    className={cn('group', isDeleted && 'opacity-60 bg-secondary/30')}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium text-white"
                          style={{ backgroundColor: s.color ?? DEFAULT_COLOR }}
                        >
                          {s.name}
                        </span>
                        {isDeleted && <Badge variant="secondary">видалено</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-[13px] text-muted-foreground tabular-nums">
                        {s.counterpartyCount}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isDeleted ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={restoringIds.has(s.id)}
                            disabled={restoringIds.has(s.id)}
                            onClick={() => void restore(s.id)}
                            className="text-success/70 hover:text-success hover:bg-success/10"
                            title="Відновити"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(s)}
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={deletingId === s.id}
                              onClick={() => void remove(s)}
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                              title="Помітити на видалення"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editStatus ? 'Редагувати статус' : 'Новий статус'}
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name.trim()} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва статусу"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="наприклад: VIP, Постійний, Чорний список"
            autoFocus
            className="h-8 text-[13px]"
          />

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Колір</label>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, color: c }))}
                  className={cn(
                    'h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    form.color === c ? 'border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: c }}
                  aria-label={`Колір ${c}`}
                />
              ))}
              <input
                type="color"
                value={form.color}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                className="h-7 w-9 rounded border border-border bg-transparent cursor-pointer"
                aria-label="Власний колір"
              />
            </div>

            {/* Preview */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">Вигляд мітки:</span>
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium text-white"
                style={{ backgroundColor: form.color }}
              >
                {form.name.trim() || 'Назва'}
              </span>
            </div>
          </div>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
