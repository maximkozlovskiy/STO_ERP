'use client';

import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { kyivToday } from '@/lib/format';
import { displayCounterpartyName } from '@/lib/utils';
import { WO_PRIORITY_LABELS, WO_CATEGORY_LABELS } from '@sto/shared';
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
interface WOTemplate {
  id: string;
  name: string;
  lines: { workId: string; quantity: number }[];
  parts: { goodId: string; quantity: number }[];
}

export interface CreateWOPrefill {
  counterpartyId?: string;
  counterpartyDisplay?: string;
  vehicleId?: string;
  branchId?: string;
  description?: string;
}

export interface CreatedWorkOrder {
  id: string;
  number: string;
  counterpartyId: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after successful creation */
  onCreated?: (wo: CreatedWorkOrder) => void;
  /** Pre-filled values from calendar slot */
  prefill?: CreateWOPrefill;
}

export function CreateWorkOrderModal({ open, onClose, onCreated, prefill }: Props) {
  const [form, setForm] = useState({
    branchId: '',
    vehicleId: '',
    counterpartyId: '',
    description: '',
    inMileage: '',
    plannedAt: '',
    priority: 'NORMAL',
    repairCategory: '',
    dueDate: '',
    documentDate: kyivToday(),
  });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [templates, setTemplates] = useState<WOTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<WOTemplate | null>(null);
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const vehicleReqRef = useRef(0);
  const branchesRef = useRef(branches);
  branchesRef.current = branches;

  // Load branches + templates once on mount
  useEffect(() => {
    let cancelled = false;
    const cachedBranches = getCached<Branch[]>('cache:branches');
    const cachedTemplates = getCached<WOTemplate[]>('cache:wo-templates');
    if (cachedBranches && cachedTemplates) {
      setBranches(cachedBranches);
      setTemplates(cachedTemplates);
      return;
    }
    Promise.all([
      apiFetch<Branch[]>('/branches'),
      apiFetch<{ items: WOTemplate[] }>('/work-order-templates?limit=100'),
    ])
      .then(([bs, tmpl]) => {
        if (cancelled) return;
        setBranches(bs);
        setTemplates(tmpl.items);
        setCache('cache:branches', bs);
        setCache('cache:wo-templates', tmpl.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply prefill + auto-select single branch when modal opens
  useEffect(() => {
    if (!open) return;
    setError('');
    setSelectedTemplate(null);
    setVehicles([]);
    setForm({
      branchId: prefill?.branchId ?? '',
      vehicleId: prefill?.vehicleId ?? '',
      counterpartyId: prefill?.counterpartyId ?? '',
      description: prefill?.description ?? '',
      inMileage: '',
      plannedAt: '',
      priority: 'NORMAL',
      repairCategory: '',
      dueDate: '',
      documentDate: kyivToday(),
    });
    setCounterpartyDisplayName(prefill?.counterpartyDisplay ?? '');

    // Auto-select single branch (cache → already-loaded state → defer to branches effect)
    if (!prefill?.branchId) {
      const src = getCached<Branch[]>('cache:branches') ?? branchesRef.current;
      if (src.length === 1) setForm(f => ({ ...f, branchId: src[0].id }));
    }

    // Load vehicles for prefilled counterparty
    if (prefill?.counterpartyId) {
      loadVehicles(prefill.counterpartyId, prefill.vehicleId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // After branches load, auto-select if single
  useEffect(() => {
    if (branches.length === 1) {
      setForm(f => (f.branchId ? f : { ...f, branchId: branches[0].id }));
    }
  }, [branches]);

  const loadVehicles = (counterpartyId: string, keepVehicleId?: string) => {
    if (!counterpartyId) return;
    const reqId = ++vehicleReqRef.current;
    apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${counterpartyId}`)
      .then(list => {
        if (reqId !== vehicleReqRef.current) return;
        const all = Array.isArray(list) ? list : [];
        setVehicles(all);
        if (keepVehicleId && all.some(v => v.id === keepVehicleId)) return;
        if (all.length === 1) setForm(f => (f.vehicleId ? f : { ...f, vehicleId: all[0].id }));
      })
      .catch(() => {});
  };

  const create = async () => {
    const mileage = form.inMileage ? Number(form.inMileage) : undefined;
    if (mileage !== undefined && (!Number.isFinite(mileage) || mileage < 0)) {
      setError("Пробіг повинен бути невід'ємним числом");
      return;
    }
    setSaving(true);
    setError('');
    try {
      const wo = await apiFetch<CreatedWorkOrder>('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          branchId: form.branchId,
          vehicleId: form.vehicleId,
          counterpartyId: form.counterpartyId,
          description: form.description || undefined,
          inMileage: mileage,
          plannedAt: form.plannedAt || undefined,
          priority: form.priority || 'NORMAL',
          repairCategory: form.repairCategory || undefined,
          dueDate: form.dueDate || undefined,
          documentDate: form.documentDate || undefined,
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

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Новий наряд"
        description="Заповніть дані для створення наряду"
        size="full"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.branchId || !form.vehicleId || !form.counterpartyId}
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

        <div className="space-y-4">
          {/* Рядок 1: Клієнт + Автомобіль */}
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
                  setForm(f => ({ ...f, counterpartyId: '', vehicleId: '' }));
                  setVehicles([]);
                }}
                hidePick={false}
              />
            </div>
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
          </div>

          {/* Рядок 2: Філія + Шаблон */}
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
            {templates.length > 0 ? (
              <div>
                <Select
                  label="Шаблон (необов'язково)"
                  value={selectedTemplate?.id ?? ''}
                  onChange={e => {
                    const tpl = templates.find(t => t.id === e.target.value) ?? null;
                    setSelectedTemplate(tpl);
                    if (tpl)
                      setForm(f => ({
                        ...f,
                        description: `Створено за шаблоном «${tpl.name}»`,
                      }));
                  }}
                >
                  <option value="">— Без шаблону —</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                {selectedTemplate &&
                  (selectedTemplate.lines.length > 0 || selectedTemplate.parts.length > 0) && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedTemplate.lines.length > 0 && `${selectedTemplate.lines.length} роб.`}
                      {selectedTemplate.lines.length > 0 &&
                        selectedTemplate.parts.length > 0 &&
                        ', '}
                      {selectedTemplate.parts.length > 0 &&
                        `${selectedTemplate.parts.length} запч.`}
                    </p>
                  )}
              </div>
            ) : (
              <div />
            )}
          </div>

          {/* Рядок 3: Опис — повна ширина */}
          <Input
            label="Опис"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Заміна масла, колодок..."
          />

          {/* Рядок 4: Пріоритет + Категорія */}
          <div className="grid grid-cols-2 gap-4">
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

          {/* Рядок 5: Пробіг + Заплановано */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Пробіг (вхід), км"
              type="number"
              value={form.inMileage}
              onChange={e => setForm(f => ({ ...f, inMileage: e.target.value }))}
              placeholder="50000"
            />
            <Input
              label="Заплановано"
              type="datetime-local"
              value={form.plannedAt}
              onChange={e => setForm(f => ({ ...f, plannedAt: e.target.value }))}
            />
          </div>

          {/* Рядок 6: Дедлайн + Дата документа */}
          <div className="grid grid-cols-2 gap-4">
            <DatePickerInput
              label="Дедлайн"
              value={form.dueDate}
              onChange={v => setForm(f => ({ ...f, dueDate: v }))}
            />
            <DatePickerInput
              label="Дата документа"
              value={form.documentDate}
              onChange={v => setForm(f => ({ ...f, documentDate: v }))}
            />
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
          setForm(f => ({ ...f, counterpartyId: cp.id, vehicleId: '' }));
          loadVehicles(cp.id);
        }}
      />
    </>
  );
}
