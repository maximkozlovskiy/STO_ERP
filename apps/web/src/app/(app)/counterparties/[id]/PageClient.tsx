'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Plus, Pencil, Check, X } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn, daysUntil } from '@/lib/utils';
import { AnimatedBody } from '@/components/ui/modal';
import { fmtMoney, fmtInt, fmtDate, kyivToday } from '@/lib/format';
import {
  COUNTERPARTY_TYPE_LABELS,
  COUNTERPARTY_TYPE_BADGE,
  CONTRACT_TYPE_LABELS,
} from '@sto/shared';

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
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}
interface Garage {
  id: string;
  name: string;
  address: string | null;
  isDefault: boolean;
}
interface Vehicle {
  id: string;
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
  createdAt: string;
  notes?: string | null;
}
interface Warranty {
  id: string;
  orgId: string;
  workOrderId: string;
  workOrderLineId?: string | null;
  workOrderPartId?: string | null;
  counterpartyId: string;
  workOrderNumber?: string;
  counterpartyName?: string;
  expiresAt: string;
  description: string;
  claimedAt?: string | null;
  claimWoId?: string | null;
  isActive: boolean;
  createdAt: string;
}

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
  | 'warranties'
  | 'loyalty';

// Static tab labels — module-level, не пересоздається на кожен render.
const CRM_TABS: { key: CrmTab; label: string }[] = [
  { key: 'info', label: 'Загальна інформація' },
  { key: 'garages', label: 'Гаражі та авто' },
  { key: 'contracts', label: 'Договори' },
  { key: 'settlements', label: 'Взаєморозрахунки' },
  { key: 'work-orders', label: 'Наряди' },
  { key: 'warranties', label: 'Гарантії' },
  { key: 'loyalty', label: 'Лояльність' },
];

const TYPE_LABELS: Record<string, string> = {
  CLIENT: 'Клієнт',
  SUPPLIER: 'Постачальник',
  BOTH: 'Клієнт / Постачальник',
};
const LEGAL_FORM_LABELS: Record<string, string> = {
  INDIVIDUAL: 'Фіз. особа',
  FOP: 'ФОП',
  TOV: 'ТОВ',
  AT: 'АТ',
  PP: 'ПП',
  OTHER: 'Інше',
};
const TYPE_BADGE = COUNTERPARTY_TYPE_BADGE;

const WO_STATUS_LABELS: Record<string, string> = {
  NEW: 'Новий',
  IN_PROGRESS: 'В роботі',
  DONE: 'Готовий',
  CLOSED: 'Закрито',
  CANCELLED: 'Скасовано',
};
const WO_STATUS_COLORS: Record<string, string> = {
  NEW: 'bg-info-subtle text-info',
  IN_PROGRESS: 'bg-warning-subtle text-warning',
  DONE: 'bg-success-subtle text-success',
  CLOSED: 'bg-secondary text-muted-foreground',
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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CounterpartyCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { confirm, dialogProps } = useConfirm();

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
    // Bug review: /currencies повертає { items, total }, не bare array; +
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
  const [editForm, setEditForm] = useState({
    phone: '',
    email: '',
    notes: '',
    legalForm: '',
    legalAddress: '',
    actualAddress: '',
    bankAccount: '',
    bankName: '',
    contactPerson: '',
    taxNumber: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const loadCp = useCallback(() => {
    apiFetch<Counterparty>(`/counterparties/${id}`)
      .then(c => {
        setCp(c);
        setEditForm({
          phone: c.phone ?? '',
          email: c.email ?? '',
          notes: c.notes ?? '',
          legalForm: c.legalForm ?? '',
          legalAddress: c.legalAddress ?? '',
          actualAddress: c.actualAddress ?? '',
          bankAccount: c.bankAccount ?? '',
          bankName: c.bankName ?? '',
          contactPerson: c.contactPerson ?? '',
          taxNumber: c.taxNumber ?? '',
        });
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка завантаження'));
  }, [id]);

  const loadGarages = useCallback(() => {
    // cancelled guard mirrors loadWarranties: prevents two concurrent staged loads
    // (tab switch back-and-forth, or addGarage refresh racing the tab effect) from
    // interleaving setGarageVehicles/setMaintenanceSchedules with stale data, and
    // blocks setState after unmount.
    let cancelled = false;
    setGaragesLoading(true);
    void (async () => {
      try {
        const garages = await apiFetch<Garage[]>(`/counterparties/${id}/garages`);
        if (cancelled) return;
        setGarages(garages);
        setExpandedGarages(new Set(garages.map(g => g.id)));

        // Stage 1 — load all vehicles in parallel (one request per garage)
        const vehiclesByGarage = await Promise.all(
          garages.map(g =>
            apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}`).catch(() => [] as Vehicle[]),
          ),
        );
        if (cancelled) return;
        const garageMap: Record<string, Vehicle[]> = {};
        garages.forEach((g, i) => {
          garageMap[g.id] = vehiclesByGarage[i];
        });
        setGarageVehicles(garageMap);

        // Stage 2 — bulk-load maintenance schedules for all vehicles in ONE request.
        // Backend supports `?vehicleIds=v1,v2,v3` (vehicle IN clause) — replaces
        // the prior N+1 (1 fetch per vehicle, up to 100s of round-trips for big garages).
        const allVehicles = vehiclesByGarage.flat();
        if (allVehicles.length > 0) {
          const vehicleIdsParam = allVehicles.map(v => v.id).join(',');
          const schedules = await apiFetch<MaintenanceSchedule[]>(
            `/maintenance-schedules?vehicleIds=${vehicleIdsParam}`,
          ).catch(() => [] as MaintenanceSchedule[]);
          if (cancelled) return;
          setMaintenanceSchedules(schedules);
        }
      } catch (e: unknown) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Помилка гаражів');
      } finally {
        if (!cancelled) setGaragesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

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
        if (!cancelled) setContractsError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (!cancelled) setContractsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

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
        if (!cancelled) setLoyaltyError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (!cancelled) setLoyaltyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

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
      setLoadError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingGarage(false);
    }
  };

  const saveEdit = async () => {
    if (!cp) return;
    setSavingEdit(true);
    try {
      const updated = await apiFetch<Counterparty>(`/counterparties/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          phone: editForm.phone || undefined,
          email: editForm.email || undefined,
          notes: editForm.notes || undefined,
          legalForm: editForm.legalForm || undefined,
          legalAddress: editForm.legalAddress || undefined,
          actualAddress: editForm.actualAddress || undefined,
          bankAccount: editForm.bankAccount || undefined,
          bankName: editForm.bankName || undefined,
          contactPerson: editForm.contactPerson || undefined,
          taxNumber: editForm.taxNumber || undefined,
        }),
      });
      setCp(updated);
      setEditing(false);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingEdit(false);
    }
  };

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
          Назад
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">{displayName(cp)}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>
              {TYPE_LABELS[cp.type] ?? cp.type}
            </Badge>
            {cp.vatPayer && <Badge variant="secondary">Платник ПДВ</Badge>}
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
          {fmtMoney(cp.balance)} ₴
          <p className="text-xs font-normal text-muted-foreground text-right">баланс</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {CRM_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Info */}
      {tab === 'info' && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Контактна інформація</h2>
            {!editing ? (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Редагувати
              </Button>
            ) : (
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setEditForm({
                      phone: cp.phone ?? '',
                      email: cp.email ?? '',
                      notes: cp.notes ?? '',
                      legalForm: cp.legalForm ?? '',
                      legalAddress: cp.legalAddress ?? '',
                      actualAddress: cp.actualAddress ?? '',
                      bankAccount: cp.bankAccount ?? '',
                      bankName: cp.bankName ?? '',
                      contactPerson: cp.contactPerson ?? '',
                      taxNumber: cp.taxNumber ?? '',
                    });
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" loading={savingEdit} onClick={saveEdit}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Зберегти
                </Button>
              </div>
            )}
          </div>

          {!editing ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Ім'я / Назва" value={displayName(cp)} />
                <Field label="Телефон" value={cp.phone} />
                <Field label="Email" value={cp.email} />
                <Field label="ЄДРПОУ" value={cp.edrpou} />
                <Field label="Нотатки" value={cp.notes} />
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
                        'Форма власності',
                        cp.legalForm ? (LEGAL_FORM_LABELS[cp.legalForm] ?? cp.legalForm) : null,
                      ],
                      ['Юр. адреса', cp.legalAddress],
                      ['Факт. адреса', cp.actualAddress],
                      ['IBAN', cp.bankAccount],
                      ['Банк', cp.bankName],
                      ['Контактна особа', cp.contactPerson],
                      ['ІПН', cp.taxNumber],
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
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Телефон"
                  value={editForm.phone}
                  onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+38 (067) 000-00-00"
                />
                <Input
                  label="Email"
                  type="email"
                  value={editForm.email}
                  onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="email@example.com"
                />
              </div>
              <Select
                label="Форма власності"
                value={editForm.legalForm}
                onChange={e => setEditForm(f => ({ ...f, legalForm: e.target.value }))}
              >
                <option value="">— Не вказано —</option>
                {Object.entries(LEGAL_FORM_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <Input
                label="ІПН / ЄДРПОУ"
                value={editForm.taxNumber}
                onChange={e => setEditForm(f => ({ ...f, taxNumber: e.target.value }))}
                placeholder="3456789012"
              />
              <Input
                label="Юридична адреса"
                value={editForm.legalAddress}
                onChange={e => setEditForm(f => ({ ...f, legalAddress: e.target.value }))}
                placeholder="вул. Хрещатик 1, Київ"
              />
              <Input
                label="Фактична адреса"
                value={editForm.actualAddress}
                onChange={e => setEditForm(f => ({ ...f, actualAddress: e.target.value }))}
                placeholder="вул. Хрещатик 1, Київ"
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="IBAN"
                  value={editForm.bankAccount}
                  onChange={e => setEditForm(f => ({ ...f, bankAccount: e.target.value }))}
                  placeholder="UA12 3456 7890 1234 5678 9012 3456 7"
                />
                <Input
                  label="Банк"
                  value={editForm.bankName}
                  onChange={e => setEditForm(f => ({ ...f, bankName: e.target.value }))}
                  placeholder="АТ КБ «ПриватБанк»"
                />
              </div>
              <Input
                label="Контактна особа"
                value={editForm.contactPerson}
                onChange={e => setEditForm(f => ({ ...f, contactPerson: e.target.value }))}
                placeholder="Іван Коваль"
              />
              <Input
                label="Нотатки"
                value={editForm.notes}
                onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Garages & Vehicles */}
      {tab === 'garages' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Гаражі та автомобілі</h2>
            <Button variant="ghost" size="sm" onClick={() => setShowAddGarage(v => !v)}>
              <Plus className="h-4 w-4 mr-1" />
              Гараж
            </Button>
          </div>

          {showAddGarage && (
            <AnimatedBody className="p-4 bg-secondary rounded-xl border border-border space-y-3">
              <Input
                label="Назва гаражу"
                required
                value={garageName}
                onChange={e => setGarageName(e.target.value)}
                placeholder="Основний гараж"
              />
              <Input
                label="Адреса (необов'язково)"
                value={garageAddress}
                onChange={e => setGarageAddress(e.target.value)}
                placeholder="вул. Шевченка 1"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={addGarage}
                  loading={savingGarage}
                  disabled={!garageName.trim()}
                >
                  Зберегти
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddGarage(false)}>
                  Скасувати
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
            <p className="text-sm text-muted-foreground text-center py-8">Немає гаражів</p>
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
                        Основний
                      </span>
                    )}
                    {garage.address && (
                      <span className="text-xs text-muted-foreground">· {garage.address}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {garageVehicles[garage.id]?.length ?? 0} авто
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
                        Автомобілі
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push(`/vehicles/new?garageId=${garage.id}`)}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Авто
                      </Button>
                    </div>
                    {!garageVehicles[garage.id] ? (
                      <div className="flex justify-center py-4">
                        <Spinner size="sm" />
                      </div>
                    ) : garageVehicles[garage.id].length === 0 ? (
                      <p className="text-sm text-muted-foreground px-4 py-3">Немає автомобілів</p>
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
                                      v.currentMileage ? `${fmtInt(v.currentMileage)} км` : null,
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
                                        <span>ТО: {s.maintenanceType}</span>
                                        {s.nextMaintenanceDate && (
                                          <span>· Наступне: {fmtDate(s.nextMaintenanceDate)}</span>
                                        )}
                                        {isSoon && (
                                          <span className="px-1.5 py-0.5 bg-warning-subtle text-warning rounded text-[11px] font-medium">
                                            ⚠ Скоро
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
              Додати договір
            </Button>
          </div>

          {/* Add contract form */}
          {showAddContract && (
            <div className="bg-surface rounded-xl border border-border p-4 space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Новий договір</h3>
              {/* Рядок 1: вид договору + checkbox Головний */}
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Вид договору{cp.type === 'BOTH' && <span className="text-destructive"> *</span>}
                  </label>
                  {cp.type === 'BOTH' ? (
                    <Select
                      value={contractForm.contractType}
                      onChange={e => setContractForm(f => ({ ...f, contractType: e.target.value }))}
                    >
                      <option value="">Оберіть вид</option>
                      <option value="PURCHASE">Купівля</option>
                      <option value="SALE">Продаж</option>
                    </Select>
                  ) : (
                    <div className="px-3 py-2 rounded-lg border border-border bg-secondary text-[13px] text-foreground">
                      {cp.type === 'CLIENT' ? 'Продаж' : 'Купівля'}
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
                  <span className="text-[13px] text-foreground whitespace-nowrap">Головний</span>
                </label>
              </div>
              {/* Рядок 2: дати */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Дата початку <span className="text-destructive">*</span>
                  </label>
                  <Input
                    type="date"
                    value={contractForm.startDate}
                    onChange={e => setContractForm(f => ({ ...f, startDate: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Дата завершення
                  </label>
                  <Input
                    type="date"
                    value={contractForm.endDate}
                    onChange={e => setContractForm(f => ({ ...f, endDate: e.target.value }))}
                  />
                </div>
              </div>
              {/* Рядок 3: валюта */}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Валюта</label>
                {currencies.length > 0 ? (
                  <select
                    value={contractForm.currencyCode || orgCurrency}
                    onChange={e => setContractForm(f => ({ ...f, currencyCode: e.target.value }))}
                    className="h-9 w-auto rounded-md border border-border bg-surface px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                    onChange={e => setContractForm(f => ({ ...f, currencyCode: e.target.value }))}
                    placeholder="UAH"
                    maxLength={10}
                    className="h-9 w-24 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                )}
              </div>
              {/* Рядок 4: фінансові поля */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Кредитний ліміт
                  </label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={contractForm.creditLimit}
                    onChange={e => setContractForm(f => ({ ...f, creditLimit: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Відтермінування (днів)
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
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowAddContract(false)}>
                  Скасувати
                </Button>
                <Button
                  size="sm"
                  loading={savingContract}
                  disabled={
                    !contractForm.startDate || (cp.type === 'BOTH' && !contractForm.contractType)
                  }
                  onClick={async () => {
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
                      setContractsError(e instanceof Error ? e.message : 'Помилка збереження');
                    } finally {
                      setSavingContract(false);
                    }
                  }}
                >
                  Зберегти
                </Button>
              </div>
            </div>
          )}

          {contractsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : contracts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Немає договорів</p>
          ) : (
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      Номер
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      Тип
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      Початок
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                      Завершення
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                      Кред. ліміт
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                      Відт., дн.
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
                              Головний
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {CONTRACT_TYPE_LABELS[c.contractType] ?? c.contractType}
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
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: `Видалити договір ${c.number}?`,
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
                                  e instanceof Error ? e.message : 'Помилка видалення',
                                );
                              }
                            }}
                          >
                            Видалити
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
              <p className="text-xs text-muted-foreground mb-0.5">Поточний баланс</p>
              <p
                className={cn(
                  'text-xl font-bold',
                  cp.balance < 0
                    ? 'text-destructive'
                    : cp.balance > 0
                      ? 'text-success'
                      : 'text-muted-foreground',
                )}
              >
                {fmtMoney(cp.balance)} ₴
              </p>
            </div>
          </div>

          {settlementsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Немає транзакцій</p>
          ) : (
            <div className="bg-surface rounded-xl border border-border divide-y divide-border overflow-hidden">
              {transactions.map(t => (
                <div key={t.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm text-foreground">{t.notes ?? t.documentType ?? t.type}</p>
                    <p className="text-xs text-muted-foreground">{fmtDate(t.createdAt)}</p>
                  </div>
                  <span
                    className={cn(
                      'text-sm font-semibold',
                      ['PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'].includes(t.type)
                        ? 'text-success'
                        : 'text-destructive-text',
                    )}
                  >
                    {['PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'].includes(t.type)
                      ? '-'
                      : '+'}
                    {fmtMoney(Math.abs(t.amount))} ₴
                  </span>
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
            <p className="text-sm text-muted-foreground text-center py-8">Немає нарядів</p>
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
                        {WO_STATUS_LABELS[wo.status] ?? wo.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {wo.vehicleSummary ?? '—'} · {fmtDate(wo.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground">
                      {fmtMoney(wo.totalAmount)} ₴
                    </p>
                    <span className="text-muted-foreground text-sm">→</span>
                  </div>
                </button>
              ))}
            </div>
          )}
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
                <h3 className="font-medium text-foreground text-sm">Гарантії</h3>
                <span className="text-xs text-muted-foreground">{warranties.length} записів</span>
              </div>
              {warranties.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-[13px]">
                  Гарантій немає
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
                          Наряд №{w.workOrderNumber ?? w.workOrderId.slice(0, 8)}
                        </div>
                        {w.description && (
                          <div className="text-[12px] text-muted-foreground">{w.description}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[12px] text-muted-foreground">
                          до {fmtDate(w.expiresAt)}
                        </div>
                        {w.isActive ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-success/10 text-success">
                            Активна
                          </span>
                        ) : w.claimedAt ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-warning/10 text-warning">
                            {"Пред'явлена"}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground">
                            Закінчилась
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
                  <div className="text-[13px] text-muted-foreground">Бали лояльності</div>
                  <div className="text-2xl font-bold text-foreground">
                    {fmtInt(loyaltyBalance)} балів
                  </div>
                </div>
                <div className="flex gap-2 items-center">
                  <Input
                    value={redeemPoints}
                    onChange={e => setRedeemPoints(e.target.value)}
                    placeholder="Кількість балів"
                    type="number"
                    min="0"
                    className="w-36"
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
                    onClick={async () => {
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
                        setLoyaltyError(e instanceof Error ? e.message : 'Помилка списання');
                      } finally {
                        setRedeemSaving(false);
                      }
                    }}
                  >
                    Списати
                  </Button>
                </div>
              </div>

              {/* Transaction history */}
              {loyaltyTxs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">Немає транзакцій</p>
              ) : (
                <div className="divide-y divide-border max-h-60 overflow-y-auto">
                  {loyaltyTxs.map(t => (
                    <div key={t.id} className="flex items-center justify-between py-2 text-[12px]">
                      <span className="text-muted-foreground">{fmtDate(t.createdAt)}</span>
                      <span className="text-foreground flex-1 px-3 truncate">
                        {t.notes ?? (t.type === 'EARN' ? 'Нарахування балів' : 'Списання балів')}
                      </span>
                      <span
                        className={cn(
                          'font-medium',
                          t.type === 'EARN' ? 'text-success' : 'text-destructive',
                        )}
                      >
                        {t.type === 'EARN' ? '+' : '-'}
                        {t.points}
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
