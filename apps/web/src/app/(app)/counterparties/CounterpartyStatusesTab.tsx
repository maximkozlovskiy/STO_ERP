'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('counterparties');
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
          if (!cached) setError(e instanceof Error ? e.message : t('statusesTab.loadFailed'));
        })
        .finally(() => {
          if (loadReqRef.current === reqId) setLoading(false);
        });
    },
    [showDeleted, t],
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

  // `void` в onClick: обробник сам ловить помилку у catch і показує її користувачу
  // (банер setError / toast.error) — проміс більше нікому не потрібен.
  const save = async () => {
    if (!form.name.trim()) {
      setError(t('statusesTab.nameRequired'));
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
      setError(e instanceof Error ? e.message : t('statusesTab.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: CounterpartyStatus) => {
    if (
      !(await confirm({
        title: t('statusesTab.confirmDeleteTitle'),
        message: s.counterpartyCount
          ? t('statusesTab.confirmDeleteAssigned', { count: s.counterpartyCount })
          : t('statusesTab.confirmDeleteUnassigned'),
        variant: 'destructive',
      }))
    )
      return;
    setDeletingId(s.id);
    try {
      await apiFetch<void>(`/counterparty-statuses/${s.id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('statusesTab.deleteFailed'));
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
      toast.success(t('statusesTab.restored'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('statusesTab.restoreFailed'));
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
        <p className="text-[13px] text-muted-foreground">{t('statusesTab.description')}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? t('statusesTab.hideDeleted') : t('statusesTab.showDeleted')}
            onClick={() => setShowDeleted(d => !d)}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            {t('statusesTab.addStatus')}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('statusesTab.colName')}</TableHead>
              <TableHead>{t('statusesTab.colCounterparties')}</TableHead>
              <TableHead className="text-right">
                {activeCount > 0 && (
                  <span className="text-[12px] text-muted-foreground font-normal">
                    {t('statusesTab.activeCount', { count: activeCount })}
                    {deletedCount > 0 &&
                      !showDeleted &&
                      t('statusesTab.archiveSuffix', { count: deletedCount })}
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
                    title={t('statusesTab.emptyTitle')}
                    description={t('statusesTab.emptyDescription')}
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
                        {isDeleted && <Badge variant="secondary">{t('badges.deleted')}</Badge>}
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
                            title={t('statusesTab.restore')}
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
                              title={t('statusesTab.markForDeletion')}
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
        title={editStatus ? t('statusesTab.modalEditTitle') : t('statusesTab.modalCreateTitle')}
        footer={
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!form.name.trim()}
            className="w-full"
          >
            {t('statusesTab.save')}
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
            label={t('statusesTab.nameLabel')}
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('statusesTab.namePlaceholder')}
            autoFocus
            className="h-8 text-[13px]"
          />

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('statusesTab.colorLabel')}
            </label>
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
                  aria-label={t('statusesTab.colorAria', { color: c })}
                />
              ))}
              <input
                type="color"
                value={form.color}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                className="h-7 w-9 rounded border border-border bg-transparent cursor-pointer"
                aria-label={t('statusesTab.customColorAria')}
              />
            </div>

            {/* Preview */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">
                {t('statusesTab.previewLabel')}
              </span>
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium text-white"
                style={{ backgroundColor: form.color }}
              >
                {form.name.trim() || t('statusesTab.previewFallback')}
              </span>
            </div>
          </div>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
