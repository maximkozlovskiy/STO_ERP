'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Plus, Pencil, Check, X } from 'lucide-react';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { StatusManager } from '@/components/ui/CounterpartyStatusManager';
import { useForm } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  counterpartyFormSchema,
  type CounterpartyFormInput,
  type CounterpartyFormValues,
} from '@sto/shared';
import {
  CounterpartyForm,
  emptyCounterpartyForm,
  counterpartyToForm,
} from '@/components/ui/CounterpartyForm';
import { type Warranty } from '@/hooks/api/useWarranties';
import { useBaseCurrency } from '@/hooks/api/useCash';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn, daysUntil, settlementBalanceTone, settlementBalanceToneClass } from '@/lib/utils';
import { AnimatedBody } from '@/components/ui/modal';
import { LinkedDocumentsPanel } from '@/components/ui/LinkedDocumentsPanel';
import { counterpartyLinkedConfig } from '@/lib/linked-configs';
import { useLinkedNav } from '@/lib/linked-nav';
import { fmtMoney, fmtInt, fmtDate, kyivToday } from '@/lib/format';
import {
  COUNTERPARTY_TYPE_BADGE,
  COUNTERPARTY_TYPE_DESCRIPTIONS,
  SETTLEMENT_BALANCE_UP_TYPES,
  SETTLEMENT_TX_CHARGE_LIKE_TYPES,
} from '@sto/shared';
import {
  contractTypeLabel,
  woStatusLabel,
  counterpartyTypeLabel,
  settlementTxTypeLabel,
} from '@/i18n/enumLabel';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Counterparty {
  id: string;
  orgId?: string;
  type: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  edrpou: string | null;
  vatPayer: boolean;
  balance: number;
  notes: string | null;
  legalForm?: string | null;
  legalAddress?: string | null;
  actualAddress?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  contactPerson?: string | null;
  taxNumber?: string | null;
  statuses?: CounterpartyStatusBadge[];
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}
interface CounterpartyStatusBadge {
  id: string;
  name: string;
  color: string;
}
interface Garage {
  id: string;
  name: string;
  address: string | null;
  isDefault: boolean;
}
interface Vehicle {
  id: string;
  customerGarageId: string;
  make: string;
  model: string;
  licensePlate: string | null;
  year: number | null;
  currentMileage: number | null;
  transmissionType?: string | null;
  driveType?: string | null;
  bodyType?: string | null;
  engineCode?: string | null;
  insuranceExpiry?: string | null;
  inspectionExpiry?: string | null;
}
interface MaintenanceSchedule {
  id: string;
  vehicleId: string;
  maintenanceType: string;
  intervalDays?: number | null;
  intervalMileage?: number | null;
  lastMaintenanceDate?: string | null;
  lastMaintenanceMileage?: number | null;
  nextMaintenanceDate?: string | null;
  nextMaintenanceMileage?: number | null;
  isActive: boolean;
  notes?: string | null;
}
interface Transaction {
  id: string;
  type: string;
  amount: number;
  // Мультивалюта (Фаза 2): валюта + base-сума + курс. null → історичні/base UAH.
  currencyId?: string | null;
  currencyCode?: string | null;
  amountBase?: number | null;
  rateUsed?: number | null;
  documentType: string | null;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
}
interface WorkOrder {
  id: string;
  number: string;
  status: string;
  vehicleSummary?: string | null;
  createdAt: string;
  totalAmount: number;
}
interface LoyaltyTransaction {
  id: string;
  type: string;
  points: number;
  documentId?: string | null;
  documentType?: string | null;
  createdAt: string;
  notes?: string | null;
}
// B6 (dedup): тип Warranty підіймається у спільний хук useWarranties (єдине джерело правди,
// усуває drift локальної копії — клас Bug #715). Data-flow тут лишається imperative (loadWarranties).

interface Contract {
  id: string;
  number: string;
  contractType: 'PURCHASE' | 'SALE';
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  creditLimit: number | null;
  currencyCode: string;
  paymentDeferDays: number | null;
  createdAt: string;
}

type CrmTab =
  | 'info'
  | 'garages'
  | 'contracts'
  | 'settlements'
  | 'work-orders'
  | 'documents'
  | 'warranties'
  | 'loyalty';

// Static tab labels — module-level, i18n labelKey резолвиться у компоненті.
const CRM_TABS: { key: CrmTab; labelKey: string }[] = [
  { key: 'info', labelKey: 'card.tabs.info' },
  { key: 'garages', labelKey: 'card.tabs.garages' },
  { key: 'contracts', labelKey: 'card.tabs.contracts' },
  { key: 'settlements', labelKey: 'card.tabs.settlements' },
  { key: 'work-orders', labelKey: 'card.tabs.workOrders' },
  { key: 'documents', labelKey: 'card.tabs.documents' },
  { key: 'warranties', labelKey: 'card.tabs.warranties' },
  { key: 'loyalty', labelKey: 'card.tabs.loyalty' },
];

// Коди форм власності — мітки page-specific через counterparties:card.legalForm.<CODE>.
const LEGAL_FORM_CODES = ['INDIVIDUAL', 'FOP', 'TOV', 'AT', 'PP', 'OTHER'] as const;
const TYPE_BADGE = COUNTERPARTY_TYPE_BADGE;

// woStatusLabel from @/i18n/enumLabel — single source of truth for status labels
const WO_STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  ESTIMATE: 'bg-warning-subtle text-warning',
  APPROVED: 'bg-info-subtle text-info',
  IN_PROGRESS: 'bg-info-subtle text-info',
  ON_HOLD: 'bg-warning-subtle text-warning',
  COMPLETED: 'bg-success-subtle text-success',
  INVOICED: 'bg-info-subtle text-info',
  PAID: 'bg-success-subtle text-success',
  ARCHIVED: 'bg-secondary text-muted-foreground',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

// Транзакційні знаки/кольори у вкладці «Розрахунки». Джерело правди — @sto/shared
// SETTLEMENT_BALANCE_UP_TYPES (дзеркало бекового BALANCE_SIGN, під invariant-тестом) для знаку
// «+»/«−», і SETTLEMENT_TX_CHARGE_LIKE_TYPES для кольору (той самий набір, що у SettlementsTabContent
// → жодного cross-page колір/знак drift, Bug #715 клас). Локальні дублі прибрано.
const BALANCE_UP_TX_TYPES = SETTLEMENT_BALANCE_UP_TYPES;
const CHARGE_LIKE_TX_TYPES = SETTLEMENT_TX_CHARGE_LIKE_TYPES;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CounterpartyCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const { t } = useTranslation('counterparties');
  const { employee } = useAuth();
  // Мітки форм власності — page-specific мапа (не shared enum), будується через counterparties-каталог.
  const legalFormLabels = useMemo(
    () => Object.fromEntries(LEGAL_FORM_CODES.map(c => [c, t(`card.legalForm.${c}`)])),
    [t],
  );
  // Призначати/знімати статуси можуть OWNER/ADMIN/RECEPTIONIST (як assign-endpoint @Roles).
  const canManageStatuses = ['OWNER', 'ADMIN', 'RECEPTIONIST'].includes(employee?.role ?? '');
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { confirm, dialogProps } = useConfirm();
  const linkedNav = useLinkedNav();
  const linkedConfig = useMemo(() => counterpartyLinkedConfig(linkedNav), [linkedNav]);
  // Мультивалюта: символ базової валюти для base-підрядка транзакцій (не хардкод '₴' — Bug #742).
  const { data: baseCurrency } = useBaseCurrency();
  const baseSymbol = baseCurrency?.symbol ?? '₴';

  const [cp, setCp] = useState<Counterparty | null>(null);
  const tab = (searchParams.get('tab') ?? 'info') as CrmTab;
  const setTab = (t: CrmTab) => router.replace(`?tab=${t}`, { scroll: false });
  const [loadError, setLoadError] = useState('');
  const [todayMs, setTodayMs] = useState(0);
  const [orgCurrency, setOrgCurrency] = useState('UAH');
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    setTodayMs(Date.now());
  }, []);

  useEffect(() => {
    // /currencies повертає { items, total }, не bare array;
    // фейл /currencies не повинен ховати orgCurrency у Promise.all-loss.
    let cancelled = false;
    void Promise.allSettled([
      apiFetch<{ currency: string }>('/settings/organisation'),
      apiFetch<{ items: { code: string; name: string }[]; total: number }>('/currencies'),
    ]).then(([settingsRes, currRes]) => {
      if (cancelled) return;
      if (settingsRes.status === 'fulfilled') setOrgCurrency(settingsRes.value.currency);
      if (currRes.status === 'fulfilled') setCurrencies(currRes.value.items ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Garages
  const [garages, setGarages] = useState<Garage[]>([]);
  const [garageVehicles, setGarageVehicles] = useState<Record<string, Vehicle[]>>({});
  const [garagesLoading, setGaragesLoading] = useState(false);
  const [showAddGarage, setShowAddGarage] = useState(false);
  const [garageName, setGarageName] = useState('');
  const [garageAddress, setGarageAddress] = useState('');
  const [savingGarage, setSavingGarage] = useState(false);
  const [expandedGarages, setExpandedGarages] = useState<Set<string>>(new Set());
  const [maintenanceSchedules, setMaintenanceSchedules] = useState<MaintenanceSchedule[]>([]);

  // Settlements
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [settlementsLoading, setSettlementsLoading] = useState(false);

  // Work orders
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [woLoading, setWoLoading] = useState(false);

  // Loyalty
  const [loyaltyBalance, setLoyaltyBalance] = useState(0);
  const [loyaltyTxs, setLoyaltyTxs] = useState<LoyaltyTransaction[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState('');
  const [redeemSaving, setRedeemSaving] = useState(false);
  const [loyaltyError, setLoyaltyError] = useState('');

  // Warranties
  const [warranties, setWarranties] = useState<Warranty[]>([]);
  const [warrantiesLoading, setWarrantiesLoading] = useState(false);

  // Contracts
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState('');
  const [showAddContract, setShowAddContract] = useState(false);
  const [contractForm, setContractForm] = useState({
    contractType: '',
    startDate: kyivToday(),
    endDate: '',
    creditLimit: '',
    currencyCode: '',
    paymentDeferDays: '',
    isPrimary: false,
  });
  const [savingContract, setSavingContract] = useState(false);

  // Editing info
  const [editing, setEditing] = useState(false);
  // Спільна форма контрагента (react-hook-form + zod-схема) — ідентична з CounterpartyEditModal.
  const {
    register,
    handleSubmit,
    reset: resetEditForm,
    control,
    watch,
    formState: { errors },
  } = useForm<CounterpartyFormInput, unknown, CounterpartyFormValues>({
    resolver: i18nZodResolver(counterpartyFormSchema),
    defaultValues: emptyCounterpartyForm(),
    mode: 'onBlur',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const loadCp = useCallback(() => {
    apiFetch<Counterparty>(`/counterparties/${id}`)
      .then(c => {
        setCp(c);
        resetEditForm(counterpartyToForm(c));
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : t('card.loadFailed')));
  }, [id, resetEditForm, t]);

  const loadGarages = useCallback(() => {
    // cancelled guard mirrors loadWarranties: prevents two concurrent staged loads
    // (tab switch back-and-forth, or addGarage refresh racing the tab effect) from
    // interleaving setGarageVehicles/setMaintenanceSchedules with stale data, and
    // blocks setState after unmount.
    let cancelled = false;
    setGaragesLoading(true);
    void (async () => {
      try {
        // sto-optimize: parallel garages + vehicles fetch (раніше garages waterfall →
        // per-garage vehicles N+1). Backend `/vehicles?counterpartyId=X` join
        // customerGarage → counterparty. Stage 2 (schedules) лишилось як було.
        const [garages, allVehicles] = await Promise.all([
          apiFetch<Garage[]>(`/counterparties/${id}/garages`),
          apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${id}`).catch(() => [] as Vehicle[]),
        ]);
        if (cancelled) return;
        setGarages(garages);
        setExpandedGarages(new Set(garages.map(g => g.id)));

        // Group vehicles by garage id locally — replaces per-garage RTT.
        const garageMap: Record<string, Vehicle[]> = {};
        garages.forEach(g => {
          garageMap[g.id] = [];
        });
        for (const v of allVehicles) {
          (garageMap[v.customerGarageId] ??= []).push(v);
        }
        setGarageVehicles(garageMap);

        // Stage 2 — bulk-load maintenance schedules for all vehicles in ONE request.
        // Backend supports `?vehicleIds=v1,v2,v3` (vehicle IN clause) — replaces
        // the prior N+1 (1 fetch per vehicle, up to 100s of round-trips for big garages).
        if (allVehicles.length > 0) {
          const vehicleIdsParam = allVehicles.map(v => v.id).join(',');
          const schedules = await apiFetch<MaintenanceSchedule[]>(
            `/maintenance-schedules?vehicleIds=${vehicleIdsParam}`,
          ).catch(() => [] as MaintenanceSchedule[]);
          if (cancelled) return;
          setMaintenanceSchedules(schedules);
        }
      } catch (e: unknown) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : t('card.garagesError'));
      } finally {
        if (!cancelled) setGaragesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const loadSettlements = useCallback(() => {
    // cancelled guard: tab-switch during fetch must not mutate state for the previous tab.
    // Returning cleanup fn lets the parent useEffect chain (`if (tab === 'settlements') return loadSettlements();`)
    // abort an in-flight load when the tab changes again.
    let cancelled = false;
    setSettlementsLoading(true);
    apiFetch<{ items: Transaction[]; total: number }>(
      `/counterparties/${id}/transactions?page=1&limit=50`,
    )
      .then(r => {
        if (!cancelled) setTransactions(r.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setTransactions([]);
      })
      .finally(() => {
        if (!cancelled) setSettlementsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadWorkOrders = useCallback(() => {
    let cancelled = false;
    setWoLoading(true);
    apiFetch<{ items: WorkOrder[] }>(`/work-orders?counterpartyId=${id}&limit=50`)
      .then(r => {
        if (!cancelled) setWorkOrders(r.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setWorkOrders([]);
      })
      .finally(() => {
        if (!cancelled) setWoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadWarranties = useCallback(() => {
    let cancelled = false;
    setWarrantiesLoading(true);
    apiFetch<{ items: Warranty[] }>(`/warranties/by-counterparty/${id}`)
      .then(d => {
        if (!cancelled) setWarranties(d.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setWarranties([]);
      })
      .finally(() => {
        if (!cancelled) setWarrantiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadContracts = useCallback(() => {
    let cancelled = false;
    setContractsLoading(true);
    setContractsError('');
    apiFetch<Contract[]>(`/counterparties/${id}/contracts`)
      .then(items => {
        if (!cancelled) setContracts(items ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setContractsError(e instanceof Error ? e.message : t('card.contracts.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setContractsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const loadLoyalty = useCallback(() => {
    let cancelled = false;
    setLoyaltyLoading(true);
    setLoyaltyError('');
    Promise.all([
      apiFetch<{ balance: number }>(`/loyalty/balance/${id}`),
      apiFetch<{ items: LoyaltyTransaction[] }>(`/loyalty/transactions/${id}`),
    ])
      .then(([bal, txs]) => {
        if (cancelled) return;
        setLoyaltyBalance(bal.balance);
        setLoyaltyTxs(txs.items ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoyaltyError(e instanceof Error ? e.message : t('card.loyalty.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoyaltyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  useEffect(() => {
    loadCp();
  }, [loadCp]);

  useEffect(() => {
    // Усі load*() повертають cancel-fn — return дозволяє useEffect автоматично
    // викликати її на tab-switch/unmount, скасовуючи in-flight load і не даючи
    // йому перезаписати state поточного табу.
    if (tab === 'garages') return loadGarages();
    if (tab === 'contracts') return loadContracts();
    if (tab === 'settlements') return loadSettlements();
    if (tab === 'work-orders') return loadWorkOrders();
    if (tab === 'warranties') return loadWarranties();
    if (tab === 'loyalty') return loadLoyalty();
  }, [
    tab,
    loadGarages,
    loadContracts,
    loadSettlements,
    loadWorkOrders,
    loadWarranties,
    loadLoyalty,
  ]);

  const addGarage = async () => {
    if (!garageName.trim()) return;
    setSavingGarage(true);
    try {
      await apiFetch<Garage>(`/counterparties/${id}/garages`, {
        method: 'POST',
        body: JSON.stringify({
          name: garageName.trim(),
          address: garageAddress.trim() || undefined,
        }),
      });
      setGarageName('');
      setGarageAddress('');
      setShowAddGarage(false);
      loadGarages();
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : t('card.saveFailed'));
    } finally {
      setSavingGarage(false);
    }
  };

  // Валідація через zodResolver (per-field inline, name-by-type superRefine). Спільна з модалкою.
  const saveEdit = handleSubmit(async (values: CounterpartyFormValues) => {
    if (!cp) return;
    setLoadError('');
    setSavingEdit(true);
    try {
      const updated = await apiFetch<Counterparty>(`/counterparties/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      });
      // Bug #740: PATCH-відповідь (update→toDto) НЕ включає statusLinks → updated.statuses=undefined.
      // Прямий setCp(updated) стирав би badge-мітки з шапки до перезавантаження. PATCH не чіпає
      // статуси (окремий M:N-endpoint) → зберігаємо наявні cp.statuses.
      setCp({ ...updated, statuses: updated.statuses ?? cp.statuses });
      setEditing(false);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : t('card.saveFailed'));
    } finally {
      setSavingEdit(false);
    }
  });

  const toggleGarage = (garageId: string) => {
    setExpandedGarages(prev => {
      const next = new Set(prev);
      if (next.has(garageId)) next.delete(garageId);
      else next.add(garageId);
      return next;
    });
  };

  const displayName = (c: Counterparty) =>
    c.companyName ?? [c.lastName, c.firstName].filter(Boolean).join(' ') ?? '—';

  if (!cp)
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        {loadError ? (
          <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
            {loadError}
          </p>
        ) : (
          <Spinner size="lg" />
        )}
      </div>
    );

  return (
    <div className="page-container max-w-4xl space-y-6">
      {loadError && (
        <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
          {loadError}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
          {t('card.back')}
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">{displayName(cp)}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge
              variant={TYPE_BADGE[cp.type] ?? 'secondary'}
              tooltip={COUNTERPARTY_TYPE_DESCRIPTIONS[cp.type]}
            >
              {counterpartyTypeLabel(cp.type)}
            </Badge>
            {cp.vatPayer && <Badge variant="secondary">{t('card.vatPayer')}</Badge>}
          </div>
          {/* Кастомні статуси-мітки (M:N) — badge-и + керування */}
          <div className="mt-2">
            <StatusManager
              counterpartyId={cp.id}
              assigned={cp.statuses ?? []}
              canManage={canManageStatuses}
              onChange={loadCp}
            />
          </div>
        </div>
        <div
          className={cn(
            'text-lg font-semibold',
            cp.balance < 0
              ? 'text-destructive'
              : cp.balance > 0
                ? 'text-success'
                : 'text-muted-foreground',
          )}
        >
          {fmtMoney(cp.balance)} {baseSymbol}
          <p className="text-xs font-normal text-muted-foreground text-right">
            {t('card.balanceLabel')}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {CRM_TABS.map(tabItem => (
          <button
            key={tabItem.key}
            onClick={() => setTab(tabItem.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === tabItem.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tabItem.labelKey)}
          </button>
        ))}
      </div>

      {/* Tab 1: Info */}
      {tab === 'info' && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">{t('card.info.heading')}</h2>
            {!editing ? (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                {t('card.info.edit')}
              </Button>
            ) : (
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    resetEditForm(counterpartyToForm(cp)); // скидання незбережених змін
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
                {/* (А) Усі обробники на цій сторінці вже показують відмову самі —
                    setLoadError / setContractsError / setLoyaltyError. Проміс
                    нікому не потрібен, тому `void`. */}
                <Button size="sm" loading={savingEdit} onClick={() => void saveEdit()}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  {t('card.info.save')}
                </Button>
              </div>
            )}
          </div>

          {!editing ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t('card.info.nameOrCompany')} value={displayName(cp)} />
                <Field label={t('card.info.phone')} value={cp.phone} />
                <Field label={t('card.info.email')} value={cp.email} />
                <Field label={t('card.info.edrpou')} value={cp.edrpou} />
                <Field label={t('card.info.notes')} value={cp.notes} />
              </div>
              {(cp.legalForm ||
                cp.legalAddress ||
                cp.actualAddress ||
                cp.bankAccount ||
                cp.bankName ||
                cp.contactPerson ||
                cp.taxNumber) && (
                <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 gap-x-6 gap-y-2">
                  {(
                    [
                      [
                        t('card.info.legalForm'),
                        cp.legalForm ? (legalFormLabels[cp.legalForm] ?? cp.legalForm) : null,
                      ],
                      [t('card.info.legalAddress'), cp.legalAddress],
                      [t('card.info.actualAddress'), cp.actualAddress],
                      [t('card.info.iban'), cp.bankAccount],
                      [t('card.info.bank'), cp.bankName],
                      [t('card.info.contactPerson'), cp.contactPerson],
                      [t('card.info.taxNumber'), cp.taxNumber],
                    ] as [string, string | null | undefined][]
                  )
                    .filter(([, v]) => v)
                    .map(([label, value]) => (
                      <div key={label}>
                        <div className="text-[12px] text-muted-foreground">{label}:</div>
                        <div className="text-[13px] text-foreground">{value}</div>
                      </div>
                    ))}
                </div>
              )}
            </>
          ) : (
            <CounterpartyForm register={register} errors={errors} control={control} watch={watch} />
          )}
        </div>
      )}

      {/* Tab 2: Garages & Vehicles */}
      {tab === 'garages' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t('card.garages.heading')}</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowAddGarage(v => !v)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('card.garages.addGarage')}
            </Button>
          </div>

          {showAddGarage && (
            <AnimatedBody className="p-4 bg-secondary rounded-xl border border-border space-y-3">
              <Input
                label={t('card.garages.nameLabel')}
                required
                value={garageName}
                onChange={e => setGarageName(e.target.value)}
                placeholder={t('card.garages.namePlaceholder')}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('card.garages.addressLabel')}
                value={garageAddress}
                onChange={e => setGarageAddress(e.target.value)}
                placeholder={t('card.garages.addressPlaceholder')}
                className="h-8 text-[13px]"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void addGarage()}
                  loading={savingGarage}
                  disabled={!garageName.trim()}
                >
                  {t('card.garages.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddGarage(false)}>
                  {t('card.garages.cancel')}
                </Button>
              </div>
            </AnimatedBody>
          )}

          {garagesLoading && (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          )}

          {!garagesLoading && garages.length === 0 && !showAddGarage && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('card.garages.empty')}
            </p>
          )}

          {!garagesLoading &&
            garages.map(garage => (
              <div
                key={garage.id}
                className="bg-surface rounded-xl border border-border overflow-hidden"
              >
                <button
                  onClick={() => toggleGarage(garage.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{garage.name}</span>
                    {garage.isDefault && (
                      <span className="text-[11px] px-1.5 py-0.5 bg-primary/10 text-primary rounded font-medium">
                        {t('card.garages.default')}
                      </span>
                    )}
                    {garage.address && (
                      <span className="text-xs text-muted-foreground">· {garage.address}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t('card.garages.vehicleCount', {
                        count: garageVehicles[garage.id]?.length ?? 0,
                      })}
                    </span>
                    <span
                      className={cn(
                        'text-muted-foreground transition-transform',
                        expandedGarages.has(garage.id) && 'rotate-180',
                      )}
                    >
                      ▾
                    </span>
                  </div>
                </button>

                {expandedGarages.has(garage.id) && (
                  <div className="border-t border-border">
                    <div className="flex items-center justify-between px-4 py-2 bg-secondary/50">
                      <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
                        {t('card.garages.vehicles')}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          router.push(
                            `/vehicles/new?garageId=${garage.id}&garageName=${encodeURIComponent(garage.name)}`,
                          )
                        }
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        {t('card.garages.addVehicle')}
                      </Button>
                    </div>
                    {!garageVehicles[garage.id] ? (
                      <div className="flex justify-center py-4">
                        <Spinner size="sm" />
                      </div>
                    ) : garageVehicles[garage.id].length === 0 ? (
                      <p className="text-sm text-muted-foreground px-4 py-3">
                        {t('card.garages.noVehicles')}
                      </p>
                    ) : (
                      <div>
                        {garageVehicles[garage.id].map(v => {
                          const techParts = [v.transmissionType, v.driveType, v.bodyType].filter(
                            Boolean,
                          );
                          const vSchedules = maintenanceSchedules.filter(
                            s => s.vehicleId === v.id && s.isActive,
                          );
                          return (
                            <div
                              key={v.id}
                              className="px-4 py-3 border-b border-border last:border-0"
                            >
                              <button
                                onClick={() => router.push(`/vehicles/${v.id}`)}
                                className="w-full flex items-center justify-between text-left"
                              >
                                <div>
                                  <p className="text-sm font-medium text-foreground">
                                    {v.make} {v.model}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {[
                                      v.licensePlate,
                                      v.year,
                                      v.currentMileage
                                        ? t('card.garages.mileage', {
                                            value: fmtInt(v.currentMileage),
                                          })
                                        : null,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </p>
                                  {techParts.length > 0 && (
                                    <p className="text-[11px] text-muted-foreground mt-0.5">
                                      {techParts.join(' · ')}
                                    </p>
                                  )}
                                </div>
                                <span className="text-muted-foreground text-sm">→</span>
                              </button>
                              {vSchedules.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  {vSchedules.map(s => {
                                    const diff = daysUntil(s.nextMaintenanceDate, todayMs);
                                    const isSoon = diff !== null && diff <= 30;
                                    return (
                                      <div
                                        key={s.id}
                                        className="flex items-center gap-2 text-[12px] text-muted-foreground"
                                      >
                                        <span>
                                          {t('card.garages.maintenance', {
                                            type: s.maintenanceType,
                                          })}
                                        </span>
                                        {s.nextMaintenanceDate && (
                                          <span>
                                            {t('card.garages.nextMaintenance', {
                                              date: fmtDate(s.nextMaintenanceDate),
                                            })}
                                          </span>
                                        )}
                                        {isSoon && (
                                          <span className="px-1.5 py-0.5 bg-warning-subtle text-warning rounded text-[11px] font-medium">
                                            {t('card.garages.soon')}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {/* Tab 3: Contracts */}
      {tab === 'contracts' && (
        <div className="space-y-4">
          {contractsError && (
            <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
              {contractsError}
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => setShowAddContract(v => !v)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('card.contracts.add')}
            </Button>
          </div>

          {/* Add contract form */}
          {showAddContract && (
            <div className="bg-surface rounded-xl border border-border p-4 space-y-3">
              <h3 className="text-sm font-semibold text-foreground">
                {t('card.contracts.newContract')}
              </h3>
              {/* Рядок 1: вид договору + checkbox Головний */}
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="text-[13px] text-muted-foreground mb-1 block">
                    {t('card.contracts.contractType')}
                    {cp.type === 'BOTH' && <span className="text-destructive"> *</span>}
                  </label>
                  {cp.type === 'BOTH' ? (
                    <Select
                      value={contractForm.contractType}
                      onChange={e => setContractForm(f => ({ ...f, contractType: e.target.value }))}
                      className="h-8 text-[13px] py-0.5 px-2 pr-7"
                    >
                      <option value="">{t('card.contracts.chooseType')}</option>
                      <option value="PURCHASE">{contractTypeLabel('PURCHASE')}</option>
                      <option value="SALE">{contractTypeLabel('SALE')}</option>
                    </Select>
                  ) : (
                    <div className="px-3 py-2 rounded-lg border border-border bg-secondary text-[13px] text-foreground">
                      {cp.type === 'CLIENT'
                        ? contractTypeLabel('SALE')
                        : contractTypeLabel('PURCHASE')}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none pb-2">
                  <input
                    type="checkbox"
                    checked={contractForm.isPrimary}
                    onChange={e => setContractForm(f => ({ ...f, isPrimary: e.target.checked }))}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span className="text-[13px] text-foreground whitespace-nowrap">
                    {t('card.contracts.primary')}
                  </span>
                </label>
              </div>
              {/* Рядок 2: дати */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[13px] text-muted-foreground mb-1 block">
                    {t('card.contracts.startDate')} <span className="text-destructive">*</span>
                  </label>
                  <Input
                    type="date"
                    value={contractForm.startDate}
                    onChange={e => setContractForm(f => ({ ...f, startDate: e.target.value }))}
                    className="h-8 text-[13px]"
                  />
                </div>
                <div>
                  <label className="text-[13px] text-muted-foreground mb-1 block">
                    {t('card.contracts.endDate')}
                  </label>
                  <Input
                    type="date"
                    value={contractForm.endDate}
                    onChange={e => setContractForm(f => ({ ...f, endDate: e.target.value }))}
                    className="h-8 text-[13px]"
                  />
                </div>
              </div>
              {/* Рядок 3: валюта */}
              <div>
                <label className="text-[13px] text-muted-foreground mb-1 block">
                  {t('card.contracts.currency')}
                </label>
                {currencies.length > 0 ? (
                  <select
                    value={contractForm.currencyCode || orgCurrency}
                    onChange={e => setContractForm(f => ({ ...f, currencyCode: e.target.value }))}
                    className="h-8 w-auto rounded-md border border-border bg-surface px-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    {currencies.map(c => (
                      <option key={c.code} value={c.code}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={contractForm.currencyCode || orgCurrency}
                    onChange={e =>
                      setContractForm(f => ({
                        ...f,
                        // backend lookup case-sensitive — normalize to UPPERCASE immediately on input,
                        // otherwise `uah` → 400 from API.
                        currencyCode: e.target.value.toUpperCase().slice(0, 10),
                      }))
                    }
                    placeholder="UAH"
                    maxLength={10}
                    className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                )}
              </div>
              {/* Рядок 4: фінансові поля */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[13px] text-muted-foreground mb-1 block">
                    {t('card.contracts.creditLimit')}
                  </label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={contractForm.creditLimit}
                    onChange={e => setContractForm(f => ({ ...f, creditLimit: e.target.value }))}
                    className="h-8 text-[13px]"
                  />
                </div>
                <div>
                  <label className="text-[13px] text-muted-foreground mb-1 block">
                    {t('card.contracts.deferDays')}
                  </label>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={contractForm.paymentDeferDays}
                    onChange={e =>
                      setContractForm(f => ({
                        ...f,
                        paymentDeferDays: String(Math.floor(Number(e.target.value))),
                      }))
                    }
                    className="h-8 text-[13px]"
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowAddContract(false)}>
                  {t('card.contracts.cancel')}
                </Button>
                <Button
                  size="sm"
                  loading={savingContract}
                  disabled={
                    !contractForm.startDate || (cp.type === 'BOTH' && !contractForm.contractType)
                  }
                  onClick={() => {
                    void (async () => {
                      setSavingContract(true);
                      setContractsError('');
                      try {
                        const resolvedType =
                          cp.type === 'CLIENT'
                            ? 'SALE'
                            : cp.type === 'SUPPLIER'
                              ? 'PURCHASE'
                              : contractForm.contractType;
                        await apiFetch(`/counterparties/${id}/contracts`, {
                          method: 'POST',
                          body: JSON.stringify({
                            contractType: resolvedType,
                            startDate: contractForm.startDate,
                            endDate: contractForm.endDate || undefined,
                            creditLimit: contractForm.creditLimit
                              ? Number(contractForm.creditLimit)
                              : undefined,
                            currencyCode: contractForm.currencyCode || orgCurrency,
                            paymentDeferDays: contractForm.paymentDeferDays
                              ? Number(contractForm.paymentDeferDays)
                              : undefined,
                            isPrimary: contractForm.isPrimary || undefined,
                          }),
                        });
                        setContractForm({
                          contractType: '',
                          startDate: kyivToday(),
                          endDate: '',
                          creditLimit: '',
                          currencyCode: '',
                          paymentDeferDays: '',
                          isPrimary: false,
                        });
                        setShowAddContract(false);
                        loadContracts();
                      } catch (e: unknown) {
                        setContractsError(
                          e instanceof Error ? e.message : t('card.contracts.saveFailed'),
                        );
                      } finally {
                        setSavingContract(false);
                      }
                    })();
                  }}
                >
                  {t('card.contracts.save')}
                </Button>
              </div>
            </div>
          )}

          {contractsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : contracts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('card.contracts.empty')}
            </p>
          ) : (
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      {t('card.contracts.colNumber')}
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      {t('card.contracts.colType')}
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      {t('card.contracts.colStart')}
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      {t('card.contracts.colEnd')}
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                      {t('card.contracts.colCreditLimit')}
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                      {t('card.contracts.colDeferDays')}
                    </th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {contracts.map(c => (
                    <tr key={c.id} className="hover:bg-secondary/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{c.number}</span>
                          {c.isPrimary && (
                            <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-primary/10 text-primary">
                              {t('card.contracts.primary')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {contractTypeLabel(c.contractType)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(c.startDate)}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {c.endDate ? fmtDate(c.endDate) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {c.creditLimit != null
                          ? `${fmtMoney(c.creditLimit)} ${c.currencyCode}`
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {c.paymentDeferDays ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!c.isPrimary && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive h-7 px-2"
                            onClick={() => {
                              void (async () => {
                                if (
                                  !(await confirm({
                                    title: t('card.contracts.confirmDelete', { number: c.number }),
                                    variant: 'destructive',
                                  }))
                                )
                                  return;
                                try {
                                  await apiFetch(`/counterparties/${id}/contracts/${c.id}`, {
                                    method: 'DELETE',
                                  });
                                  loadContracts();
                                } catch (e: unknown) {
                                  setContractsError(
                                    e instanceof Error
                                      ? e.message
                                      : t('card.contracts.deleteFailed'),
                                  );
                                }
                              })();
                            }}
                          >
                            {t('card.contracts.delete')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Settlements */}
      {tab === 'settlements' && (
        <div className="space-y-4">
          <div className="bg-surface rounded-xl border border-border p-4 flex items-center gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">
                {t('card.settlements.currentBalance')}
              </p>
              <p
                className={cn(
                  'text-xl font-bold',
                  // Bug #606: тип-aware тон (див. settlementBalanceTone у lib/utils).
                  // Було: <0=red|>0=success (лише supplier-first) → інвертувало
                  // колір для клієнтської переплати (CLIENT balance<0 → red = «проблема»
                  // замість warning) і показувало клієнтський борг (CLIENT>0) як «success».
                  settlementBalanceToneClass(settlementBalanceTone(cp.balance, cp.type)),
                )}
              >
                {fmtMoney(cp.balance)} {baseSymbol}
              </p>
            </div>
          </div>

          {settlementsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('card.settlements.empty')}
            </p>
          ) : (
            <div className="bg-surface rounded-xl border border-border divide-y divide-border overflow-hidden">
              {transactions.map(tx => (
                <div key={tx.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm text-foreground">
                      {tx.notes ?? settlementTxTypeLabel(tx.type)}
                    </p>
                    <p className="text-xs text-muted-foreground">{fmtDate(tx.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    {(() => {
                      // Знак = дзеркало бекового BALANCE_SIGN. +1: CHARGE, SUPPLIER_PAYMENT,
                      // SUPPLIER_REFUND; −1: PAYMENT, PREPAYMENT, REFUND, CREDIT_NOTE, SUPPLIER_CHARGE.
                      const sign = BALANCE_UP_TX_TYPES.has(tx.type) ? '+' : '−';
                      const isBase = !tx.currencyCode || tx.currencyCode === orgCurrency;
                      // Bug #742: символ базової валюти з useBaseCurrency (не хардкод '₴' — база
                      // орг може бути USD/EUR). Дзеркалить payments/page.tsx та SettlementsTabContent.
                      const sym = isBase ? baseSymbol : tx.currencyCode!;
                      return (
                        <>
                          <span
                            className={cn(
                              'text-sm font-semibold',
                              // Колір за семантикою (як у SettlementsTabContent): нарахування (наш
                              // борг/клієнт винен) → destructive; оплата/повернення → success.
                              // Курсові різниці (Фаза 4): FX_LOSS — destructive, FX_GAIN — success.
                              CHARGE_LIKE_TX_TYPES.has(tx.type) || tx.type === 'FX_LOSS'
                                ? 'text-destructive-text'
                                : 'text-success',
                            )}
                          >
                            {sign}
                            {fmtMoney(Math.abs(tx.amount))} {sym}
                          </span>
                          {!isBase && tx.amountBase != null && (
                            <div className="text-[11px] text-muted-foreground tabular-nums">
                              {sign}
                              {fmtMoney(Math.abs(tx.amountBase))} {baseSymbol}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Work Orders */}
      {tab === 'work-orders' && (
        <div className="space-y-4">
          {woLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : workOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('card.workOrders.empty')}
            </p>
          ) : (
            <div className="bg-surface rounded-xl border border-border divide-y divide-border overflow-hidden">
              {workOrders.map(wo => (
                <button
                  key={wo.id}
                  onClick={() => router.push(`/work-orders/${wo.id}`)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary text-left transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-medium text-foreground">№{wo.number}</p>
                      <span
                        className={cn(
                          'text-[11px] px-1.5 py-0.5 rounded',
                          WO_STATUS_COLORS[wo.status] ?? 'bg-secondary text-muted-foreground',
                        )}
                      >
                        {woStatusLabel(wo.status)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {wo.vehicleSummary ?? '—'} · {fmtDate(wo.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground">
                      {fmtMoney(wo.totalAmount)} {baseSymbol}
                    </p>
                    <span className="text-muted-foreground text-sm">→</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Документи (пов'язані документи контрагента) */}
      {tab === 'documents' && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <LinkedDocumentsPanel config={linkedConfig} entityId={id} />
        </div>
      )}

      {/* Tab 5: Warranties */}
      {tab === 'warranties' && (
        <div className="space-y-4">
          {warrantiesLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : (
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-secondary flex items-center justify-between">
                <h3 className="font-medium text-foreground text-sm">
                  {t('card.warranties.heading')}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {t('card.warranties.recordsCount', { count: warranties.length })}
                </span>
              </div>
              {warranties.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-[13px]">
                  {t('card.warranties.empty')}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {warranties.map(w => (
                    <div
                      key={w.id}
                      className="px-5 py-3 flex items-center justify-between gap-3 text-sm"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-foreground">
                          {t('card.warranties.workOrderNumber', {
                            number: w.workOrderNumber ?? w.workOrderId.slice(0, 8),
                          })}
                        </div>
                        {w.description && (
                          <div className="text-[12px] text-muted-foreground">{w.description}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[12px] text-muted-foreground">
                          {t('card.warranties.until', { date: fmtDate(w.expiresAt) })}
                        </div>
                        {w.isActive ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-success/10 text-success">
                            {t('card.warranties.active')}
                          </span>
                        ) : w.claimedAt ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-warning/10 text-warning">
                            {t('card.warranties.claimed')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground">
                            {t('card.warranties.expired')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 6: Loyalty */}
      {tab === 'loyalty' && (
        <div className="space-y-4">
          {loyaltyError && (
            <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
              {loyaltyError}
            </div>
          )}
          {loyaltyLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : (
            <div className="bg-surface rounded-xl border border-border p-4 space-y-4">
              {/* Balance + redeem */}
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-[13px] text-muted-foreground">
                    {t('card.loyalty.points')}
                  </div>
                  <div className="text-2xl font-bold text-foreground">
                    {t('card.loyalty.pointsValue', { value: fmtInt(loyaltyBalance) })}
                  </div>
                </div>
                <div className="flex gap-2 items-center">
                  <Input
                    value={redeemPoints}
                    onChange={e => setRedeemPoints(e.target.value)}
                    placeholder={t('card.loyalty.redeemPlaceholder')}
                    type="number"
                    min="0"
                    className="w-36 h-8 text-[13px]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    loading={redeemSaving}
                    disabled={
                      !redeemPoints ||
                      Number(redeemPoints) <= 0 ||
                      Number(redeemPoints) > loyaltyBalance
                    }
                    onClick={() => {
                      void (async () => {
                        setRedeemSaving(true);
                        setLoyaltyError('');
                        try {
                          await apiFetch(`/loyalty/redeem/${id}`, {
                            method: 'POST',
                            body: JSON.stringify({ points: Number(redeemPoints) }),
                          });
                          setRedeemPoints('');
                          loadLoyalty();
                        } catch (e: unknown) {
                          setLoyaltyError(
                            e instanceof Error ? e.message : t('card.loyalty.redeemFailed'),
                          );
                        } finally {
                          setRedeemSaving(false);
                        }
                      })();
                    }}
                  >
                    {t('card.loyalty.redeem')}
                  </Button>
                </div>
              </div>

              {/* Transaction history */}
              {loyaltyTxs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t('card.loyalty.empty')}
                </p>
              ) : (
                <div className="divide-y divide-border max-h-60 overflow-y-auto">
                  {loyaltyTxs.map(tx => (
                    <div key={tx.id} className="flex items-center justify-between py-2 text-[12px]">
                      <span className="text-muted-foreground">{fmtDate(tx.createdAt)}</span>
                      <span className="text-foreground flex-1 px-3 truncate">
                        {tx.notes ??
                          (tx.type === 'EARN' ? t('card.loyalty.earn') : t('card.loyalty.spend'))}
                      </span>
                      <span
                        className={cn(
                          'font-medium',
                          tx.type === 'EARN' ? 'text-success' : 'text-destructive',
                        )}
                      >
                        {tx.type === 'EARN' ? '+' : '-'}
                        {tx.points}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
