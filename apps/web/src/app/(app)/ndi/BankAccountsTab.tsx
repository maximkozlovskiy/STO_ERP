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
import type { BankAccount, BranchInfo, Currency } from './types';

export default function BankAccountsTab() {
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [error, setError] = useState('');

  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [baModal, setBaModal] = useState(false);
  const [editingBa, setEditingBa] = useState<BankAccount | null>(null);
  const [baForm, setBaForm] = useState({
    name: '',
    ibanUA: '',
    currencyId: '',
    branchId: '',
    bankName: '',
    mfo: '',
    edrpou: '',
    bankAddress: '',
  });
  const [baErrors, setBaErrors] = useState<{ name?: string; ibanUA?: string; currencyId?: string }>(
    {},
  );
  const [savingBa, setSavingBa] = useState(false);
  const [loadingBa, setLoadingBa] = useState(false);

  useEffect(() => {
    setLoadingBa(true);

    const cachedBa = getCached<{ items: BankAccount[] }>('cache:bank-accounts');
    if (cachedBa) {
      setBankAccounts(cachedBa.items);
    }
    const cachedCurrencies = getCached<{ items: Currency[] }>('cache:currencies');
    if (cachedCurrencies) {
      setCurrencies(cachedCurrencies.items);
    }
    const cachedBranches = getCached<BranchInfo[]>('cache:branches');
    if (cachedBranches && cachedBranches.length > 0) {
      setBranches(cachedBranches);
    }

    Promise.all([
      apiFetch<{ items: BankAccount[] }>('/bank-accounts'),
      apiFetch<{ items: Currency[] }>('/currencies'),
      apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches'),
    ])
      .then(([baRes, currRes, branchRes]) => {
        setBankAccounts(baRes.items);
        setCache('cache:bank-accounts', baRes);
        setCurrencies(currRes.items);
        setCache('cache:currencies', currRes);
        const arr = Array.isArray(branchRes) ? branchRes : branchRes.items;
        setBranches(arr);
        setCache('cache:branches', arr);
        setLoadingBa(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
        setLoadingBa(false);
      });
  }, []);

  const openBaModal = (ba?: BankAccount) => {
    setEditingBa(ba ?? null);
    setBaErrors({});
    if (ba) {
      setBaForm({
        name: ba.name,
        ibanUA: ba.ibanUA,
        currencyId: ba.currencyId,
        branchId: ba.branchId ?? '',
        bankName: ba.bankName ?? '',
        mfo: ba.mfo ?? '',
        edrpou: ba.edrpou ?? '',
        bankAddress: ba.bankAddress ?? '',
      });
    } else {
      setBaForm({
        name: '',
        ibanUA: '',
        currencyId: currencies.length === 1 ? currencies[0].id : '',
        branchId: branches.length === 1 ? branches[0].id : '',
        bankName: '',
        mfo: '',
        edrpou: '',
        bankAddress: '',
      });
    }
    setBaModal(true);
  };

  const saveBa = async () => {
    const errs: typeof baErrors = {};
    if (!baForm.name.trim()) errs.name = 'Введіть назву рахунку';
    if (!baForm.ibanUA.trim()) errs.ibanUA = 'Введіть IBAN';
    else if (!/^UA\d{27}$/.test(baForm.ibanUA))
      errs.ibanUA = 'Невірний формат IBAN. Має починатись з UA та містити 29 символів';
    if (!baForm.currencyId) errs.currencyId = 'Оберіть валюту';
    if (Object.keys(errs).length > 0) {
      setBaErrors(errs);
      return;
    }
    setBaErrors({});
    setSavingBa(true);
    try {
      const body: Record<string, unknown> = {
        name: baForm.name,
        ibanUA: baForm.ibanUA,
        currencyId: baForm.currencyId,
        bankName: baForm.bankName || undefined,
        branchId: baForm.branchId || undefined,
        mfo: baForm.mfo || undefined,
        edrpou: baForm.edrpou || undefined,
        bankAddress: baForm.bankAddress || undefined,
      };
      if (editingBa) {
        const updated = await apiFetch<BankAccount>(`/bank-accounts/${editingBa.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setBankAccounts(prev => {
          const next = prev.map(b => (b.id === updated.id ? updated : b));
          setCache('cache:bank-accounts', { items: next });
          return next;
        });
      } else {
        const created = await apiFetch<BankAccount>('/bank-accounts', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setBankAccounts(prev => {
          const next = [...prev, created];
          setCache('cache:bank-accounts', { items: next });
          return next;
        });
      }
      setBaModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingBa(false);
    }
  };

  const deleteBa = async (id: string) => {
    if (!(await confirm({ title: 'Видалити банківський рахунок?', variant: 'destructive' })))
      return;
    try {
      await apiFetch(`/bank-accounts/${id}`, { method: 'DELETE' });
      setBankAccounts(prev => {
        const next = prev.filter(b => b.id !== id);
        setCache('cache:bank-accounts', { items: next });
        return next;
      });
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
        <Button onClick={() => openBaModal()}>
          <Plus className="w-4 h-4 mr-1" />
          Додати рахунок
        </Button>
      </div>
      {loadingBa && <p className="text-muted-foreground text-sm">Завантаження...</p>}
      {!loadingBa && bankAccounts.length === 0 && (
        <p className="text-muted-foreground text-sm">Рахунки не додано</p>
      )}
      <div className="space-y-2">
        {bankAccounts.map(b => (
          <div
            key={b.id}
            className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between"
          >
            <div>
              <span className="font-medium text-foreground">{b.name}</span>
              <span className="ml-2 text-xs text-muted-foreground font-mono">{b.ibanUA}</span>
              <div className="text-xs text-muted-foreground mt-0.5">
                {b.currencyCode}
                {b.bankName ? ` · ${b.bankName}` : ''}
                {b.branchName ? ` · ${b.branchName}` : ''}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                aria-label="Редагувати рахунок"
                onClick={() => openBaModal(b)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                aria-label="Видалити рахунок"
                onClick={() => void deleteBa(b.id)}
                className="text-destructive/70 hover:text-destructive transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={baModal}
        onClose={() => setBaModal(false)}
        title={editingBa ? 'Редагувати рахунок' : 'Новий банківський рахунок'}
        footer={
          <>
            <Button variant="outline" onClick={() => setBaModal(false)}>
              Скасувати
            </Button>
            <Button onClick={() => void saveBa()} loading={savingBa}>
              Зберегти
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Назва рахунку"
            required
            value={baForm.name}
            onChange={e => {
              setBaForm({ ...baForm, name: e.target.value });
              if (baErrors.name) setBaErrors(p => ({ ...p, name: undefined }));
            }}
            errorMessage={baErrors.name}
          />
          <Input
            label="IBAN"
            required
            value={baForm.ibanUA}
            onChange={e => {
              setBaForm({ ...baForm, ibanUA: e.target.value });
              if (baErrors.ibanUA) setBaErrors(p => ({ ...p, ibanUA: undefined }));
            }}
            placeholder="UA213223130000026007233566001"
            errorMessage={baErrors.ibanUA}
          />
          <Select
            label="Валюта"
            required
            value={baForm.currencyId}
            onChange={e => {
              setBaForm({ ...baForm, currencyId: e.target.value });
              if (baErrors.currencyId) setBaErrors(p => ({ ...p, currencyId: undefined }));
            }}
            errorMessage={baErrors.currencyId}
            placeholder="Оберіть валюту..."
          >
            {currencies.map(c => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Філія"
            value={baForm.branchId}
            onChange={e => setBaForm({ ...baForm, branchId: e.target.value })}
            placeholder="Не прив'язано до філії"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            label="Назва банку"
            value={baForm.bankName}
            onChange={e => setBaForm({ ...baForm, bankName: e.target.value })}
          />
          <Input
            label="МФО"
            value={baForm.mfo}
            onChange={e => setBaForm({ ...baForm, mfo: e.target.value })}
          />
          <Input
            label="ЄДРПОУ банку"
            value={baForm.edrpou}
            onChange={e => setBaForm({ ...baForm, edrpou: e.target.value })}
          />
          <Input
            label="Адреса банку"
            value={baForm.bankAddress}
            onChange={e => setBaForm({ ...baForm, bankAddress: e.target.value })}
          />
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
