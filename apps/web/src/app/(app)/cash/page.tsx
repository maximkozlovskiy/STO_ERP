'use client';

import { useEffect, useState } from 'react';
import { DoorOpen, DoorClosed, AlertTriangle } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { useCurrentShift, useOpenShift, useCloseShift } from '@/hooks/api/useCashShift';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { fmtDate } from '@/lib/format';
import { type BranchInfo } from '../settings/shared';

export default function CashPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const cached = getCached<BranchInfo[]>('cache:branches');
    if (cached && cached.length > 0) {
      setBranches(cached);
      setSelectedBranch(prev => prev || cached[0].id);
    }
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
        if (arr.length > 0) setSelectedBranch(prev => prev || arr[0].id);
      })
      .catch((e: unknown) =>
        console.warn('[Cash] /branches failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  const { data: shift, isLoading } = useCurrentShift(selectedBranch || null);
  const openShift = useOpenShift();
  const closeShift = useCloseShift();

  const onOpen = async () => {
    setError('');
    try {
      await openShift.mutateAsync(selectedBranch);
      toast.success('Зміну відкрито');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Не вдалося відкрити зміну';
      setError(msg);
      toast.error(msg);
    }
  };

  const onClose = async () => {
    if (!shift) return;
    setError('');
    try {
      await closeShift.mutateAsync(shift.id);
      toast.success('Зміну закрито (Z-звіт)');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Не вдалося закрити зміну';
      setError(msg);
      toast.error(msg);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-xl">
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="page-title">Каса</h1>
        {branches.length > 1 && (
          <Select
            value={selectedBranch}
            onChange={e => setSelectedBranch(e.target.value)}
            className="w-48"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : shift ? (
        <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-success" />
            <span className="text-sm font-medium text-foreground">Зміна відкрита</span>
            <span className="text-sm text-muted-foreground">з {fmtDate(shift.openedAt)}</span>
          </div>
          {shift.cashRegisterName && (
            <div className="text-sm text-muted-foreground">Каса: {shift.cashRegisterName}</div>
          )}
          {!!shift.pendingReceipts && shift.pendingReceipts > 0 && (
            <div className="flex items-center gap-2 text-sm text-warning bg-warning-subtle rounded-lg p-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Чеків очікує пробиття: {shift.pendingReceipts}
            </div>
          )}
          <Button variant="outline" onClick={() => void onClose()} loading={closeShift.isPending}>
            <DoorClosed className="h-4 w-4 mr-1.5" />
            Закрити зміну (Z-звіт)
          </Button>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Зміну закрито</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Відкрийте зміну, щоб пробивати фіскальні чеки. Наприкінці дня закрийте її (Z-звіт).
          </p>
          <Button
            onClick={() => void onOpen()}
            loading={openShift.isPending}
            disabled={!selectedBranch}
          >
            <DoorOpen className="h-4 w-4 mr-1.5" />
            Відкрити зміну
          </Button>
        </div>
      )}
    </div>
  );
}
