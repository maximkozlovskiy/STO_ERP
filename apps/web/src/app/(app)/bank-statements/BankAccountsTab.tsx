'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2, RefreshCw } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';
import type { BankAccount, BranchInfo, Currency } from '../ndi/types';

export default function BankAccountsTab() {
  const { t } = useTranslation('ndi');
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [error, setError] = useState('');

  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [bankProviders, setBankProviders] = useState<{ code: string; name: string }[]>([]);
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
    provider: '',
    autoPullEnabled: false,
  });
  const [baErrors, setBaErrors] = useState<{ name?: string; ibanUA?: string; currencyId?: string }>(
    {},
  );
  const [savingBa, setSavingBa] = useState(false);
  const [loadingBa, setLoadingBa] = useState(false);

  useEffect(() => {
    setLoadingBa(true);

    const cachedBa = getCached<{ items: BankAccount[] }>('cache:bank-accounts');
    if (cachedBa && Array.isArray(cachedBa.items)) {
      setBankAccounts(cachedBa.items);
    }
    const cachedCurrencies = getCached<{ items: Currency[] }>('cache:currencies');
    if (cachedCurrencies && Array.isArray(cachedCurrencies.items)) {
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
        setError(e instanceof Error ? e.message : t('common.loadError'));
        setLoadingBa(false);
      });

    // Метадані банків-провайдерів для селекта auto-pull (best-effort — не блокує форму).
    // Guard Array.isArray (Bug #592-стиль): битий/несподіваний респонс не має крашити .map.
    apiFetch<{ code: string; name: string }[]>('/bank-statement-providers')
      .then(res => setBankProviders(Array.isArray(res) ? res : []))
      .catch(() => setBankProviders([]));
  }, [t]);

  // Код провайдера → людська назва (privat24→Приват24) з метаданих; fallback — сам код.
  const providerLabel = (code: string): string =>
    bankProviders.find(p => p.code === code)?.name ?? code;

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
        provider: ba.provider ?? '',
        autoPullEnabled: ba.autoPullEnabled ?? false,
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
        provider: '',
        autoPullEnabled: false,
      });
    }
    setBaModal(true);
  };

  const saveBa = async () => {
    const errs: typeof baErrors = {};
    if (!baForm.name.trim()) errs.name = t('bankAccounts.nameRequired');
    if (!baForm.ibanUA.trim()) errs.ibanUA = t('bankAccounts.ibanRequired');
    else if (!/^UA\d{27}$/.test(baForm.ibanUA)) errs.ibanUA = t('bankAccounts.ibanInvalid');
    if (!baForm.currencyId) errs.currencyId = t('bankAccounts.currencyRequired');
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
        provider: baForm.provider || undefined,
        autoPullEnabled: baForm.autoPullEnabled,
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
      if (currentFeatures.toastEnabled) toast.success(t('common.saved'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingBa(false);
    }
  };

  const deleteBa = async (id: string) => {
    if (!(await confirm({ title: t('bankAccounts.deleteConfirmTitle'), variant: 'destructive' })))
      return;
    try {
      await apiFetch(`/bank-accounts/${id}`, { method: 'DELETE' });
      setBankAccounts(prev => {
        const next = prev.filter(b => b.id !== id);
        setCache('cache:bank-accounts', { items: next });
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
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
          {t('bankAccounts.addButton')}
        </Button>
      </div>
      {loadingBa && <p className="text-muted-foreground text-sm">{t('common.loading')}</p>}
      {!loadingBa && bankAccounts.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('bankAccounts.empty')}</p>
      )}
      <div className="space-y-2">
        {bankAccounts.map(b => (
          <div
            key={b.id}
            className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between"
          >
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-foreground">{b.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{b.ibanUA}</span>
                {/* Auto-pull бейдж — оператор бачить, по яких рахунках увімкнено завантаження виписки. */}
                {b.autoPullEnabled && (
                  <Badge variant="info" className="gap-1">
                    <RefreshCw className="w-3 h-3" />
                    {t('bankAccounts.autoPullBadge', {
                      provider: b.provider
                        ? providerLabel(b.provider)
                        : t('bankAccounts.providerAny'),
                    })}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {b.currencyCode}
                {b.bankName ? ` · ${b.bankName}` : ''}
                {b.branchName ? ` · ${b.branchName}` : ''}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                aria-label={t('bankAccounts.editAria')}
                onClick={() => openBaModal(b)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                aria-label={t('bankAccounts.deleteAria')}
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
        title={editingBa ? t('bankAccounts.editTitle') : t('bankAccounts.createTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setBaModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void saveBa()} loading={savingBa}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label={t('bankAccounts.fieldName')}
            required
            value={baForm.name}
            onChange={e => {
              setBaForm({ ...baForm, name: e.target.value });
              if (baErrors.name) setBaErrors(p => ({ ...p, name: undefined }));
            }}
            errorMessage={baErrors.name}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('bankAccounts.fieldIban')}
            required
            value={baForm.ibanUA}
            onChange={e => {
              setBaForm({ ...baForm, ibanUA: e.target.value });
              if (baErrors.ibanUA) setBaErrors(p => ({ ...p, ibanUA: undefined }));
            }}
            placeholder="UA213223130000026007233566001"
            errorMessage={baErrors.ibanUA}
            className="h-8 text-[13px]"
          />
          <Select
            label={t('bankAccounts.fieldCurrency')}
            required
            value={baForm.currencyId}
            onChange={e => {
              setBaForm({ ...baForm, currencyId: e.target.value });
              if (baErrors.currencyId) setBaErrors(p => ({ ...p, currencyId: undefined }));
            }}
            errorMessage={baErrors.currencyId}
            placeholder={t('bankAccounts.currencyPlaceholder')}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {currencies.map(c => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </Select>
          <Select
            label={t('bankAccounts.fieldBranch')}
            value={baForm.branchId}
            onChange={e => setBaForm({ ...baForm, branchId: e.target.value })}
            placeholder={t('bankAccounts.branchPlaceholder')}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            label={t('bankAccounts.fieldBankName')}
            value={baForm.bankName}
            onChange={e => setBaForm({ ...baForm, bankName: e.target.value })}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('bankAccounts.fieldMfo')}
            value={baForm.mfo}
            onChange={e => setBaForm({ ...baForm, mfo: e.target.value })}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('bankAccounts.fieldEdrpou')}
            value={baForm.edrpou}
            onChange={e => setBaForm({ ...baForm, edrpou: e.target.value })}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('bankAccounts.fieldBankAddress')}
            value={baForm.bankAddress}
            onChange={e => setBaForm({ ...baForm, bankAddress: e.target.value })}
            className="h-8 text-[13px]"
          />
          <Select
            label={t('bankAccounts.fieldProvider')}
            value={baForm.provider}
            onChange={e => setBaForm({ ...baForm, provider: e.target.value })}
            placeholder={t('bankAccounts.providerNone')}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {bankProviders.map(p => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={baForm.autoPullEnabled}
              onChange={e => setBaForm({ ...baForm, autoPullEnabled: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            {t('bankAccounts.fieldAutoPull')}
          </label>
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
