'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BookingRequest {
  id: string;
  status: string;
  clientName: string;
  clientPhone: string;
  requestedDate: string;
  branchId: string;
  notes?: string | null;
  createdAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Очікує',
  CONFIRMED: 'Підтверджено',
  CANCELLED: 'Скасовано',
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-warning-subtle text-warning',
  CONFIRMED: 'bg-success-subtle text-success',
  CANCELLED: 'bg-secondary text-muted-foreground',
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST']);

  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Bug #256: mountedRef для race-protection — без нього unmount під час
  // fetch → setRequests/setLoading на unmounted component (React warning + leak).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: BookingRequest[]; total: number }>('/booking')
      .then(r => {
        if (mountedRef.current) setRequests(r.items ?? []);
      })
      .catch((e: unknown) => {
        if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const confirm = async (id: string) => {
    setConfirmingId(id);
    setError('');
    try {
      await apiFetch(`/booking/${id}/confirm`, { method: 'PATCH' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка підтвердження');
    } finally {
      setConfirmingId(null);
    }
  };

  const cancel = async (id: string) => {
    setError('');
    setCancellingId(id);
    try {
      await apiFetch(`/booking/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка скасування');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="page-container space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Онлайн-запис</h1>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          Оновити
        </Button>
      </div>

      {error && (
        <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-surface rounded-xl border border-border p-12 text-center">
          <p className="text-muted-foreground text-sm">Заявок на запис немає</p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <div className="divide-y divide-border">
            {requests.map(r => (
              <div key={r.id} className="flex items-center justify-between px-5 py-4 gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <p className="font-medium text-foreground text-sm">{r.clientName}</p>
                    <span
                      className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full',
                        STATUS_COLORS[r.status] ?? 'bg-secondary text-muted-foreground',
                      )}
                    >
                      {STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.clientPhone} · {fmtDate(r.requestedDate)}
                  </p>
                  {r.notes && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.notes}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    Заявка від {fmtDateTime(r.createdAt)}
                  </p>
                </div>
                {r.status === 'PENDING' && (
                  <div className="flex gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => confirm(r.id)}
                      loading={confirmingId === r.id}
                      disabled={confirmingId === r.id || cancellingId === r.id}
                    >
                      Підтвердити
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => cancel(r.id)}
                      loading={cancellingId === r.id}
                      disabled={confirmingId === r.id || cancellingId === r.id}
                    >
                      Скасувати
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
