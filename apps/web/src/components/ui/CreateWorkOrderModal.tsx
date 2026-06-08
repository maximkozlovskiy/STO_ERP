'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { kyivToday } from '@/lib/format';
import { displayCounterpartyName } from '@/lib/utils';
import { WO_STATUS_LABELS, WO_PRIORITY_LABELS, WO_CATEGORY_LABELS } from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { SearchCombobox } from '@/components/ui/search-combobox';

interface Branch {
  id: string;
  name: string;
}
interface Lift {
  id: string;
  name: string;
}
interface Warehouse {
  id: string;
  name: string;
}
interface Employee {
  id: string;
  firstName: string;
  lastName: string;
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
interface WorkItem {
  id: string;
  name: string;
  normoHours: number;
  price: number;
}
interface GoodItem {
  id: string;
  name: string;
  sku?: string | null;
  salePrice: number;
}

// Local line/part rows (pre-save state)
interface LocalLine {
  _key: string;
  workId: string;
  workName: string;
  employeeId: string;
  normoHours: string;
  price: string;
}
interface LocalPart {
  _key: string;
  goodId: string;
  goodName: string;
  warehouseId: string;
  quantity: string;
  price: string;
}

const EMPTY_LINE: Omit<LocalLine, '_key'> = {
  workId: '',
  workName: '',
  employeeId: '',
  normoHours: '',
  price: '',
};
const EMPTY_PART: Omit<LocalPart, '_key'> = {
  goodId: '',
  goodName: '',
  warehouseId: '',
  quantity: '1',
  price: '',
};

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

// Crypto-randomUUID gives globally-unique row keys without relying on a
// module-level counter (which would survive HMR/StrictMode and risk reuse).
const nextKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

// UA users often type `1,5` for fractional values — accept comma as decimal
// separator before passing to `Number()`. Returns `undefined` for empty/NaN.
const toNumberOrUndefined = (raw: string): number | undefined => {
  if (!raw) return undefined;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

export function CreateWorkOrderModal({ open, onClose, onCreated, prefill }: Props) {
  const [form, setForm] = useState({
    branchId: '',
    vehicleId: '',
    counterpartyId: '',
    contractId: '',
    liftId: '',
    description: '',
    priority: 'NORMAL',
    repairCategory: '',
    documentDate: kyivToday(),
    plannedStartAt: '',
    plannedEndAt: '',
  });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Inline add-row state
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [newPart, setNewPart] = useState<Omit<LocalPart, '_key'>>(EMPTY_PART);
  const [showLineInput, setShowLineInput] = useState(false);
  const [showPartInput, setShowPartInput] = useState(false);

  // Accumulated pre-save rows
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [parts, setParts] = useState<LocalPart[]>([]);

  const vehicleReqRef = useRef(0);
  const contractReqRef = useRef(0);
  const branchesRef = useRef(branches);
  branchesRef.current = branches;

  // Load branches, warehouses, employees once
  useEffect(() => {
    const cachedBranches = getCached<Branch[]>('cache:branches');
    if (cachedBranches) {
      setBranches(cachedBranches);
    } else {
      apiFetch<Branch[]>('/branches')
        .then(bs => {
          setBranches(bs);
          setCache('cache:branches', bs);
        })
        .catch(() => {});
    }

    const cachedLifts = getCached<Lift[]>('cache:lifts');
    if (cachedLifts) {
      setLifts(cachedLifts);
    } else {
      apiFetch<Lift[] | { items: Lift[] }>('/lifts')
        .then(r => {
          const list = Array.isArray(r) ? r : ((r as { items: Lift[] }).items ?? []);
          setLifts(list);
          setCache('cache:lifts', list);
        })
        .catch(() => {});
    }

    const cachedWarehouses = getCached<Warehouse[]>('cache:warehouses');
    if (cachedWarehouses) {
      setWarehouses(cachedWarehouses);
    } else {
      apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
        .then(r => {
          const list = Array.isArray(r) ? r : ((r as { items: Warehouse[] }).items ?? []);
          setWarehouses(list);
          setCache('cache:warehouses', list);
        })
        .catch(() => {});
    }

    apiFetch<{ items: Employee[] }>('/employees?limit=200')
      .then(r => setEmployees(Array.isArray(r.items) ? r.items : []))
      .catch(() => {});
  }, []);

  // Apply prefill + auto-select single branch when modal opens
  useEffect(() => {
    if (!open) return;
    setError('');
    setVehicles([]);
    setContracts([]);
    setLines([]);
    setParts([]);
    setNewLine(EMPTY_LINE);
    setNewPart(EMPTY_PART);
    setShowLineInput(false);
    setShowPartInput(false);
    // A fresh modal session starts without a prior partial create.
    createdWoRef.current = null;
    setForm({
      branchId: prefill?.branchId ?? '',
      vehicleId: prefill?.vehicleId ?? '',
      counterpartyId: prefill?.counterpartyId ?? '',
      contractId: '',
      liftId: '',
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

  // Auto-select first warehouse for new parts when warehouses load
  useEffect(() => {
    if (warehouses.length === 1) {
      setNewPart(p => (p.warehouseId ? p : { ...p, warehouseId: warehouses[0].id }));
    }
  }, [warehouses]);

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

  const fetchWorks = useCallback(
    (q: string) =>
      apiFetch<{ items: WorkItem[] }>(`/works?q=${encodeURIComponent(q)}&limit=20`).then(r =>
        (r.items ?? []).map(w => ({ ...w, primary: w.name, secondary: `${w.price} ₴` })),
      ),
    [],
  );

  const fetchGoods = useCallback(
    (q: string) =>
      apiFetch<{ items: GoodItem[] }>(`/goods?q=${encodeURIComponent(q)}&limit=20`).then(r =>
        (r.items ?? []).map(g => ({
          ...g,
          primary: g.name,
          secondary: g.sku ? `${g.sku} · ${g.salePrice} ₴` : `${g.salePrice} ₴`,
        })),
      ),
    [],
  );

  // Counterparty search for the header picker.
  // Wrapped in useCallback so EntityPickerField's outside-click listener
  // is not re-attached on every parent render.
  type HeaderCpItem = SearchPickerItem & { phone?: string | null };
  const fetchCpHeaderItems = useCallback(async (q: string): Promise<HeaderCpItem[]> => {
    const r = await apiFetch<{
      items: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        phone?: string | null;
      }[];
    }>(`/counterparties?q=${encodeURIComponent(q)}&limit=20`);
    return r.items.map(c => ({
      id: c.id,
      primary: displayCounterpartyName(c),
      secondary: c.phone ?? undefined,
    }));
  }, []);

  const addLine = () => {
    if (!newLine.workId || !newLine.employeeId) return;
    // Bug #382: блокуємо повний дублікат (work + виконавець) — типовий user-error.
    if (lines.some(l => l.workId === newLine.workId && l.employeeId === newLine.employeeId)) {
      setError('Цю роботу для цього виконавця вже додано');
      return;
    }
    // Bug #383: захист від негативних/нульових normoHours (DTO @Min(0.01) інакше rejects after WO created).
    const normo = toNumberOrUndefined(newLine.normoHours);
    if (newLine.normoHours && (normo === undefined || normo <= 0)) {
      setError('Нормо-години мають бути більше нуля');
      return;
    }
    const linePrice = toNumberOrUndefined(newLine.price);
    if (newLine.price && (linePrice === undefined || linePrice < 0)) {
      setError('Ціна не може бути відʼємною');
      return;
    }
    setError('');
    setLines(prev => [...prev, { ...newLine, _key: nextKey() }]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  const addPart = () => {
    if (!newPart.goodId || !newPart.warehouseId) return;
    // Bug #382: блокуємо повний дублікат (товар + склад).
    if (parts.some(p => p.goodId === newPart.goodId && p.warehouseId === newPart.warehouseId)) {
      setError('Цей товар із цього складу вже додано');
      return;
    }
    // Bug #383: backend DTO @Min(0.001) для quantity → reject цілого create() після WO POST.
    const qty = toNumberOrUndefined(newPart.quantity);
    if (qty === undefined || qty <= 0) {
      setError('Кількість має бути більше нуля');
      return;
    }
    const partPrice = toNumberOrUndefined(newPart.price);
    if (newPart.price && (partPrice === undefined || partPrice < 0)) {
      setError('Ціна не може бути відʼємною');
      return;
    }
    setError('');
    setParts(prev => [...prev, { ...newPart, _key: nextKey() }]);
    setNewPart({ ...EMPTY_PART, warehouseId: newPart.warehouseId });
    setShowPartInput(false);
  };

  // Track the WO created in a previous (failed) submit so retry posts only the
  // lines/parts that have not been persisted yet — otherwise the same lines
  // would be duplicated on every retry click.
  const createdWoRef = useRef<CreatedWorkOrder | null>(null);

  const create = async () => {
    // Bug #384: warn user if half-typed row would be silently dropped (data loss).
    // Pre-check BEFORE setSaving so the button stays enabled and the warning is visible.
    const hasHalfLine = !!newLine.workId && !newLine.employeeId;
    const hasHalfPart = !!newPart.goodId && !newPart.warehouseId;
    if (hasHalfLine || hasHalfPart) {
      setError(
        hasHalfLine
          ? 'У рядку «Роботи» не обрано виконавця. Натисніть «+» щоб додати або очистіть рядок.'
          : 'У рядку «Товари» не обрано склад. Натисніть «+» щоб додати або очистіть рядок.',
      );
      return;
    }

    setSaving(true);
    setError('');

    // Auto-flush in-progress rows that the user filled but never clicked "+".
    // Without this, switching focus to the footer button silently drops the
    // half-typed row (data loss).
    const pendingLine: LocalLine | null =
      newLine.workId && newLine.employeeId ? { ...newLine, _key: nextKey() } : null;
    const pendingPart: LocalPart | null =
      newPart.goodId && newPart.warehouseId ? { ...newPart, _key: nextKey() } : null;

    const linesToPost: LocalLine[] = pendingLine ? [...lines, pendingLine] : lines;
    const partsToPost: LocalPart[] = pendingPart ? [...parts, pendingPart] : parts;

    if (pendingLine) {
      setLines(linesToPost);
      setNewLine(EMPTY_LINE);
    }
    if (pendingPart) {
      setParts(partsToPost);
      setNewPart({ ...EMPTY_PART, warehouseId: newPart.warehouseId });
    }

    try {
      // Reuse a previously-created WO on retry to avoid duplicate WO documents.
      let wo = createdWoRef.current;
      if (!wo) {
        wo = await apiFetch<CreatedWorkOrder>('/work-orders', {
          method: 'POST',
          body: JSON.stringify({
            branchId: form.branchId,
            vehicleId: form.vehicleId,
            counterpartyId: form.counterpartyId,
            contractId: form.contractId || undefined,
            liftId: form.liftId || undefined,
            description: form.description || undefined,
            priority: form.priority || 'NORMAL',
            repairCategory: form.repairCategory || undefined,
            documentDate: form.documentDate || undefined,
            plannedAt: form.plannedStartAt || undefined,
            dueDate: form.plannedEndAt || undefined,
          }),
        });
        createdWoRef.current = wo;
      }

      // Post lines sequentially (order matters for display).
      // After each successful POST we drop the row from local state so a retry
      // after a mid-batch failure does NOT duplicate already-saved lines.
      for (const line of linesToPost) {
        await apiFetch(`/work-orders/${wo.id}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            workId: line.workId,
            employeeId: line.employeeId,
            normoHours: toNumberOrUndefined(line.normoHours),
            price: toNumberOrUndefined(line.price),
          }),
        });
        setLines(prev => prev.filter(l => l._key !== line._key));
      }

      for (const part of partsToPost) {
        await apiFetch(`/work-orders/${wo.id}/parts`, {
          method: 'POST',
          body: JSON.stringify({
            goodId: part.goodId,
            warehouseId: part.warehouseId,
            quantity: toNumberOrUndefined(part.quantity) ?? 1,
            price: toNumberOrUndefined(part.price),
          }),
        });
        setParts(prev => prev.filter(p => p._key !== part._key));
      }

      createdWoRef.current = null;
      onCreated?.(wo);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення наряду');
    } finally {
      setSaving(false);
    }
  };

  const initialStatus = Object.keys(WO_STATUS_LABELS)[0] ?? 'DRAFT';

  // Column header widths (shared between table header and input row grid)
  return (
    <>
      <Modal
        open={open}
        // Bug #381: блокуємо закриття під час послідовного POST /work-orders → /lines → /parts.
        // Інакше overlay/Escape/X закривають UI, а фонові fetch продовжуються — створюється WO
        // з частково записаними позиціями без видимого зворотного звʼязку.
        onClose={saving ? () => {} : onClose}
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

        <div className="space-y-0 divide-y divide-border">
          {/* Рядок 1: Номер | Дата документа | Статус */}
          <div className="grid grid-cols-3 gap-4 pb-4">
            <Input label="Номер" value="— присвоюється автоматично —" disabled readOnly />
            <Input
              label="Дата документа"
              type="date"
              value={form.documentDate}
              onChange={e => setForm(f => ({ ...f, documentDate: e.target.value }))}
            />
            <Input
              label="Статус"
              value={WO_STATUS_LABELS[initialStatus] ?? 'Чернетка'}
              disabled
              readOnly
            />
          </div>

          {/* Рядок 2: Філія | Підйомник | Пріоритет */}
          <div className="grid grid-cols-3 gap-4 pt-4 pb-4">
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
              label="Підйомник"
              value={form.liftId}
              onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
            >
              <option value="">— Без підйомника —</option>
              {lifts.map(l => (
                <option key={l.id} value={l.id}>
                  {l.name}
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

          {/* Планові та фактичні показники */}
          <div className="rounded-none border-0 overflow-hidden pt-4 pb-4">
            <div className="grid grid-cols-2 divide-x divide-border">
              <div className="px-3 py-1.5 bg-secondary/50 text-xs font-medium text-muted-foreground">
                Планові показники
              </div>
              <div className="px-3 py-1.5 bg-secondary/50 text-xs font-medium text-muted-foreground">
                Фактичні показники
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-border">
              <div className="grid grid-cols-2 gap-3 p-3">
                <DateTimePickerInput
                  label="Дата та час початку"
                  value={form.plannedStartAt}
                  onChange={v => setForm(f => ({ ...f, plannedStartAt: v }))}
                />
                <DateTimePickerInput
                  label="Дата та час завершення"
                  value={form.plannedEndAt}
                  onChange={v => setForm(f => ({ ...f, plannedEndAt: v }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 p-3">
                <DateTimePickerInput
                  label="Дата та час початку"
                  value=""
                  onChange={() => {}}
                  disabled
                />
                <DateTimePickerInput
                  label="Дата та час завершення"
                  value=""
                  onChange={() => {}}
                  disabled
                />
              </div>
            </div>
          </div>

          {/* Секція: Клієнт */}
          <div className="space-y-3 pt-4 pb-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Клієнт <span className="text-destructive-text">*</span>
                </label>
                <EntityPickerField<HeaderCpItem>
                  display={counterpartyDisplayName}
                  placeholder="Пошук клієнта…"
                  ariaLabel="Клієнт"
                  onPick={() => setCpPickerOpen(true)}
                  onSearch={fetchCpHeaderItems}
                  onSearchSelect={item => {
                    setCounterpartyDisplayName(item.primary);
                    setForm(f => ({
                      ...f,
                      counterpartyId: item.id,
                      vehicleId: '',
                      contractId: '',
                    }));
                    setVehicles([]);
                    setContracts([]);
                    loadVehicles(item.id);
                    loadContracts(item.id);
                  }}
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
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Автомобіль"
                required
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
          </div>

          {/* Секція: Опис */}
          <div className="pt-4 pb-4">
            <Input
              label="Опис"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Заміна масла, колодок..."
            />
          </div>

          {/* Секція: Роботи — таблиця з inline рядком вводу в tbody */}
          <div className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground">Роботи</p>
              {!showLineInput && (
                <button
                  type="button"
                  onClick={() => {
                    setNewLine(EMPTY_LINE);
                    setShowLineInput(true);
                  }}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Додати
                </button>
              )}
            </div>

            <div className="rounded-lg border border-border overflow-visible">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground">
                      Назва роботи
                    </th>
                    <th className="px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground w-40">
                      Виконавець
                    </th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-muted-foreground w-18">
                      Год
                    </th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-muted-foreground w-24">
                      Ціна, ₴
                    </th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-muted-foreground w-24">
                      Сума, ₴
                    </th>
                    <th className="w-9" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.length === 0 && !showLineInput && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-3 py-4 text-center text-[12px] text-muted-foreground"
                      >
                        Натисніть «Додати» щоб додати роботу
                      </td>
                    </tr>
                  )}
                  {lines.map(line => {
                    const emp = employees.find(e => e.id === line.employeeId);
                    const h = toNumberOrUndefined(line.normoHours);
                    const p = toNumberOrUndefined(line.price);
                    const sum = h != null && p != null ? h * p : null;
                    return (
                      <tr
                        key={line._key}
                        className="bg-surface hover:bg-secondary/30 transition-colors"
                      >
                        <td className="px-3 py-1.5 text-foreground">{line.workName}</td>
                        <td className="px-2 py-1.5 text-muted-foreground w-40">
                          {emp ? `${emp.lastName} ${emp.firstName}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground w-18">
                          {line.normoHours || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground w-24">
                          {line.price || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium text-foreground w-24">
                          {sum != null ? sum.toFixed(2) : '—'}
                        </td>
                        <td className="px-1.5 py-1.5 text-right w-9">
                          <button
                            type="button"
                            onClick={() => setLines(prev => prev.filter(l => l._key !== line._key))}
                            disabled={saving}
                            aria-label="Видалити роботу"
                            title="Видалити роботу"
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {/* Рядок вводу — з'являється після кліку "+ Додати" */}
                  {showLineInput && (
                    <tr className="bg-primary/5 border-t-2 border-primary/20">
                      <td className="px-2 py-1.5">
                        <SearchCombobox<WorkItem>
                          placeholder="Пошук роботи..."
                          value={newLine.workId}
                          displayValue={newLine.workName}
                          fetchItems={fetchWorks}
                          onSelect={w =>
                            setNewLine(l => ({
                              ...l,
                              workId: w.id,
                              workName: w.name,
                              normoHours: String(w.normoHours),
                              price: String(w.price),
                            }))
                          }
                          onClear={() => setNewLine(EMPTY_LINE)}
                        />
                      </td>
                      <td className="px-2 py-1.5 w-40">
                        <Select
                          value={newLine.employeeId}
                          onChange={e => setNewLine(l => ({ ...l, employeeId: e.target.value }))}
                        >
                          <option value="">— Механік —</option>
                          {employees.map(e => (
                            <option key={e.id} value={e.id}>
                              {e.lastName} {e.firstName}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5 w-18">
                        <Input
                          type="number"
                          placeholder="Год"
                          value={newLine.normoHours}
                          onChange={e => setNewLine(l => ({ ...l, normoHours: e.target.value }))}
                          min="0"
                          step="0.1"
                        />
                      </td>
                      <td className="px-2 py-1.5 w-24">
                        <Input
                          type="number"
                          placeholder="Ціна"
                          value={newLine.price}
                          onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                          min="0"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-[12px] text-muted-foreground w-24">
                        {(() => {
                          const h = toNumberOrUndefined(newLine.normoHours);
                          const p = toNumberOrUndefined(newLine.price);
                          return h != null && p != null ? (h * p).toFixed(2) : '—';
                        })()}
                      </td>
                      <td className="px-1.5 py-1.5 w-9">
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={addLine}
                            disabled={!newLine.workId || !newLine.employeeId || saving}
                            title="Зберегти рядок"
                            className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setNewLine(EMPTY_LINE);
                              setShowLineInput(false);
                            }}
                            title="Скасувати"
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
                {lines.length > 0 && (
                  <tfoot>
                    <tr className="bg-secondary/50 border-t border-border">
                      <td
                        colSpan={4}
                        className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground"
                      >
                        Разом робіт:
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-xs font-semibold text-foreground w-24">
                        {lines
                          .reduce((acc, l) => {
                            const h = toNumberOrUndefined(l.normoHours);
                            const p = toNumberOrUndefined(l.price);
                            return acc + (h != null && p != null ? h * p : 0);
                          }, 0)
                          .toFixed(2)}
                      </td>
                      <td className="w-9" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Секція: Товари */}
          <div className="pt-4 pb-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground">Товари / Запчастини</p>
              {!showPartInput && (
                <button
                  type="button"
                  onClick={() => {
                    setNewPart(EMPTY_PART);
                    setShowPartInput(true);
                  }}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Додати
                </button>
              )}
            </div>

            <div className="rounded-lg border border-border overflow-visible">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground">
                      Назва товару
                    </th>
                    <th className="px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground w-36">
                      Склад
                    </th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-muted-foreground w-18">
                      К-сть
                    </th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-muted-foreground w-24">
                      Ціна, ₴
                    </th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-muted-foreground w-24">
                      Сума, ₴
                    </th>
                    <th className="w-9" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {parts.length === 0 && !showPartInput && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-3 py-4 text-center text-[12px] text-muted-foreground"
                      >
                        Натисніть «Додати» щоб додати товар
                      </td>
                    </tr>
                  )}
                  {parts.map(part => {
                    const wh = warehouses.find(w => w.id === part.warehouseId);
                    const qty = toNumberOrUndefined(part.quantity);
                    const p = toNumberOrUndefined(part.price);
                    const sum = qty != null && p != null ? qty * p : null;
                    return (
                      <tr
                        key={part._key}
                        className="bg-surface hover:bg-secondary/30 transition-colors"
                      >
                        <td className="px-3 py-1.5 text-foreground">{part.goodName}</td>
                        <td className="px-2 py-1.5 text-muted-foreground w-36">
                          {wh?.name ?? '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground w-18">
                          {part.quantity}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground w-24">
                          {part.price || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium text-foreground w-24">
                          {sum != null ? sum.toFixed(2) : '—'}
                        </td>
                        <td className="px-1.5 py-1.5 text-right w-9">
                          <button
                            type="button"
                            onClick={() => setParts(prev => prev.filter(p => p._key !== part._key))}
                            disabled={saving}
                            aria-label="Видалити товар"
                            title="Видалити товар"
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {/* Рядок вводу */}
                  {showPartInput && (
                    <tr className="bg-primary/5 border-t-2 border-primary/20">
                      <td className="px-2 py-1.5">
                        <SearchCombobox<GoodItem>
                          placeholder="Пошук товару..."
                          value={newPart.goodId}
                          displayValue={newPart.goodName}
                          fetchItems={fetchGoods}
                          onSelect={g =>
                            setNewPart(p => ({
                              ...p,
                              goodId: g.id,
                              goodName: g.name,
                              price: String(g.salePrice),
                            }))
                          }
                          onClear={() =>
                            setNewPart(p => ({ ...EMPTY_PART, warehouseId: p.warehouseId }))
                          }
                        />
                      </td>
                      <td className="px-2 py-1.5 w-36">
                        <Select
                          value={newPart.warehouseId}
                          onChange={e => setNewPart(p => ({ ...p, warehouseId: e.target.value }))}
                        >
                          <option value="">Склад</option>
                          {warehouses.map(w => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5 w-18">
                        <Input
                          type="number"
                          placeholder="К-сть"
                          value={newPart.quantity}
                          onChange={e => setNewPart(p => ({ ...p, quantity: e.target.value }))}
                          min="0.001"
                          step="any"
                        />
                      </td>
                      <td className="px-2 py-1.5 w-24">
                        <Input
                          type="number"
                          placeholder="Ціна"
                          value={newPart.price}
                          onChange={e => setNewPart(p => ({ ...p, price: e.target.value }))}
                          min="0"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-[12px] text-muted-foreground w-24">
                        {(() => {
                          const qty = toNumberOrUndefined(newPart.quantity);
                          const p = toNumberOrUndefined(newPart.price);
                          return qty != null && p != null ? (qty * p).toFixed(2) : '—';
                        })()}
                      </td>
                      <td className="px-1.5 py-1.5 w-9">
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={addPart}
                            disabled={!newPart.goodId || !newPart.warehouseId || saving}
                            title="Зберегти рядок"
                            className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setNewPart(EMPTY_PART);
                              setShowPartInput(false);
                            }}
                            title="Скасувати"
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
                {parts.length > 0 && (
                  <tfoot>
                    <tr className="bg-secondary/50 border-t border-border">
                      <td
                        colSpan={4}
                        className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground"
                      >
                        Разом товарів:
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-xs font-semibold text-foreground w-24">
                        {parts
                          .reduce((acc, pt) => {
                            const qty = toNumberOrUndefined(pt.quantity);
                            const p = toNumberOrUndefined(pt.price);
                            return acc + (qty != null && p != null ? qty * p : 0);
                          }, 0)
                          .toFixed(2)}
                      </td>
                      <td className="w-9" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
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
