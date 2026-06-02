'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Trash2, Ruler, Pencil, Check, X, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
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

interface Unit {
  id: string;
  name: string;
  shortName: string;
  isSystem: boolean;
  coefficient: number;
  deletedAt?: string | null;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  volume?: number | null;
  weight?: number | null;
}

interface EditForm {
  name: string;
  shortName: string;
  coefficient: string;
}

const EMPTY_FORM = {
  name: '',
  shortName: '',
  coefficient: '1',
  width: '',
  height: '',
  depth: '',
  volume: '',
  weight: '',
};

// ─── Inline edit row ──────────────────────────────────────────────────────────

interface InlineEditRowProps {
  unit: Unit;
  onSave: (id: string, form: EditForm) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

function InlineEditRow({ unit, onSave, onCancel, saving }: InlineEditRowProps) {
  const [form, setForm] = useState<EditForm>({
    name: unit.name,
    shortName: unit.shortName,
    coefficient: String(unit.coefficient),
  });
  const shortNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    shortNameRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSave(unit.id, form);
    }
  };

  const valid = form.name.trim() && form.shortName.trim();

  return (
    <TableRow className="bg-primary/5">
      <TableCell>
        <input
          ref={shortNameRef}
          value={form.shortName}
          onChange={e => setForm(f => ({ ...f, shortName: e.target.value }))}
          onKeyDown={handleKeyDown}
          placeholder="шт"
          className="w-full rounded border border-primary/40 bg-surface px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </TableCell>
      <TableCell>
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          onKeyDown={handleKeyDown}
          placeholder="штука"
          className="w-full rounded border border-primary/40 bg-surface px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </TableCell>
      <TableCell>
        <input
          value={form.coefficient}
          onChange={e => setForm(f => ({ ...f, coefficient: e.target.value }))}
          onKeyDown={handleKeyDown}
          type="number"
          min="0"
          step="any"
          placeholder="1"
          className="w-24 rounded border border-primary/40 bg-surface px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSave(unit.id, form)}
            disabled={!valid || saving}
            className="text-success/80 hover:text-success hover:bg-success/10"
            title="Зберегти (Enter)"
          >
            {saving ? <Spinner size="xs" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground"
            title="Скасувати (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Units Tab ────────────────────────────────────────────────────────────────

export default function UnitsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  // Bug #303: блокування повторних кліків Restore (інакше дублюючі POST → 2nd+ повертає 404)
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());

  const load = useCallback(
    (opts?: { fromCache?: boolean; withDeleted?: boolean; signal?: AbortSignal }) => {
      const fromCache = opts?.fromCache ?? false;
      const withDeleted = opts?.withDeleted ?? showDeleted;
      const cached = fromCache && !withDeleted ? getCached<Unit[]>('cache:units') : null;
      if (cached) {
        setUnits(cached);
        setLoading(false);
      } else setLoading(true);

      const url = withDeleted ? '/units?showDeleted=true' : '/units';
      return apiFetch<Unit[]>(url, opts?.signal ? { signal: opts.signal } : undefined)
        .then(d => {
          if (opts?.signal?.aborted) return;
          setUnits(d);
          // Bug #300: cache:units завжди має містити лише активні (consumers like GoodsTab
          // показують одиниці у select). Якщо ми у withDeleted режимі — фільтруємо клієнтсайд.
          const activeOnly = withDeleted ? d.filter(u => !u.deletedAt) : d;
          setCache('cache:units', activeOnly);
        })
        .catch((e: unknown) => {
          if (opts?.signal?.aborted) return;
          if (e instanceof Error && e.name === 'AbortError') return;
          if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження');
        })
        .finally(() => {
          if (opts?.signal?.aborted) return;
          setLoading(false);
        });
    },
    [showDeleted],
  );

  useEffect(() => {
    // Bug #301: AbortController щоб попередній fetch не "виграв" race після toggle.
    const controller = new AbortController();
    load({ fromCache: !showDeleted, signal: controller.signal });
    return () => controller.abort();
  }, [load, showDeleted]);

  // ── Create ────────────────────────────────────────────────────────────────

  const create = async () => {
    if (!form.name.trim() || !form.shortName.trim()) {
      setError("Усі поля є обов'язковими");
      return;
    }
    // Bug #302: coefficient = 0 → divide-by-zero у qty_base. Frontend guard.
    const coeff = form.coefficient ? Number(form.coefficient) : undefined;
    if (coeff !== undefined && (!Number.isFinite(coeff) || coeff <= 0)) {
      setError('Коефіцієнт має бути більший 0');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch<Unit>('/units', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          shortName: form.shortName.trim(),
          coefficient: coeff,
          width: form.width ? Number(form.width) : undefined,
          height: form.height ? Number(form.height) : undefined,
          depth: form.depth ? Number(form.depth) : undefined,
          volume: form.volume ? Number(form.volume) : undefined,
          weight: form.weight ? Number(form.weight) : undefined,
        }),
      });
      setModal(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  // ── Inline update ─────────────────────────────────────────────────────────

  const saveEdit = async (id: string, editForm: EditForm) => {
    if (!editForm.name.trim() || !editForm.shortName.trim()) {
      setEditError("Скорочення та назва є обов'язковими");
      return;
    }
    // Bug #302: coefficient guard
    const coeff = editForm.coefficient ? Number(editForm.coefficient) : undefined;
    if (coeff !== undefined && (!Number.isFinite(coeff) || coeff <= 0)) {
      setEditError('Коефіцієнт має бути більший 0');
      return;
    }
    setEditSaving(true);
    setEditError('');
    try {
      await apiFetch<Unit>(`/units/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.name.trim(),
          shortName: editForm.shortName.trim(),
          coefficient: coeff,
        }),
      });
      setEditingId(null);
      load();
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setEditSaving(false);
    }
  };

  // ── Delete (soft) ─────────────────────────────────────────────────────────

  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: 'Помітити на видалення?',
        message: 'Одиницю буде деактивовано. Можна відновити.',
        variant: 'destructive',
      }))
    )
      return;
    // Bug #304: очистити попередню помилку перед action
    setError('');
    try {
      await apiFetch<void>(`/units/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  // ── Restore ───────────────────────────────────────────────────────────────

  const restore = async (id: string) => {
    // Bug #303: in-flight guard — блокувати повторні кліки, інакше дублюючі POST → 404 errors
    if (restoringIds.has(id)) return;
    setRestoringIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setError('');
    try {
      await apiFetch<Unit>(`/units/${id}/restore`, { method: 'POST' });
      load();
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

  const activeCount = units.filter(u => !u.deletedAt).length;
  const deletedCount = units.filter(u => !!u.deletedAt).length;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      {editError && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {editError}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-muted-foreground">
            Одиниці виміру, що використовуються в каталозі товарів
          </p>
          {/* Filter pills */}
          <div className="flex gap-1" role="group" aria-label="Фільтр одиниць">
            <button
              type="button"
              onClick={() => setShowDeleted(false)}
              aria-pressed={!showDeleted}
              className={cn(
                'px-2.5 py-0.5 rounded-full text-[12px] font-medium border transition-colors',
                !showDeleted
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary',
              )}
            >
              Активні{activeCount > 0 && ` (${activeCount})`}
            </button>
            {/* Bug #295: кнопка "Всі" завжди видима, інакше soft-delete feature недосяжна
                (initial state showDeleted=false → API повертає тільки активні → deletedCount=0
                → кнопка не рендерилась → користувач не міг переключитися у режим перегляду
                видалених і відновити одиницю). */}
            <button
              type="button"
              onClick={() => setShowDeleted(true)}
              aria-pressed={showDeleted}
              className={cn(
                'px-2.5 py-0.5 rounded-full text-[12px] font-medium border transition-colors',
                showDeleted
                  ? 'bg-destructive/10 text-destructive border-destructive/30'
                  : 'border-border text-muted-foreground hover:bg-secondary',
              )}
            >
              Архів{showDeleted && deletedCount > 0 && ` (${deletedCount})`}
            </button>
          </div>
        </div>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            setError('');
            setModal(true);
          }}
        >
          Одиниця
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Скорочення</TableHead>
              <TableHead>Назва</TableHead>
              <TableHead>Коефіцієнт</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading && units.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState icon={Ruler} title="Одиниці відсутні" />
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              units.map(u => {
                const isDeleted = !!u.deletedAt;

                if (editingId === u.id && !isDeleted) {
                  return (
                    <InlineEditRow
                      key={u.id}
                      unit={u}
                      onSave={saveEdit}
                      onCancel={() => {
                        setEditingId(null);
                        setEditError('');
                      }}
                      saving={editSaving}
                    />
                  );
                }

                return (
                  <TableRow
                    key={u.id}
                    className={cn(
                      'group',
                      isDeleted
                        ? 'bg-secondary/30 text-muted-foreground'
                        : !u.isSystem
                          ? 'cursor-pointer hover:bg-surface-hover'
                          : '',
                    )}
                    onClick={() => {
                      if (!isDeleted && !u.isSystem && editingId === null) {
                        setEditError('');
                        setEditingId(u.id);
                      }
                    }}
                  >
                    <TableCell
                      className={cn(
                        'font-medium',
                        isDeleted ? 'line-through text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {u.shortName}
                    </TableCell>
                    <TableCell
                      className={cn(
                        isDeleted ? 'line-through text-muted-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {u.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {u.coefficient !== 1 ? u.coefficient : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isDeleted ? (
                          // Deleted: show restore button
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={e => {
                              e.stopPropagation();
                              void restore(u.id);
                            }}
                            disabled={restoringIds.has(u.id)}
                            className="text-success/70 hover:text-success hover:bg-success/10"
                            title="Відновити"
                          >
                            {restoringIds.has(u.id) ? (
                              <Spinner size="xs" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        ) : u.isSystem ? (
                          <span className="text-[11px] px-1.5 py-0.5 bg-info-subtle text-info rounded">
                            системна
                          </span>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={e => {
                                e.stopPropagation();
                                setEditError('');
                                setEditingId(u.id);
                              }}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                              title="Редагувати"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={e => {
                                e.stopPropagation();
                                void remove(u.id);
                              }}
                              className="opacity-0 group-hover:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                              title="Позначити на видалення"
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

      {/* ── Create modal ──────────────────────────────────────────────────── */}
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Нова одиниця виміру"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.name || !form.shortName}
            className="w-full"
          >
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
            label="Скорочення"
            required
            value={form.shortName}
            onChange={e => setForm(f => ({ ...f, shortName: e.target.value }))}
            placeholder="шт"
          />
          <Input
            label="Повна назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="штука"
          />
          <Input
            label="Коефіцієнт"
            type="number"
            value={form.coefficient}
            onChange={e => setForm(f => ({ ...f, coefficient: e.target.value }))}
            placeholder="1"
            hint="Коефіцієнт перерахунку до базової одиниці"
          />
          <div className="grid grid-cols-3 gap-2">
            <Input
              label="Ширина, м"
              type="number"
              value={form.width}
              onChange={e => setForm(f => ({ ...f, width: e.target.value }))}
              placeholder="0.0"
            />
            <Input
              label="Висота, м"
              type="number"
              value={form.height}
              onChange={e => setForm(f => ({ ...f, height: e.target.value }))}
              placeholder="0.0"
            />
            <Input
              label="Глибина, м"
              type="number"
              value={form.depth}
              onChange={e => setForm(f => ({ ...f, depth: e.target.value }))}
              placeholder="0.0"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Об'єм, м³"
              type="number"
              value={form.volume}
              onChange={e => setForm(f => ({ ...f, volume: e.target.value }))}
              placeholder="0.0"
            />
            <Input
              label="Вага, кг"
              type="number"
              value={form.weight}
              onChange={e => setForm(f => ({ ...f, weight: e.target.value }))}
              placeholder="0.0"
            />
          </div>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
