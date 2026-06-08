'use client';

import { useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { TaxRateItem } from './types';

export default function TaxRatesTab() {
  const { confirm, dialogProps } = useConfirm();
  const [error, setError] = useState('');

  const [taxRates, setTaxRates] = useState<TaxRateItem[]>([]);
  const [newTaxRate, setNewTaxRate] = useState({ name: '', rate: '' });
  const [editTaxRate, setEditTaxRate] = useState<TaxRateItem | null>(null);
  const [editTaxForm, setEditTaxForm] = useState({ name: '', rate: '' });
  const [savingTax, setSavingTax] = useState(false);

  useEffect(() => {
    apiFetch<TaxRateItem[]>('/settings/tax-rates')
      .then(setTaxRates)
      .catch((e: unknown) =>
        console.warn(
          '[TaxRatesTab] /settings/tax-rates failed:',
          e instanceof Error ? e.message : e,
        ),
      );
  }, []);

  const addTaxRate = async () => {
    const rate = Number(newTaxRate.rate);
    if (!newTaxRate.name || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      setError('Некоректні дані');
      return;
    }
    setSavingTax(true);
    try {
      const created = await apiFetch<TaxRateItem>('/settings/tax-rates', {
        method: 'POST',
        body: JSON.stringify({ name: newTaxRate.name, rate }),
      });
      setTaxRates(prev => [...prev, created]);
      setNewTaxRate({ name: '', rate: '' });
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingTax(false);
    }
  };

  const toggleTaxRate = async (tr: TaxRateItem) => {
    try {
      const updated = await apiFetch<TaxRateItem>(`/settings/tax-rates/${tr.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !tr.isActive }),
      });
      setTaxRates(prev => prev.map(r => (r.id === updated.id ? updated : r)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  const deleteTaxRate = async (id: string) => {
    if (!(await confirm({ title: 'Видалити ставку ПДВ?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/settings/tax-rates/${id}`, { method: 'DELETE' });
      setTaxRates(prev => prev.filter(r => r.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  const openEditTaxRate = (tr: TaxRateItem) => {
    setEditTaxRate(tr);
    setEditTaxForm({ name: tr.name, rate: String(tr.rate) });
  };

  const saveEditTaxRate = async () => {
    if (!editTaxRate) return;
    const rate = Number(editTaxForm.rate);
    if (!editTaxForm.name || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      setError('Некоректні дані');
      return;
    }
    setSavingTax(true);
    try {
      const updated = await apiFetch<TaxRateItem>(`/settings/tax-rates/${editTaxRate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editTaxForm.name, rate }),
      });
      setTaxRates(prev => prev.map(r => (r.id === updated.id ? updated : r)));
      setEditTaxRate(null);
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingTax(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}
      <div className="bg-surface rounded-xl border border-border divide-y divide-border">
        {taxRates.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">Ставок ПДВ не знайдено</p>
        )}
        {taxRates.map(tr => (
          <div key={tr.id} className="px-4 py-3">
            {editTaxRate?.id === tr.id ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editTaxForm.name}
                  onChange={e => setEditTaxForm(f => ({ ...f, name: e.target.value }))}
                  className="flex-1 px-2 py-1 border border-border rounded-lg text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={editTaxForm.rate}
                  onChange={e => setEditTaxForm(f => ({ ...f, rate: e.target.value }))}
                  className="w-20 px-2 py-1 border border-border rounded-lg text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <span className="text-muted-foreground text-sm">%</span>
                <Button size="sm" onClick={() => void saveEditTaxRate()} loading={savingTax}>
                  Зберегти
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditTaxRate(null)}>
                  Скасувати
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-foreground">{tr.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{tr.rate}%</span>
                  {tr.isDefault && (
                    <span className="ml-2 text-xs text-primary">(за замовчуванням)</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void toggleTaxRate(tr)}
                    className={cn(
                      'relative inline-flex h-5 w-9 rounded-full transition-colors',
                      tr.isActive ? 'bg-primary' : 'bg-border',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
                        tr.isActive ? 'translate-x-4' : 'translate-x-0.5',
                      )}
                    />
                  </button>
                  <button
                    onClick={() => openEditTaxRate(tr)}
                    className="p-1 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => void deleteTaxRate(tr.id)}
                    className="p-1 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="bg-surface rounded-xl border border-border p-4 space-y-3">
        <p className="text-[13px] font-medium text-foreground">Нова ставка</p>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Назва"
            value={newTaxRate.name}
            onChange={e => setNewTaxRate(f => ({ ...f, name: e.target.value }))}
            placeholder="ПДВ 20%"
            className="h-8 text-[13px]"
          />
          <Input
            label="Ставка, %"
            type="number"
            min="0"
            max="100"
            value={newTaxRate.rate}
            onChange={e => setNewTaxRate(f => ({ ...f, rate: e.target.value }))}
            className="h-8 text-[13px]"
          />
        </div>
        <Button
          onClick={() => void addTaxRate()}
          loading={savingTax}
          disabled={!newTaxRate.name || !newTaxRate.rate}
        >
          Додати ставку
        </Button>
      </div>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
