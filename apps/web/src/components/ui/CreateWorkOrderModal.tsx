'use client';

import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { kyivToday } from '@/lib/format';
import { displayCounterpartyName } from '@/lib/utils';
import { WO_STATUS_LABELS, WO_PRIORITY_LABELS, WO_CATEGORY_LABELS } from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';

interface Branch {
  id: string;
  name: string;
}
interface Vehicle {
  id: string;
  make: string;
  model: string;
  licensePlate: string | null;
}
interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}
interface Contract {
  id: string;
  title: string;
  number?: string | null;
}

export interface CreateWOPrefill {
  counterpartyId?: string;
  counterpartyDisplay?: string;
  vehicleId?: string;
  branchId?: string;
  description?: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
}

export interface CreatedWorkOrder {
  id: string;
  number: string;
  counterpartyId: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (wo: CreatedWorkOrder) => void;
  prefill?: CreateWOPrefill;
}

export function CreateWorkOrderModal({ open, onClose, onCreated, prefill }: Props) {
  const [form, setForm] = useState({
    branchId: '',
    vehicleId: '',
    counterpartyId: '',
    contractId: '',
    description: '',
    priority: 'NORMAL',
    repairCategory: '',
    documentDate: kyivToday(),
    plannedStartAt: '',
    plannedEndAt: '',
  });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const vehicleReqRef = useRef(0);
  const contractReqRef = useRef(0);
  const branchesRef = useRef(branches);
  branchesRef.current = branches;

  // Load branches once on mount
  useEffect(() => {
    const cached = getCached<Branch[]>('cache:branches');
    if (cached) {
      setBranches(cached);
      return;
    }
    apiFetch<Branch[]>('/branches')
      .then(bs => {
        setBranches(bs);
        setCache('cache:branches', bs);
      })
      .catch(() => {});
  }, []);

  // Apply prefill + auto-select single branch when modal opens
  useEffect(() => {
    if (!open) return;
    setError('');
    setVehicles([]);
    setContracts([]);
    setForm({
      branchId: prefill?.branchId ?? '',
      vehicleId: prefill?.vehicleId ?? '',
      counterpartyId: prefill?.counterpartyId ?? '',
      contractId: '',
      description: prefill?.description ?? '',
      priority: 'NORMAL',
      repairCategory: '',
      documentDate: kyivToday(),
      plannedStartAt: prefill?.plannedStartAt ?? '',
      plannedEndAt: prefill?.plannedEndAt ?? '',
    });
    setCounterpartyDisplayName(prefill?.counterpartyDisplay ?? '');

    if (!prefill?.branchId) {
      const src = getCached<Branch[]>('cache:branches') ?? branchesRef.current;
      if (src.length === 1) setForm(f => ({ ...f, branchId: src[0].id }));
    }

    if (prefill?.counterpartyId) {
      loadVehicles(prefill.counterpartyId, prefill.vehicleId);
      loadContracts(prefill.counterpartyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // After branches load, auto-select if single
  useEffect(() => {
    if (branches.length === 1) {
      setForm(f => (f.branchId ? f : { ...f, branchId: branches[0].id }));
    }
  }, [branches]);

  const loadVehicles = (cpId: string, keepVehicleId?: string) => {
    if (!cpId) return;
    const reqId = ++vehicleReqRef.current;
    apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${cpId}`)
      .then(list => {
        if (reqId !== vehicleReqRef.current) return;
        const all = Array.isArray(list) ? list : [];
        setVehicles(all);
        if (keepVehicleId && all.some(v => v.id === keepVehicleId)) return;
        if (all.length === 1) setForm(f => (f.vehicleId ? f : { ...f, vehicleId: all[0].id }));
      })
      .catch(() => {});
  };

  const loadContracts = (cpId: string) => {
    if (!cpId) return;
    const reqId = ++contractReqRef.current;
    apiFetch<{ items: Contract[] }>(`/counterparties/${cpId}/contracts?limit=100`)
      .then(r => {
        if (reqId !== contractReqRef.current) return;
        setContracts(Array.isArray(r.items) ? r.items : []);
      })
      .catch(() => {});
  };

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const wo = await apiFetch<CreatedWorkOrder>('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          branchId: form.branchId,
          vehicleId: form.vehicleId,
          counterpartyId: form.counterpartyId,
          contractId: form.contractId || undefined,
          description: form.description || undefined,
          priority: form.priority || 'NORMAL',
          repairCategory: form.repairCategory || undefined,
          documentDate: form.documentDate || undefined,
          plannedAt: form.plannedStartAt || undefined,
          dueDate: form.plannedEndAt || undefined,
        }),
      });
      onCreated?.(wo);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення наряду');
    } finally {
      setSaving(false);
    }
  };

  const initialStatus = Object.keys(WO_STATUS_LABELS)[0] ?? 'DRAFT';

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Новий наряд"
        size="content"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.branchId || !form.counterpartyId || !form.vehicleId}
            className="w-full sm:w-auto"
          >
            Створити наряд
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {/* Рядок 1: Номер | Дата документа | Статус */}
          <div className="grid grid-cols-3 gap-4">
            <Input label="Номер" value="— присвоюється автоматично —" disabled readOnly />
            <DatePickerInput
              label="Дата документа"
              value={form.documentDate}
              onChange={v => setForm(f => ({ ...f, documentDate: v }))}
            />
            <Input
              label="Статус"
              value={WO_STATUS_LABELS[initialStatus] ?? 'Чернетка'}
              disabled
              readOnly
            />
          </div>

          {/* Рядок 2: Планова дата початку | Планова дата завершення */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Планова дата та час початку"
              type="datetime-local"
              value={form.plannedStartAt}
              onChange={e => setForm(f => ({ ...f, plannedStartAt: e.target.value }))}
            />
            <Input
              label="Планова дата та час завершення"
              type="datetime-local"
              value={form.plannedEndAt}
              onChange={e => setForm(f => ({ ...f, plannedEndAt: e.target.value }))}
            />
          </div>

          {/* Рядок 3: Філія | Пріоритет */}
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Філія"
              required
              value={form.branchId}
              onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
            >
              <option value="">— Оберіть —</option>
              {branches.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Select
              label="Пріоритет"
              value={form.priority}
              onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            >
              {Object.entries(WO_PRIORITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>

          {/* Рядок 4: Клієнт | Договір */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Клієнт <span className="text-destructive-text">*</span>
              </label>
              <EntityPickerField
                display={counterpartyDisplayName}
                placeholder="Обрати клієнта…"
                onPick={() => setCpPickerOpen(true)}
                onClear={() => {
                  setCounterpartyDisplayName('');
                  setForm(f => ({ ...f, counterpartyId: '', vehicleId: '', contractId: '' }));
                  setVehicles([]);
                  setContracts([]);
                }}
                hidePick={false}
              />
            </div>
            <Select
              label="Договір"
              value={form.contractId}
              onChange={e => setForm(f => ({ ...f, contractId: e.target.value }))}
              disabled={!form.counterpartyId || contracts.length === 0}
            >
              <option value="">— Без договору —</option>
              {contracts.map(c => (
                <option key={c.id} value={c.id}>
                  {c.number ? `${c.number} — ` : ''}
                  {c.title}
                </option>
              ))}
            </Select>
          </div>

          {/* Рядок 5: Автомобіль | Категорія ремонту */}
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Автомобіль"
              value={form.vehicleId}
              onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
              disabled={!form.counterpartyId}
            >
              <option value="">— Оберіть —</option>
              {vehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {v.make} {v.model}
                  {v.licensePlate ? ` (${v.licensePlate})` : ''}
                </option>
              ))}
            </Select>
            <Select
              label="Категорія ремонту"
              value={form.repairCategory}
              onChange={e => setForm(f => ({ ...f, repairCategory: e.target.value }))}
            >
              <option value="">— Не вказано —</option>
              {Object.entries(WO_CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>

          {/* Опис */}
          <Input
            label="Опис"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Заміна масла, колодок..."
          />

          {/* Таблички — placeholder, заповнюються після створення наряду */}
          <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3 text-xs text-muted-foreground">
            Роботи та товари додаються на сторінці наряду після створення.
          </div>
        </div>
      </Modal>

      <SearchPickerModal<SearchPickerItem & Counterparty>
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        title="Оберіть клієнта"
        selectedId={form.counterpartyId}
        searchPlaceholder="Ім'я, телефон, держ. номер авто..."
        fetchItems={q =>
          apiFetch<{ items: Counterparty[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&limit=20`,
          ).then(r => r.items.map(c => ({ ...c, primary: displayCounterpartyName(c) })))
        }
        onSelect={cp => {
          setCounterpartyDisplayName(cp.primary);
          setForm(f => ({ ...f, counterpartyId: cp.id, vehicleId: '', contractId: '' }));
          loadVehicles(cp.id);
          loadContracts(cp.id);
        }}
      />
    </>
  );
}
