'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import {
  WO_STATUS_LABELS,
  WO_STATUS_BADGE,
  COUNTERPARTY_TYPE_LABELS,
  CONTRACT_TYPE_LABELS,
} from '@sto/shared';
import { useRouter } from 'next/navigation';

// ─── Types ────────────────────────────────────────────────────────────────────

import type { CpType } from '@/hooks/api/useCounterparties';

export type { CpType };

export interface CounterpartyForModal {
  id: string;
  type: CpType;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  edrpou?: string | null;
  vatPayer: boolean;
  notes?: string | null;
  contactPerson?: string | null;
}

type Vehicle = {
  id: string;
  make: string;
  model: string;
  year: number | null;
  licensePlate: string;
};

type ModalWorkOrder = {
  id: string;
  number: string;
  status: string;
  totalAmount: number;
  createdAt: string;
  vehicleSummary?: string | null;
};

type ModalContract = {
  id: string;
  number: string;
  contractType: 'PURCHASE' | 'SALE';
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  creditLimit: number | null;
  paymentDeferDays: number | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
const kyivToday = () => KYIV_YMD.format(new Date());

const TYPE_LABELS = COUNTERPARTY_TYPE_LABELS;

// ─── Props ────────────────────────────────────────────────────────────────────

interface CounterpartyEditModalProps {
  open: boolean;
  /** null = create new */
  counterparty: CounterpartyForModal | null;
  onClose: () => void;
  onSaved: (cp: CounterpartyForModal) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CounterpartyEditModal({
  open,
  counterparty,
  onClose,
  onSaved,
}: CounterpartyEditModalProps) {
  const router = useRouter();
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();
  const dirty = useDirtyForm();

  const isEdit = !!counterparty;

  // ── Form ─────────────────────────────────────────────────────────────────────
  const [editTab, setEditTab] = useState<'main' | 'vehicles' | 'contracts' | 'work-orders'>('main');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    type: 'CLIENT',
    firstName: '',
    lastName: '',
    companyName: '',
    phone: '',
    email: '',
    edrpou: '',
    vatPayer: false,
    notes: '',
    contactPerson: '',
  });

  // Sync form when counterparty changes (open edit)
  useEffect(() => {
    if (open) {
      setEditTab('main');
      setError('');
      dirty.resetDirty();
      if (counterparty) {
        setForm({
          type: counterparty.type,
          firstName: counterparty.firstName ?? '',
          lastName: counterparty.lastName ?? '',
          companyName: counterparty.companyName ?? '',
          phone: counterparty.phone ?? '',
          email: counterparty.email ?? '',
          edrpou: counterparty.edrpou ?? '',
          vatPayer: counterparty.vatPayer,
          notes: counterparty.notes ?? '',
          contactPerson: counterparty.contactPerson ?? '',
        });
      } else {
        setForm({
          type: 'CLIENT',
          firstName: '',
          lastName: '',
          companyName: '',
          phone: '',
          email: '',
          edrpou: '',
          vatPayer: false,
          notes: '',
          contactPerson: '',
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, counterparty?.id]);

  // ── Vehicles ─────────────────────────────────────────────────────────────────
  const [modalVehicles, setModalVehicles] = useState<Vehicle[]>([]);
  const [modalVehiclesLoading, setModalVehiclesLoading] = useState(false);
  const [modalGarageId, setModalGarageId] = useState<string | null>(null);
  const [vehiclesError, setVehiclesError] = useState('');
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [deletingVehicleId, setDeletingVehicleId] = useState<string | null>(null);
  const [addVehicleForm, setAddVehicleForm] = useState({
    make: '',
    model: '',
    year: '',
    licensePlate: '',
    vin: '',
  });
  const modalVehiclesReqRef = useRef(0);

  // ── Work Orders ──────────────────────────────────────────────────────────────
  const [modalWorkOrders, setModalWorkOrders] = useState<ModalWorkOrder[]>([]);
  const [modalWorkOrdersLoading, setModalWorkOrdersLoading] = useState(false);
  const [woError, setWoError] = useState('');
  const modalWoReqRef = useRef(0);

  // ── Contracts ────────────────────────────────────────────────────────────────
  const [modalContracts, setModalContracts] = useState<ModalContract[]>([]);
  const [modalContractsLoading, setModalContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState('');
  const [showAddContract, setShowAddContract] = useState(false);
  const [addingContract, setAddingContract] = useState(false);
  const [addContractForm, setAddContractForm] = useState({
    contractType: '',
    startDate: kyivToday(),
    endDate: '',
    creditLimit: '',
    paymentDeferDays: '',
    isPrimary: false,
  });
  const modalContractsReqRef = useRef(0);

  // Load related data when modal opens for an existing counterparty
  useEffect(() => {
    if (!open || !counterparty) return;

    const vReqId = ++modalVehiclesReqRef.current;
    const woReqId = ++modalWoReqRef.current;
    const cReqId = ++modalContractsReqRef.current;

    setModalVehicles([]);
    setModalWorkOrders([]);
    setModalContracts([]);
    setVehiclesError('');
    setWoError('');
    setContractsError('');
    setShowAddVehicle(false);
    setShowAddContract(false);

    setModalVehiclesLoading(true);
    apiFetch<{ id: string }[]>(`/counterparties/${counterparty.id}/garages`)
      .then(garages => {
        if (modalVehiclesReqRef.current !== vReqId) return [] as Vehicle[][];
        const defaultGarage = garages[0];
        if (defaultGarage) setModalGarageId(defaultGarage.id);
        return Promise.all(
          garages.map(g => apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}&limit=50`)),
        );
      })
      .then(results => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehicles(results.flat());
      })
      .catch(err => {
        if (modalVehiclesReqRef.current === vReqId)
          setVehiclesError(err instanceof Error ? err.message : 'Помилка завантаження авто');
      })
      .finally(() => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehiclesLoading(false);
      });

    setModalWorkOrdersLoading(true);
    apiFetch<{ items: ModalWorkOrder[] }>(`/work-orders?counterpartyId=${counterparty.id}&limit=50`)
      .then(data => {
        if (modalWoReqRef.current === woReqId) setModalWorkOrders(data.items);
      })
      .catch(err => {
        if (modalWoReqRef.current === woReqId)
          setWoError(err instanceof Error ? err.message : 'Помилка завантаження нарядів');
      })
      .finally(() => {
        if (modalWoReqRef.current === woReqId) setModalWorkOrdersLoading(false);
      });

    setModalContractsLoading(true);
    apiFetch<ModalContract[]>(`/counterparties/${counterparty.id}/contracts`)
      .then(items => {
        if (modalContractsReqRef.current === cReqId) setModalContracts(items ?? []);
      })
      .catch(err => {
        if (modalContractsReqRef.current === cReqId)
          setContractsError(err instanceof Error ? err.message : 'Помилка завантаження договорів');
      })
      .finally(() => {
        if (modalContractsReqRef.current === cReqId) setModalContractsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, counterparty?.id]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    onClose();
  }, [dirty, onClose]);

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const created = await apiFetch<CounterpartyForModal>('/counterparties', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
          vatPayer: form.vatPayer || undefined,
          notes: form.notes || undefined,
          contactPerson: form.contactPerson || undefined,
        }),
      });
      dirty.resetDirty();
      onSaved(created);
      toast.success('Контрагента створено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const update = async () => {
    if (!counterparty) return;
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<CounterpartyForModal>(`/counterparties/${counterparty.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          type: form.type,
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
          vatPayer: form.vatPayer || undefined,
          notes: form.notes || undefined,
          contactPerson: form.contactPerson || undefined,
        }),
      });
      dirty.resetDirty();
      onSaved(updated);
      toast.success('Контрагента збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const addVehicle = async () => {
    if (!modalGarageId || !addVehicleForm.make || !addVehicleForm.model) return;
    setAddingVehicle(true);
    try {
      const created = await apiFetch<Vehicle>('/vehicles', {
        method: 'POST',
        body: JSON.stringify({
          customerGarageId: modalGarageId,
          make: addVehicleForm.make,
          model: addVehicleForm.model,
          year: addVehicleForm.year ? Number(addVehicleForm.year) : undefined,
          licensePlate: addVehicleForm.licensePlate || undefined,
          vin: addVehicleForm.vin || undefined,
        }),
      });
      setModalVehicles(v => [...v, created]);
      setAddVehicleForm({ make: '', model: '', year: '', licensePlate: '', vin: '' });
      setShowAddVehicle(false);
      toast.success('Авто додано');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setAddingVehicle(false);
    }
  };

  const deleteVehicle = async (id: string) => {
    if (!(await confirm({ title: 'Видалити авто?', variant: 'destructive' }))) return;
    setDeletingVehicleId(id);
    try {
      await apiFetch(`/vehicles/${id}`, { method: 'DELETE' });
      setModalVehicles(v => v.filter(x => x.id !== id));
      toast.success('Авто видалено');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setDeletingVehicleId(null);
    }
  };

  const addContract = async () => {
    if (!counterparty) return;
    setAddingContract(true);
    setContractsError('');
    try {
      const resolvedType =
        counterparty.type === 'CLIENT'
          ? 'SALE'
          : counterparty.type === 'SUPPLIER'
            ? 'PURCHASE'
            : addContractForm.contractType;
      const created = await apiFetch<ModalContract>(
        `/counterparties/${counterparty.id}/contracts`,
        {
          method: 'POST',
          body: JSON.stringify({
            contractType: resolvedType,
            startDate: addContractForm.startDate,
            endDate: addContractForm.endDate || undefined,
            creditLimit: addContractForm.creditLimit
              ? Number(addContractForm.creditLimit)
              : undefined,
            paymentDeferDays: addContractForm.paymentDeferDays
              ? Number(addContractForm.paymentDeferDays)
              : undefined,
            isPrimary: addContractForm.isPrimary || undefined,
          }),
        },
      );
      setModalContracts(prev => [...prev, created]);
      setAddContractForm({
        contractType: '',
        startDate: '',
        endDate: '',
        creditLimit: '',
        paymentDeferDays: '',
        isPrimary: false,
      });
      setShowAddContract(false);
      toast.success('Договір додано');
    } catch (e: unknown) {
      setContractsError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setAddingContract(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={isEdit ? 'Редагування контрагента' : 'Новий контрагент'}
        size={isEdit ? 'lg' : 'md'}
        bodyMinHeight={isEdit ? 340 : undefined}
        footer={
          editTab === 'main' ? (
            <Button onClick={isEdit ? update : create} loading={saving}>
              {isEdit ? 'Оновити' : 'Зберегти'}
            </Button>
          ) : null
        }
      >
        {/* Tabs — only in edit mode */}
        {isEdit && (
          <div className="flex gap-0 border-b border-border -mx-6 px-6 mb-5 overflow-x-auto">
            {(
              [
                { key: 'main', label: 'Основне' },
                { key: 'vehicles', label: 'Авто', count: modalVehicles.length },
                { key: 'contracts', label: 'Договори', count: modalContracts.length },
                { key: 'work-orders', label: 'Історія', count: modalWorkOrders.length },
              ] as { key: typeof editTab; label: string; count?: number }[]
            ).map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setEditTab(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
                  editTab === tab.key
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground',
                )}
              >
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="inline-flex items-center justify-center min-w-4.5 h-4.5 px-1 rounded-full text-[11px] font-semibold bg-secondary text-muted-foreground">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── Tab: Main ─────────────────────────────────────────────────────────── */}
        {(!isEdit || editTab === 'main') && (
          <div key="tab-main" data-animate data-state="open" data-variant="content">
            {error && (
              <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div className="space-y-4">
              <Select
                label="Тип"
                required
                value={form.type}
                onChange={e => {
                  setForm(f => ({ ...f, type: e.target.value }));
                  dirty.markDirty();
                }}
              >
                {Object.entries(TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>

              {form.type !== 'SUPPLIER' && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Ім'я"
                    value={form.firstName}
                    onChange={e => {
                      setForm(f => ({ ...f, firstName: e.target.value }));
                      dirty.markDirty();
                    }}
                    placeholder="Іван"
                  />
                  <Input
                    label="Прізвище"
                    value={form.lastName}
                    onChange={e => {
                      setForm(f => ({ ...f, lastName: e.target.value }));
                      dirty.markDirty();
                    }}
                    placeholder="Коваль"
                  />
                </div>
              )}

              <Input
                label="Назва компанії"
                value={form.companyName}
                onChange={e => {
                  setForm(f => ({ ...f, companyName: e.target.value }));
                  dirty.markDirty();
                }}
                placeholder="ТОВ «Авто»"
              />
              <Input
                label="Телефон"
                value={form.phone}
                onChange={e => {
                  setForm(f => ({ ...f, phone: e.target.value }));
                  dirty.markDirty();
                }}
                placeholder="+38 (067) 123-45-67"
              />
              <Input
                label="Email"
                type="email"
                value={form.email}
                onChange={e => {
                  setForm(f => ({ ...f, email: e.target.value }));
                  dirty.markDirty();
                }}
              />
              <Input
                label="ЄДРПОУ"
                value={form.edrpou}
                onChange={e => {
                  setForm(f => ({ ...f, edrpou: e.target.value }));
                  dirty.markDirty();
                }}
                placeholder="12345678"
              />
              <Input
                label="Контактна особа"
                value={form.contactPerson}
                onChange={e => {
                  setForm(f => ({ ...f, contactPerson: e.target.value }));
                  dirty.markDirty();
                }}
                placeholder="Петро Іваненко"
              />
              <Input
                label="Нотатки"
                value={form.notes}
                onChange={e => {
                  setForm(f => ({ ...f, notes: e.target.value }));
                  dirty.markDirty();
                }}
              />
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.vatPayer}
                  onChange={e => {
                    setForm(f => ({ ...f, vatPayer: e.target.checked }));
                    dirty.markDirty();
                  }}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <span className="text-sm text-foreground">Платник ПДВ</span>
              </label>
            </div>
          </div>
        )}

        {/* ── Tab: Vehicles ────────────────────────────────────────────────────── */}
        {isEdit && editTab === 'vehicles' && (
          <div
            key="tab-vehicles"
            data-animate
            data-state="open"
            data-variant="content"
            className="space-y-3 min-h-64"
          >
            {modalVehiclesLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Завантаження...</div>
            )}
            {!modalVehiclesLoading && vehiclesError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {vehiclesError}
              </div>
            )}
            {!modalVehiclesLoading && !vehiclesError && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-muted-foreground">
                    {modalVehicles.length} авто
                  </span>
                  {!showAddVehicle && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => setShowAddVehicle(true)}
                    >
                      Додати авто
                    </Button>
                  )}
                </div>
                {showAddVehicle && (
                  <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Марка"
                        required
                        value={addVehicleForm.make}
                        onChange={e => setAddVehicleForm(f => ({ ...f, make: e.target.value }))}
                        placeholder="Toyota"
                      />
                      <Input
                        label="Модель"
                        required
                        value={addVehicleForm.model}
                        onChange={e => setAddVehicleForm(f => ({ ...f, model: e.target.value }))}
                        placeholder="Camry"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        label="Рік"
                        type="number"
                        value={addVehicleForm.year}
                        onChange={e => setAddVehicleForm(f => ({ ...f, year: e.target.value }))}
                        placeholder="2020"
                      />
                      <Input
                        label="Держномер"
                        value={addVehicleForm.licensePlate}
                        onChange={e =>
                          setAddVehicleForm(f => ({ ...f, licensePlate: e.target.value }))
                        }
                        placeholder="АА 1234 ВС"
                      />
                      <Input
                        label="VIN"
                        value={addVehicleForm.vin}
                        onChange={e => setAddVehicleForm(f => ({ ...f, vin: e.target.value }))}
                        placeholder="WVWZZZ1JZXW000001"
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setShowAddVehicle(false);
                          setAddVehicleForm({
                            make: '',
                            model: '',
                            year: '',
                            licensePlate: '',
                            vin: '',
                          });
                        }}
                      >
                        Скасувати
                      </Button>
                      <Button
                        size="sm"
                        onClick={addVehicle}
                        loading={addingVehicle}
                        disabled={!addVehicleForm.make || !addVehicleForm.model}
                      >
                        Зберегти
                      </Button>
                    </div>
                  </AnimatedBody>
                )}
                {modalVehicles.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead className="bg-secondary border-b border-border">
                        <tr>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Марка / Модель
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Держномер
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Рік
                          </th>
                          <th className="w-16" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalVehicles.map(v => (
                          <tr
                            key={v.id}
                            className="bg-surface hover:bg-secondary/50 transition-colors"
                          >
                            <td className="px-3 py-2 font-medium text-foreground">
                              {v.make} {v.model}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {v.licensePlate || '—'}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{v.year ?? '—'}</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => deleteVehicle(v.id)}
                                disabled={deletingVehicleId === v.id}
                                className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                                title="Видалити"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {modalVehicles.length === 0 && !showAddVehicle && (
                  <p className="text-[13px] text-muted-foreground text-center py-8">
                    Авто не додано
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Tab: Contracts ───────────────────────────────────────────────────── */}
        {isEdit && editTab === 'contracts' && (
          <div
            key="tab-contracts"
            data-animate
            data-state="open"
            data-variant="content"
            className="space-y-3 min-h-64"
          >
            {contractsError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {contractsError}
              </div>
            )}
            {modalContractsLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Завантаження...</div>
            )}
            {!modalContractsLoading && !contractsError && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-muted-foreground">
                    {modalContracts.length} договор{modalContracts.length === 1 ? '' : 'ів'}
                  </span>
                  {!showAddContract && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => setShowAddContract(true)}
                    >
                      Додати договір
                    </Button>
                  )}
                </div>
                {showAddContract && counterparty && (
                  <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                    <div className="flex items-end gap-3">
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Вид договору
                          {counterparty.type === 'BOTH' && (
                            <span className="text-destructive"> *</span>
                          )}
                        </label>
                        {counterparty.type === 'BOTH' ? (
                          <Select
                            value={addContractForm.contractType}
                            onChange={e =>
                              setAddContractForm(f => ({ ...f, contractType: e.target.value }))
                            }
                          >
                            <option value="">Оберіть вид</option>
                            <option value="PURCHASE">Купівля</option>
                            <option value="SALE">Продаж</option>
                          </Select>
                        ) : (
                          <div className="px-3 py-2 rounded-lg border border-border bg-secondary text-[13px] text-foreground">
                            {counterparty.type === 'CLIENT' ? 'Продаж' : 'Купівля'}
                          </div>
                        )}
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer select-none pb-2">
                        <input
                          type="checkbox"
                          checked={addContractForm.isPrimary}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, isPrimary: e.target.checked }))
                          }
                          className="h-4 w-4 rounded border-border accent-primary"
                        />
                        <span className="text-[13px] text-foreground whitespace-nowrap">
                          Головний
                        </span>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Дата початку <span className="text-destructive">*</span>
                        </label>
                        <Input
                          type="date"
                          value={addContractForm.startDate}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, startDate: e.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Дата завершення
                        </label>
                        <Input
                          type="date"
                          value={addContractForm.endDate}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, endDate: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Кредитний ліміт (₴)
                        </label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0"
                          value={addContractForm.creditLimit}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, creditLimit: e.target.value }))
                          }
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
                          value={addContractForm.paymentDeferDays}
                          onChange={e =>
                            setAddContractForm(f => ({
                              ...f,
                              paymentDeferDays: String(Math.floor(Number(e.target.value))),
                            }))
                          }
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setShowAddContract(false);
                          setAddContractForm({
                            contractType: '',
                            startDate: '',
                            endDate: '',
                            creditLimit: '',
                            paymentDeferDays: '',
                            isPrimary: false,
                          });
                        }}
                      >
                        Скасувати
                      </Button>
                      <Button
                        size="sm"
                        loading={addingContract}
                        disabled={
                          !addContractForm.startDate ||
                          (counterparty.type === 'BOTH' && !addContractForm.contractType)
                        }
                        onClick={addContract}
                      >
                        Зберегти
                      </Button>
                    </div>
                  </AnimatedBody>
                )}
                {modalContracts.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead className="bg-secondary border-b border-border">
                        <tr>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Номер
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Тип
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Початок
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            Завершення
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalContracts.map(c => (
                          <tr
                            key={c.id}
                            className="bg-surface hover:bg-secondary/50 transition-colors"
                          >
                            <td className="px-3 py-2 font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {c.number}
                                {c.isPrimary && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                                    Головний
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {CONTRACT_TYPE_LABELS[c.contractType] ?? c.contractType}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {fmtDate(c.startDate)}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {c.endDate ? fmtDate(c.endDate) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {modalContracts.length === 0 && !showAddContract && (
                  <p className="text-[13px] text-muted-foreground text-center py-8">
                    Договорів немає
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Tab: Work Orders ─────────────────────────────────────────────────── */}
        {isEdit && editTab === 'work-orders' && (
          <div
            key="tab-work-orders"
            data-animate
            data-state="open"
            data-variant="content"
            className="space-y-3 min-h-64"
          >
            {modalWorkOrdersLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Завантаження...</div>
            )}
            {!modalWorkOrdersLoading && woError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {woError}
              </div>
            )}
            {!modalWorkOrdersLoading && !woError && modalWorkOrders.length === 0 && (
              <p className="text-[13px] text-muted-foreground text-center py-8">Нарядів немає</p>
            )}
            {!modalWorkOrdersLoading && !woError && modalWorkOrders.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead className="bg-secondary border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        Номер
                      </th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        Авто
                      </th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        Статус
                      </th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                        Сума
                      </th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        Дата
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {modalWorkOrders.map(wo => (
                      <tr
                        key={wo.id}
                        className="bg-surface hover:bg-secondary/50 transition-colors cursor-pointer"
                        onClick={() => router.push(`/work-orders/${wo.id}`)}
                      >
                        <td className="px-3 py-2 font-mono font-medium text-foreground">
                          {wo.number}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {wo.vehicleSummary || '—'}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={WO_STATUS_BADGE[wo.status] ?? 'secondary'} dot>
                            {WO_STATUS_LABELS[wo.status] ?? wo.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right text-foreground tabular-nums">
                          {fmtMoney(wo.totalAmount)} ₴
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{fmtDate(wo.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...confirmDialogProps} />
    </>
  );
}
