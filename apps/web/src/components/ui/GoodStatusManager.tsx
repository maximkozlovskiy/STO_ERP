'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X, Check } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface StatusBadge {
  id: string;
  name: string;
  color: string;
}

interface GoodStatusManagerProps {
  goodId: string;
  /**
   * Призначені статуси. Якщо передано — компонент керований (батько сам їх завантажує/оновлює,
   * `onChange` викликається після мутації). Якщо `undefined` — компонент self-fetch-ить власний
   * список призначень через `GET /goods/:id` (для модалки, яка не тримає statuses).
   */
  assigned?: StatusBadge[];
  /** Чи має користувач право призначати/знімати мітки (OWNER/ADMIN/STOREKEEPER). */
  canManage: boolean;
  /** Викликається після успішного assign/unassign — перезавантажити товар / список. */
  onChange?: () => void;
}

/**
 * Керування статусами-мітками товару: колірні badge-и призначених статусів (× — зняти)
 * + dropdown «+ Статус» для призначення з довідника. Мутації йдуть через
 * POST/DELETE /goods/:id/statuses. Дзеркалить CounterpartyStatusManager.
 *
 * Два режими:
 *  - керований (`assigned` передано): батько володіє списком, після мутації → `onChange()`.
 *  - self-fetch (`assigned` не передано): сам тягне `GET /goods/:id` → statuses[].
 */
export function GoodStatusManager({
  goodId,
  assigned,
  canManage,
  onChange,
}: GoodStatusManagerProps) {
  const controlled = assigned !== undefined;
  const [directory, setDirectory] = useState<StatusBadge[]>([]);
  const [selfAssigned, setSelfAssigned] = useState<StatusBadge[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const effectiveAssigned = controlled ? (assigned ?? []) : selfAssigned;

  // Self-fetch режим: тягнемо власні призначення товару (керований режим це робить батько).
  const reloadSelf = useCallback(() => {
    if (controlled) return;
    apiFetch<{ statuses?: StatusBadge[] }>(`/goods/${goodId}`)
      .then(g => setSelfAssigned(g.statuses ?? []))
      .catch(() => undefined);
  }, [controlled, goodId]);

  useEffect(() => {
    reloadSelf();
  }, [reloadSelf]);

  const afterMutation = () => {
    if (!controlled) reloadSelf();
    // Батько (модалка/список) оновлює свій стан, щоб badge-и з'явились одразу.
    onChange?.();
  };

  // Довідник вантажимо лениво — лише коли користувач відкриває dropdown.
  const loadDirectory = () => {
    apiFetch<{ items: StatusBadge[]; total: number }>('/good-statuses')
      .then(r => setDirectory(r.items))
      .catch(() => undefined);
  };

  // Закриття dropdown по кліку поза межами.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const assignedIds = new Set(effectiveAssigned.map(s => s.id));
  const available = directory.filter(s => !assignedIds.has(s.id));

  const assign = async (statusId: string) => {
    setBusyId(statusId);
    setError('');
    try {
      await apiFetch(`/goods/${goodId}/statuses`, {
        method: 'POST',
        body: JSON.stringify({ statusId }),
      });
      afterMutation();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка призначення');
    } finally {
      setBusyId(null);
    }
  };

  const unassign = async (statusId: string) => {
    setBusyId(statusId);
    setError('');
    try {
      await apiFetch(`/goods/${goodId}/statuses/${statusId}`, { method: 'DELETE' });
      afterMutation();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка зняття');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap" ref={wrapRef}>
      {effectiveAssigned.map(s => (
        <span
          key={s.id}
          className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[12px] font-medium text-white"
          style={{ backgroundColor: s.color }}
        >
          {s.name}
          {canManage && (
            <button
              type="button"
              onClick={() => void unassign(s.id)}
              disabled={busyId === s.id}
              className="text-white/70 hover:text-white transition-colors disabled:opacity-50"
              aria-label={`Зняти статус ${s.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}

      {canManage && (
        <div className="relative inline-block">
          <button
            type="button"
            onClick={() => {
              if (!open) loadDirectory();
              setOpen(o => !o);
            }}
            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[12px] font-medium border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
          >
            <Plus className="h-3 w-3" />
            Статус
          </button>

          {open && (
            <div className="absolute left-0 top-full mt-1 z-20 min-w-[180px] max-h-64 overflow-auto rounded-lg border border-border bg-surface shadow-lg py-1">
              {available.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-muted-foreground">
                  {directory.length === 0
                    ? 'Довідник статусів порожній'
                    : 'Усі статуси вже призначено'}
                </div>
              ) : (
                available.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      void assign(s.id);
                      setOpen(false);
                    }}
                    disabled={busyId === s.id}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-left hover:bg-secondary transition-colors disabled:opacity-50',
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: s.color }}
                    />
                    <span className="flex-1 truncate">{s.name}</span>
                    {busyId === s.id && <Check className="h-3 w-3 text-muted-foreground" />}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {error && <span className="text-[12px] text-destructive-text">{error}</span>}
    </div>
  );
}
