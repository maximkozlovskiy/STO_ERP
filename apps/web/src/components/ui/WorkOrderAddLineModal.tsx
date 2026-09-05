'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';

interface Work {
  id: string;
  name: string;
  normoHours: number;
  price: number;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
}

interface WorkOrderAddLineModalProps {
  open: boolean;
  workOrderId: string;
  works: Work[];
  employees: Employee[];
  onClose: () => void;
  onAdded: () => void;
}

const EMPTY_FORM = {
  workId: '',
  employeeId: '',
  normoHours: '',
  actualHours: '',
  price: '',
  notes: '',
};

export function WorkOrderAddLineModal({
  open,
  workOrderId,
  works,
  employees,
  onClose,
  onAdded,
}: WorkOrderAddLineModalProps) {
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // WEB-H3 (Bug #635, клас Bug #630): синхронний guard проти concurrent double-submit.
  // Кнопка «Додати» disabled лише за !workId/!employeeId (не saving) → два same-tick кліки
  // → 2× POST /lines → дубль роботи (подвійне нарахування праці). Ref фліпається синхронно.
  const savingRef = useRef(false);
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError('');
      dirty.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectWork = useCallback(
    (workId: string) => {
      const w = works.find(x => x.id === workId);
      setForm(f => ({
        ...f,
        workId,
        normoHours: w ? String(w.normoHours) : f.normoHours,
        price: w ? String(w.price) : f.price,
      }));
      dirty.markDirty();
    },
    [works, dirty],
  );

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    onClose();
  }, [dirty, onClose]);

  const handleAdd = async () => {
    if (savingRef.current) return;
    setSavingBoth(true);
    setError('');
    try {
      await apiFetch(`/work-orders/${workOrderId}/lines`, {
        method: 'POST',
        body: JSON.stringify({
          workId: form.workId,
          employeeId: form.employeeId,
          normoHours: form.normoHours ? Number(form.normoHours) : undefined,
          actualHours: form.actualHours ? Number(form.actualHours) : undefined,
          price: form.price ? Number(form.price) : undefined,
          notes: form.notes || undefined,
        }),
      });
      dirty.resetDirty();
      if (features.toastEnabled) toast.success('Роботу додано');
      onAdded();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSavingBoth(false);
    }
  };

  return (
    <>
      <Modal open={open} onClose={handleClose} title="Додати роботу">
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Робота <span className="text-destructive">*</span>
            </label>
            <Select value={form.workId} onChange={e => selectWork(e.target.value)}>
              <option value="">— Оберіть —</option>
              {works.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Виконавець <span className="text-destructive">*</span>
            </label>
            <Select
              value={form.employeeId}
              onChange={e => {
                setForm(f => ({ ...f, employeeId: e.target.value }));
                dirty.markDirty();
              }}
            >
              <option value="">— Оберіть —</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.lastName} {e.firstName}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Нормо-год (план)
              </label>
              <Input
                type="number"
                value={form.normoHours}
                onChange={e => {
                  setForm(f => ({ ...f, normoHours: e.target.value }));
                  dirty.markDirty();
                }}
                min="0"
                step="0.1"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1.5">
                Факт. год
              </label>
              <Input
                type="number"
                value={form.actualHours}
                onChange={e => {
                  setForm(f => ({ ...f, actualHours: e.target.value }));
                  dirty.markDirty();
                }}
                min="0"
                step="0.1"
                placeholder="необов'язково"
              />
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Ціна, ₴</label>
            <Input
              type="number"
              value={form.price}
              onChange={e => {
                setForm(f => ({ ...f, price: e.target.value }));
                dirty.markDirty();
              }}
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Нотатки</label>
            <Input
              value={form.notes}
              onChange={e => {
                setForm(f => ({ ...f, notes: e.target.value }));
                dirty.markDirty();
              }}
            />
          </div>
          <Button
            onClick={handleAdd}
            loading={saving}
            disabled={!form.workId || !form.employeeId}
            className="w-full"
          >
            Додати
          </Button>
        </div>
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
