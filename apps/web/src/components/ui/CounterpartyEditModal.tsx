'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Trash2, Pencil, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate, kyivToday } from '@/lib/format';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
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
  vin?: string | null;
  deletedAt?: string | null;
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
  currencyCode: string;
  paymentDeferDays: number | null;
  deletedAt?: string | null;
};

// Доступні види договору за типом контрагента: SUPPLIER → лише Купівля,
// CLIENT → лише Продаж, BOTH → обидва. Поле «Вид договору» завжди редаговане
// (select), лише список пунктів фільтрується — жодного disabled-стану.
function contractTypesForCounterparty(cpType: string): Array<'PURCHASE' | 'SALE'> {
  if (cpType === 'SUPPLIER') return ['PURCHASE'];
  if (cpType === 'CLIENT') return ['SALE'];
  return ['PURCHASE', 'SALE']; // BOTH (та будь-який інший) — обидва
}

// Дефолтний вид при відкритті форми: єдиний доступний для SUPPLIER/CLIENT,
// порожній для BOTH (обов'язковий явний вибір).
function defaultContractType(cpType: string): string {
  const types = contractTypesForCounterparty(cpType);
  return types.length === 1 ? types[0] : '';
}

// ─── Constants ────────────────────────────────────────────────────────────────

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
  // Редагування наявного авто: id → форма prefill; null → режим створення.
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  // Галки «Показувати видалені» (soft-deleted авто/договори) у формі контрагента.
  const [showDeletedVehicles, setShowDeletedVehicles] = useState(false);
  const [addVehicleForm, setAddVehicleForm] = useState({
    make: '',
    model: '',
    year: '',
    licensePlate: '',
    vin: '',
  });
  const modalVehiclesReqRef = useRef(0);
  // Live counterparty id — звіряється у handler-fetch async після await, щоб не
  // setState у списки чужого CP при швидкому перемиканні (§8.2 tenant-guard).
  const currentCpIdRef = useRef<string | null>(null);
  // explicit deps `[counterparty?.id]` — ref оновлюється ТІЛЬКИ при
  // зміні CP-id, а не на кожен render (form-keystrokes). ESLint-clean.
  useEffect(() => {
    currentCpIdRef.current = counterparty?.id ?? null;
  }, [counterparty?.id]);

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
  // Редагування наявного договору: id → форма prefill; null → режим створення.
  const [editingContractId, setEditingContractId] = useState<string | null>(null);
  const [deletingContractId, setDeletingContractId] = useState<string | null>(null);
  const [showDeletedContracts, setShowDeletedContracts] = useState(false);
  const [orgCurrency, setOrgCurrency] = useState('UAH');
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[]>([]);
  const [addContractForm, setAddContractForm] = useState({
    contractType: '',
    startDate: kyivToday(),
    endDate: '',
    creditLimit: '',
    currencyCode: '',
    paymentDeferDays: '',
    isPrimary: false,
  });
  const modalContractsReqRef = useRef(0);

  // Skip-first-run refs для toggle-useEffect (див. коментарі нижче). Оголошені тут
  // (не поруч зі своїми useEffect), бо головний useEffect їх скидає при зміні CP —
  // ES const має TDZ у порядку виконання, тому декларація має передувати використанню.
  const vehiclesLoadedRef = useRef(false);
  const contractsLoadedRef = useRef(false);

  // Load related data when modal opens for an existing counterparty
  useEffect(() => {
    if (!open || !counterparty) return;

    const vReqId = ++modalVehiclesReqRef.current;
    const woReqId = ++modalWoReqRef.current;
    const cReqId = ++modalContractsReqRef.current;

    setModalVehicles([]);
    setModalWorkOrders([]);
    setModalContracts([]);
    setModalGarageId(null); // reset stale id before fetch — інакше addVehicle для нового CP
    //                       міг би запостити vehicle у гараж попереднього контрагента.
    setVehiclesError('');
    setWoError('');
    setContractsError('');
    setShowAddVehicle(false);
    setShowAddContract(false);
    // Галки видалених скидаються при відкритті модалки для (іншого) контрагента.
    setShowDeletedVehicles(false);
    setShowDeletedContracts(false);

    setModalVehiclesLoading(true);
    // sto-optimize: parallel garages (для defaultGarageId) + bulk vehicles
    // через ?counterpartyId=. Раніше waterfall: garages → N per-garage fetches.
    Promise.all([
      apiFetch<{ id: string }[]>(`/counterparties/${counterparty.id}/garages`),
      apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${counterparty.id}`),
    ])
      .then(([garages, vehicles]) => {
        if (modalVehiclesReqRef.current !== vReqId) return;
        const defaultGarage = garages[0];
        if (defaultGarage) setModalGarageId(defaultGarage.id);
        setModalVehicles(vehicles);
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
    // Reset skip-first-run refs — головний useEffect уже завантажив дані для нового CP,
    // toggle-useEffect має пропустити свій перший прогін (уникнення дубля-запиту).
    vehiclesLoadedRef.current = false;
    contractsLoadedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, counterparty?.id]);

  // Перезавантаження авто при перемиканні галки «Показувати видалені» (both directions —
  // toggle-on показує deleted, toggle-off ховає їх назад). Skip перший прогін після
  // open/CP-switch (головний useEffect уже завантажив дані з дефолтом false); при зміні
  // CP головний useEffect скидає `vehiclesLoadedRef.current = false` — уникнення дубля.
  useEffect(() => {
    if (!open || !counterparty) {
      vehiclesLoadedRef.current = false;
      return;
    }
    // Skip перший прогін після open (дефолт false вже завантажений головним useEffect).
    if (!vehiclesLoadedRef.current) {
      vehiclesLoadedRef.current = true;
      return;
    }
    const vReqId = ++modalVehiclesReqRef.current;
    setModalVehiclesLoading(true);
    const qs = showDeletedVehicles ? '&showDeleted=true' : '';
    apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${counterparty.id}${qs}`)
      .then(vehicles => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehicles(vehicles);
      })
      .catch(err => {
        if (modalVehiclesReqRef.current === vReqId)
          setVehiclesError(err instanceof Error ? err.message : 'Помилка завантаження авто');
      })
      .finally(() => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehiclesLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeletedVehicles, open, counterparty?.id]);

  // Перезавантаження договорів при перемиканні галки (both directions).
  // Skip-first-run ref обнуляється у головному useEffect при зміні CP (див. вище).
  useEffect(() => {
    if (!open || !counterparty) {
      contractsLoadedRef.current = false;
      return;
    }
    if (!contractsLoadedRef.current) {
      contractsLoadedRef.current = true;
      return;
    }
    const cReqId = ++modalContractsReqRef.current;
    setModalContractsLoading(true);
    const qs = showDeletedContracts ? '?showDeleted=true' : '';
    apiFetch<ModalContract[]>(`/counterparties/${counterparty.id}/contracts${qs}`)
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
  }, [showDeletedContracts, open, counterparty?.id]);

  useEffect(() => {
    if (!open) return;
    void Promise.allSettled([
      apiFetch<{ currency: string }>('/settings/organisation'),
      apiFetch<{ items: { code: string; name: string }[]; total: number }>('/currencies'),
    ]).then(([settingsRes, currRes]) => {
      if (settingsRes.status === 'fulfilled') setOrgCurrency(settingsRes.value.currency);
      if (currRes.status === 'fulfilled') setCurrencies(currRes.value.items ?? []);
    });
  }, [open]);

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
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
          vatPayer: form.vatPayer,
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

  // Скидання форми авто у дефолтний стан (вихід з create/edit-режиму).
  const resetVehicleForm = () => {
    setAddVehicleForm({ make: '', model: '', year: '', licensePlate: '', vin: '' });
    setEditingVehicleId(null);
    setShowAddVehicle(false);
  };

  // Відкрити форму на РЕДАГУВАННЯ наявного авто — prefill з рядка.
  const startEditVehicle = (v: Vehicle) => {
    setAddVehicleForm({
      make: v.make,
      model: v.model,
      year: v.year != null ? String(v.year) : '',
      licensePlate: v.licensePlate || '',
      vin: v.vin || '',
    });
    setEditingVehicleId(v.id);
    setShowAddVehicle(true);
  };

  const saveVehicle = async () => {
    if (!counterparty || !addVehicleForm.make || !addVehicleForm.model) return;
    // Tenant-guard: handler-fetch ↔ зміна counterparty (§8.2). Якщо під час запиту
    // користувач перемкнувся на іншого CP — викидаємо setState у чужу таблицю.
    // Звіряємо проти currentCpIdRef (живий id з ref), а не з captured closure.
    const cpIdAtStart = counterparty.id;
    const editId = editingVehicleId;
    setAddingVehicle(true);
    try {
      const payload = {
        make: addVehicleForm.make,
        model: addVehicleForm.model,
        year: addVehicleForm.year ? Number(addVehicleForm.year) : undefined,
        licensePlate: addVehicleForm.licensePlate || undefined,
        vin: addVehicleForm.vin || undefined,
      };
      let saved: Vehicle;
      if (editId) {
        // PATCH наявного авто — гараж уже існує, customerGarageId не потрібен.
        saved = await apiFetch<Vehicle>(`/vehicles/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        // Якщо гаража ще немає — створюємо автоматично (новий контрагент без гаражу).
        // Назва "Основний" + isDefault:true дзеркалить backend (counterparties.service.ts
        // auto-create на create() для CLIENT/BOTH) — консистентний UX.
        let garageId = modalGarageId;
        if (!garageId) {
          const garage = await apiFetch<{ id: string }>(`/counterparties/${cpIdAtStart}/garages`, {
            method: 'POST',
            body: JSON.stringify({ name: 'Основний', isDefault: true }),
          });
          garageId = garage.id;
          if (currentCpIdRef.current === cpIdAtStart) setModalGarageId(garage.id);
        }
        saved = await apiFetch<Vehicle>('/vehicles', {
          method: 'POST',
          body: JSON.stringify({ customerGarageId: garageId, ...payload }),
        });
      }
      if (currentCpIdRef.current !== cpIdAtStart) return; // CP змінився — викидаємо setState
      setModalVehicles(v => {
        const idx = v.findIndex(x => x.id === saved.id);
        if (idx < 0) return [...v, saved];
        const next = [...v];
        next[idx] = saved;
        return next;
      });
      resetVehicleForm();
      toast.success(editId ? 'Авто оновлено' : 'Авто додано');
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        toast.error(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setAddingVehicle(false);
    }
  };

  const deleteVehicle = async (id: string) => {
    if (!(await confirm({ title: 'Видалити авто?', variant: 'destructive' }))) return;
    const cpIdAtStart = counterparty?.id ?? null;
    setDeletingVehicleId(id);
    try {
      await apiFetch(`/vehicles/${id}`, { method: 'DELETE' });
      if (currentCpIdRef.current !== cpIdAtStart) return;
      // З галкою «показувати видалені» — лишаємо рядок, позначаємо deletedAt (покаже бейдж
      // + кнопку «Відновити»). Без галки — прибираємо зі списку.
      setModalVehicles(v =>
        showDeletedVehicles
          ? v.map(x => (x.id === id ? { ...x, deletedAt: new Date().toISOString() } : x))
          : v.filter(x => x.id !== id),
      );
      // Якщо редагували саме це авто — закриваємо форму.
      if (editingVehicleId === id) resetVehicleForm();
      toast.success('Авто видалено');
    } catch (e: unknown) {
      // 404 = вже видалено (stale UI) — просто прибираємо з локального списку.
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (currentCpIdRef.current !== cpIdAtStart) return;
      if (/не знайдено|not found/i.test(msg)) {
        setModalVehicles(v => v.filter(x => x.id !== id));
      } else {
        toast.error(msg);
      }
    } finally {
      setDeletingVehicleId(null);
    }
  };

  const restoreVehicle = async (v: Vehicle) => {
    const cpIdAtStart = counterparty?.id ?? null;
    setDeletingVehicleId(v.id);
    try {
      const restored = await apiFetch<Vehicle>(`/vehicles/${v.id}/restore`, { method: 'POST' });
      if (currentCpIdRef.current !== cpIdAtStart) return;
      setModalVehicles(list => list.map(x => (x.id === restored.id ? restored : x)));
      toast.success('Авто відновлено');
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        toast.error(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setDeletingVehicleId(null);
    }
  };

  // Скидання форми договору у дефолтний стан.
  const resetContractForm = () => {
    setAddContractForm({
      contractType: '',
      startDate: '',
      endDate: '',
      creditLimit: '',
      currencyCode: '',
      paymentDeferDays: '',
      isPrimary: false,
    });
    setEditingContractId(null);
    setShowAddContract(false);
  };

  // Відкрити форму на РЕДАГУВАННЯ наявного договору — prefill з рядка.
  const startEditContract = (c: ModalContract) => {
    setAddContractForm({
      contractType: c.contractType,
      startDate: c.startDate ? c.startDate.slice(0, 10) : '',
      endDate: c.endDate ? c.endDate.slice(0, 10) : '',
      creditLimit: c.creditLimit != null ? String(c.creditLimit) : '',
      currencyCode: c.currencyCode || '',
      paymentDeferDays: c.paymentDeferDays != null ? String(c.paymentDeferDays) : '',
      isPrimary: c.isPrimary,
    });
    setEditingContractId(c.id);
    setContractsError('');
    setShowAddContract(true);
  };

  const saveContract = async () => {
    if (!counterparty) return;
    // Tenant-guard (Bug #370): handler-fetch ↔ зміна counterparty. Якщо під час
    // запиту користувач закрив/перевідкрив modal для іншого CP — викидаємо setState
    // у чужу таблицю contracts. Дзеркалить захист у addVehicle/deleteVehicle.
    const cpIdAtStart = counterparty.id;
    const cpTypeAtStart = counterparty.type;
    const editId = editingContractId;
    setAddingContract(true);
    setContractsError('');
    try {
      // Вибір користувача (select уже фільтрований за типом контрагента + має дефолт).
      // Fallback на дефолт-тип якщо поле чомусь порожнє (для BOTH guard на кнопці не пустить).
      const resolvedType = addContractForm.contractType || defaultContractType(cpTypeAtStart);
      const body = JSON.stringify({
        contractType: resolvedType,
        startDate: addContractForm.startDate,
        endDate: addContractForm.endDate || undefined,
        creditLimit: addContractForm.creditLimit ? Number(addContractForm.creditLimit) : undefined,
        currencyCode: addContractForm.currencyCode || orgCurrency,
        paymentDeferDays: addContractForm.paymentDeferDays
          ? Number(addContractForm.paymentDeferDays)
          : undefined,
        isPrimary: addContractForm.isPrimary || undefined,
      });
      const saved = await apiFetch<ModalContract>(
        editId
          ? `/counterparties/${cpIdAtStart}/contracts/${editId}`
          : `/counterparties/${cpIdAtStart}/contracts`,
        { method: editId ? 'PATCH' : 'POST', body },
      );
      if (currentCpIdRef.current !== cpIdAtStart) return; // CP змінився — drop
      setModalContracts(prev => {
        // isPrimary ексклюзивний У МЕЖАХ contractType (дзеркалить бек swapType-scope):
        // якщо saved став головним — скидаємо прапорець з інших того ж типу.
        const next = saved.isPrimary
          ? prev.map(c => (c.contractType === saved.contractType ? { ...c, isPrimary: false } : c))
          : [...prev];
        const idx = next.findIndex(c => c.id === saved.id);
        if (idx >= 0) next[idx] = saved;
        else next.push(saved);
        return next;
      });
      resetContractForm();
      toast.success(editId ? 'Договір оновлено' : 'Договір додано');
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        setContractsError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setAddingContract(false);
    }
  };

  const deleteContract = async (c: ModalContract) => {
    if (!counterparty) return;
    if (
      !(await confirm({
        title: 'Видалити договір?',
        message: `Договір ${c.number} буде видалено.`,
        variant: 'destructive',
      }))
    )
      return;
    const cpIdAtStart = counterparty.id;
    setDeletingContractId(c.id);
    setContractsError('');
    try {
      await apiFetch(`/counterparties/${cpIdAtStart}/contracts/${c.id}`, { method: 'DELETE' });
      if (currentCpIdRef.current !== cpIdAtStart) return; // CP змінився — drop
      setModalContracts(prev => {
        // З галкою «показувати видалені» — лишаємо рядок, позначаємо deletedAt + isPrimary=false
        // (видалений не може бути головним). Без галки — прибираємо зі списку.
        let next = showDeletedContracts
          ? prev.map(x =>
              x.id === c.id ? { ...x, deletedAt: new Date().toISOString(), isPrimary: false } : x,
            )
          : prev.filter(x => x.id !== c.id);
        // Бек промоутить наступний головний того ж типу (найстаріший) у тому ж $transaction.
        // Дзеркалимо optimistic: якщо видалили головний — робимо головним перший АКТИВНИЙ
        // ТОГО Ж contractType. Бек сортує `[isPrimary desc, createdAt asc]`, але після
        // видалення primary у решти same-type isPrimary=false → тайбрейк за createdAt asc
        // → findIndex дає найстаріший, що збігається з беком. Істина — при перевідкритті.
        if (c.isPrimary) {
          const idx = next.findIndex(x => x.contractType === c.contractType && !x.deletedAt);
          if (idx >= 0) next = next.map((x, i) => (i === idx ? { ...x, isPrimary: true } : x));
        }
        return next;
      });
      // Якщо редагували саме цей договір — закриваємо форму.
      if (editingContractId === c.id) resetContractForm();
      toast.success('Договір видалено');
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        setContractsError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setDeletingContractId(null);
    }
  };

  const restoreContract = async (c: ModalContract) => {
    if (!counterparty) return;
    const cpIdAtStart = counterparty.id;
    setDeletingContractId(c.id);
    setContractsError('');
    try {
      // Бек restore ставить isPrimary=false (уникнення дубля-головного) — приймаємо as-is.
      const restored = await apiFetch<ModalContract>(
        `/counterparties/${cpIdAtStart}/contracts/${c.id}/restore`,
        { method: 'POST' },
      );
      if (currentCpIdRef.current !== cpIdAtStart) return;
      setModalContracts(prev => prev.map(x => (x.id === restored.id ? restored : x)));
      toast.success('Договір відновлено');
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        setContractsError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setDeletingContractId(null);
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
              <PhoneInput
                label="Телефон"
                value={form.phone}
                onChange={e => {
                  setForm(f => ({ ...f, phone: e.target.value }));
                  dirty.markDirty();
                }}
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
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] text-muted-foreground">
                      {modalVehicles.length} авто
                    </span>
                    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showDeletedVehicles}
                        onChange={e => setShowDeletedVehicles(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                      />
                      Показувати видалені
                    </label>
                  </div>
                  {!showAddVehicle && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => {
                        // Режим СТВОРЕННЯ — скидаємо edit-стан і форму.
                        setEditingVehicleId(null);
                        setAddVehicleForm({
                          make: '',
                          model: '',
                          year: '',
                          licensePlate: '',
                          vin: '',
                        });
                        setShowAddVehicle(true);
                      }}
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
                      <Button size="sm" variant="outline" onClick={resetVehicleForm}>
                        Скасувати
                      </Button>
                      <Button
                        size="sm"
                        onClick={saveVehicle}
                        loading={addingVehicle}
                        disabled={!addVehicleForm.make || !addVehicleForm.model}
                      >
                        {editingVehicleId ? 'Оновити' : 'Зберегти'}
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
                          <th className="w-20">
                            <span className="sr-only">Дії</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalVehicles.map(v => (
                          <tr
                            key={v.id}
                            className={cn(
                              'group bg-surface hover:bg-secondary/50 transition-colors',
                              v.deletedAt && 'opacity-60',
                            )}
                          >
                            <td className="px-3 py-2 font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {v.make} {v.model}
                                {v.deletedAt && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive-subtle text-destructive">
                                    Видалено
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {v.licensePlate || '—'}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{v.year ?? '—'}</td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {v.deletedAt ? (
                                  <button
                                    type="button"
                                    title="Відновити"
                                    onClick={() => restoreVehicle(v)}
                                    disabled={deletingVehicleId === v.id}
                                    className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition disabled:opacity-50"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      title="Редагувати"
                                      onClick={() => startEditVehicle(v)}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-secondary hover:text-foreground transition"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title="Видалити"
                                      onClick={() => deleteVehicle(v.id)}
                                      disabled={deletingVehicleId === v.id}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-destructive-subtle hover:text-destructive transition disabled:opacity-50"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
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
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] text-muted-foreground">
                      {modalContracts.length} договор{modalContracts.length === 1 ? '' : 'ів'}
                    </span>
                    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showDeletedContracts}
                        onChange={e => setShowDeletedContracts(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                      />
                      Показувати видалені
                    </label>
                  </div>
                  {!showAddContract && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => {
                        // Режим СТВОРЕННЯ (не edit): дефолт-вид за типом контрагента
                        // (Купівля для постачальника, Продаж для клієнта, порожньо для BOTH).
                        setEditingContractId(null);
                        setAddContractForm({
                          contractType: defaultContractType(counterparty?.type ?? ''),
                          startDate: kyivToday(),
                          endDate: '',
                          creditLimit: '',
                          currencyCode: '',
                          paymentDeferDays: '',
                          isPrimary: false,
                        });
                        setShowAddContract(true);
                      }}
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
                        {/* Поле завжди редаговане (не блокуємо) — лише список пунктів
                            фільтрується за типом контрагента. */}
                        <Select
                          value={addContractForm.contractType}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, contractType: e.target.value }))
                          }
                        >
                          {counterparty.type === 'BOTH' && <option value="">Оберіть вид</option>}
                          {contractTypesForCounterparty(counterparty.type).map(t => (
                            <option key={t} value={t}>
                              {CONTRACT_TYPE_LABELS[t] ?? t}
                            </option>
                          ))}
                        </Select>
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
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Валюта</label>
                      {currencies.length > 0 ? (
                        <Select
                          value={addContractForm.currencyCode || orgCurrency}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, currencyCode: e.target.value }))
                          }
                          className="w-auto"
                        >
                          {currencies.map(c => (
                            <option key={c.code} value={c.code}>
                              {c.code} — {c.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <input
                          type="text"
                          value={addContractForm.currencyCode || orgCurrency}
                          onChange={e =>
                            setAddContractForm(f => ({
                              ...f,
                              currencyCode: e.target.value.toUpperCase().slice(0, 10),
                            }))
                          }
                          placeholder="UAH"
                          maxLength={10}
                          className="h-9 w-24 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Кредитний ліміт
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
                      <Button size="sm" variant="outline" onClick={resetContractForm}>
                        Скасувати
                      </Button>
                      <Button
                        size="sm"
                        loading={addingContract}
                        disabled={
                          !addContractForm.startDate ||
                          (counterparty.type === 'BOTH' && !addContractForm.contractType)
                        }
                        onClick={saveContract}
                      >
                        {editingContractId ? 'Оновити' : 'Зберегти'}
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
                          <th className="px-3 py-2 w-20">
                            <span className="sr-only">Дії</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalContracts.map(c => (
                          <tr
                            key={c.id}
                            className={cn(
                              'group bg-surface hover:bg-secondary/50 transition-colors',
                              c.deletedAt && 'opacity-60',
                            )}
                          >
                            <td className="px-3 py-2 font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {c.number}
                                {c.isPrimary && !c.deletedAt && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                                    Головний
                                  </span>
                                )}
                                {c.deletedAt && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive-subtle text-destructive">
                                    Видалено
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
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {c.deletedAt ? (
                                  <button
                                    type="button"
                                    title="Відновити"
                                    disabled={deletingContractId === c.id}
                                    onClick={() => restoreContract(c)}
                                    className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition disabled:opacity-50"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      title="Редагувати"
                                      onClick={() => startEditContract(c)}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-secondary hover:text-foreground transition"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title="Видалити"
                                      disabled={deletingContractId === c.id}
                                      onClick={() => deleteContract(c)}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-destructive-subtle hover:text-destructive transition disabled:opacity-50"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
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
