'use client';

import { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_ROLE_LABELS,
  employeeFormSchema,
  buildRateScheme,
  type EmployeeFormInput,
  type EmployeeFormValues,
  type RateType,
} from '@sto/shared';
import { employeeStatusLabel, employeeRoleLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { ModalTabs } from '@/components/ui/modal-tabs';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmployeeForModal {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  phone: string | null;
  email?: string | null;
  status: 'ACTIVE' | 'ON_LEAVE' | 'FIRED';
  dateOfHire?: string | null;
  dateOfFire?: string | null;
  rateScheme?: { type: string; params: Record<string, number> };
  zoneIds: string[];
  liftIds: string[];
  workCategoryIds: string[];
  branchIds: string[];
  allBranches: boolean;
  deletedAt?: string | null;
}

interface Zone {
  id: string;
  name: string;
  type: string;
}

interface Lift {
  id: string;
  name: string;
  type: string;
}

interface WorkCategory {
  id: string;
  name: string;
  parentId: string | null;
  children: WorkCategory[];
}

interface Branch {
  id: string;
  name: string;
  address: string;
}

interface EmployeeEditModalProps {
  open: boolean;
  /** null = create new */
  employee: EmployeeForModal | null;
  onClose: () => void;
  onSaved: (emp: EmployeeForModal) => void;
}

const RATE_LABELS: Record<string, string> = {
  percent_normo: '% від норма-год',
  per_normo_hour: 'Ставка × нормо-год',
  fixed_plus_bonus: 'Ставка + бонус',
};

const EMPTY_FORM: EmployeeFormInput = {
  firstName: '',
  lastName: '',
  role: 'MECHANIC',
  phone: '',
  email: '',
  status: 'ACTIVE',
  dateOfHire: '',
  dateOfFire: '',
  rateType: 'percent_normo',
  percent: '40',
  ratePerHour: '0',
  fixedMonthly: '0',
  bonusPercent: '10',
  grantAccess: false,
  loginEmail: '',
  password: '',
};

function flattenTree(cats: WorkCategory[]): { id: string; name: string }[] {
  return cats.flatMap(c => [{ id: c.id, name: c.name }, ...flattenTree(c.children)]);
}

// sto-optimize: memo обгортка — при typing у firstName/lastName/email батьківський
// компонент re-renderя кожен keystroke, але items/selected references зазвичай стабільні
// (зміни тільки при toggle або після ref-data fetch). Без memo — N×CheckboxList × M items
// re-renderя на кожен keystroke у формі (помітно при 50+ work-categories).
const CheckboxList = memo(function CheckboxList({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="mb-3">
      {label && (
        <label className="block text-[13px] font-medium text-foreground mb-2">{label}</label>
      )}
      <div className="border border-border rounded-lg max-h-36 overflow-y-auto divide-y divide-border">
        {items.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">Немає записів</p>
        )}
        {items.map(item => (
          <label
            key={item.id}
            className="flex items-center gap-2 px-3 py-2 hover:bg-secondary cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={() => toggle(item.id)}
              className="rounded border-border"
            />
            <span className="text-[13px] text-foreground">{item.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
});

// ─── Component ────────────────────────────────────────────────────────────────

export function EmployeeEditModal({ open, employee, onClose, onSaved }: EmployeeEditModalProps) {
  const isEdit = !!employee;
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<EmployeeFormInput, unknown, EmployeeFormValues>({
    resolver: i18nZodResolver(employeeFormSchema),
    defaultValues: EMPTY_FORM,
    mode: 'onBlur',
  });
  const rateType = watch('rateType');
  const grantAccess = watch('grantAccess');

  const [saving, setSaving] = useState(false);
  // WEB-H3 (Bug #633, клас Bug #630): синхронний guard проти concurrent double-submit.
  // save() робить кілька послідовних POST (employee + auth-account) — подвійний клік
  // у одному tick дав би дубль співробітника + дубль auth-акаунта. Ref фліпається
  // синхронно ДО React state-flush, `loading={saving}` вимикає кнопку лише пізніше.
  const savingRef = useRef(false);
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const [error, setError] = useState('');

  // Reference data
  const [zones, setZones] = useState<Zone[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [workCategories, setWorkCategories] = useState<WorkCategory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  // Assignment state
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [liftIds, setLiftIds] = useState<string[]>([]);
  const [workCatIds, setWorkCatIds] = useState<string[]>([]);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [allBranches, setAllBranches] = useState(false);

  // Load reference data lazily when modal opens
  useEffect(() => {
    if (!open) return;
    // Race guard: повторне відкриття/закриття під час in-flight fetch не має дати
    // застарілій відповіді перезаписати актуальні довідники. setCache лишається
    // безумовним (кеш — не стан компонента), setState — лише коли не cancelled.
    let cancelled = false;
    const cZones = getCached<Zone[]>('cache:zones');
    const cLifts = getCached<Lift[]>('cache:lifts');
    const cCats = getCached<WorkCategory[]>('cache:work-categories');
    const cBranches = getCached<Branch[]>('cache:branches');
    if (cZones) setZones(cZones);
    if (cLifts) setLifts(cLifts);
    if (cCats) setWorkCategories(cCats);
    if (cBranches) setBranches(cBranches);

    Promise.all([
      apiFetch<Zone[]>('/zones').catch(() => [] as Zone[]),
      apiFetch<Lift[]>('/lifts').catch(() => [] as Lift[]),
      apiFetch<WorkCategory[]>('/work-categories').catch(() => [] as WorkCategory[]),
      apiFetch<Branch[]>('/branches').catch(() => [] as Branch[]),
    ]).then(([z, l, c, b]) => {
      setCache('cache:zones', z);
      setCache('cache:lifts', l);
      setCache('cache:work-categories', c);
      setCache('cache:branches', b);
      if (cancelled) return;
      setZones(z);
      setLifts(l);
      setWorkCategories(c);
      setBranches(b);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset form when employee changes
  useEffect(() => {
    if (!open) return;
    setError('');
    dirty.resetDirty();
    if (employee) {
      const rs = employee.rateScheme;
      reset({
        firstName: employee.firstName,
        lastName: employee.lastName,
        role: employee.role as EmployeeFormInput['role'],
        phone: employee.phone ?? '',
        email: employee.email ?? '',
        status: employee.status,
        dateOfHire: employee.dateOfHire ? employee.dateOfHire.slice(0, 10) : '',
        dateOfFire: employee.dateOfFire ? employee.dateOfFire.slice(0, 10) : '',
        rateType: (rs?.type ?? 'percent_normo') as RateType,
        percent: rs?.type === 'percent_normo' ? String(rs.params.percent ?? 40) : '40',
        ratePerHour: rs?.type === 'per_normo_hour' ? String(rs.params.ratePerHour ?? 0) : '0',
        fixedMonthly: rs?.type === 'fixed_plus_bonus' ? String(rs.params.fixedMonthly ?? 0) : '0',
        bonusPercent: rs?.type === 'fixed_plus_bonus' ? String(rs.params.bonusPercent ?? 10) : '10',
        grantAccess: false,
        loginEmail: '',
        password: '',
      });
      setZoneIds(employee.zoneIds ?? []);
      setLiftIds(employee.liftIds ?? []);
      setWorkCatIds(employee.workCategoryIds ?? []);
      setBranchIds(employee.branchIds ?? []);
      setAllBranches(employee.allBranches ?? false);
    } else {
      reset({ ...EMPTY_FORM });
      setZoneIds([]);
      setLiftIds([]);
      setWorkCatIds([]);
      setBranchIds([]);
      setAllBranches(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee?.id]);

  // Міст RHF isDirty → useDirtyForm (assignment-масиви вже кличуть markDirty окремо;
  // тут лише ДОДАЄМО dirty від полів форми, не скидаємо — щоб не затерти assignment-dirty).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    onClose();
  }, [dirty, onClose]);

  // sto-optimize: stable handlers + memoized flatCats — без них memo на CheckboxList
  // марний бо нові onChange refs на кожен render форми (typing у будь-якому input
  // тригерить весь компонент). flatCats теж recompute на кожен render без useMemo.
  const handleZoneChange = useCallback(
    (ids: string[]) => {
      setZoneIds(ids);
      dirty.markDirty();
    },
    [dirty.markDirty],
  );
  const handleLiftChange = useCallback(
    (ids: string[]) => {
      setLiftIds(ids);
      dirty.markDirty();
    },
    [dirty.markDirty],
  );
  const handleWorkCatChange = useCallback(
    (ids: string[]) => {
      setWorkCatIds(ids);
      dirty.markDirty();
    },
    [dirty.markDirty],
  );
  const handleBranchChange = useCallback(
    (ids: string[]) => {
      setBranchIds(ids);
      dirty.markDirty();
    },
    [dirty.markDirty],
  );

  // Валідація через zodResolver (per-field + крос-польові superRefine). onValid отримує
  // коерснуті значення (числа — number); nested rateScheme будуємо спільним buildRateScheme.
  const save = handleSubmit(async values => {
    if (savingRef.current) return;
    setError('');
    const rateScheme = buildRateScheme({
      rateType: values.rateType,
      percent: values.percent,
      ratePerHour: values.ratePerHour,
      fixedMonthly: values.fixedMonthly,
      bonusPercent: values.bonusPercent,
    });
    setSavingBoth(true);
    try {
      const payload = {
        firstName: values.firstName,
        lastName: values.lastName,
        role: values.role,
        phone: values.phone || undefined,
        email: values.email || undefined,
        status: values.status,
        dateOfHire: values.dateOfHire || undefined,
        dateOfFire: values.dateOfFire || undefined,
        rateScheme,
        ...(!isEdit &&
          values.grantAccess && {
            loginEmail: values.loginEmail,
            password: values.password,
          }),
      };
      const saved = isEdit
        ? await apiFetch<EmployeeForModal>(`/employees/${employee.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await apiFetch<EmployeeForModal>('/employees', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
      // Save assignments only for edit (create doesn't expose assignments yet)
      if (isEdit && employee) {
        await Promise.all([
          apiFetch<void>(`/employees/${employee.id}/branches`, {
            method: 'POST',
            body: JSON.stringify({
              branchIds: allBranches ? [] : branchIds,
              allBranches,
            }),
          }),
          apiFetch<void>(`/employees/${employee.id}/zones`, {
            method: 'POST',
            body: JSON.stringify({ zoneIds }),
          }),
          apiFetch<void>(`/employees/${employee.id}/lifts`, {
            method: 'POST',
            body: JSON.stringify({ liftIds }),
          }),
          apiFetch<void>(`/employees/${employee.id}/work-categories`, {
            method: 'POST',
            body: JSON.stringify({ workCategoryIds: workCatIds }),
          }),
        ]);
      }
      dirty.resetDirty();
      onSaved(saved);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  });

  const flatCats = useMemo(() => flattenTree(workCategories), [workCategories]);

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={
          isEdit && employee ? `${employee.lastName} ${employee.firstName}` : 'Новий співробітник'
        }
        size="lg"
        footer={
          <>
            <Button onClick={save} loading={saving}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={handleClose}>
              Скасувати
            </Button>
          </>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ім'я"
              required
              {...register('firstName')}
              errorMessage={errors.firstName?.message}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              required
              {...register('lastName')}
              errorMessage={errors.lastName?.message}
              placeholder="Коваль"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Посада"
              required
              {...register('role')}
              errorMessage={errors.role?.message}
            >
              {Object.keys(EMPLOYEE_ROLE_LABELS).map(k => (
                <option key={k} value={k}>
                  {employeeRoleLabel(k)}
                </option>
              ))}
            </Select>
            <Select label="Статус" {...register('status')} errorMessage={errors.status?.message}>
              {Object.keys(EMPLOYEE_STATUS_LABELS).map(k => (
                <option key={k} value={k}>
                  {employeeStatusLabel(k)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Controller
              control={control}
              name="phone"
              render={({ field }) => (
                <PhoneInput
                  label="Телефон"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={field.onChange}
                />
              )}
            />
            <Input
              label="Email"
              {...register('email')}
              errorMessage={errors.email?.message}
              placeholder="ivan@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Controller
              control={control}
              name="dateOfHire"
              render={({ field }) => (
                <DatePickerInput
                  label="Дата прийому"
                  value={typeof field.value === 'string' ? field.value : ''}
                  onChange={field.onChange}
                />
              )}
            />
            {isEdit && (
              <Controller
                control={control}
                name="dateOfFire"
                render={({ field }) => (
                  <DatePickerInput
                    label="Дата звільнення"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  />
                )}
              />
            )}
          </div>
          <Select
            label="Схема нарахування"
            required
            {...register('rateType')}
            errorMessage={errors.rateType?.message}
          >
            {Object.entries(RATE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          {rateType === 'percent_normo' && (
            <Input
              label="Відсоток, %"
              type="number"
              min="0"
              {...register('percent')}
              errorMessage={errors.percent?.message}
            />
          )}
          {rateType === 'per_normo_hour' && (
            <Input
              label="Ставка, ₴/нормо-год"
              type="number"
              min="0"
              {...register('ratePerHour')}
              errorMessage={errors.ratePerHour?.message}
            />
          )}
          {rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ставка, ₴/міс"
                type="number"
                min="0"
                {...register('fixedMonthly')}
                errorMessage={errors.fixedMonthly?.message}
              />
              <Input
                label="Бонус, %"
                type="number"
                min="0"
                {...register('bonusPercent')}
                errorMessage={errors.bonusPercent?.message}
              />
            </div>
          )}
        </div>

        {/* Доступ до системи — тільки при створенні */}
        {!isEdit && (
          <div className="mt-4 border border-border rounded-lg overflow-hidden">
            <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary transition-colors">
              <input
                type="checkbox"
                {...register('grantAccess')}
                className="rounded border-border w-4 h-4"
              />
              <span className="text-[13px] font-medium text-foreground">
                Надати доступ до системи
              </span>
            </label>
            {grantAccess && (
              <div className="grid grid-cols-2 gap-3 px-4 pb-4 border-t border-border pt-3">
                <Input
                  label="Email для входу (логін)"
                  required
                  type="email"
                  {...register('loginEmail')}
                  errorMessage={errors.loginEmail?.message}
                  placeholder="ivan@sto.local"
                />
                <Input
                  label="Пароль"
                  required
                  type="password"
                  {...register('password')}
                  errorMessage={errors.password?.message}
                  placeholder="Мін. 6 символів"
                />
              </div>
            )}
          </div>
        )}

        {/* Assignments tabs — only for edit */}
        {isEdit && (
          <ModalTabs
            tabs={[
              {
                key: 'zones',
                label: 'Зони та підйомники',
                count: zoneIds.length + liftIds.length,
                content: (
                  <div className="grid grid-cols-2 gap-4">
                    <CheckboxList
                      label="Зони"
                      items={zones}
                      selected={zoneIds}
                      onChange={handleZoneChange}
                    />
                    <CheckboxList
                      label="Підйомники"
                      items={lifts}
                      selected={liftIds}
                      onChange={handleLiftChange}
                    />
                  </div>
                ),
              },
              {
                key: 'categories',
                label: 'Категорії робіт',
                count: workCatIds.length,
                content: (
                  <CheckboxList
                    label=""
                    items={flatCats}
                    selected={workCatIds}
                    onChange={handleWorkCatChange}
                  />
                ),
              },
              ...(branches.length > 0
                ? [
                    {
                      key: 'branches',
                      label: 'Філії',
                      content: (
                        <div className="space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={allBranches}
                              onChange={e => {
                                setAllBranches(e.target.checked);
                                dirty.markDirty();
                              }}
                              className="rounded border-border"
                            />
                            <span className="text-[13px] text-foreground">
                              Доступ до всіх філій
                            </span>
                          </label>
                          {!allBranches && (
                            <CheckboxList
                              label=""
                              items={branches}
                              selected={branchIds}
                              onChange={handleBranchChange}
                            />
                          )}
                          <p className="text-[12px] text-muted-foreground">
                            OWNER та ADMIN мають доступ до всіх філій автоматично.
                          </p>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
