'use client';

import { useEffect, useRef, useState } from 'react';
import { Sun, Moon, Monitor, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { THEMES, type ThemeName, applyTheme } from '@/lib/theme';
import { setColorMode, getColorMode, type ColorMode } from '@/lib/color-mode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { PickerModal } from '@/components/ui/picker-modal';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useUiFeatures, invalidateUiFeaturesCache, type UiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';

// Must match Prisma enum BatchCostMethod (FIFO | FEFO | LIFO | AVG_COST).
// String-typed in the API DTO, but kept as a literal union here so an
// unknown value at compile time becomes a TS error rather than a 400
// from class-validator at runtime.
type CostMethod = 'FIFO' | 'FEFO' | 'LIFO' | 'AVG_COST';

const COST_METHOD_OPTIONS: { value: CostMethod; label: string; hint: string }[] = [
  { value: 'FIFO',     label: 'FIFO',     hint: 'Перший прийшов — перший пішов' },
  { value: 'FEFO',     label: 'FEFO',     hint: 'За терміном придатності (раніший пішов першим)' },
  { value: 'LIFO',     label: 'LIFO',     hint: 'Останній прийшов — перший пішов' },
  { value: 'AVG_COST', label: 'Середній', hint: 'За середньозваженою собівартістю' },
];

interface OrgSettings {
  orgId: string;
  currency: string;
  vatMode: string;
  invoiceDueDays: number;
  autoArchiveDays: number;
  defaultWarrantyDays: number;
  requireClientApproval: boolean;
  allowPartialPayment: boolean;
  brandTheme: string;
  costMethod: CostMethod;
  followUpActive?: boolean;
  followUpDays?: number;
  uiFeatures?: UiFeatures;
  updatedAt: string;
}

interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  requiresFiscal: boolean;
}

interface NotificationTemplate {
  id: string; eventType: string; channel: string;
  subject: string | null; body: string; isActive: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  WO_COMPLETED: 'Наряд завершено', WO_ESTIMATE_READY: 'Кошторис готовий',
  WO_APPROVED: 'Наряд підтверджено', WO_IN_PROGRESS: 'Наряд в роботі',
  WO_READY_FOR_PICKUP: 'Авто готове до видачі', PAYMENT_RECEIVED: 'Оплата отримана',
  INVOICE_SENT: 'Рахунок надіслано', LOW_STOCK_ALERT: 'Низький залишок',
  FOLLOWUP_REMINDER: 'Нагадування про планове ТО',
};

interface DocNumberConfig { id: string; documentType: string; prefix: string | null; includeDate: boolean; separator: string; padding: number; currentSeq: number; resetPeriod: string; }
interface TaxRateItem { id: string; name: string; rate: number; isDefault: boolean; isActive: boolean; }
interface BranchInfo { id: string; name: string; }

interface WebhookEndpoint {
  id: string; url: string; events: string[]; isActive: boolean; createdAt: string;
}
interface WebhookDelivery {
  id: string; event: string; status: string; attempts: number; responseCode?: number | null; createdAt: string;
}

interface Currency {
  id: string; name: string; code: string; symbol?: string | null;
  fullName?: string | null; internationalName?: string | null;
}
interface ExchangeRate {
  id: string; currencyId: string; currencyCode: string; currencyName: string;
  date: string; rate: number; coefficient: number;
}
interface BankAccount {
  id: string; name: string; ibanUA: string; currencyId: string; currencyCode: string;
  bankName?: string | null; branchId?: string | null; branchName?: string | null;
  mfo?: string | null; edrpou?: string | null; bankAddress?: string | null;
}
interface CashRegister {
  id: string; name: string; currencyId: string; currencyCode: string;
  currencySymbol?: string | null; branchId: string; branchName: string;
}
interface OrgInfo {
  id: string; name: string; edrpou?: string | null;
  logoUrl?: string | null; legalAddress?: string | null;
  actualAddress?: string | null; bankAccountId?: string | null;
}

const WEBHOOK_EVENT_OPTIONS = [
  { value: 'WO_STATUS_CHANGED', label: 'Зміна статусу наряду' },
  { value: 'PAYMENT_RECEIVED', label: 'Отримання оплати' },
  { value: 'LOW_STOCK_ALERT', label: 'Низький залишок' },
];

type Tab = 'org' | 'org-info' | 'currencies' | 'exchange-rates' | 'bank-accounts' | 'cash-registers' | 'payments' | 'notifications' | 'theme' | 'ui' | 'numbers' | 'taxrates' | 'workdays' | 'followup' | 'integrations';
type NavMode = 'sections' | 'functions';
const NAV_MODE_KEY = 'sto_nav_mode';

const VAT_LABELS: Record<string, string> = {
  NONE: 'Без ПДВ',
  EXCLUSIVE: 'ПДВ зверху',
  INCLUSIVE: 'ПДВ включено',
};

export default function SettingsPage() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const { confirm, dialogProps } = useConfirm();
  const [tab, setTab] = useState<Tab>('org');
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [payments, setPayments] = useState<PaymentMethod[]>([]);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [navMode, setNavModeState] = useState<NavMode>('sections');
  const [colorMode, setColorModeState] = useState<ColorMode>('system');
  const [uiFeatures, setUiFeatures] = useState<UiFeatures | null>(null);
  const currentFeatures = useUiFeatures();
  const [docNumbers, setDocNumbers] = useState<DocNumberConfig[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRateItem[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [branchSettings, setBranchSettings] = useState<{ workStartTime: string; workEndTime: string; workDays: number[]; slotDurationMinutes: number } | null>(null);
  const [newTaxRate, setNewTaxRate] = useState({ name: '', rate: '' });
  const [editTaxRate, setEditTaxRate] = useState<TaxRateItem | null>(null);
  const [editTaxForm, setEditTaxForm] = useState({ name: '', rate: '' });
  const [savingTax, setSavingTax] = useState(false);
  const [savingBranch, setSavingBranch] = useState(false);
  // Payment method editing
  const [editPayment, setEditPayment] = useState<PaymentMethod | null>(null);
  const [editPaymentForm, setEditPaymentForm] = useState({ name: '', requiresFiscal: false });
  const [paymentModal, setPaymentModal] = useState(false);
  const [newPaymentForm, setNewPaymentForm] = useState({ code: '', name: '', requiresFiscal: false });
  const [savingPayment, setSavingPayment] = useState(false);

  // Webhook state
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookForm, setWebhookForm] = useState({ url: '', secret: '', events: [] as string[] });
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [webhookDeliveries, setWebhookDeliveries] = useState<{ [id: string]: WebhookDelivery[] }>({});
  const [loadingDeliveries, setLoadingDeliveries] = useState<string | null>(null);

  // Currencies state
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [currencyModal, setCurrencyModal] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<Currency | null>(null);
  const [currencyForm, setCurrencyForm] = useState({ name: '', code: '', symbol: '', fullName: '', internationalName: '' });
  const [currencyErrors, setCurrencyErrors] = useState<{ name?: string; code?: string }>({});
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [loadingCurrencies, setLoadingCurrencies] = useState(false);

  // Exchange rates state
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [rateModal, setRateModal] = useState(false);
  const [editingRate, setEditingRate] = useState<ExchangeRate | null>(null);
  const [rateForm, setRateForm] = useState({ currencyId: '', currencyDisplay: '', date: '', rate: '', coefficient: '1' });
  const [rateErrors, setRateErrors] = useState<{ currencyId?: string; date?: string; rate?: string; coefficient?: string }>({});
  const [savingRate, setSavingRate] = useState(false);
  const [loadingRates, setLoadingRates] = useState(false);

  // Bank accounts state
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [baPickerModal, setBaPickerModal] = useState(false);
  const [baModal, setBaModal] = useState(false);
  const [editingBa, setEditingBa] = useState<BankAccount | null>(null);
  const [baForm, setBaForm] = useState({ name: '', ibanUA: '', currencyId: '', branchId: '', bankName: '', mfo: '', edrpou: '', bankAddress: '' });
  const [baErrors, setBaErrors] = useState<{ name?: string; ibanUA?: string; currencyId?: string }>({});
  const [savingBa, setSavingBa] = useState(false);
  const [loadingBa, setLoadingBa] = useState(false);

  // Cash registers state
  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([]);
  const [crModal, setCrModal] = useState(false);
  const [editingCr, setEditingCr] = useState<CashRegister | null>(null);
  const [crForm, setCrForm] = useState({ name: '', currencyId: '', branchId: '' });
  const [crErrors, setCrErrors] = useState<{ name?: string; currencyId?: string; branchId?: string }>({});
  const [savingCr, setSavingCr] = useState(false);
  const [loadingCr, setLoadingCr] = useState(false);

  // Org info state
  const [orgInfo, setOrgInfo] = useState<OrgInfo | null>(null);
  const [orgInfoForm, setOrgInfoForm] = useState({ name: '', edrpou: '', legalAddress: '', actualAddress: '', bankAccountId: '', bankAccountDisplay: '' });
  const [savingOrgInfo, setSavingOrgInfo] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [removingLogo, setRemovingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(NAV_MODE_KEY) as NavMode | null;
      if (saved === 'sections' || saved === 'functions') setNavModeState(saved);
    } catch { /* ignore */ }
    setColorModeState(getColorMode());
  }, []);

  const changeNavMode = (mode: NavMode) => {
    setNavModeState(mode);
    try { localStorage.setItem(NAV_MODE_KEY, mode); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent<NavMode>('sto:nav-mode-change', { detail: mode }));
  };

  useEffect(() => {
    if (!uiFeatures) setUiFeatures(currentFeatures);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFeatures]);

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(s => { setOrgSettings(s); applyTheme(s.brandTheme); if (s.uiFeatures) setUiFeatures(s.uiFeatures); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'));
    apiFetch<PaymentMethod[]>('/payment-methods')
      .then(setPayments)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження методів оплати'));
    apiFetch<NotificationTemplate[]>('/notification-templates')
      .then(setTemplates)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження шаблонів'));
    apiFetch<DocNumberConfig[]>('/settings/document-numbers')
      .then(setDocNumbers)
      .catch(() => {});
    apiFetch<TaxRateItem[]>('/settings/tax-rates')
      .then(setTaxRates)
      .catch(() => {});
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => { const arr = Array.isArray(d) ? d : d.items; setBranches(arr); if (arr.length > 0) setSelectedBranch(arr[0].id); })
      .catch(() => {});
  }, []);

  // New financial directories — parallel Promise.all з loading/error станами та cancelled-flag.
  // currencies та bank-accounts кешуються в sessionStorage (Bug #145).
  useEffect(() => {
    let cancelled = false;
    setLoadingCurrencies(true); setLoadingRates(true); setLoadingBa(true); setLoadingCr(true);

    // Seed from sessionStorage immediately (avoid empty flash)
    const cachedCurrencies = getCached<{ items: Currency[] }>('cache:currencies');
    if (cachedCurrencies) { setCurrencies(cachedCurrencies.items); setLoadingCurrencies(false); }
    const cachedBa = getCached<{ items: BankAccount[] }>('cache:bank-accounts');
    if (cachedBa) { setBankAccounts(cachedBa.items); setLoadingBa(false); }

    Promise.all([
      apiFetch<{ items: Currency[] }>('/currencies'),
      apiFetch<{ items: ExchangeRate[] }>('/exchange-rates'),
      apiFetch<{ items: BankAccount[] }>('/bank-accounts'),
      apiFetch<{ items: CashRegister[] }>('/cash-registers'),
      apiFetch<OrgInfo>('/settings/org-info'),
    ]).then(([currencies, rates, bankAccounts, cashRegisters, info]) => {
      if (cancelled) return;
      setCurrencies(currencies.items);
      setCache('cache:currencies', currencies);
      setLoadingCurrencies(false);
      setExchangeRates(rates.items);
      setLoadingRates(false);
      setBankAccounts(bankAccounts.items);
      setCache('cache:bank-accounts', bankAccounts);
      setLoadingBa(false);
      setCashRegisters(cashRegisters.items);
      setLoadingCr(false);
      setOrgInfo(info);
      setOrgInfoForm({ name: info.name, edrpou: info.edrpou ?? '', legalAddress: info.legalAddress ?? '', actualAddress: info.actualAddress ?? '', bankAccountId: info.bankAccountId ?? '', bankAccountDisplay: '' });
    }).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань');
    }).finally(() => {
      if (!cancelled) { setLoadingCurrencies(false); setLoadingRates(false); setLoadingBa(false); setLoadingCr(false); }
    });
    return () => { cancelled = true; };
  }, []);

  const saveTemplate = async () => {
    if (!editingTemplate) return;
    setSaving(true);
    try {
      const updated = await apiFetch<NotificationTemplate>(`/notification-templates/${editingTemplate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: editingTemplate.body, subject: editingTemplate.subject, isActive: editingTemplate.isActive }),
      });
      setTemplates(ts => ts.map(t => t.id === updated.id ? updated : t));
      setEditingTemplate(null);
      setMsg('Шаблон збережено');
      if (currentFeatures.toastEnabled) toast.success('Шаблон збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження шаблону';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally { setSaving(false); }
  };

  const saveOrgSettings = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setMsg('');
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          vatMode: orgSettings.vatMode,
          invoiceDueDays: orgSettings.invoiceDueDays,
          autoArchiveDays: orgSettings.autoArchiveDays,
          defaultWarrantyDays: orgSettings.defaultWarrantyDays,
          requireClientApproval: orgSettings.requireClientApproval,
          allowPartialPayment: orgSettings.allowPartialPayment,
          brandTheme: orgSettings.brandTheme,
          costMethod: orgSettings.costMethod,
        }),
      });
      applyTheme(updated.brandTheme);
      setOrgSettings(updated);
      setMsg('Збережено');
      if (currentFeatures.toastEnabled) toast.success('Налаштування збережено');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(errMsg);
      if (currentFeatures.toastEnabled) toast.error(errMsg);
    } finally {
      setSaving(false);
    }
  };

  const saveUiFeatures = async () => {
    if (!uiFeatures) return;
    setSaving(true);
    setMsg(''); setError('');
    try {
      await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ uiFeatures }),
      });
      invalidateUiFeaturesCache();
      window.dispatchEvent(new CustomEvent('sto:ui-features-change'));
      setMsg('Збережено');
      toast.success('Налаштування інтерфейсу збережено');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(errMsg);
      toast.error(errMsg);
    } finally { setSaving(false); }
  };

  useEffect(() => {
    if (!selectedBranch) return;
    let cancelled = false;
    apiFetch<{ workStartTime: string; workEndTime: string; workDays: number[]; slotDurationMinutes: number }>(`/settings/branch/${selectedBranch}`)
      .then(s => { if (!cancelled) setBranchSettings({ workStartTime: s.workStartTime, workEndTime: s.workEndTime, workDays: s.workDays, slotDurationMinutes: s.slotDurationMinutes }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedBranch]);

  useEffect(() => {
    if (tab !== 'integrations') return;
    apiFetch<{ items: WebhookEndpoint[] }>('/webhooks')
      .then(d => setWebhooks(d.items))
      .catch(() => {});
  }, [tab]);

  const saveBranchSettings = async () => {
    if (!branchSettings || !selectedBranch) return;
    setSavingBranch(true);
    try {
      await apiFetch(`/settings/branch/${selectedBranch}`, { method: 'PATCH', body: JSON.stringify(branchSettings) });
      setMsg('Налаштування філії збережено');
      if (currentFeatures.toastEnabled) toast.success('Налаштування філії збережено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingBranch(false); }
  };

  const addTaxRate = async () => {
    const rate = Number(newTaxRate.rate);
    if (!newTaxRate.name || !Number.isFinite(rate) || rate < 0 || rate > 100) { setError('Некоректні дані'); return; }
    setSavingTax(true);
    try {
      const created = await apiFetch<TaxRateItem>('/settings/tax-rates', { method: 'POST', body: JSON.stringify({ name: newTaxRate.name, rate }) });
      setTaxRates(prev => [...prev, created]);
      setNewTaxRate({ name: '', rate: '' });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingTax(false); }
  };

  const toggleTaxRate = async (tr: TaxRateItem) => {
    try {
      const updated = await apiFetch<TaxRateItem>(`/settings/tax-rates/${tr.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !tr.isActive }) });
      setTaxRates(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  const deleteTaxRate = async (id: string) => {
    if (!(await confirm({ title: 'Видалити ставку ПДВ?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/settings/tax-rates/${id}`, { method: 'DELETE' });
      setTaxRates(prev => prev.filter(r => r.id !== id));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  const openEditTaxRate = (tr: TaxRateItem) => {
    setEditTaxRate(tr);
    setEditTaxForm({ name: tr.name, rate: String(tr.rate) });
  };

  const saveEditTaxRate = async () => {
    if (!editTaxRate) return;
    const rate = Number(editTaxForm.rate);
    if (!editTaxForm.name || !Number.isFinite(rate) || rate < 0 || rate > 100) { setError('Некоректні дані'); return; }
    setSavingTax(true);
    try {
      const updated = await apiFetch<TaxRateItem>(`/settings/tax-rates/${editTaxRate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editTaxForm.name, rate }),
      });
      setTaxRates(prev => prev.map(r => r.id === updated.id ? updated : r));
      setEditTaxRate(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingTax(false); }
  };

  const openEditPayment = (pm: PaymentMethod) => {
    setEditPayment(pm);
    setEditPaymentForm({ name: pm.name, requiresFiscal: pm.requiresFiscal });
  };

  const saveEditPayment = async () => {
    if (!editPayment) return;
    setSavingPayment(true);
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${editPayment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editPaymentForm.name, requiresFiscal: editPaymentForm.requiresFiscal }),
      });
      setPayments(prev => prev.map(p => p.id === updated.id ? updated : p));
      setEditPayment(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingPayment(false); }
  };

  const createPaymentMethod = async () => {
    if (!newPaymentForm.code.trim() || !newPaymentForm.name.trim()) { setError('Код і назва є обов\'язковими'); return; }
    setSavingPayment(true);
    try {
      const created = await apiFetch<PaymentMethod>('/payment-methods', {
        method: 'POST',
        body: JSON.stringify({ code: newPaymentForm.code.trim().toUpperCase(), name: newPaymentForm.name.trim(), requiresFiscal: newPaymentForm.requiresFiscal }),
      });
      setPayments(prev => [...prev, created]);
      setPaymentModal(false);
      setNewPaymentForm({ code: '', name: '', requiresFiscal: false });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingPayment(false); }
  };

  const deletePaymentMethod = async (id: string) => {
    if (!(await confirm({ title: 'Видалити метод оплати?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/payment-methods/${id}`, { method: 'DELETE' });
      setPayments(prev => prev.filter(p => p.id !== id));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  const resetDocNumber = async (documentType: string) => {
    if (!(await confirm({ title: `Скинути лічильник для ${documentType}?` }))) return;
    try {
      await apiFetch(`/settings/document-numbers/${documentType}/reset`, { method: 'POST' });
      setDocNumbers(prev => prev.map(c => c.documentType === documentType ? { ...c, currentSeq: 0 } : c));
      setMsg('Лічильник скинуто');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  const WORK_DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

  const toggleWorkDay = (day: number) => {
    if (!branchSettings) return;
    const days = branchSettings.workDays.includes(day)
      ? branchSettings.workDays.filter(d => d !== day)
      : [...branchSettings.workDays, day].sort();
    setBranchSettings({ ...branchSettings, workDays: days });
  };

  const togglePayment = async (pm: PaymentMethod) => {
    setSaving(true);
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${pm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !pm.isActive }),
      });
      setPayments((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const addWebhook = async () => {
    if (!webhookForm.url || webhookForm.events.length === 0) { setError('Вкажіть URL та хоча б одну подію'); return; }
    setSavingWebhook(true);
    try {
      const created = await apiFetch<WebhookEndpoint>('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: webhookForm.url, secret: webhookForm.secret || undefined, events: webhookForm.events }),
      });
      setWebhooks(prev => [created, ...prev]);
      setWebhookForm({ url: '', secret: '', events: [] });
      setMsg('Вебхук додано');
      if (currentFeatures.toastEnabled) toast.success('Вебхук додано');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingWebhook(false); }
  };

  const toggleWebhook = async (wh: WebhookEndpoint) => {
    try {
      const updated = await apiFetch<WebhookEndpoint>(`/webhooks/${wh.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !wh.isActive }),
      });
      setWebhooks(prev => prev.map(w => w.id === updated.id ? updated : w));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  const deleteWebhook = async (id: string) => {
    if (!(await confirm({ title: 'Видалити вебхук?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/webhooks/${id}`, { method: 'DELETE' });
      setWebhooks(prev => prev.filter(w => w.id !== id));
      if (currentFeatures.toastEnabled) toast.success('Вебхук видалено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  const loadDeliveries = async (endpointId: string) => {
    if (webhookDeliveries[endpointId]) {
      // toggle off if already loaded
      setWebhookDeliveries(prev => { const next = { ...prev }; delete next[endpointId]; return next; });
      return;
    }
    setLoadingDeliveries(endpointId);
    try {
      const d = await apiFetch<{ items: WebhookDelivery[] }>(`/webhooks/${endpointId}/deliveries`);
      setWebhookDeliveries(prev => ({ ...prev, [endpointId]: d.items }));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setLoadingDeliveries(null); }
  };

  // ─── Currencies handlers ───────────────────────────────────────────────────

  const openCurrencyModal = (c?: Currency) => {
    setEditingCurrency(c ?? null);
    setCurrencyErrors({});
    setCurrencyForm(c ? { name: c.name, code: c.code, symbol: c.symbol ?? '', fullName: c.fullName ?? '', internationalName: c.internationalName ?? '' } : { name: '', code: '', symbol: '', fullName: '', internationalName: '' });
    setCurrencyModal(true);
  };

  const saveCurrency = async () => {
    const errs: typeof currencyErrors = {};
    if (!currencyForm.name.trim()) errs.name = 'Введіть назву валюти';
    if (!currencyForm.code.trim()) errs.code = 'Введіть код валюти';
    if (Object.keys(errs).length > 0) { setCurrencyErrors(errs); return; }
    setCurrencyErrors({});
    setSavingCurrency(true);
    try {
      // Незаповнені optional поля → undefined (omit), щоб у БД зберігся null, а не ''.
      const body = {
        name: currencyForm.name.trim(),
        code: currencyForm.code.trim(),
        symbol: currencyForm.symbol.trim() || undefined,
        fullName: currencyForm.fullName.trim() || undefined,
        internationalName: currencyForm.internationalName.trim() || undefined,
      };
      if (editingCurrency) {
        const updated = await apiFetch<Currency>(`/currencies/${editingCurrency.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setCurrencies(prev => { const next = prev.map(c => c.id === updated.id ? updated : c); setCache('cache:currencies', { items: next }); return next; });
      } else {
        const created = await apiFetch<Currency>('/currencies', { method: 'POST', body: JSON.stringify(body) });
        setCurrencies(prev => { const next = [...prev, created]; setCache('cache:currencies', { items: next }); return next; });
      }
      setCurrencyModal(false);
      if (currentFeatures.toastEnabled) toast.success(editingCurrency ? 'Збережено' : 'Валюту додано');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingCurrency(false); }
  };

  const deleteCurrency = async (id: string) => {
    if (!(await confirm({ title: 'Видалити валюту?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/currencies/${id}`, { method: 'DELETE' });
      setCurrencies(prev => { const next = prev.filter(c => c.id !== id); setCache('cache:currencies', { items: next }); return next; });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  // ─── Exchange rates handlers ───────────────────────────────────────────────

  const openRateModal = (r?: ExchangeRate) => {
    setEditingRate(r ?? null);
    setRateErrors({});
    setRateForm(r ? { currencyId: r.currencyId, currencyDisplay: `${r.currencyCode} — ${r.currencyName}`, date: r.date, rate: String(r.rate), coefficient: String(r.coefficient) } : { currencyId: '', currencyDisplay: '', date: new Date().toISOString().split('T')[0], rate: '', coefficient: '1' });
    setRateModal(true);
  };

  const saveRate = async () => {
    const errs: typeof rateErrors = {};
    if (!editingRate && !rateForm.currencyId) errs.currencyId = 'Оберіть валюту';
    if (!rateForm.date) errs.date = 'Вкажіть дату';
    const rateNum = Number(rateForm.rate);
    if (!rateForm.rate || !Number.isFinite(rateNum) || rateNum <= 0) errs.rate = 'Курс має бути більше 0';
    const coefNum = Number(rateForm.coefficient);
    if (!Number.isFinite(coefNum) || coefNum <= 0) errs.coefficient = 'Кількість одиниць має бути більше 0';
    if (Object.keys(errs).length > 0) { setRateErrors(errs); return; }
    setRateErrors({});
    setSavingRate(true);
    try {
      const body = { currencyId: rateForm.currencyId, date: rateForm.date, rate: rateNum, coefficient: coefNum };
      if (editingRate) {
        const updated = await apiFetch<ExchangeRate>(`/exchange-rates/${editingRate.id}`, { method: 'PATCH', body: JSON.stringify({ date: body.date, rate: body.rate, coefficient: body.coefficient }) });
        setExchangeRates(prev => prev.map(r => r.id === updated.id ? updated : r));
      } else {
        const created = await apiFetch<ExchangeRate>('/exchange-rates', { method: 'POST', body: JSON.stringify(body) });
        setExchangeRates(prev => [created, ...prev]);
      }
      setRateModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingRate(false); }
  };

  const deleteRate = async (id: string) => {
    if (!(await confirm({ title: 'Видалити курс?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/exchange-rates/${id}`, { method: 'DELETE' });
      setExchangeRates(prev => prev.filter(r => r.id !== id));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  // ─── Bank accounts handlers ────────────────────────────────────────────────

  const openBaModal = (ba?: BankAccount) => {
    setEditingBa(ba ?? null);
    setBaErrors({});
    if (ba) {
      setBaForm({ name: ba.name, ibanUA: ba.ibanUA, currencyId: ba.currencyId, branchId: ba.branchId ?? '', bankName: ba.bankName ?? '', mfo: ba.mfo ?? '', edrpou: ba.edrpou ?? '', bankAddress: ba.bankAddress ?? '' });
    } else {
      setBaForm({
        name: '',
        ibanUA: '',
        currencyId: currencies.length === 1 ? currencies[0].id : '',
        branchId: branches.length === 1 ? branches[0].id : '',
        bankName: '', mfo: '', edrpou: '', bankAddress: '',
      });
    }
    setBaModal(true);
  };

  const saveBa = async () => {
    const errs: typeof baErrors = {};
    if (!baForm.name.trim()) errs.name = "Введіть назву рахунку";
    if (!baForm.ibanUA.trim()) errs.ibanUA = "Введіть IBAN";
    else if (!/^UA\d{27}$/.test(baForm.ibanUA)) errs.ibanUA = "Невірний формат IBAN. Має починатись з UA та містити 29 символів";
    if (!baForm.currencyId) errs.currencyId = "Оберіть валюту";
    if (Object.keys(errs).length > 0) { setBaErrors(errs); return; }
    setBaErrors({});
    setSavingBa(true);
    try {
      const body: Record<string, unknown> = { name: baForm.name, ibanUA: baForm.ibanUA, currencyId: baForm.currencyId, bankName: baForm.bankName || undefined, branchId: baForm.branchId || undefined, mfo: baForm.mfo || undefined, edrpou: baForm.edrpou || undefined, bankAddress: baForm.bankAddress || undefined };
      if (editingBa) {
        const updated = await apiFetch<BankAccount>(`/bank-accounts/${editingBa.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setBankAccounts(prev => { const next = prev.map(b => b.id === updated.id ? updated : b); setCache('cache:bank-accounts', { items: next }); return next; });
      } else {
        const created = await apiFetch<BankAccount>('/bank-accounts', { method: 'POST', body: JSON.stringify(body) });
        setBankAccounts(prev => { const next = [...prev, created]; setCache('cache:bank-accounts', { items: next }); return next; });
      }
      setBaModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingBa(false); }
  };

  const deleteBa = async (id: string) => {
    if (!(await confirm({ title: 'Видалити банківський рахунок?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/bank-accounts/${id}`, { method: 'DELETE' });
      setBankAccounts(prev => { const next = prev.filter(b => b.id !== id); setCache('cache:bank-accounts', { items: next }); return next; });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
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
    if (!crForm.name.trim()) errs.name = "Введіть назву каси";
    if (!crForm.currencyId) errs.currencyId = "Оберіть валюту";
    if (!crForm.branchId) errs.branchId = "Оберіть філію";
    if (Object.keys(errs).length > 0) { setCrErrors(errs); return; }
    setCrErrors({});
    setSavingCr(true);
    try {
      const body = { name: crForm.name, currencyId: crForm.currencyId, branchId: crForm.branchId };
      if (editingCr) {
        const updated = await apiFetch<CashRegister>(`/cash-registers/${editingCr.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setCashRegisters(prev => prev.map(c => c.id === updated.id ? updated : c));
      } else {
        const created = await apiFetch<CashRegister>('/cash-registers', { method: 'POST', body: JSON.stringify(body) });
        setCashRegisters(prev => [...prev, created]);
      }
      setCrModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingCr(false); }
  };

  const deleteCr = async (id: string) => {
    if (!(await confirm({ title: 'Видалити касу?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/cash-registers/${id}`, { method: 'DELETE' });
      setCashRegisters(prev => prev.filter(c => c.id !== id));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
  };

  // ─── Org info handlers ─────────────────────────────────────────────────────

  const saveOrgInfo = async () => {
    setSavingOrgInfo(true);
    try {
      const updated = await apiFetch<OrgInfo>('/settings/org-info', {
        method: 'PATCH',
        body: JSON.stringify({
          name: orgInfoForm.name || undefined,
          edrpou: orgInfoForm.edrpou || undefined,
          legalAddress: orgInfoForm.legalAddress || null,
          actualAddress: orgInfoForm.actualAddress || null,
          bankAccountId: orgInfoForm.bankAccountId || null,
        }),
      });
      setOrgInfo(updated);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingOrgInfo(false); }
  };

  const uploadLogo = async (file: File) => {
    // Show local preview immediately so user sees the image regardless of MinIO URL accessibility
    const objectUrl = URL.createObjectURL(file);
    setLogoPreview(objectUrl);
    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await apiMultipartFetch<{ url: string }>('/files/upload', formData);
      await apiFetch('/settings/org-info', { method: 'PATCH', body: JSON.stringify({ logoUrl: result.url }) });
      setOrgInfo(prev => prev ? { ...prev, logoUrl: result.url } : prev);
      // Clear blob preview so src falls through to the persisted server URL
      setLogoPreview(null);
      if (currentFeatures.toastEnabled) toast.success('Логотип завантажено');
    } catch (e: unknown) {
      setLogoPreview(null);
      setError(e instanceof Error ? e.message : 'Помилка завантаження логотипу');
    } finally {
      setUploadingLogo(false);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    }
  };

  const removeLogo = async () => {
    setRemovingLogo(true);
    try {
      await apiFetch('/settings/org-info', { method: 'PATCH', body: JSON.stringify({ logoUrl: null }) });
      setOrgInfo(prev => prev ? { ...prev, logoUrl: null } : prev);
      setLogoPreview(null);
      if (logoInputRef.current) logoInputRef.current.value = '';
      if (currentFeatures.toastEnabled) toast.success('Логотип видалено');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення логотипу'); }
    finally { setRemovingLogo(false); }
  };

  const selectedBankAccount = bankAccounts.find(b => b.id === orgInfoForm.bankAccountId);

  return (
    <div className="page-container max-w-3xl">
      <h1 className="page-title mb-6">Налаштування</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6 flex-wrap">
        {(['org', 'org-info', 'currencies', 'exchange-rates', 'bank-accounts', 'cash-registers', 'payments', 'numbers', 'taxrates', 'workdays', 'notifications', 'theme', 'ui', 'followup', 'integrations'] as Tab[]).map((t) => (
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
            {{ org: 'Організація', 'org-info': 'Реквізити', currencies: 'Валюти', 'exchange-rates': 'Курси валют', 'bank-accounts': 'Банк. рахунки', 'cash-registers': 'Каса', payments: 'Оплата', numbers: 'Нумерація', taxrates: 'Ставки ПДВ', workdays: 'Робочі дні', notifications: 'Сповіщення', theme: 'Оформлення', ui: 'Інтерфейс', followup: 'Нагадування', integrations: 'Інтеграції' }[t]}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mb-4 text-sm text-success bg-success-subtle border border-success/20 rounded-lg p-3">
          {msg}
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Org settings */}
      {tab === 'org' && orgSettings && (
        <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Режим ПДВ</label>
            <Select
              value={orgSettings.vatMode}
              onChange={(e) => setOrgSettings({ ...orgSettings, vatMode: e.target.value })}
              className="w-auto"
            >
              {Object.entries(VAT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>

          <NumberField
            label="Термін оплати рахунку (днів)"
            value={orgSettings.invoiceDueDays}
            onChange={(v) => setOrgSettings({ ...orgSettings, invoiceDueDays: v })}
            min={1}
            max={365}
          />
          <NumberField
            label="Авто-архівування (днів після закриття)"
            value={orgSettings.autoArchiveDays}
            onChange={(v) => setOrgSettings({ ...orgSettings, autoArchiveDays: v })}
            min={1}
            max={365}
          />
          <NumberField
            label="Гарантійний термін за замовчуванням (днів)"
            value={orgSettings.defaultWarrantyDays}
            onChange={(v) => setOrgSettings({ ...orgSettings, defaultWarrantyDays: v })}
            min={0}
            max={3650}
          />

          <div className="space-y-3">
            <Toggle
              label="Вимагати підтвердження клієнта"
              checked={orgSettings.requireClientApproval}
              onChange={(v) => setOrgSettings({ ...orgSettings, requireClientApproval: v })}
            />
            <Toggle
              label="Дозволити часткову оплату"
              checked={orgSettings.allowPartialPayment}
              onChange={(v) => setOrgSettings({ ...orgSettings, allowPartialPayment: v })}
            />
          </div>

          <div role="radiogroup" aria-label="Метод списання партій">
            <label className="block text-sm font-medium text-foreground mb-1">Метод списання партій</label>
            <p className="text-xs text-muted-foreground mb-2">Визначає порядок списання запчастин з партійного обліку при виконанні нарядів</p>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {COST_METHOD_OPTIONS.map(({ value, label, hint }) => {
                const selected = orgSettings.costMethod === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setOrgSettings({ ...orgSettings, costMethod: value })}
                    className={cn(
                      'flex-1 min-w-40 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors text-left',
                      selected
                        ? 'border-primary bg-primary-subtle text-primary'
                        : 'border-border bg-surface text-muted-foreground hover:border-primary/40 hover:text-foreground',
                    )}
                  >
                    <div className="font-semibold">{label}</div>
                    <div className="text-xs mt-0.5 opacity-70">{hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <Button onClick={saveOrgSettings} loading={saving} className="w-full">
            Зберегти
          </Button>
        </div>
      )}

      {/* ─── Org Info (Реквізити) ──────────────────────────────────────────────── */}
      {tab === 'org-info' && (
        <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
          {/* Logo */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Логотип</label>
            {(logoPreview || orgInfo?.logoUrl) && (
              <div className="mb-3 inline-flex items-start gap-2">
                <img
                  src={logoPreview ?? orgInfo!.logoUrl!}
                  alt="Логотип"
                  className="h-16 rounded object-contain border border-border bg-white p-1"
                  loading="lazy"
                  decoding="async"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
                <button
                  aria-label="Видалити логотип"
                  onClick={removeLogo}
                  disabled={removingLogo || uploadingLogo}
                  className="mt-1 text-muted-foreground hover:text-destructive-text transition-colors disabled:opacity-40"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
            <div>
              <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); }} />
              <Button variant="outline" onClick={() => logoInputRef.current?.click()} loading={uploadingLogo}>
                <Upload className="w-4 h-4 mr-2" />
                {orgInfo?.logoUrl || logoPreview ? 'Замінити логотип' : 'Завантажити логотип'}
              </Button>
            </div>
          </div>

          <Input label="Назва організації" value={orgInfoForm.name} onChange={(e) => setOrgInfoForm({ ...orgInfoForm, name: e.target.value })} />
          <Input label="ЄДРПОУ" value={orgInfoForm.edrpou} onChange={(e) => setOrgInfoForm({ ...orgInfoForm, edrpou: e.target.value })} />
          <Input label="Юридична адреса" value={orgInfoForm.legalAddress} onChange={(e) => setOrgInfoForm({ ...orgInfoForm, legalAddress: e.target.value })} />
          <Input label="Фактична адреса" value={orgInfoForm.actualAddress} onChange={(e) => setOrgInfoForm({ ...orgInfoForm, actualAddress: e.target.value })} />

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Основний банківський рахунок</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBaPickerModal(true)}
                className="flex-1 text-left px-3 py-2 rounded-lg border border-border bg-surface hover:border-primary transition-colors text-sm"
              >
                {selectedBankAccount ? (
                  <span className="text-foreground">{selectedBankAccount.name} <span className="text-muted-foreground font-mono">{selectedBankAccount.ibanUA}</span></span>
                ) : (
                  <span className="text-muted-foreground">Оберіть рахунок...</span>
                )}
              </button>
              {orgInfoForm.bankAccountId && (
                <button
                  aria-label="Очистити рахунок"
                  type="button"
                  onClick={() => setOrgInfoForm({ ...orgInfoForm, bankAccountId: '', bankAccountDisplay: '' })}
                  className="text-muted-foreground hover:text-destructive-text transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <Button onClick={saveOrgInfo} loading={savingOrgInfo} className="w-full">Зберегти</Button>
        </div>
      )}

      {/* ─── Currencies ─────────────────────────────────────────────────────── */}
      {tab === 'currencies' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => openCurrencyModal()}><Plus className="w-4 h-4 mr-1" />Додати валюту</Button>
          </div>
          {loadingCurrencies && <p className="text-muted-foreground text-sm">Завантаження...</p>}
          {!loadingCurrencies && currencies.length === 0 && <p className="text-muted-foreground text-sm">Валюти не додано</p>}
          <div className="space-y-2">
            {currencies.map(c => (
              <div key={c.id} className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-foreground">{c.name}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{c.code}{c.symbol ? ` (${c.symbol})` : ''}</span>
                  {c.fullName && <p className="text-xs text-muted-foreground mt-0.5">{c.fullName}</p>}
                </div>
                <div className="flex gap-2">
                  <button aria-label="Редагувати валюту" onClick={() => openCurrencyModal(c)} className="text-muted-foreground hover:text-foreground transition-colors"><Pencil className="w-4 h-4" /></button>
                  <button aria-label="Видалити валюту" onClick={() => deleteCurrency(c.id)} className="text-muted-foreground hover:text-destructive-text transition-colors"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Exchange Rates ──────────────────────────────────────────────────── */}
      {tab === 'exchange-rates' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => openRateModal()}><Plus className="w-4 h-4 mr-1" />Додати курс</Button>
          </div>
          {loadingRates && <p className="text-muted-foreground text-sm">Завантаження...</p>}
          {!loadingRates && exchangeRates.length === 0 && <p className="text-muted-foreground text-sm">Курси не додано</p>}
          <div className="space-y-2">
            {exchangeRates.map(r => (
              <div key={r.id} className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-foreground">{r.currencyCode}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{r.date}</span>
                  <span className="ml-2 text-sm text-foreground">{Number(r.coefficient)} = {Number(r.rate)} UAH</span>
                </div>
                <div className="flex gap-2">
                  <button aria-label="Редагувати курс" onClick={() => openRateModal(r)} className="text-muted-foreground hover:text-foreground transition-colors"><Pencil className="w-4 h-4" /></button>
                  <button aria-label="Видалити курс" onClick={() => deleteRate(r.id)} className="text-muted-foreground hover:text-destructive-text transition-colors"><Trash2 className="w-4 h-4" /></button>
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
            <Button onClick={() => openBaModal()}><Plus className="w-4 h-4 mr-1" />Додати рахунок</Button>
          </div>
          {loadingBa && <p className="text-muted-foreground text-sm">Завантаження...</p>}
          {!loadingBa && bankAccounts.length === 0 && <p className="text-muted-foreground text-sm">Рахунки не додано</p>}
          <div className="space-y-2">
            {bankAccounts.map(b => (
              <div key={b.id} className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-foreground">{b.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground font-mono">{b.ibanUA}</span>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {b.currencyCode}{b.bankName ? ` · ${b.bankName}` : ''}{b.branchName ? ` · ${b.branchName}` : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button aria-label="Редагувати рахунок" onClick={() => openBaModal(b)} className="text-muted-foreground hover:text-foreground transition-colors"><Pencil className="w-4 h-4" /></button>
                  <button aria-label="Видалити рахунок" onClick={() => deleteBa(b.id)} className="text-muted-foreground hover:text-destructive-text transition-colors"><Trash2 className="w-4 h-4" /></button>
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
            <Button onClick={() => openCrModal()}><Plus className="w-4 h-4 mr-1" />Додати касу</Button>
          </div>
          {loadingCr && <p className="text-muted-foreground text-sm">Завантаження...</p>}
          {!loadingCr && cashRegisters.length === 0 && <p className="text-muted-foreground text-sm">Каси не додано</p>}
          <div className="space-y-2">
            {cashRegisters.map(c => (
              <div key={c.id} className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-foreground">{c.name}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{c.currencyCode}{c.currencySymbol ? ` ${c.currencySymbol}` : ''}</span>
                  <span className="ml-2 text-xs text-muted-foreground">· {c.branchName}</span>
                </div>
                <div className="flex gap-2">
                  <button aria-label="Редагувати касу" onClick={() => openCrModal(c)} className="text-muted-foreground hover:text-foreground transition-colors"><Pencil className="w-4 h-4" /></button>
                  <button aria-label="Видалити касу" onClick={() => deleteCr(c.id)} className="text-muted-foreground hover:text-destructive-text transition-colors"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SMS templates */}
      {tab === 'notifications' && (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Використовуйте змінні у подвійних дужках: {'{{workOrderNumber}}'}, {'{{clientName}}'}, {'{{amount}}'}
          </p>
          {templates.length === 0 && (
            <p className="text-muted-foreground text-sm">Шаблони не знайдено</p>
          )}
          {(['SMS', 'EMAIL', 'PUSH'] as const).map(channel => {
            const channelTemplates = templates.filter(t => t.channel === channel);
            if (channelTemplates.length === 0) return null;
            return (
              <div key={channel}>
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-secondary rounded text-xs font-mono">{channel}</span>
                  {channel === 'SMS' && 'SMS-сповіщення'}
                  {channel === 'EMAIL' && 'Email-сповіщення'}
                  {channel === 'PUSH' && 'Push-сповіщення'}
                </h3>
                <div className="space-y-3">
                  {channelTemplates.map(t => (
                    <div key={t.id} className="bg-surface rounded-xl border border-border p-4">
                      {editingTemplate?.id === t.id ? (
                        <div className="space-y-3">
                          <span className="text-sm font-medium text-foreground">{EVENT_LABELS[t.eventType] ?? t.eventType}</span>
                          {channel === 'EMAIL' && (
                            <input
                              type="text"
                              value={editingTemplate.subject ?? ''}
                              onChange={e => setEditingTemplate(et => et ? { ...et, subject: e.target.value } : et)}
                              placeholder="Тема листа"
                              className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary bg-surface text-foreground"
                            />
                          )}
                          <textarea
                            value={editingTemplate.body}
                            onChange={e => setEditingTemplate(et => et ? { ...et, body: e.target.value } : et)}
                            rows={3}
                            className="w-full px-3 py-2 border border-border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary bg-surface text-foreground"
                          />
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editingTemplate.isActive}
                                onChange={e => setEditingTemplate(et => et ? { ...et, isActive: e.target.checked } : et)}
                                className="rounded border-border"
                              />
                              <span className="text-sm text-foreground">Активний</span>
                            </label>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={saveTemplate} loading={saving}>Зберегти</Button>
                            <Button size="sm" variant="outline" onClick={() => setEditingTemplate(null)}>Скасувати</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium text-foreground">{EVENT_LABELS[t.eventType] ?? t.eventType}</span>
                              <span className={cn('text-xs px-1.5 py-0.5 rounded', t.isActive ? 'bg-success-subtle text-success' : 'bg-secondary text-muted-foreground')}>
                                {t.isActive ? 'Активний' : 'Вимкнено'}
                              </span>
                            </div>
                            {t.subject && <p className="text-xs text-muted-foreground mb-1">Тема: {t.subject}</p>}
                            <p className="text-xs text-muted-foreground font-mono bg-secondary rounded p-2">{t.body}</p>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(t)}>Редагувати</Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Theme */}
      {tab === 'theme' && orgSettings && (
        <div className="space-y-6">
          <div className="bg-surface rounded-xl border border-border p-6">
            <p className="text-sm text-muted-foreground mb-4">Оберіть кольорову палітру інтерфейсу</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              {(Object.entries(THEMES) as [ThemeName, typeof THEMES[ThemeName]][]).map(([key, theme]) => (
                <button key={key} onClick={() => { setOrgSettings({ ...orgSettings, brandTheme: key }); applyTheme(key); }}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-xl border-2 transition-all',
                    orgSettings.brandTheme === key ? 'border-foreground shadow-sm' : 'border-border hover:border-foreground/40',
                  )}>
                  <span className="w-8 h-8 rounded-full shrink-0" style={{ background: theme.primary }} />
                  <span className="text-sm font-medium text-foreground">{theme.label}</span>
                </button>
              ))}
            </div>
            <Button onClick={saveOrgSettings} loading={saving} className="w-full">
              Зберегти тему
            </Button>
          </div>

          <div className="bg-surface rounded-xl border border-border p-6">
            <p className="text-[13px] font-medium text-foreground mb-3">Режим навігації</p>
            <div className="flex gap-1.5">
              {([
                { mode: 'sections' as NavMode, label: 'По розділах' },
                { mode: 'functions' as NavMode, label: 'По функціях' },
              ]).map(({ mode, label }) => (
                <button
                  key={mode}
                  onClick={() => changeNavMode(mode)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
                    navMode === mode
                      ? 'bg-primary text-white'
                      : 'bg-secondary text-foreground hover:bg-secondary/80',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-muted-foreground mt-2">
              Зберігається локально у браузері
            </p>
          </div>

          <div className="bg-surface rounded-xl border border-border p-6">
            <p className="text-[13px] font-medium text-foreground mb-3">Тема</p>
            <div className="flex gap-1.5">
              {([
                { mode: 'light' as ColorMode, label: 'Світла', icon: Sun },
                { mode: 'dark' as ColorMode, label: 'Темна', icon: Moon },
                { mode: 'system' as ColorMode, label: 'Системна', icon: Monitor },
              ] as const).map(({ mode, label, icon: Icon }) => (
                <button
                  key={mode}
                  onClick={() => { setColorMode(mode); setColorModeState(mode); }}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
                    colorMode === mode
                      ? 'bg-primary text-white'
                      : 'bg-secondary text-foreground hover:bg-secondary/80',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-muted-foreground mt-2">
              Зберігається локально у браузері
            </p>
          </div>
        </div>
      )}

      {/* UI Features */}
      {tab === 'ui' && uiFeatures && (
        <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
          <p className="text-sm text-muted-foreground">Вмикайте або вимикайте функції інтерфейсу. Налаштування зберігаються для всієї організації.</p>
          {(
            [
              { key: 'toastEnabled', label: 'Сповіщення (Toast)', description: 'Показувати спливаючі повідомлення про результат дій' },
              { key: 'unsavedGuardEnabled', label: 'Захист незбережених змін', description: 'Попереджати при закритті форми з незбереженими даними' },
              { key: 'stockIndicatorEnabled', label: 'Індикатор залишку', description: 'Показувати доступну кількість при додаванні запчастини' },
              { key: 'commandPaletteEnabled', label: 'Командна палітра', description: 'Швидкий пошук та навігація через Ctrl+K' },
              { key: 'keyboardShortcutsEnabled', label: 'Клавіатурні скорочення', description: 'Гарячі клавіші для частих дій' },
              { key: 'savedFiltersEnabled', label: 'Збережені фільтри', description: 'Зберігати та відновлювати фільтри у списках' },
              { key: 'inlineEditEnabled', label: 'Редагування в рядку', description: 'Редагувати поля прямо в таблицях без переходу на форму' },
              { key: 'syncIndicatorEnabled', label: 'Індикатор синхронізації', description: 'Показувати статус синхронізації даних' },
              { key: 'notificationCenterEnabled', label: 'Центр сповіщень', description: 'Панель з усіма сповіщеннями та подіями' },
              { key: 'bulkActionsEnabled', label: 'Групові дії', description: 'Вибір кількох записів для масових операцій' },
            ] as { key: keyof UiFeatures; label: string; description: string }[]
          ).map(({ key, label, description }) => (
            <div key={key} className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0">
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
              <Toggle
                label=""
                checked={uiFeatures[key]}
                onChange={(v) => setUiFeatures(f => f ? { ...f, [key]: v } : f)}
              />
            </div>
          ))}
          <Button onClick={saveUiFeatures} loading={saving} className="w-full mt-2">
            Зберегти
          </Button>
        </div>
      )}

      {/* Follow-up Reminders — B8 */}
      {tab === 'followup' && orgSettings && (
        <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-4">
              Автоматичні SMS нагадування клієнтам після тривалої відсутності та перед технічним обслуговуванням.
            </p>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Включити нагадування</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Система щодня отримуватиме список авто без візитів і надсилатиме SMS
                </p>
              </div>
              <input
                type="checkbox"
                checked={orgSettings.followUpActive ?? false}
                onChange={(e) => setOrgSettings({ ...orgSettings, followUpActive: e.target.checked })}
                className="h-4 w-4 rounded border-border cursor-pointer"
              />
            </div>
          </div>

          {(orgSettings.followUpActive ?? false) && (
            <div className="mt-4 pt-4 border-t border-border">
              <label className="block text-sm font-medium text-foreground mb-2">
                Нагадувати через (днів без візиту)
              </label>
              <input
                type="number"
                min={30}
                max={365}
                value={orgSettings.followUpDays ?? 90}
                onChange={(e) =>
                  setOrgSettings({ ...orgSettings, followUpDays: Math.max(30, Math.min(365, Number(e.target.value))) })
                }
                className="w-32 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                Мінімум 30 днів, максимум 365
              </p>
            </div>
          )}

          <Button onClick={saveOrgSettings} loading={saving} className="w-full mt-4">
            Зберегти
          </Button>
        </div>
      )}

      {/* Payment methods */}
      {tab === 'payments' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setNewPaymentForm({ code: '', name: '', requiresFiscal: false }); setPaymentModal(true); }}>
              Метод оплати
            </Button>
          </div>
          <div className="bg-surface rounded-xl border border-border divide-y divide-border">
            {payments.length === 0 && (
              <p className="p-6 text-sm text-muted-foreground">Методи оплати не знайдено</p>
            )}
            {payments.map((pm) => (
              <div key={pm.id} className="flex items-center justify-between px-5 py-4">
                <div>
                  <p className="text-sm font-medium text-foreground">{pm.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pm.code}
                    {pm.requiresFiscal ? ' · фіскальний' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => togglePayment(pm)}
                    className={cn('relative inline-flex h-5 w-9 rounded-full transition-colors', pm.isActive ? 'bg-primary' : 'bg-border')}
                  >
                    <span className={cn('inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5', pm.isActive ? 'translate-x-4' : 'translate-x-0.5')} />
                  </button>
                  <button onClick={() => openEditPayment(pm)} className="p-1 text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => deletePaymentMethod(pm.id)} className="p-1 text-destructive/60 hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Edit payment modal */}
          {editPayment && (
            <Modal open={!!editPayment} onClose={() => setEditPayment(null)} title="Редагувати метод оплати"
              footer={<Button onClick={saveEditPayment} loading={savingPayment} className="w-full">Зберегти</Button>}
            >
              <div className="space-y-4">
                <Input label="Назва" value={editPaymentForm.name} onChange={e => setEditPaymentForm(f => ({ ...f, name: e.target.value }))} required />
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={editPaymentForm.requiresFiscal} onChange={e => setEditPaymentForm(f => ({ ...f, requiresFiscal: e.target.checked }))} className="rounded border-border" />
                  <span className="text-sm text-foreground">Фіскальний (потребує ПРРО)</span>
                </label>
              </div>
            </Modal>
          )}

          {/* Create payment modal */}
          <Modal open={paymentModal} onClose={() => setPaymentModal(false)} title="Новий метод оплати"
            footer={<Button onClick={createPaymentMethod} loading={savingPayment} disabled={!newPaymentForm.code || !newPaymentForm.name} className="w-full">Додати</Button>}
          >
            <div className="space-y-4">
              <Input label="Код" value={newPaymentForm.code} onChange={e => setNewPaymentForm(f => ({ ...f, code: e.target.value }))} placeholder="CASH, CARD, BANK" required hint="Унікальний ідентифікатор (латиниця, великі літери)" />
              <Input label="Назва" value={newPaymentForm.name} onChange={e => setNewPaymentForm(f => ({ ...f, name: e.target.value }))} placeholder="Готівка" required />
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={newPaymentForm.requiresFiscal} onChange={e => setNewPaymentForm(f => ({ ...f, requiresFiscal: e.target.checked }))} className="rounded border-border" />
                <span className="text-sm text-foreground">Фіскальний (потребує ПРРО)</span>
              </label>
            </div>
          </Modal>
        </div>
      )}

      {/* Document number configs */}
      {tab === 'numbers' && (
        <div className="space-y-3">
          {docNumbers.length === 0 && <p className="text-sm text-muted-foreground">Конфігурацій не знайдено</p>}
          {docNumbers.map(cfg => (
            <div key={cfg.id} className="bg-surface rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{cfg.documentType}</span>
                <span className="text-xs text-muted-foreground font-mono">#{cfg.currentSeq}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-[13px]">
                <div>
                  <label className="block text-muted-foreground mb-1">Префікс</label>
                  <Input
                    value={cfg.prefix ?? ''}
                    onChange={e => {
                      const prefix = e.target.value || null;
                      setDocNumbers(prev => prev.map(c => c.documentType === cfg.documentType ? { ...c, prefix } : c));
                    }}
                    onBlur={e => {
                      const prefix = e.target.value || null;
                      apiFetch(`/settings/document-numbers/${cfg.documentType}`, { method: 'PATCH', body: JSON.stringify({ prefix }) })
                        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Помилка збереження префікса'));
                    }}
                    className="h-7 text-sm"
                    placeholder="Без префіксу"
                  />
                </div>
                <div>
                  <label className="block text-muted-foreground mb-1">Роздільник</label>
                  <Input
                    value={cfg.separator}
                    onChange={e => {
                      const separator = e.target.value || '-';
                      setDocNumbers(prev => prev.map(c => c.documentType === cfg.documentType ? { ...c, separator } : c));
                    }}
                    onBlur={e => {
                      const separator = e.target.value || '-';
                      apiFetch(`/settings/document-numbers/${cfg.documentType}`, { method: 'PATCH', body: JSON.stringify({ separator }) })
                        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Помилка збереження роздільника'));
                    }}
                    className="h-7 text-sm w-16"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-muted-foreground">Скидати: {cfg.resetPeriod === 'NEVER' ? 'Ніколи' : cfg.resetPeriod === 'YEARLY' ? 'Щороку' : 'Щомісяця'}</span>
                <Button size="sm" variant="destructive" onClick={() => resetDocNumber(cfg.documentType)} className="h-7 text-xs">
                  Скинути лічильник
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tax rates */}
      {tab === 'taxrates' && (
        <div className="space-y-4">
          <div className="bg-surface rounded-xl border border-border divide-y divide-border">
            {taxRates.length === 0 && <p className="p-4 text-sm text-muted-foreground">Ставок ПДВ не знайдено</p>}
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
                      min="0" max="100"
                      value={editTaxForm.rate}
                      onChange={e => setEditTaxForm(f => ({ ...f, rate: e.target.value }))}
                      className="w-20 px-2 py-1 border border-border rounded-lg text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <span className="text-muted-foreground text-sm">%</span>
                    <Button size="sm" onClick={saveEditTaxRate} loading={savingTax}>Зберегти</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditTaxRate(null)}>Скасувати</Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-foreground">{tr.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{tr.rate}%</span>
                      {tr.isDefault && <span className="ml-2 text-xs text-primary">(за замовчуванням)</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleTaxRate(tr)}
                        className={cn('relative inline-flex h-5 w-9 rounded-full transition-colors', tr.isActive ? 'bg-primary' : 'bg-border')}
                      >
                        <span className={cn('inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5', tr.isActive ? 'translate-x-4' : 'translate-x-0.5')} />
                      </button>
                      <button onClick={() => openEditTaxRate(tr)} className="p-1 text-muted-foreground hover:text-foreground">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => deleteTaxRate(tr.id)} className="p-1 text-destructive/60 hover:text-destructive">
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
              <Input label="Назва" value={newTaxRate.name} onChange={e => setNewTaxRate(f => ({ ...f, name: e.target.value }))} placeholder="ПДВ 20%" />
              <Input label="Ставка, %" type="number" min="0" max="100" value={newTaxRate.rate} onChange={e => setNewTaxRate(f => ({ ...f, rate: e.target.value }))} />
            </div>
            <Button onClick={addTaxRate} loading={savingTax} disabled={!newTaxRate.name || !newTaxRate.rate}>Додати ставку</Button>
          </div>
        </div>
      )}

      {/* Integrations (Webhooks) */}
      {tab === 'integrations' && (
        <div className="space-y-4">
          {/* Add webhook form */}
          <div className="bg-surface rounded-xl border border-border p-5 space-y-3">
            <h2 className="font-semibold text-foreground">Додати вебхук</h2>
            <Input
              label="URL"
              type="url"
              value={webhookForm.url}
              onChange={e => setWebhookForm(f => ({ ...f, url: e.target.value }))}
              placeholder="https://example.com/webhook"
            />
            <Input
              label="Секрет (HMAC, необов'язково)"
              type="text"
              value={webhookForm.secret}
              onChange={e => setWebhookForm(f => ({ ...f, secret: e.target.value }))}
              placeholder="Секретний ключ для підпису"
            />
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">Події</label>
              <div className="space-y-1.5">
                {WEBHOOK_EVENT_OPTIONS.map(opt => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={webhookForm.events.includes(opt.value)}
                      onChange={e => {
                        const events = e.target.checked
                          ? [...webhookForm.events, opt.value]
                          : webhookForm.events.filter(v => v !== opt.value);
                        setWebhookForm(f => ({ ...f, events }));
                      }}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-foreground">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <Button onClick={() => void addWebhook()} loading={savingWebhook}>
              Додати вебхук
            </Button>
          </div>

          {/* Webhooks list */}
          <div className="bg-surface rounded-xl border border-border divide-y divide-border">
            {webhooks.length === 0 && <p className="p-4 text-sm text-muted-foreground">Вебхуків не налаштовано</p>}
            {webhooks.map(wh => (
              <div key={wh.id}>
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{wh.url}</p>
                    <p className="text-xs text-muted-foreground">{wh.events.map(e => WEBHOOK_EVENT_OPTIONS.find(o => o.value === e)?.label ?? e).join(', ')}</p>
                  </div>
                  <div className="flex items-center gap-2 ml-3 shrink-0">
                    <button
                      onClick={() => void loadDeliveries(wh.id)}
                      disabled={loadingDeliveries === wh.id}
                      className="text-xs text-primary hover:underline px-1"
                    >
                      {webhookDeliveries[wh.id] ? 'Сховати лог' : 'Лог'}
                    </button>
                    <button
                      onClick={() => void toggleWebhook(wh)}
                      className={cn('relative inline-flex h-5 w-9 rounded-full transition-colors', wh.isActive ? 'bg-primary' : 'bg-border')}
                      title={wh.isActive ? 'Активний' : 'Неактивний'}
                    >
                      <span className={cn('inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5', wh.isActive ? 'translate-x-4' : 'translate-x-0.5')} />
                    </button>
                    <button onClick={() => void deleteWebhook(wh.id)} className="text-xs text-destructive/60 hover:text-destructive px-1">×</button>
                  </div>
                </div>
                {webhookDeliveries[wh.id] && (
                  <div className="px-4 pb-3">
                    <div className="bg-secondary rounded-lg overflow-hidden divide-y divide-border border border-border">
                      {webhookDeliveries[wh.id].length === 0 && (
                        <p className="px-3 py-2 text-xs text-muted-foreground">Доставок не було</p>
                      )}
                      {webhookDeliveries[wh.id].map(d => (
                        <div key={d.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                          <span className={cn(
                            'w-2 h-2 rounded-full shrink-0',
                            d.status === 'DELIVERED' ? 'bg-success' : 'bg-destructive',
                          )} />
                          <span className="font-mono text-muted-foreground">{WEBHOOK_EVENT_OPTIONS.find(o => o.value === d.event)?.label ?? d.event}</span>
                          <span className={cn('px-1.5 py-0.5 rounded text-[11px]', d.status === 'DELIVERED' ? 'bg-success-subtle text-success' : 'bg-destructive-subtle text-destructive-text')}>
                            {d.status === 'DELIVERED' ? 'Доставлено' : 'Помилка'}
                          </span>
                          {d.responseCode != null && <span className="text-muted-foreground">HTTP {d.responseCode}</span>}
                          <span className="text-muted-foreground ml-auto">{new Date(d.createdAt).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Work days */}
      {tab === 'workdays' && (
        <div className="space-y-4">
          {branches.length > 1 && (
            <Select label="Філія" value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)}>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          )}
          {branchSettings && (
            <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
              <div>
                <p className="text-[13px] font-medium text-foreground mb-2">Робочі дні</p>
                <div className="flex gap-2">
                  {WORK_DAYS.map((label, i) => (
                    <button
                      key={i}
                      onClick={() => toggleWorkDay(i + 1)}
                      className={cn(
                        'w-9 h-9 rounded-full text-sm font-medium transition-colors',
                        branchSettings.workDays.includes(i + 1)
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-muted-foreground hover:bg-secondary/80',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[13px] font-medium text-foreground mb-1">Початок роботи</label>
                  <Input type="time" value={branchSettings.workStartTime} onChange={e => setBranchSettings(s => s ? { ...s, workStartTime: e.target.value } : s)} className="w-32" />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-foreground mb-1">Кінець роботи</label>
                  <Input type="time" value={branchSettings.workEndTime} onChange={e => setBranchSettings(s => s ? { ...s, workEndTime: e.target.value } : s)} className="w-32" />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-foreground mb-1">Тривалість слоту (хв)</label>
                <Input type="number" min="15" max="240" step="15" value={branchSettings.slotDurationMinutes} onChange={e => setBranchSettings(s => s ? { ...s, slotDurationMinutes: Number(e.target.value) } : s)} className="w-32" />
              </div>
              <Button onClick={saveBranchSettings} loading={savingBranch}>Зберегти</Button>
            </div>
          )}
        </div>
      )}

      {/* ─── Bank Account Picker Modal ──────────────────────────────────────── */}
      <PickerModal<BankAccount>
        open={baPickerModal}
        onClose={() => setBaPickerModal(false)}
        title="Оберіть банківський рахунок"
        items={bankAccounts}
        selectedId={orgInfoForm.bankAccountId}
        searchKeys={['name', 'ibanUA', 'bankName', 'mfo', 'edrpou']}
        searchPlaceholder="Пошук за назвою, IBAN, МФО, ЄДРПОУ, банком..."
        emptyText="Рахунки не додано"
        onSelect={(b) => setOrgInfoForm(prev => ({ ...prev, bankAccountId: b.id, bankAccountDisplay: b.name }))}
        renderItem={(b) => (
          <>
            <div className="font-medium text-foreground text-sm">{b.name}</div>
            <div className="font-mono text-xs text-muted-foreground mt-0.5">{b.ibanUA}</div>
            {(b.bankName || b.mfo || b.edrpou) && (
              <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                {b.bankName && <span>{b.bankName}</span>}
                {b.mfo && <span>МФО: {b.mfo}</span>}
                {b.edrpou && <span>ЄДРПОУ: {b.edrpou}</span>}
              </div>
            )}
          </>
        )}
      />

      {/* ─── Currency Modal ──────────────────────────────────────────────────── */}
      <Modal open={currencyModal} onClose={() => setCurrencyModal(false)} title={editingCurrency ? 'Редагувати валюту' : 'Нова валюта'}
        footer={<><Button variant="outline" onClick={() => setCurrencyModal(false)}>Скасувати</Button><Button onClick={saveCurrency} loading={savingCurrency}>Зберегти</Button></>}>
        <div className="space-y-4">
          <Input label="Назва *" required value={currencyForm.name} errorMessage={currencyErrors.name} onChange={e => { setCurrencyForm({ ...currencyForm, name: e.target.value }); if (currencyErrors.name) setCurrencyErrors(p => ({ ...p, name: undefined })); }} />
          <Input label="Код (ISO 4217) *" required value={currencyForm.code} errorMessage={currencyErrors.code} onChange={e => { setCurrencyForm({ ...currencyForm, code: e.target.value.toUpperCase() }); if (currencyErrors.code) setCurrencyErrors(p => ({ ...p, code: undefined })); }} placeholder="UAH" />
          <Input label="Символ" value={currencyForm.symbol} onChange={e => setCurrencyForm({ ...currencyForm, symbol: e.target.value })} placeholder="₴" />
          <Input label="Повна назва" value={currencyForm.fullName} onChange={e => setCurrencyForm({ ...currencyForm, fullName: e.target.value })} />
          <Input label="Міжнародна назва" value={currencyForm.internationalName} onChange={e => setCurrencyForm({ ...currencyForm, internationalName: e.target.value })} />
        </div>
      </Modal>

      {/* ─── Exchange Rate Modal ─────────────────────────────────────────────── */}
      <Modal open={rateModal} onClose={() => setRateModal(false)} title={editingRate ? 'Редагувати курс' : 'Новий курс'}
        footer={<><Button variant="outline" onClick={() => setRateModal(false)}>Скасувати</Button><Button onClick={saveRate} loading={savingRate}>Зберегти</Button></>}>
        <div className="space-y-4">
          {!editingRate && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Валюта *</label>
              <SearchCombobox<Currency>
                value={rateForm.currencyId}
                displayValue={rateForm.currencyDisplay}
                onSelect={(item) => { setRateForm({ ...rateForm, currencyId: item.id, currencyDisplay: `${item.code} — ${item.name}` }); if (rateErrors.currencyId) setRateErrors(p => ({ ...p, currencyId: undefined })); }}
                onClear={() => setRateForm({ ...rateForm, currencyId: '', currencyDisplay: '' })}
                fetchItems={async (q) => { const r = await apiFetch<{ items: Currency[] }>(`/currencies?q=${encodeURIComponent(q)}&limit=10`); return r.items.map(c => ({ ...c, primary: `${c.code} — ${c.name}`, secondary: c.symbol ?? undefined })); }}
                placeholder="Пошук валюти..."
              />
              {rateErrors.currencyId && <p className="text-xs text-destructive-text mt-1">{rateErrors.currencyId}</p>}
            </div>
          )}
          <Input label="Дата *" required type="date" value={rateForm.date} errorMessage={rateErrors.date} onChange={e => { setRateForm({ ...rateForm, date: e.target.value }); if (rateErrors.date) setRateErrors(p => ({ ...p, date: undefined })); }} />
          <Input label="Курс (UAH) *" required type="number" step="0.000001" value={rateForm.rate} errorMessage={rateErrors.rate} onChange={e => { setRateForm({ ...rateForm, rate: e.target.value }); if (rateErrors.rate) setRateErrors(p => ({ ...p, rate: undefined })); }} />
          <Input label="Кількість одиниць" type="number" step="1" value={rateForm.coefficient} errorMessage={rateErrors.coefficient} onChange={e => { setRateForm({ ...rateForm, coefficient: e.target.value }); if (rateErrors.coefficient) setRateErrors(p => ({ ...p, coefficient: undefined })); }} hint="Скільки одиниць валюти відповідають вказаному курсу" />
        </div>
      </Modal>

      {/* ─── Bank Account Modal ──────────────────────────────────────────────── */}
      <Modal open={baModal} onClose={() => setBaModal(false)} title={editingBa ? 'Редагувати рахунок' : 'Новий банківський рахунок'}
        footer={<><Button variant="outline" onClick={() => setBaModal(false)}>Скасувати</Button><Button onClick={saveBa} loading={savingBa}>Зберегти</Button></>}>
        <div className="space-y-4">
          <Input
            label="Назва рахунку *" required
            value={baForm.name}
            onChange={e => { setBaForm({ ...baForm, name: e.target.value }); if (baErrors.name) setBaErrors(p => ({ ...p, name: undefined })); }}
            errorMessage={baErrors.name}
          />
          <Input
            label="IBAN *" required
            value={baForm.ibanUA}
            onChange={e => { setBaForm({ ...baForm, ibanUA: e.target.value }); if (baErrors.ibanUA) setBaErrors(p => ({ ...p, ibanUA: undefined })); }}
            placeholder="UA213223130000026007233566001"
            errorMessage={baErrors.ibanUA}
          />
          <Select
            label="Валюта *" required
            value={baForm.currencyId}
            onChange={e => { setBaForm({ ...baForm, currencyId: e.target.value }); if (baErrors.currencyId) setBaErrors(p => ({ ...p, currencyId: undefined })); }}
            errorMessage={baErrors.currencyId}
            placeholder="Оберіть валюту..."
          >
            {currencies.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </Select>
          <Select
            label="Філія"
            value={baForm.branchId}
            onChange={e => setBaForm({ ...baForm, branchId: e.target.value })}
            placeholder="Не прив'язано до філії"
          >
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Input label="Назва банку" value={baForm.bankName} onChange={e => setBaForm({ ...baForm, bankName: e.target.value })} />
          <Input label="МФО" value={baForm.mfo} onChange={e => setBaForm({ ...baForm, mfo: e.target.value })} />
          <Input label="ЄДРПОУ банку" value={baForm.edrpou} onChange={e => setBaForm({ ...baForm, edrpou: e.target.value })} />
          <Input label="Адреса банку" value={baForm.bankAddress} onChange={e => setBaForm({ ...baForm, bankAddress: e.target.value })} />
        </div>
      </Modal>

      {/* ─── Cash Register Modal ─────────────────────────────────────────────── */}
      <Modal open={crModal} onClose={() => setCrModal(false)} title={editingCr ? 'Редагувати касу' : 'Нова каса'}
        footer={<><Button variant="outline" onClick={() => setCrModal(false)}>Скасувати</Button><Button onClick={saveCr} loading={savingCr}>Зберегти</Button></>}>
        <div className="space-y-4">
          <Input
            label="Назва *" required
            value={crForm.name}
            onChange={e => { setCrForm({ ...crForm, name: e.target.value }); if (crErrors.name) setCrErrors(p => ({ ...p, name: undefined })); }}
            errorMessage={crErrors.name}
          />
          <Select
            label="Валюта *" required
            value={crForm.currencyId}
            onChange={e => { setCrForm({ ...crForm, currencyId: e.target.value }); if (crErrors.currencyId) setCrErrors(p => ({ ...p, currencyId: undefined })); }}
            errorMessage={crErrors.currencyId}
            placeholder="Оберіть валюту..."
          >
            {currencies.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </Select>
          <Select
            label="Філія *" required
            value={crForm.branchId}
            onChange={e => { setCrForm({ ...crForm, branchId: e.target.value }); if (crErrors.branchId) setCrErrors(p => ({ ...p, branchId: undefined })); }}
            errorMessage={crErrors.branchId}
            placeholder="Оберіть філію..."
          >
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32"
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-foreground">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
