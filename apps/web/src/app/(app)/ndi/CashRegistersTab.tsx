'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';
import type { BranchInfo, CashRegister, Currency } from './types';

export default function CashRegistersTab() {
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [error, setError] = useState('');

  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [crModal, setCrModal] = useState(false);
  const [editingCr, setEditingCr] = useState<CashRegister | null>(null);
  const [crForm, setCrForm] = useState({ name: '', currencyId: '', branchId: '' });
  const [crErrors, setCrErrors] = useState<{
    name?: string;
    currencyId?: string;
    branchId?: string;
  }>({});
  const [savingCr, setSavingCr] = useState(false);
  const [loadingCr, setLoadingCr] = useState(false);

  useEffect(() => {
    setLoadingCr(true);

    const cachedCurrencies = getCached<{ items: Currency[] }>('cache:currencies');
    if (cachedCurrencies && Array.isArray(cachedCurrencies.items)) {
      setCurrencies(cachedCurrencies.items);
    }
    const cachedBranches = getCached<BranchInfo[]>('cache:branches');
    if (cachedBranches && cachedBranches.length > 0) {
      setBranches(cachedBranches);
    }

    Promise.all([
      apiFetch<{ items: CashRegister[] }>('/cash-registers'),
      apiFetch<{ items: Currency[] }>('/currencies'),
      apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches'),
    ])
      .then(([crRes, currRes, branchRes]) => {
        setCashRegisters(crRes.items);
        setCurrencies(currRes.items);
        setCache('cache:currencies', currRes);
        const arr = Array.isArray(branchRes) ? branchRes : branchRes.items;
        setBranches(arr);
        setCache('cache:branches', arr);
        setLoadingCr(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
        setLoadingCr(false);
      });
  }, []);

  const openCrModal = (cr?: CashRegister) => {
    setEditingCr(cr ?? null);
    setCrErrors({});
    if (cr) {
      setCrForm({ name: cr.name, currencyId: cr.currencyId, branchId: cr.branchId });
    } else {
      setCrForm({
        name: '',
        currencyId: currencies.length === 1 ? currencies[0].id : '',
        branchId: branches.length === 1 ? branches[0].id : '',
      });
    }
    setCrModal(true);
  };

  const saveCr = async () => {
    const errs: typeof crErrors = {};
    if (!crForm.name.trim()) errs.name = 'Введіть назву каси';
    if (!crForm.currencyId) errs.currencyId = 'Оберіть валюту';
    if (!crForm.branchId) errs.branchId = 'Оберіть філію';
    if (Object.keys(errs).length > 0) {
      setCrErrors(errs);
      return;
    }
    setCrErrors({});
    setSavingCr(true);
    try {
      const body = { name: crForm.name, currencyId: crForm.currencyId, branchId: crForm.branchId };
      if (editingCr) {
        const updated = await apiFetch<CashRegister>(`/cash-registers/${editingCr.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setCashRegisters(prev => prev.map(c => (c.id === updated.id ? updated : c)));
      } else {
        const created = await apiFetch<CashRegister>('/cash-registers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setCashRegisters(prev => [...prev, created]);
      }
      setCrModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingCr(false);
    }
  };

  const deleteCr = async (id: string) => {
    if (!(await confirm({ title: 'Видалити касу?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/cash-registers/${id}`, { method: 'DELETE' });
      setCashRegisters(prev => prev.filter(c => c.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={() => openCrModal()}>
          <Plus className="w-4 h-4 mr-1" />
          Додати касу
        </Button>
      </div>
      {loadingCr && <p className="text-muted-foreground text-sm">Завантаження...</p>}
      {!loadingCr && cashRegisters.length === 0 && (
        <p className="text-muted-foreground text-sm">Каси не додано</p>
      )}
      <div className="space-y-2">
        {cashRegisters.map(c => (
          <div
            key={c.id}
            className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between"
          >
            <div>
              <span className="font-medium text-foreground">{c.name}</span>
              <span className="ml-2 text-sm text-muted-foreground">
                {c.currencyCode}
                {c.currencySymbol ? ` ${c.currencySymbol}` : ''}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">· {c.branchName}</span>
            </div>
            <div className="flex gap-2">
              <button
                aria-label="Редагувати касу"
                onClick={() => openCrModal(c)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                aria-label="Видалити касу"
                onClick={() => void deleteCr(c.id)}
                className="text-destructive/70 hover:text-destructive transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={crModal}
        onClose={() => setCrModal(false)}
        title={editingCr ? 'Редагувати касу' : 'Нова каса'}
        footer={
          <>
            <Button variant="outline" onClick={() => setCrModal(false)}>
              Скасувати
            </Button>
            <Button onClick={() => void saveCr()} loading={savingCr}>
              Зберегти
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={crForm.name}
            onChange={e => {
              setCrForm({ ...crForm, name: e.target.value });
              if (crErrors.name) setCrErrors(p => ({ ...p, name: undefined }));
            }}
            errorMessage={crErrors.name}
            className="h-8 text-[13px]"
          />
          <Select
            label="Валюта"
            required
            value={crForm.currencyId}
            onChange={e => {
              setCrForm({ ...crForm, currencyId: e.target.value });
              if (crErrors.currencyId) setCrErrors(p => ({ ...p, currencyId: undefined }));
            }}
            errorMessage={crErrors.currencyId}
            placeholder="Оберіть валюту..."
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {currencies.map(c => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Філія"
            required
            value={crForm.branchId}
            onChange={e => {
              setCrForm({ ...crForm, branchId: e.target.value });
              if (crErrors.branchId) setCrErrors(p => ({ ...p, branchId: undefined }));
            }}
            errorMessage={crErrors.branchId}
            placeholder="Оберіть філію..."
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
