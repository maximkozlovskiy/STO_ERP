'use client';

import { Suspense } from 'react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { TemplatePickerModal, type SystemTemplate } from '@/components/ui/template-picker-modal';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';

// Kyiv-local date formatter (YYYY-MM-DD) for exchange rate default date.
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
const kyivToday = () => KYIV_YMD.format(new Date());

interface TaxRateItem {
  id: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isActive: boolean;
}

interface Currency {
  id: string;
  name: string;
  code: string;
  symbol?: string | null;
  fullName?: string | null;
  internationalName?: string | null;
  nbuFetchEnabled: boolean;
  nbuMarkupPercent?: number | null;
}

interface ExchangeRate {
  id: string;
  currencyId: string;
  currencyCode: string;
  currencyName: string;
  date: string;
  rate: number;
  coefficient: number;
}

interface BankAccount {
  id: string;
  name: string;
  ibanUA: string;
  currencyId: string;
  currencyCode: string;
  bankName?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  mfo?: string | null;
  edrpou?: string | null;
  bankAddress?: string | null;
}

interface CashRegister {
  id: string;
  name: string;
  currencyId: string;
  currencyCode: string;
  currencySymbol?: string | null;
  branchId: string;
  branchName: string;
}

interface BranchInfo {
  id: string;
  name: string;
}

interface NbuSettings {
  nbuFetchHour?: number;
}

type Tab = 'taxrates' | 'currencies' | 'exchange-rates' | 'bank-accounts' | 'cash-registers';

const LABELS: Record<Tab, string> = {
  taxrates: 'Ставки ПДВ',
  currencies: 'Валюти',
  'exchange-rates': 'Курси валют',
  'bank-accounts': 'Банк. рахунки',
  'cash-registers': 'Каса',
};

const TABS: Tab[] = ['taxrates', 'currencies', 'exchange-rates', 'bank-accounts', 'cash-registers'];

function VatPageClient() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'taxrates') as Tab;
  const setTab = (t: Tab) => {
    setError('');
    router.replace(`?tab=${t}`, { scroll: false });
  };

  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [error, setError] = useState('');

  // NBU settings (nbuFetchHour only)
  const [nbuFetchHour, setNbuFetchHour] = useState<number>(12);
  const [savingNbu, setSavingNbu] = useState(false);

  // Branches (for BankAccount and CashRegister forms)
  const [branches, setBranches] = useState<BranchInfo[]>([]);

  // Tax rates state
  const [taxRates, setTaxRates] = useState<TaxRateItem[]>([]);
  const [newTaxRate, setNewTaxRate] = useState({ name: '', rate: '' });
  const [editTaxRate, setEditTaxRate] = useState<TaxRateItem | null>(null);
  const [editTaxForm, setEditTaxForm] = useState({ name: '', rate: '' });
  const [savingTax, setSavingTax] = useState(false);

  // Currencies state
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [currencyModal, setCurrencyModal] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<Currency | null>(null);
  const [currencyForm, setCurrencyForm] = useState({
    name: '',
    code: '',
    symbol: '',
    fullName: '',
    internationalName: '',
    nbuFetchEnabled: false,
    nbuMarkupPercent: '',
  });
  const [currencyErrors, setCurrencyErrors] = useState<{ name?: string; code?: string }>({});
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [loadingCurrencies, setLoadingCurrencies] = useState(false);
  const [currencyTemplatePicker, setCurrencyTemplatePicker] = useState(false);

  // Exchange rates state
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [rateModal, setRateModal] = useState(false);
  const [editingRate, setEditingRate] = useState<ExchangeRate | null>(null);
  const [rateForm, setRateForm] = useState({
    currencyId: '',
    currencyDisplay: '',
    date: '',
    rate: '',
    coefficient: '1',
  });
  const [rateErrors, setRateErrors] = useState<{
    currencyId?: string;
    date?: string;
    rate?: string;
    coefficient?: string;
  }>({});
  const [savingRate, setSavingRate] = useState(false);
  const [loadingRates, setLoadingRates] = useState(false);
  const [fetchingNbu, setFetchingNbu] = useState(false);

  // Bank accounts state
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
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

  // Cash registers state
  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([]);
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

  // Load initial data (branches, tax rates, nbu settings)
  useEffect(() => {
    const cachedBranches = getCached<BranchInfo[]>('cache:branches');
    if (cachedBranches && cachedBranches.length > 0) {
      setBranches(cachedBranches);
    }
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
      })
      .catch((e: unknown) =>
        console.warn('[VAT] /branches failed:', e instanceof Error ? e.message : e),
      );
    apiFetch<TaxRateItem[]>('/settings/tax-rates')
      .then(setTaxRates)
      .catch((e: unknown) =>
        console.warn('[VAT] /settings/tax-rates failed:', e instanceof Error ? e.message : e),
      );
    apiFetch<NbuSettings>('/settings/organisation')
      .then(s => setNbuFetchHour(s.nbuFetchHour ?? 12))
      .catch((e: unknown) =>
        console.warn('[VAT] /settings/organisation failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  // Lazy-load financial data when the relevant tab becomes active
  const isFinancialTab = [
    'currencies',
    'exchange-rates',
    'bank-accounts',
    'cash-registers',
  ].includes(tab);
  useEffect(() => {
    if (!isFinancialTab) return;
    let cancelled = false;
    setLoadingCurrencies(true);
    setLoadingRates(true);
    setLoadingBa(true);
    setLoadingCr(true);

    // Seed from cache immediately (avoid empty flash)
    const cachedCurrencies = getCached<{ items: Currency[] }>('cache:currencies');
    if (cachedCurrencies) {
      setCurrencies(cachedCurrencies.items);
      setLoadingCurrencies(false);
    }
    const cachedBa = getCached<{ items: BankAccount[] }>('cache:bank-accounts');
    if (cachedBa) {
      setBankAccounts(cachedBa.items);
      setLoadingBa(false);
    }

    Promise.all([
      apiFetch<{ items: Currency[] }>('/currencies'),
      apiFetch<{ items: ExchangeRate[] }>('/exchange-rates'),
      apiFetch<{ items: BankAccount[] }>('/bank-accounts'),
      apiFetch<{ items: CashRegister[] }>('/cash-registers'),
    ])
      .then(([currenciesRes, ratesRes, bankAccountsRes, cashRegistersRes]) => {
        if (cancelled) return;
        setCurrencies(currenciesRes.items);
        setCache('cache:currencies', currenciesRes);
        setLoadingCurrencies(false);
        setExchangeRates(ratesRes.items);
        setLoadingRates(false);
        setBankAccounts(bankAccountsRes.items);
        setCache('cache:bank-accounts', bankAccountsRes);
        setLoadingBa(false);
        setCashRegisters(cashRegistersRes.items);
        setLoadingCr(false);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Помилка завантаження даних');
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingCurrencies(false);
          setLoadingRates(false);
          setLoadingBa(false);
          setLoadingCr(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isFinancialTab]);

  // ─── Tax rate handlers ─────────────────────────────────────────────────────

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingTax(false);
    }
  };

  // ─── Currencies handlers ───────────────────────────────────────────────────

  const openCurrencyModal = (c?: Currency) => {
    setEditingCurrency(c ?? null);
    setCurrencyErrors({});
    setCurrencyForm(
      c
        ? {
            name: c.name,
            code: c.code,
            symbol: c.symbol ?? '',
            fullName: c.fullName ?? '',
            internationalName: c.internationalName ?? '',
            nbuFetchEnabled: c.nbuFetchEnabled ?? false,
            nbuMarkupPercent: c.nbuMarkupPercent != null ? String(c.nbuMarkupPercent) : '',
          }
        : {
            name: '',
            code: '',
            symbol: '',
            fullName: '',
            internationalName: '',
            nbuFetchEnabled: false,
            nbuMarkupPercent: '',
          },
    );
    setCurrencyModal(true);
  };

  const saveCurrency = async () => {
    const errs: typeof currencyErrors = {};
    if (!currencyForm.name.trim()) errs.name = 'Введіть назву валюти';
    if (!currencyForm.code.trim()) errs.code = 'Введіть код валюти';
    if (Object.keys(errs).length > 0) {
      setCurrencyErrors(errs);
      return;
    }
    setCurrencyErrors({});
    setSavingCurrency(true);
    try {
      const body = {
        name: currencyForm.name.trim(),
        code: currencyForm.code.trim(),
        symbol: currencyForm.symbol.trim() || undefined,
        fullName: currencyForm.fullName.trim() || undefined,
        internationalName: currencyForm.internationalName.trim() || undefined,
        nbuFetchEnabled: currencyForm.nbuFetchEnabled,
        nbuMarkupPercent:
          currencyForm.nbuFetchEnabled && currencyForm.nbuMarkupPercent !== ''
            ? parseFloat(currencyForm.nbuMarkupPercent)
            : null,
      };
      if (editingCurrency) {
        const updated = await apiFetch<Currency>(`/currencies/${editingCurrency.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setCurrencies(prev => {
          const next = prev.map(c => (c.id === updated.id ? updated : c));
          setCache('cache:currencies', { items: next });
          return next;
        });
      } else {
        const created = await apiFetch<Currency>('/currencies', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setCurrencies(prev => {
          const next = [...prev, created];
          setCache('cache:currencies', { items: next });
          return next;
        });
      }
      setCurrencyModal(false);
      if (currentFeatures.toastEnabled)
        toast.success(editingCurrency ? 'Збережено' : 'Валюту додано');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingCurrency(false);
    }
  };

  const deleteCurrency = async (id: string) => {
    if (!(await confirm({ title: 'Видалити валюту?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/currencies/${id}`, { method: 'DELETE' });
      setCurrencies(prev => {
        const next = prev.filter(c => c.id !== id);
        setCache('cache:currencies', { items: next });
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  const importCurrenciesFromTemplates = async (templates: SystemTemplate[]) => {
    for (const t of templates) {
      const created = await apiFetch<Currency>('/currencies', {
        method: 'POST',
        body: JSON.stringify(t.data),
      });
      setCurrencies(prev => {
        const next = [...prev, created];
        setCache('cache:currencies', { items: next });
        return next;
      });
    }
  };

  // ─── Exchange rates handlers ───────────────────────────────────────────────

  const openRateModal = (r?: ExchangeRate) => {
    setEditingRate(r ?? null);
    setRateErrors({});
    setRateForm(
      r
        ? {
            currencyId: r.currencyId,
            currencyDisplay: `${r.currencyCode} — ${r.currencyName}`,
            date: r.date,
            rate: String(r.rate),
            coefficient: String(r.coefficient),
          }
        : {
            currencyId: '',
            currencyDisplay: '',
            date: kyivToday(),
            rate: '',
            coefficient: '1',
          },
    );
    setRateModal(true);
  };

  const saveRate = async () => {
    const errs: typeof rateErrors = {};
    if (!editingRate && !rateForm.currencyId) errs.currencyId = 'Оберіть валюту';
    if (!rateForm.date) errs.date = 'Вкажіть дату';
    const rateNum = Number(rateForm.rate);
    if (!rateForm.rate || !Number.isFinite(rateNum) || rateNum <= 0)
      errs.rate = 'Курс має бути більше 0';
    const coefNum = Number(rateForm.coefficient);
    if (!Number.isFinite(coefNum) || coefNum <= 0)
      errs.coefficient = 'Кількість одиниць має бути більше 0';
    if (Object.keys(errs).length > 0) {
      setRateErrors(errs);
      return;
    }
    setRateErrors({});
    setSavingRate(true);
    try {
      const body = {
        currencyId: rateForm.currencyId,
        date: rateForm.date,
        rate: rateNum,
        coefficient: coefNum,
      };
      if (editingRate) {
        const updated = await apiFetch<ExchangeRate>(`/exchange-rates/${editingRate.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ date: body.date, rate: body.rate, coefficient: body.coefficient }),
        });
        setExchangeRates(prev => prev.map(r => (r.id === updated.id ? updated : r)));
      } else {
        const created = await apiFetch<ExchangeRate>('/exchange-rates', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setExchangeRates(prev => [created, ...prev]);
      }
      setRateModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingRate(false);
    }
  };

  const deleteRate = async (id: string) => {
    if (!(await confirm({ title: 'Видалити курс?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/exchange-rates/${id}`, { method: 'DELETE' });
      setExchangeRates(prev => prev.filter(r => r.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  // ─── NBU fetch handlers ────────────────────────────────────────────────────

  const saveNbuFetchHour = async () => {
    setSavingNbu(true);
    try {
      await apiFetch('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ nbuFetchHour }),
      });
      if (currentFeatures.toastEnabled) toast.success('Час завантаження збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSavingNbu(false);
    }
  };

  const triggerNbuFetch = async () => {
    setFetchingNbu(true);
    setError('');
    try {
      await apiFetch('/exchange-rates/nbu-fetch', { method: 'POST' });
      if (currentFeatures.toastEnabled) toast.success('Завантаження курсів НБУ поставлено в чергу');
      // Reload rates after 3s to show newly fetched data
      setTimeout(() => {
        void apiFetch<{ items: ExchangeRate[] }>('/exchange-rates').then(r =>
          setExchangeRates(r.items),
        );
      }, 3_000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка запуску завантаження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setFetchingNbu(false);
    }
  };

  // ─── Bank accounts handlers ────────────────────────────────────────────────

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

  // ─── Cash registers handlers ───────────────────────────────────────────────

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
    <div className="page-container max-w-3xl">
      <h1 className="page-title mb-6">НДС та Фінансові довідники</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6 flex-wrap">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {/* ─── Tax rates ──────────────────────────────────────────────────────── */}
      {tab === 'taxrates' && (
        <div className="space-y-4">
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
                    <Button size="sm" onClick={saveEditTaxRate} loading={savingTax}>
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
              />
              <Input
                label="Ставка, %"
                type="number"
                min="0"
                max="100"
                value={newTaxRate.rate}
                onChange={e => setNewTaxRate(f => ({ ...f, rate: e.target.value }))}
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
        </div>
      )}

      {/* ─── Currencies ─────────────────────────────────────────────────────── */}
      {tab === 'currencies' && (
        <div className="space-y-4">
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCurrencyTemplatePicker(true)}>
              З шаблону
            </Button>
            <Button onClick={() => openCurrencyModal()}>
              <Plus className="w-4 h-4 mr-1" />
              Валюта
            </Button>
          </div>
          <TemplatePickerModal
            open={currencyTemplatePicker}
            onClose={() => setCurrencyTemplatePicker(false)}
            entityType="currency"
            title="Додати валюти з шаблону"
            existingKeys={currencies.map(c => c.code)}
            onImport={importCurrenciesFromTemplates}
          />
          {loadingCurrencies && <p className="text-muted-foreground text-sm">Завантаження...</p>}
          {!loadingCurrencies && currencies.length === 0 && (
            <p className="text-muted-foreground text-sm">Валюти не додано</p>
          )}
          <div className="space-y-2">
            {currencies.map(c => (
              <div
                key={c.id}
                className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-foreground">{c.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {c.code}
                      {c.symbol ? ` (${c.symbol})` : ''}
                    </span>
                  </div>
                  {c.fullName && (
                    <p className="text-xs text-muted-foreground mt-0.5">{c.fullName}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <input
                    type="checkbox"
                    checked={c.nbuFetchEnabled}
                    readOnly
                    className="h-4 w-4 rounded border-border accent-primary pointer-events-none"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">НБУ</span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 w-14 text-right">
                  {c.nbuMarkupPercent != null ? `+${c.nbuMarkupPercent}%` : '—'}
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    aria-label="Редагувати валюту"
                    onClick={() => openCurrencyModal(c)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    aria-label="Видалити валюту"
                    onClick={() => void deleteCurrency(c.id)}
                    className="text-destructive/70 hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Exchange Rates ──────────────────────────────────────────────────── */}
      {tab === 'exchange-rates' && (
        <div className="space-y-4">
          {/* NBU auto-fetch controls */}
          <div className="bg-surface border border-border rounded-lg px-4 py-3 space-y-3">
            <p className="text-sm font-medium text-foreground">Автозавантаження курсів НБУ</p>
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Година завантаження (0–23)
                </label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  step={1}
                  value={nbuFetchHour}
                  onChange={e =>
                    setNbuFetchHour(Math.max(0, Math.min(23, Math.floor(Number(e.target.value)))))
                  }
                  className="w-20 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Щодня о {nbuFetchHour}:00 (за Києвом)
                </p>
              </div>
              <div className="flex gap-2 pb-6">
                <Button size="sm" onClick={() => void saveNbuFetchHour()} loading={savingNbu}>
                  Зберегти час
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  loading={fetchingNbu}
                  onClick={() => void triggerNbuFetch()}
                >
                  Завантажити зараз
                </Button>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => openRateModal()}>
              <Plus className="w-4 h-4 mr-1" />
              Додати курс
            </Button>
          </div>
          {loadingRates && <p className="text-muted-foreground text-sm">Завантаження...</p>}
          {!loadingRates && exchangeRates.length === 0 && (
            <p className="text-muted-foreground text-sm">Курси не додано</p>
          )}
          <div className="space-y-2">
            {exchangeRates.map(r => (
              <div
                key={r.id}
                className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between"
              >
                <div>
                  <span className="font-medium text-foreground">{r.currencyCode}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{r.date}</span>
                  <span className="ml-2 text-sm text-foreground">
                    {Number(r.coefficient)} = {Number(r.rate)} UAH
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    aria-label="Редагувати курс"
                    onClick={() => openRateModal(r)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    aria-label="Видалити курс"
                    onClick={() => void deleteRate(r.id)}
                    className="text-destructive/70 hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Bank Accounts ───────────────────────────────────────────────────── */}
      {tab === 'bank-accounts' && (
        <div className="space-y-4">
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
        </div>
      )}

      {/* ─── Cash Registers ──────────────────────────────────────────────────── */}
      {tab === 'cash-registers' && (
        <div className="space-y-4">
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
        </div>
      )}

      {/* ─── Currency Modal ──────────────────────────────────────────────────── */}
      <Modal
        open={currencyModal}
        onClose={() => setCurrencyModal(false)}
        title={editingCurrency ? 'Редагувати валюту' : 'Нова валюта'}
        footer={
          <>
            <Button variant="outline" onClick={() => setCurrencyModal(false)}>
              Скасувати
            </Button>
            <Button onClick={() => void saveCurrency()} loading={savingCurrency}>
              Зберегти
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={currencyForm.name}
            errorMessage={currencyErrors.name}
            onChange={e => {
              setCurrencyForm({ ...currencyForm, name: e.target.value });
              if (currencyErrors.name) setCurrencyErrors(p => ({ ...p, name: undefined }));
            }}
          />
          <Input
            label="Код (ISO 4217)"
            required
            value={currencyForm.code}
            errorMessage={currencyErrors.code}
            onChange={e => {
              setCurrencyForm({ ...currencyForm, code: e.target.value.toUpperCase() });
              if (currencyErrors.code) setCurrencyErrors(p => ({ ...p, code: undefined }));
            }}
            placeholder="UAH"
          />
          <Input
            label="Символ"
            value={currencyForm.symbol}
            onChange={e => setCurrencyForm({ ...currencyForm, symbol: e.target.value })}
            placeholder="₴"
          />
          <Input
            label="Повна назва"
            value={currencyForm.fullName}
            onChange={e => setCurrencyForm({ ...currencyForm, fullName: e.target.value })}
          />
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Завантажувати курс з НБУ</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Автоматично підтягувати офіційний курс щодня
              </p>
            </div>
            <input
              type="checkbox"
              checked={currencyForm.nbuFetchEnabled}
              onChange={e =>
                setCurrencyForm({ ...currencyForm, nbuFetchEnabled: e.target.checked })
              }
              className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
            />
          </div>
          <Input
            label="Відсоток нарахування (%)"
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={currencyForm.nbuMarkupPercent}
            onChange={e => setCurrencyForm({ ...currencyForm, nbuMarkupPercent: e.target.value })}
            placeholder="0.00"
            disabled={!currencyForm.nbuFetchEnabled}
          />
        </div>
      </Modal>

      {/* ─── Exchange Rate Modal ─────────────────────────────────────────────── */}
      <Modal
        open={rateModal}
        onClose={() => setRateModal(false)}
        title={editingRate ? 'Редагувати курс' : 'Новий курс'}
        footer={
          <>
            <Button variant="outline" onClick={() => setRateModal(false)}>
              Скасувати
            </Button>
            <Button onClick={() => void saveRate()} loading={savingRate}>
              Зберегти
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {!editingRate && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Валюта *</label>
              <SearchCombobox<Currency>
                value={rateForm.currencyId}
                displayValue={rateForm.currencyDisplay}
                onSelect={item => {
                  setRateForm({
                    ...rateForm,
                    currencyId: item.id,
                    currencyDisplay: `${item.code} — ${item.name}`,
                  });
                  if (rateErrors.currencyId) setRateErrors(p => ({ ...p, currencyId: undefined }));
                }}
                onClear={() => setRateForm({ ...rateForm, currencyId: '', currencyDisplay: '' })}
                fetchItems={async q => {
                  const r = await apiFetch<{ items: Currency[] }>(
                    `/currencies?q=${encodeURIComponent(q)}&limit=10`,
                  );
                  return r.items.map(c => ({
                    ...c,
                    primary: `${c.code} — ${c.name}`,
                    secondary: c.symbol ?? undefined,
                  }));
                }}
                placeholder="Пошук валюти..."
              />
              {rateErrors.currencyId && (
                <p className="text-xs text-destructive-text mt-1">{rateErrors.currencyId}</p>
              )}
            </div>
          )}
          <Input
            label="Дата"
            required
            type="date"
            value={rateForm.date}
            errorMessage={rateErrors.date}
            onChange={e => {
              setRateForm({ ...rateForm, date: e.target.value });
              if (rateErrors.date) setRateErrors(p => ({ ...p, date: undefined }));
            }}
          />
          <Input
            label="Курс (UAH)"
            required
            type="number"
            step="0.000001"
            value={rateForm.rate}
            errorMessage={rateErrors.rate}
            onChange={e => {
              setRateForm({ ...rateForm, rate: e.target.value });
              if (rateErrors.rate) setRateErrors(p => ({ ...p, rate: undefined }));
            }}
          />
          <Input
            label="Кількість одиниць"
            type="number"
            step="1"
            value={rateForm.coefficient}
            errorMessage={rateErrors.coefficient}
            onChange={e => {
              setRateForm({ ...rateForm, coefficient: e.target.value });
              if (rateErrors.coefficient) setRateErrors(p => ({ ...p, coefficient: undefined }));
            }}
            hint="Скільки одиниць валюти відповідають вказаному курсу"
          />
        </div>
      </Modal>

      {/* ─── Bank Account Modal ──────────────────────────────────────────────── */}
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

      {/* ─── Cash Register Modal ─────────────────────────────────────────────── */}
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

export default function VatPage() {
  return (
    <Suspense fallback={null}>
      <VatPageClient />
    </Suspense>
  );
}
