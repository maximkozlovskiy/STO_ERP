'use client';

import { useState, useCallback, useMemo } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { useCounterparties } from '@/hooks/api/useCounterparties';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

interface Counterparty {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}
interface Transaction {
  id: string;
  type: string;
  amount: number;
  documentType?: string | null;
  documentId?: string | null;
  notes?: string | null;
  createdAt: string;
}
interface RecAct {
  id: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: number;
  closingBalance: number;
  createdAt: string;
}

const TX_LABELS: Record<string, string> = {
  CHARGE: 'Нарахування',
  PAYMENT: 'Оплата',
  PREPAYMENT: 'Передоплата',
  REFUND: 'Повернення',
  CREDIT_NOTE: 'Кредит-нота',
};
const TX_COLORS: Record<string, string> = {
  CHARGE: 'text-destructive',
  PAYMENT: 'text-success',
  PREPAYMENT: 'text-success',
  REFUND: 'text-warning',
  CREDIT_NOTE: 'text-muted-foreground',
};

// fmt() обгортка над lib/format.ts singletons — locale-data ініціалізується ОДИН раз
// за модуль (Intl.NumberFormat). Inline `n.toLocaleString('uk-UA', {...})` ставив би
// конструкцію форматера на КОЖНУ комірку × ререндер у списках transactions/acts.
function fmt(n: number) {
  return `${fmtMoney(n)} ₴`;
}

export default function SettlementsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);

  const [selected, setSelected] = useState<Counterparty | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [acts, setActs] = useState<RecAct[]>([]);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);

  const { data: cpData, isLoading: cpLoading } = useCounterparties({
    limit: 200,
    q: debouncedQ || undefined,
  });
  const counterparties = useMemo(() => (cpData?.items ?? []) as Counterparty[], [cpData]);
  const [loading, setLoading] = useState(false);
  const [showActModal, setShowActModal] = useState(false);
  const [actForm, setActForm] = useState({ periodFrom: '', periodTo: '' });
  const [actResult, setActResult] = useState<(RecAct & { transactions: Transaction[] }) | null>(
    null,
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloadingActId, setDownloadingActId] = useState<string | null>(null);

  const loadCounterparty = useCallback(async (cp: Counterparty) => {
    setSelected(cp);
    setBalance(null);
    setTransactions([]);
    setTxTotal(0);
    setLoading(true);
    try {
      const [bal, txs, actsData] = await Promise.all([
        apiFetch<{ balance: number }>(`/counterparties/${cp.id}/balance`),
        apiFetch<{ items: Transaction[]; total: number }>(
          `/counterparties/${cp.id}/transactions?page=1&limit=50`,
        ),
        apiFetch<RecAct[]>(`/counterparties/${cp.id}/reconciliation-acts`),
      ]);
      setBalance(bal.balance);
      setTransactions(txs.items);
      setTxTotal(txs.total);
      setActs(actsData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження даних');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCreateAct = async () => {
    if (!selected) return;
    if (actForm.periodTo < actForm.periodFrom) {
      setError('Кінець періоду не може бути раніше початку');
      return;
    }
    setSaving(true);
    try {
      const result = await apiFetch<RecAct & { transactions: Transaction[] }>(
        `/counterparties/${selected.id}/reconciliation-acts`,
        {
          method: 'POST',
          body: JSON.stringify({ periodFrom: actForm.periodFrom, periodTo: actForm.periodTo }),
        },
      );
      setActResult(result);
      setActs(prev => [result, ...prev]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення акту');
    } finally {
      setSaving(false);
    }
  };

  const downloadActPdf = async (actId: string) => {
    if (!selected) return;
    setDownloadingActId(actId);
    setError('');
    try {
      // Bug #77: use apiBlobFetch for silent refresh on 401.
      // Endpoint is nested under counterparties/:cpId/reconciliation-acts/:actId/pdf for tenant isolation.
      const blob = await apiBlobFetch(
        `/counterparties/${selected.id}/reconciliation-acts/${actId}/pdf`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reconciliation-${actId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження PDF акту звірки');
    } finally {
      setDownloadingActId(null);
    }
  };

  const cpName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ');

  const filtered = counterparties.filter(
    cp => !q || cpName(cp).toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="page-fill p-4 md:p-6 gap-4">
      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <h1 className="page-title mb-6">Взаєморозрахунки</h1>

      <div className="grid grid-cols-12 gap-6">
        {/* Left: counterparty list */}
        <div className="col-span-4">
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Пошук контрагента..."
                  className="pl-9"
                />
              </div>
            </div>
            <div className="overflow-y-auto max-h-[calc(100vh-250px)]">
              {cpLoading ? (
                <div className="p-4 flex justify-center">
                  <Spinner className="h-5 w-5" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-[13px]">Не знайдено</div>
              ) : (
                filtered.map(cp => (
                  <button
                    key={cp.id}
                    onClick={() => loadCounterparty(cp)}
                    className={cn(
                      'w-full text-left px-4 py-3 text-sm border-b border-border hover:bg-secondary transition-colors',
                      selected?.id === cp.id && 'bg-primary-subtle border-l-2 border-l-primary',
                    )}
                  >
                    <div className="font-medium text-foreground">{cpName(cp)}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: details */}
        <div className="col-span-8">
          {!selected ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              Оберіть контрагента зі списку
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner size="lg" />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Balance card */}
              <div className="bg-surface rounded-xl border border-border p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13px] text-muted-foreground">Поточний баланс</div>
                    <div
                      className={cn(
                        'text-2xl font-bold mt-1',
                        (balance ?? 0) > 0
                          ? 'text-destructive'
                          : (balance ?? 0) < 0
                            ? 'text-success'
                            : 'text-foreground',
                      )}
                    >
                      {balance != null ? fmt(balance) : '—'}
                    </div>
                    <div className="text-[12px] text-muted-foreground mt-1">
                      {(balance ?? 0) > 0
                        ? 'Заборгованість клієнта'
                        : (balance ?? 0) < 0
                          ? 'Переплата клієнта'
                          : 'Немає заборгованостей'}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setActForm({ periodFrom: '', periodTo: '' });
                      setActResult(null);
                      setShowActModal(true);
                    }}
                  >
                    Акт звірки
                  </Button>
                </div>
              </div>

              {/* Transactions */}
              <div className="bg-surface rounded-xl border border-border overflow-hidden">
                <div className="px-5 py-3 border-b border-border bg-secondary">
                  <h3 className="font-medium text-foreground text-sm">Транзакції ({txTotal})</h3>
                </div>
                <div className="divide-y divide-border max-h-80 overflow-y-auto">
                  {transactions.length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground text-[13px]">
                      Транзакцій немає
                    </div>
                  ) : (
                    transactions.map(tx => (
                      <div key={tx.id} className="px-5 py-3 flex items-center justify-between">
                        <div>
                          <div className="text-[13px] font-medium text-foreground">
                            {TX_LABELS[tx.type] ?? tx.type}
                          </div>
                          <div className="text-[12px] text-muted-foreground">
                            {tx.documentType && <span>{tx.documentType} · </span>}
                            {fmtDate(tx.createdAt)}
                          </div>
                        </div>
                        <div
                          className={cn(
                            'text-sm font-semibold',
                            TX_COLORS[tx.type] ?? 'text-foreground-muted',
                          )}
                        >
                          {tx.type === 'CHARGE' ? '+' : '−'}
                          {fmt(tx.amount)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Reconciliation acts */}
              {acts.length > 0 && (
                <div className="bg-surface rounded-xl border border-border overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-secondary">
                    <h3 className="font-medium text-foreground text-sm">Акти звірки</h3>
                  </div>
                  <div className="divide-y divide-border">
                    {acts.map(act => (
                      <div
                        key={act.id}
                        className="px-5 py-3 flex items-center justify-between text-sm gap-3"
                      >
                        <div className="flex-1">
                          <div className="font-medium text-foreground">
                            {fmtDate(act.periodFrom)} – {fmtDate(act.periodTo)}
                          </div>
                          <div className="text-[12px] text-muted-foreground">
                            {fmtDate(act.createdAt)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[12px] text-muted-foreground">
                            Відкриття: {fmt(act.openingBalance)}
                          </div>
                          <div
                            className={cn(
                              'font-semibold',
                              act.closingBalance > 0
                                ? 'text-destructive'
                                : act.closingBalance < 0
                                  ? 'text-success'
                                  : 'text-foreground-muted',
                            )}
                          >
                            Закриття: {fmt(act.closingBalance)}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          loading={downloadingActId === act.id}
                          onClick={() => downloadActPdf(act.id)}
                        >
                          PDF
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Reconciliation act modal */}
      <Modal open={showActModal} onClose={() => setShowActModal(false)} title="Акт звірки">
        {actResult ? (
          <div className="space-y-4">
            <div className="p-4 bg-success-subtle rounded-lg border border-success/20">
              <div className="text-[13px] font-medium text-success mb-2">Акт звірки сформовано</div>
              <div className="text-[12px] text-foreground-muted space-y-1">
                <div>Відкриваючий залишок: {fmt(actResult.openingBalance)}</div>
                <div>Закриваючий залишок: {fmt(actResult.closingBalance)}</div>
                <div>Транзакцій: {actResult.transactions.length}</div>
              </div>
            </div>
            <Button variant="outline" onClick={() => setShowActModal(false)} className="w-full">
              Закрити
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <DatePickerInput
              label="Початок періоду"
              required
              value={actForm.periodFrom}
              onChange={v => setActForm(f => ({ ...f, periodFrom: v }))}
            />
            <DatePickerInput
              label="Кінець періоду"
              required
              value={actForm.periodTo}
              onChange={v => setActForm(f => ({ ...f, periodTo: v }))}
            />
            <Button
              onClick={handleCreateAct}
              loading={saving}
              disabled={!actForm.periodFrom || !actForm.periodTo}
              className="w-full"
            >
              Сформувати акт
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
