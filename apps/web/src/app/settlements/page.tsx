'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Counterparty { id: string; firstName?: string; lastName?: string; companyName?: string; }
interface Transaction {
  id: string; type: string; amount: number;
  documentType?: string | null; documentId?: string | null;
  notes?: string | null; createdAt: string;
}
interface RecAct {
  id: string; periodFrom: string; periodTo: string;
  openingBalance: number; closingBalance: number; createdAt: string;
}

const TX_LABELS: Record<string, string> = {
  CHARGE: 'Нарахування', PAYMENT: 'Оплата', PREPAYMENT: 'Передоплата',
  REFUND: 'Повернення', CREDIT_NOTE: 'Кредит-нота',
};
const TX_COLORS: Record<string, string> = {
  CHARGE: 'text-red-600', PAYMENT: 'text-green-600',
  PREPAYMENT: 'text-green-500', REFUND: 'text-amber-600', CREDIT_NOTE: 'text-gray-500',
};

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export default function SettlementsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);

  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [selected, setSelected] = useState<Counterparty | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txPage, setTxPage] = useState(1);
  const [acts, setActs] = useState<RecAct[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [showActModal, setShowActModal] = useState(false);
  const [actForm, setActForm] = useState({ periodFrom: '', periodTo: '' });
  const [actResult, setActResult] = useState<RecAct & { transactions: Transaction[] } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/counterparties?limit=200').then(d => setCounterparties(d.items ?? d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження контрагентів'));
  }, []);

  const loadCounterparty = useCallback(async (cp: Counterparty) => {
    setSelected(cp);
    setBalance(null);
    setTransactions([]);
    setTxPage(1);
    setLoading(true);
    try {
      const [bal, txs, actsData] = await Promise.all([
        apiFetch(`/counterparties/${cp.id}/balance`),
        apiFetch(`/counterparties/${cp.id}/transactions?page=1&limit=50`),
        apiFetch(`/counterparties/${cp.id}/reconciliation-acts`),
      ]);
      setBalance(bal.balance);
      setTransactions(txs.items);
      setTxTotal(txs.total);
      setActs(actsData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження даних');
    } finally { setLoading(false); }
  }, []);

  const handleCreateAct = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await apiFetch(`/counterparties/${selected.id}/reconciliation-acts`, {
        method: 'POST',
        body: JSON.stringify({ periodFrom: actForm.periodFrom, periodTo: actForm.periodTo }),
      });
      setActResult(result);
      setActs(prev => [result, ...prev]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення акту');
    } finally { setSaving(false); }
  };

  const cpName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ');

  const filtered = counterparties.filter(cp =>
    !q || cpName(cp).toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Взаєморозрахунки</h1>

      <div className="grid grid-cols-12 gap-6">
        {/* Left: counterparty list */}
        <div className="col-span-4">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-3 border-b">
              <input value={q} onChange={e => setQ(e.target.value)}
                placeholder="Пошук контрагента..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="overflow-y-auto max-h-[calc(100vh-250px)]">
              {filtered.length === 0 ? (
                <div className="p-4 text-center text-gray-400 text-sm">Не знайдено</div>
              ) : filtered.map(cp => (
                <button key={cp.id}
                  onClick={() => loadCounterparty(cp)}
                  className={`w-full text-left px-4 py-3 text-sm border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    selected?.id === cp.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
                  }`}>
                  <div className="font-medium text-gray-900">{cpName(cp)}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: details */}
        <div className="col-span-8">
          {!selected ? (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
              Оберіть контрагента зі списку
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
          ) : (
            <div className="space-y-5">
              {/* Balance card */}
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-gray-500">Поточний баланс</div>
                    <div className={`text-2xl font-bold mt-1 ${
                      (balance ?? 0) > 0 ? 'text-red-600' : (balance ?? 0) < 0 ? 'text-green-600' : 'text-gray-900'
                    }`}>
                      {balance != null ? fmt(balance) : '—'}
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      {(balance ?? 0) > 0 ? 'Заборгованість клієнта' : (balance ?? 0) < 0 ? 'Переплата клієнта' : 'Немає заборгованостей'}
                    </div>
                  </div>
                  <button onClick={() => { setActForm({ periodFrom: '', periodTo: '' }); setActResult(null); setShowActModal(true); }}
                    className="px-4 py-2 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
                    Акт звірки
                  </button>
                </div>
              </div>

              {/* Transactions */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b bg-gray-50">
                  <h3 className="font-medium text-gray-900 text-sm">Транзакції ({txTotal})</h3>
                </div>
                <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                  {transactions.length === 0 ? (
                    <div className="p-4 text-center text-gray-400 text-sm">Транзакцій немає</div>
                  ) : transactions.map(tx => (
                    <div key={tx.id} className="px-5 py-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{TX_LABELS[tx.type] ?? tx.type}</div>
                        <div className="text-xs text-gray-400">
                          {tx.documentType && <span>{tx.documentType} · </span>}
                          {new Date(tx.createdAt).toLocaleDateString('uk-UA')}
                        </div>
                      </div>
                      <div className={`text-sm font-semibold ${TX_COLORS[tx.type] ?? 'text-gray-700'}`}>
                        {tx.type === 'CHARGE' ? '+' : '−'}{fmt(tx.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Reconciliation acts */}
              {acts.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b bg-gray-50">
                    <h3 className="font-medium text-gray-900 text-sm">Акти звірки</h3>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {acts.map(act => (
                      <div key={act.id} className="px-5 py-3 flex items-center justify-between text-sm">
                        <div>
                          <div className="font-medium text-gray-900">
                            {new Date(act.periodFrom).toLocaleDateString('uk-UA')} –{' '}
                            {new Date(act.periodTo).toLocaleDateString('uk-UA')}
                          </div>
                          <div className="text-xs text-gray-400">{new Date(act.createdAt).toLocaleDateString('uk-UA')}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-gray-400">Відкриття: {fmt(act.openingBalance)}</div>
                          <div className={`font-semibold ${act.closingBalance > 0 ? 'text-red-600' : act.closingBalance < 0 ? 'text-green-600' : 'text-gray-700'}`}>
                            Закриття: {fmt(act.closingBalance)}
                          </div>
                        </div>
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
      {showActModal && (
        <Modal title="Акт звірки" onClose={() => setShowActModal(false)}>
          {actResult ? (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 rounded-lg border border-green-100">
                <div className="text-sm font-medium text-green-800 mb-2">Акт звірки сформовано</div>
                <div className="text-xs text-gray-600 space-y-1">
                  <div>Відкриваючий залишок: {fmt(actResult.openingBalance)}</div>
                  <div>Закриваючий залишок: {fmt(actResult.closingBalance)}</div>
                  <div>Транзакцій: {actResult.transactions.length}</div>
                </div>
              </div>
              <button onClick={() => setShowActModal(false)}
                className="w-full py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors">
                Закрити
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Початок періоду *</label>
                <input type="date" value={actForm.periodFrom}
                  onChange={e => setActForm(f => ({ ...f, periodFrom: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Кінець періоду *</label>
                <input type="date" value={actForm.periodTo}
                  onChange={e => setActForm(f => ({ ...f, periodTo: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <button onClick={handleCreateAct}
                disabled={!actForm.periodFrom || !actForm.periodTo || saving}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {saving ? 'Формування...' : 'Сформувати акт'}
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
