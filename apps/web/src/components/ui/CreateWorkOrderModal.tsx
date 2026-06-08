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
    description: '',
    priority: 'NORMAL',
    repairCategory: '',
    documentDate: kyivToday(),
    plannedStartAt: '',
    plannedEndAt: '',
  });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
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

    apiFetch<{ items: Employee[] }>('/employees?limit=200&status=ACTIVE')
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
    // A fresh modal session starts without a prior partial create.
    createdWoRef.current = null;
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

          {/* Рядок 2: Філія | Пріоритет */}
          <div className="grid grid-cols-2 gap-4 pt-4 pb-4">
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

          {/* Секція: Роботи */}
          <div className="pt-4 pb-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">Роботи</p>

            {/* Таблиця доданих робіт */}
            {lines.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden mb-3">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-secondary/50 border-b border-border">
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">
                        Робота
                      </th>
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground w-28">
                        Виконавець
                      </th>
                      <th className="text-right px-3 py-1.5 font-medium text-muted-foreground w-20">
                        Год
                      </th>
                      <th className="text-right px-3 py-1.5 font-medium text-muted-foreground w-24">
                        Ціна, ₴
                      </th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lines.map(line => {
                      const emp = employees.find(e => e.id === line.employeeId);
                      return (
                        <tr key={line._key} className="bg-surface">
                          <td className="px-3 py-1.5 text-foreground">{line.workName}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {emp ? `${emp.lastName} ${emp.firstName}` : '—'}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {line.normoHours || '—'}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {line.price || '—'}
                          </td>
                          <td className="px-1.5 py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setLines(prev => prev.filter(l => l._key !== line._key))
                              }
                              disabled={saving}
                              aria-label="Видалити роботу"
                              title="Видалити роботу"
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Рядок додавання роботи */}
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: '1fr 160px 80px 100px auto' }}
            >
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
              <Select
                value={newLine.employeeId}
                onChange={e => setNewLine(l => ({ ...l, employeeId: e.target.value }))}
              >
                <option value="">Виконавець</option>
                {employees.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.lastName} {e.firstName}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                placeholder="Год"
                value={newLine.normoHours}
                onChange={e => setNewLine(l => ({ ...l, normoHours: e.target.value }))}
                min="0"
                step="0.1"
              />
              <Input
                type="number"
                placeholder="Ціна"
                value={newLine.price}
                onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                min="0"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addLine}
                disabled={!newLine.workId || !newLine.employeeId || saving}
                className="h-9 w-9 p-0 shrink-0"
                title="Додати роботу"
                aria-label="Додати роботу"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Секція: Товари */}
          <div className="pt-4 pb-2">
            <p className="text-xs font-medium text-muted-foreground mb-2">Товари / Запчастини</p>

            {/* Таблиця доданих товарів */}
            {parts.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden mb-3">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-secondary/50 border-b border-border">
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">
                        Товар
                      </th>
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground w-32">
                        Склад
                      </th>
                      <th className="text-right px-3 py-1.5 font-medium text-muted-foreground w-20">
                        К-сть
                      </th>
                      <th className="text-right px-3 py-1.5 font-medium text-muted-foreground w-24">
                        Ціна, ₴
                      </th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {parts.map(part => {
                      const wh = warehouses.find(w => w.id === part.warehouseId);
                      return (
                        <tr key={part._key} className="bg-surface">
                          <td className="px-3 py-1.5 text-foreground">{part.goodName}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{wh?.name ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {part.quantity}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {part.price || '—'}
                          </td>
                          <td className="px-1.5 py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setParts(prev => prev.filter(p => p._key !== part._key))
                              }
                              disabled={saving}
                              aria-label="Видалити товар"
                              title="Видалити товар"
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Рядок додавання товару */}
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: '1fr 140px 70px 100px auto' }}
            >
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
                onClear={() => setNewPart(p => ({ ...EMPTY_PART, warehouseId: p.warehouseId }))}
              />
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
              <Input
                type="number"
                placeholder="К-сть"
                value={newPart.quantity}
                onChange={e => setNewPart(p => ({ ...p, quantity: e.target.value }))}
                min="0.001"
                step="any"
              />
              <Input
                type="number"
                placeholder="Ціна"
                value={newPart.price}
                onChange={e => setNewPart(p => ({ ...p, price: e.target.value }))}
                min="0"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPart}
                disabled={!newPart.goodId || !newPart.warehouseId || saving}
                className="h-9 w-9 p-0 shrink-0"
                title="Додати товар"
                aria-label="Додати товар"
              >
                <Plus className="h-4 w-4" />
              </Button>
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
