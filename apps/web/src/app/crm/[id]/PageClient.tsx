'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Pencil, Check, X } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Counterparty {
  id: string; type: string; firstName: string | null; lastName: string | null;
  companyName: string | null; phone: string | null; email: string | null;
  edrpou: string | null; vatPayer: boolean; balance: number; notes: string | null;
  legalForm?: string | null; legalAddress?: string | null; actualAddress?: string | null;
  bankAccount?: string | null; bankName?: string | null; contactPerson?: string | null;
  taxNumber?: string | null;
}
interface Garage { id: string; name: string; address: string | null; isDefault: boolean; }
interface Vehicle {
  id: string; make: string; model: string; licensePlate: string | null;
  year: number | null; currentMileage: number | null;
  transmissionType?: string | null; driveType?: string | null; bodyType?: string | null;
  engineCode?: string | null; insuranceExpiry?: string | null; inspectionExpiry?: string | null;
}
interface MaintenanceSchedule {
  id: string; vehicleId: string;
  maintenanceType: string;
  intervalDays?: number | null; intervalMileage?: number | null;
  lastMaintenanceDate?: string | null; lastMaintenanceMileage?: number | null;
  nextMaintenanceDate?: string | null; nextMaintenanceMileage?: number | null;
  isActive: boolean; notes?: string | null;
}
interface Transaction { id: string; type: string; amount: number; description: string | null; createdAt: string; }
interface WorkOrder { id: string; number: string; status: string; vehicleMake: string; vehicleModel: string; createdAt: string; totalAmount: number; }

type CrmTab = 'info' | 'garages' | 'settlements' | 'work-orders';

const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', SUPPLIER: 'Постачальник', BOTH: 'Клієнт / Постачальник' };
const LEGAL_FORM_LABELS: Record<string, string> = {
  INDIVIDUAL: 'Фіз. особа', FOP: 'ФОП', TOV: 'ТОВ', AT: 'АТ', PP: 'ПП', OTHER: 'Інше',
};
const TYPE_BADGE: Record<string, BadgeVariant> = { CLIENT: 'default', SUPPLIER: 'secondary', BOTH: 'warning' };

const WO_STATUS_LABELS: Record<string, string> = {
  NEW: 'Новий', IN_PROGRESS: 'В роботі', DONE: 'Готовий',
  CLOSED: 'Закрито', CANCELLED: 'Скасовано',
};
const WO_STATUS_COLORS: Record<string, string> = {
  NEW: 'bg-info-subtle text-info', IN_PROGRESS: 'bg-warning-subtle text-warning',
  DONE: 'bg-success-subtle text-success', CLOSED: 'bg-secondary text-muted-foreground',
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

  const [cp, setCp] = useState<Counterparty | null>(null);
  const [tab, setTab] = useState<CrmTab>('info');
  const [loadError, setLoadError] = useState('');
  const [todayMs, setTodayMs] = useState(0);

  useEffect(() => { setTodayMs(Date.now()); }, []);

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

  // Editing info
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    phone: '', email: '', notes: '',
    legalForm: '', legalAddress: '', actualAddress: '',
    bankAccount: '', bankName: '', contactPerson: '', taxNumber: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const loadCp = useCallback(() => {
    apiFetch<Counterparty>(`/counterparties/${id}`)
      .then(c => {
        setCp(c);
        setEditForm({
          phone: c.phone ?? '', email: c.email ?? '', notes: c.notes ?? '',
          legalForm: c.legalForm ?? '', legalAddress: c.legalAddress ?? '',
          actualAddress: c.actualAddress ?? '', bankAccount: c.bankAccount ?? '',
          bankName: c.bankName ?? '', contactPerson: c.contactPerson ?? '',
          taxNumber: c.taxNumber ?? '',
        });
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка завантаження'));
  }, [id]);

  const loadGarages = useCallback(() => {
    setGaragesLoading(true);
    apiFetch<Garage[]>(`/counterparties/${id}/garages`)
      .then(g => {
        setGarages(g);
        // Expand all garages by default
        setExpandedGarages(new Set(g.map(garage => garage.id)));
        // Load vehicles for each garage + maintenance schedules in parallel
        g.forEach(garage => {
          apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${garage.id}`)
            .then(vehicles => {
              setGarageVehicles(prev => ({ ...prev, [garage.id]: vehicles }));
              // Fetch maintenance schedules per vehicle (API only supports single vehicleId)
              Promise.all(
                vehicles.map(v =>
                  apiFetch<MaintenanceSchedule[]>(`/maintenance-schedules?vehicleId=${v.id}`)
                    .catch(() => [] as MaintenanceSchedule[])
                ),
              ).then(results => {
                const schedules = results.flat();
                if (schedules.length > 0) {
                  setMaintenanceSchedules(prev => {
                    const vehicleIds = new Set(vehicles.map(v => v.id));
                    return [...prev.filter(s => !vehicleIds.has(s.vehicleId)), ...schedules];
                  });
                }
              });
            })
            .catch(() => setGarageVehicles(prev => ({ ...prev, [garage.id]: [] })));
        });
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка гаражів'))
      .finally(() => setGaragesLoading(false));
  }, [id]);

  const loadSettlements = useCallback(() => {
    setSettlementsLoading(true);
    apiFetch<Transaction[]>(`/settlements?counterpartyId=${id}&limit=50`)
      .then(setTransactions)
      .catch(() => setTransactions([]))
      .finally(() => setSettlementsLoading(false));
  }, [id]);

  const loadWorkOrders = useCallback(() => {
    setWoLoading(true);
    apiFetch<{ items: WorkOrder[] }>(`/work-orders?counterpartyId=${id}&limit=50`)
      .then(r => setWorkOrders(r.items ?? []))
      .catch(() => setWorkOrders([]))
      .finally(() => setWoLoading(false));
  }, [id]);

  useEffect(() => { loadCp(); }, [loadCp]);

  useEffect(() => {
    if (tab === 'garages') loadGarages();
    if (tab === 'settlements') loadSettlements();
    if (tab === 'work-orders') loadWorkOrders();
  }, [tab, loadGarages, loadSettlements, loadWorkOrders]);

  const addGarage = async () => {
    if (!garageName.trim()) return;
    setSavingGarage(true);
    try {
      await apiFetch<Garage>(`/counterparties/${id}/garages`, {
        method: 'POST',
        body: JSON.stringify({ name: garageName.trim(), address: garageAddress.trim() || undefined }),
      });
      setGarageName(''); setGarageAddress(''); setShowAddGarage(false);
      loadGarages();
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSavingGarage(false); }
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
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSavingEdit(false); }
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

  if (!cp) return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      {loadError
        ? <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">{loadError}</p>
        : <Spinner size="lg" />}
    </div>
  );

  const CRM_TABS: { key: CrmTab; label: string }[] = [
    { key: 'info', label: 'Загальна інформація' },
    { key: 'garages', label: 'Гаражі та авто' },
    { key: 'settlements', label: 'Взаєморозрахунки' },
    { key: 'work-orders', label: 'Наряди' },
  ];

  return (
    <div className="page-container max-w-4xl space-y-6">
      {loadError && (
        <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">{loadError}</div>
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
        <div className={cn(
          'text-lg font-semibold',
          cp.balance < 0 ? 'text-destructive' : cp.balance > 0 ? 'text-success' : 'text-muted-foreground'
        )}>
          {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
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
                <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setEditForm({ phone: cp.phone ?? '', email: cp.email ?? '', notes: cp.notes ?? '', legalForm: cp.legalForm ?? '', legalAddress: cp.legalAddress ?? '', actualAddress: cp.actualAddress ?? '', bankAccount: cp.bankAccount ?? '', bankName: cp.bankName ?? '', contactPerson: cp.contactPerson ?? '', taxNumber: cp.taxNumber ?? '' }); }}>
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
              {(cp.legalForm || cp.legalAddress || cp.actualAddress || cp.bankAccount || cp.bankName || cp.contactPerson || cp.taxNumber) && (
                <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 gap-x-6 gap-y-2">
                  {([
                    ['Форма власності', cp.legalForm ? (LEGAL_FORM_LABELS[cp.legalForm] ?? cp.legalForm) : null],
                    ['Юр. адреса', cp.legalAddress],
                    ['Факт. адреса', cp.actualAddress],
                    ['IBAN', cp.bankAccount],
                    ['Банк', cp.bankName],
                    ['Контактна особа', cp.contactPerson],
                    ['ІПН', cp.taxNumber],
                  ] as [string, string | null | undefined][]).filter(([, v]) => v).map(([label, value]) => (
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
                  <option key={k} value={k}>{v}</option>
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
            <div className="p-4 bg-secondary rounded-xl border border-border space-y-3">
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
                <Button size="sm" onClick={addGarage} loading={savingGarage} disabled={!garageName.trim()}>
                  Зберегти
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddGarage(false)}>
                  Скасувати
                </Button>
              </div>
            </div>
          )}

          {garagesLoading && (
            <div className="flex justify-center py-8"><Spinner size="md" /></div>
          )}

          {!garagesLoading && garages.length === 0 && !showAddGarage && (
            <p className="text-sm text-muted-foreground text-center py-8">Немає гаражів</p>
          )}

          {!garagesLoading && garages.map(garage => (
            <div key={garage.id} className="bg-surface rounded-xl border border-border overflow-hidden">
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
                  <span className={cn('text-muted-foreground transition-transform', expandedGarages.has(garage.id) && 'rotate-180')}>▾</span>
                </div>
              </button>

              {expandedGarages.has(garage.id) && (
                <div className="border-t border-border">
                  <div className="flex items-center justify-between px-4 py-2 bg-secondary/50">
                    <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">Автомобілі</span>
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
                    <div className="flex justify-center py-4"><Spinner size="sm" /></div>
                  ) : garageVehicles[garage.id].length === 0 ? (
                    <p className="text-sm text-muted-foreground px-4 py-3">Немає автомобілів</p>
                  ) : (
                    <div>
                      {garageVehicles[garage.id].map(v => {
                        const techParts = [v.transmissionType, v.driveType, v.bodyType].filter(Boolean);
                        const vSchedules = maintenanceSchedules.filter(s => s.vehicleId === v.id && s.isActive);
                        return (
                          <div key={v.id} className="px-4 py-3 border-b border-border last:border-0">
                            <button
                              onClick={() => router.push(`/vehicles/${v.id}`)}
                              className="w-full flex items-center justify-between text-left"
                            >
                              <div>
                                <p className="text-sm font-medium text-foreground">{v.make} {v.model}</p>
                                <p className="text-xs text-muted-foreground">
                                  {[v.licensePlate, v.year, v.currentMileage ? `${v.currentMileage.toLocaleString()} км` : null].filter(Boolean).join(' · ')}
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
                                {(() => {
                                  return vSchedules.map(s => {
                                  const nextDate = s.nextMaintenanceDate
                                    ? new Date(s.nextMaintenanceDate)
                                    : null;
                                  const daysUntil = (nextDate && todayMs > 0)
                                    ? Math.ceil((nextDate.getTime() - todayMs) / 86_400_000)
                                    : null;
                                  const isSoon = daysUntil !== null && daysUntil <= 30;
                                  return (
                                    <div key={s.id} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                      <span>ТО: {s.maintenanceType}</span>
                                      {nextDate && (
                                        <span>· Наступне: {nextDate.toLocaleDateString('uk-UA')}</span>
                                      )}
                                      {isSoon && (
                                        <span className="px-1.5 py-0.5 bg-warning-subtle text-warning rounded text-[11px] font-medium">
                                          ⚠ Скоро
                                        </span>
                                      )}
                                    </div>
                                  );
                                  });
                                })()}
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

      {/* Tab 3: Settlements */}
      {tab === 'settlements' && (
        <div className="space-y-4">
          <div className="bg-surface rounded-xl border border-border p-4 flex items-center gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Поточний баланс</p>
              <p className={cn(
                'text-xl font-bold',
                cp.balance < 0 ? 'text-destructive' : cp.balance > 0 ? 'text-success' : 'text-muted-foreground',
              )}>
                {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
              </p>
            </div>
          </div>

          {settlementsLoading ? (
            <div className="flex justify-center py-8"><Spinner size="md" /></div>
          ) : transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Немає транзакцій</p>
          ) : (
            <div className="bg-surface rounded-xl border border-border divide-y divide-border overflow-hidden">
              {transactions.map(t => (
                <div key={t.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm text-foreground">{t.description ?? t.type}</p>
                    <p className="text-xs text-muted-foreground">{new Date(t.createdAt).toLocaleDateString('uk-UA')}</p>
                  </div>
                  <span className={cn(
                    'text-sm font-semibold',
                    t.type === 'PAYMENT' ? 'text-success' : 'text-destructive',
                  )}>
                    {t.type === 'PAYMENT' ? '+' : '-'}{Math.abs(t.amount).toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
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
            <div className="flex justify-center py-8"><Spinner size="md" /></div>
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
                      <span className={cn('text-[11px] px-1.5 py-0.5 rounded', WO_STATUS_COLORS[wo.status] ?? 'bg-secondary text-muted-foreground')}>
                        {WO_STATUS_LABELS[wo.status] ?? wo.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {wo.vehicleMake} {wo.vehicleModel} · {new Date(wo.createdAt).toLocaleDateString('uk-UA')}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground">
                      {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                    </p>
                    <span className="text-muted-foreground text-sm">→</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
