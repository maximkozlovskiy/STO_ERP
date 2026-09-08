'use client';

import { useState, useCallback, useRef } from 'react';
import { Download } from 'lucide-react';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { cn, escapeCsvCell, settlementBalanceTone, settlementBalanceToneClass } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

interface Counterparty {
  id: string;
  type?: string;
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

type CpItem = SearchPickerItem & Counterparty;

const TX_LABELS: Record<string, string> = {
  CHARGE: 'Нарахування',
  PAYMENT: 'Оплата',
  PREPAYMENT: 'Передоплата',
  REFUND: 'Повернення',
  CREDIT_NOTE: 'Кредит-нота',
  SUPPLIER_CHARGE: 'Нарахування (постач.)',
  SUPPLIER_PAYMENT: 'Оплата постачальнику',
  SUPPLIER_REFUND: 'Повернення постачальнику',
};
// Колір дзеркалить бековий BALANCE_SIGN (settlements.service): sign −1 (гасить борг клієнта) =
// success/зелений, +1 (збільшує борг) = destructive. REFUND/CREDIT_NOTE обидва −1 (як PAYMENT) —
// раніше показувались warning/muted → той самий тип фарбувався інакше, ніж на картці контрагента
// (Cycle-2 sync-фікс: cross-page-неузгодженість кольору знаку балансу).
const TX_COLORS: Record<string, string> = {
  CHARGE: 'text-destructive',
  PAYMENT: 'text-success',
  PREPAYMENT: 'text-success',
  REFUND: 'text-success', // −1: повернення клієнту гасить його борг
  CREDIT_NOTE: 'text-success', // −1: кредит-нота гасить борг клієнта
  SUPPLIER_CHARGE: 'text-destructive', // збільшує наш борг постачальнику
  SUPPLIER_PAYMENT: 'text-success', // гасить наш борг
  SUPPLIER_REFUND: 'text-success',
};
// Типи, що ЗБІЛЬШУЮТЬ баланс (BALANCE_SIGN = +1) — для знаку «+»/«−» у рядку транзакції.
// Дзеркалить бековий BALANCE_SIGN (settlements.service): CHARGE + постачальницькі оплата/повернення.
const BALANCE_UP_TYPES = new Set(['CHARGE', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND']);

function fmt(n: number) {
  return `${fmtMoney(n)} ₴`;
}

function cpDisplayName(cp: Counterparty): string {
  const name = cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ');
  return name || '(без імені)';
}

/**
 * Reusable settlements content — used both in /settlements page and as
 * a "Розрахунки" tab inside /reports.
 */
export function SettlementsTabContent() {
  const [selected, setSelected] = useState<Counterparty | null>(null);
  const [selectedDisplay, setSelectedDisplay] = useState('');
  const [cpPickerOpen, setCpPickerOpen] = useState(false);

  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [acts, setActs] = useState<RecAct[]>([]);

  const [loading, setLoading] = useState(false);
  const [showActModal, setShowActModal] = useState(false);
  const [actForm, setActForm] = useState({ periodFrom: '', periodTo: '' });
  const [actResult, setActResult] = useState<(RecAct & { transactions: Transaction[] }) | null>(
    null,
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloadingActId, setDownloadingActId] = useState<string | null>(null);

  // Stable onSearch reference so EntityPickerField doesn't re-attach its
  // outside-click listener on every render of this component.
  const searchCounterparties = useCallback(
    async (q: string): Promise<CpItem[]> =>
      apiFetch<{ items: Counterparty[] }>(
        `/counterparties?q=${encodeURIComponent(q)}&limit=20`,
      ).then(r => r.items.map(c => ({ ...c, primary: cpDisplayName(c) }))),
    [],
  );

  // Race guard: при швидкому перемиканні A→B повільніша відповідь A не має
  // перезаписати стан B. Фіксуємо requestId перед await, застосовуємо setState
  // лише якщо він досі актуальний (reqRef не зрушив).
  const loadCpReqRef = useRef(0);
  const loadCounterparty = useCallback(async (cp: Counterparty) => {
    const reqId = ++loadCpReqRef.current;
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
      if (reqId !== loadCpReqRef.current) return;
      setBalance(bal.balance);
      setTransactions(txs.items);
      setTxTotal(txs.total);
      setActs(actsData);
    } catch (e: unknown) {
      if (reqId !== loadCpReqRef.current) return;
      setError(e instanceof Error ? e.message : 'Помилка завантаження даних');
    } finally {
      if (reqId === loadCpReqRef.current) setLoading(false);
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

  return (
    <>
      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Picker row */}
      <div className="flex items-center gap-3 py-4 shrink-0">
        <div className="w-80">
          <EntityPickerField<CpItem>
            display={selectedDisplay}
            placeholder="Пошук контрагента…"
            ariaLabel="Контрагент"
            onPick={() => setCpPickerOpen(true)}
            onSearch={searchCounterparties}
            onSearchSelect={item => {
              setSelectedDisplay(item.primary);
              loadCounterparty(item);
            }}
            onClear={() => {
              setSelected(null);
              setSelectedDisplay('');
              setBalance(null);
              setTransactions([]);
              setTxTotal(0);
              setActs([]);
            }}
            className="h-8 text-[13px]"
          />
        </div>
        {selected && (
          <span className="text-[13px] text-muted-foreground">
            {selected.companyName
              ? [selected.lastName, selected.firstName].filter(Boolean).join(' ')
              : ''}
          </span>
        )}
      </div>

      {/* Details */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!selected ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
            Оберіть контрагента
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
                      // Bug #606: тип-aware тон — CLIENT/SUPPLIER мають різну шкалу
                      // «проблема vs OK». Було: >0=red|<0=success (client-only героистика,
                      // яка інвертувала колір для SUPPLIER balance<0 = «ми винні» → success).
                      settlementBalanceToneClass(
                        settlementBalanceTone(balance ?? 0, selected?.type),
                      ),
                    )}
                  >
                    {balance != null ? fmt(balance) : '—'}
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1">
                    {(() => {
                      const b = balance ?? 0;
                      if (b === 0) return 'Немає заборгованостей';
                      const isSupplier = selected?.type === 'SUPPLIER' || selected?.type === 'BOTH';
                      // balance>0 = нам винні; balance<0 = ми винні.
                      if (b > 0)
                        return isSupplier ? 'Переплата постачальнику' : 'Заборгованість клієнта';
                      return isSupplier ? 'Ми винні постачальнику' : 'Переплата клієнта';
                    })()}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!selected || transactions.length === 0) return;
                      const name = cpDisplayName(selected);
                      const rows = [
                        ['Дата', 'Тип', 'Сума', 'Документ', 'Нотатки'],
                        ...transactions.map(tx => [
                          fmtDate(tx.createdAt),
                          TX_LABELS[tx.type] ?? tx.type,
                          tx.amount,
                          tx.documentType ?? '',
                          tx.notes ?? '',
                        ]),
                      ];
                      const csv = rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
                      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `transactions-${name}.csv`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(url), 100);
                    }}
                    disabled={transactions.length === 0}
                    aria-label="Експорт CSV"
                    title="Завантажити транзакції у CSV"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
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
                        {BALANCE_UP_TYPES.has(tx.type) ? '+' : '−'}
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

      {/* Counterparty picker modal */}
      <SearchPickerModal<CpItem>
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        title="Оберіть контрагента"
        selectedId={selected?.id}
        searchPlaceholder="Ім'я, телефон, компанія..."
        fetchItems={q =>
          apiFetch<{ items: Counterparty[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&limit=20`,
          ).then(r => r.items.map(c => ({ ...c, primary: cpDisplayName(c) })))
        }
        onSelect={cp => {
          setSelectedDisplay(cp.primary);
          loadCounterparty(cp);
        }}
      />

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
    </>
  );
}
