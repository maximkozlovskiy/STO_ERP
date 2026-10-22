'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useLiftMechanics } from '@/hooks/api/useLiftMechanics';
import {
  pickLineExecutor,
  slotMechanicId,
  type LinkedSlotMechanic,
} from '@/lib/work-line-executor';

/**
 * Додавання роботи в наряд.
 *
 * `void` перед `handleAdd()` / `handleClose()` у JSX: `handleAdd` має власний try/catch, що
 * пише текст відмови у `error` (рендериться над формою) і в `toast.error`, плюс
 * `finally { setSavingBoth(false) }`; єдиний `await` у `handleClose` — `dirty.confirmClose()`,
 * який ніколи не реджектиться (резолвиться з діалогу). Користувач уже бачить результат,
 * тож проміс обробника нікому не потрібен.
 */

interface Work {
  id: string;
  name: string;
  normoHours: number;
  price: number;
  categoryId?: string | null;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  status?: string;
  /** Категорії робіт механіка (BR-WO-030); у кеші довідника їх немає. */
  workCategoryIds?: readonly string[] | null;
}

interface WorkOrderAddLineModalProps {
  open: boolean;
  workOrderId: string;
  /** Підйомник наряду: його єдиний механік — виконавець нової роботи (BR-WO-030). */
  liftId?: string | null;
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
  liftId,
  employees,
  onClose,
  onAdded,
}: WorkOrderAddLineModalProps) {
  const { t } = useTranslation('workOrders');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const [form, setForm] = useState(EMPTY_FORM);
  // Обрана робота — з пошуку на сервері (`/works?q=`), а не зі списку перших 200 довідника:
  // роботи далі за алфавітом були недосяжні (рішення власника 2026-10-22).
  const [work, setWork] = useState<Work | null>(null);
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
  // BR-WO-030: виконавця обрала людина — автопідстановка його не перезаписує.
  const executorManualRef = useRef(false);
  const [calendarMechanicId, setCalendarMechanicId] = useState<string | null>(null);
  const liftMechanics = useLiftMechanics(open ? liftId : null);
  const activeMechanicIds = useMemo(() => employees.map(e => e.id), [employees]);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setWork(null);
      setError('');
      executorManualRef.current = false;
      dirty.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Механік запису наряду в календарі — на кожне відкриття: запис міг змінитись у календарі.
  // Збій — запису «немає», діє решта правила.
  useEffect(() => {
    setCalendarMechanicId(null);
    if (!open) return;
    const ac = new AbortController();
    apiFetch<{ calendarSlots: LinkedSlotMechanic[] }>(
      `/work-orders/${workOrderId}/linked-documents`,
      { signal: ac.signal },
    ).then(
      d => {
        if (!ac.signal.aborted) setCalendarMechanicId(slotMechanicId(d.calendarSlots));
      },
      () => {},
    );
    return () => ac.abort();
  }, [open, workOrderId]);

  // Виконавець підставляється, щойно обрано роботу, і стежить за даними правила, що приходять
  // пізніше (механіки підйомника, запис календаря), — доки його не обрала людина.
  const workCategoryId = work?.categoryId ?? null;
  useEffect(() => {
    if (!open || !form.workId || executorManualRef.current) return;
    const employeeId = pickLineExecutor({
      calendarMechanicId,
      liftMechanics,
      workCategoryId,
      activeMechanicIds,
      mechanics: employees,
    });
    setForm(f =>
      f.workId && !executorManualRef.current && f.employeeId !== employeeId
        ? { ...f, employeeId }
        : f,
    );
  }, [
    open,
    form.workId,
    workCategoryId,
    calendarMechanicId,
    liftMechanics,
    activeMechanicIds,
    employees,
  ]);

  const selectWork = useCallback(
    (w: Work | null) => {
      setWork(w);
      setForm(f => ({
        ...f,
        workId: w?.id ?? '',
        normoHours: w ? String(w.normoHours) : f.normoHours,
        price: w ? String(w.price) : f.price,
      }));
      dirty.markDirty();
    },
    [dirty],
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
      if (features.toastEnabled) toast.success(t('toast.lineAdded'));
      onAdded();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('common:error');
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSavingBoth(false);
    }
  };

  return (
    <>
      <Modal open={open} onClose={() => void handleClose()} title={t('addLine.title')}>
        <div className="space-y-3">
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <div>
            <SearchCombobox<Work>
              label={t('addLine.work')}
              required
              placeholder={t('worksTable.searchPlaceholder')}
              value={form.workId}
              displayValue={work?.name ?? ''}
              onSelect={selectWork}
              onClear={() => selectWork(null)}
              fetchItems={q =>
                apiFetch<{ items: Work[] }>(`/works?q=${encodeURIComponent(q)}&limit=20`).then(r =>
                  r.items.map(w => ({ ...w, primary: w.name })),
                )
              }
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('addLine.executor')} <span className="text-destructive">*</span>
            </label>
            <Select
              value={form.employeeId}
              onChange={e => {
                executorManualRef.current = true;
                setForm(f => ({ ...f, employeeId: e.target.value }));
                dirty.markDirty();
              }}
            >
              <option value="">{t('addLine.choose')}</option>
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
                {t('addLine.normoHoursPlan')}
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
                {t('addLine.actualHours')}
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
                placeholder={t('addLine.optional')}
              />
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('addLine.price')}
            </label>
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
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('addLine.notes')}
            </label>
            <Input
              value={form.notes}
              onChange={e => {
                setForm(f => ({ ...f, notes: e.target.value }));
                dirty.markDirty();
              }}
            />
          </div>
          <Button
            onClick={() => void handleAdd()}
            loading={saving}
            disabled={!form.workId || !form.employeeId}
            className="w-full"
          >
            {t('common:add')}
          </Button>
        </div>
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
