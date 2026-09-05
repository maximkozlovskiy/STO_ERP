'use client';

import { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { EMPLOYEE_STATUS_LABELS, EMPLOYEE_ROLE_LABELS } from '@sto/shared';
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

const ROLE_LABELS = EMPLOYEE_ROLE_LABELS;
const STATUS_LABELS = EMPLOYEE_STATUS_LABELS;
const RATE_LABELS: Record<string, string> = {
  percent_normo: '% від норма-год',
  fixed_plus_bonus: 'Ставка + бонус',
};

const EMPTY_FORM = {
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

  const [form, setForm] = useState(EMPTY_FORM);
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
      setForm({
        firstName: employee.firstName,
        lastName: employee.lastName,
        role: employee.role,
        phone: employee.phone ?? '',
        email: employee.email ?? '',
        status: employee.status as string,
        dateOfHire: employee.dateOfHire ? employee.dateOfHire.slice(0, 10) : '',
        dateOfFire: employee.dateOfFire ? employee.dateOfFire.slice(0, 10) : '',
        rateType: rs?.type ?? 'percent_normo',
        percent: rs?.type === 'percent_normo' ? String(rs.params.percent ?? 40) : '40',
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
      setForm({ ...EMPTY_FORM });
      setZoneIds([]);
      setLiftIds([]);
      setWorkCatIds([]);
      setBranchIds([]);
      setAllBranches(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee?.id]);

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

  const buildRateScheme = () => {
    if (form.rateType === 'percent_normo') {
      const pct = Number(form.percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        setError('Відсоток має бути від 1 до 100');
        return null;
      }
      return { type: 'percent_normo', params: { percent: pct } };
    }
    const fixed = Number(form.fixedMonthly);
    const bonus = Number(form.bonusPercent);
    if (!Number.isFinite(fixed) || fixed < 0) {
      setError("Фіксована ставка повинна бути невід'ємним числом");
      return null;
    }
    if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) {
      setError('Бонус має бути від 0 до 100');
      return null;
    }
    return {
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: fixed, bonusPercent: bonus },
    };
  };

  const save = async () => {
    if (savingRef.current) return;
    setError('');
    if (!isEdit && form.grantAccess) {
      // trim перед перевіркою — інакше whitespace-only '   ' проходить
      // як truthy і нерозбірливий backend `@IsEmail` помилка показується замість
      // зрозумілого «Вкажіть email для входу».
      if (!form.loginEmail.trim()) {
        setError('Вкажіть email для входу');
        return;
      }
      if (!form.password) {
        setError('Вкажіть пароль');
        return;
      }
      if (form.password.length < 6) {
        setError('Пароль має бути не менше 6 символів');
        return;
      }
    }
    const rateScheme = buildRateScheme();
    if (!rateScheme) return;
    setSavingBoth(true);
    try {
      const payload = {
        firstName: form.firstName,
        lastName: form.lastName,
        role: form.role,
        phone: form.phone || undefined,
        email: form.email || undefined,
        status: form.status,
        dateOfHire: form.dateOfHire || undefined,
        dateOfFire: form.dateOfFire || undefined,
        rateScheme,
        ...(!isEdit &&
          form.grantAccess && {
            loginEmail: form.loginEmail,
            password: form.password,
          }),
      };
      const saved = isEdit
        ? await apiFetch<EmployeeForModal>(`/employees/${employee!.id}`, {
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
  };

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
            <Button onClick={save} loading={saving} disabled={!form.firstName || !form.lastName}>
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
              value={form.firstName}
              onChange={e => {
                setForm(f => ({ ...f, firstName: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              required
              value={form.lastName}
              onChange={e => {
                setForm(f => ({ ...f, lastName: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="Коваль"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Посада"
              required
              value={form.role}
              onChange={e => {
                setForm(f => ({ ...f, role: e.target.value }));
                dirty.markDirty();
              }}
            >
              {Object.entries(ROLE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select
              label="Статус"
              value={form.status}
              onChange={e => {
                setForm(f => ({ ...f, status: e.target.value }));
                dirty.markDirty();
              }}
            >
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
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
              value={form.email}
              onChange={e => {
                setForm(f => ({ ...f, email: e.target.value }));
                dirty.markDirty();
              }}
              placeholder="ivan@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DatePickerInput
              label="Дата прийому"
              value={form.dateOfHire}
              onChange={v => {
                setForm(f => ({ ...f, dateOfHire: v }));
                dirty.markDirty();
              }}
            />
            {isEdit && (
              <DatePickerInput
                label="Дата звільнення"
                value={form.dateOfFire}
                onChange={v => {
                  setForm(f => ({ ...f, dateOfFire: v }));
                  dirty.markDirty();
                }}
              />
            )}
          </div>
          <Select
            label="Схема нарахування"
            required
            value={form.rateType}
            onChange={e => {
              setForm(f => ({ ...f, rateType: e.target.value }));
              dirty.markDirty();
            }}
          >
            {Object.entries(RATE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          {form.rateType === 'percent_normo' && (
            <Input
              label="Відсоток, %"
              type="number"
              min="0"
              value={form.percent}
              onChange={e => {
                setForm(f => ({ ...f, percent: e.target.value }));
                dirty.markDirty();
              }}
            />
          )}
          {form.rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ставка, грн/міс"
                type="number"
                min="0"
                value={form.fixedMonthly}
                onChange={e => {
                  setForm(f => ({ ...f, fixedMonthly: e.target.value }));
                  dirty.markDirty();
                }}
              />
              <Input
                label="Бонус, %"
                type="number"
                min="0"
                value={form.bonusPercent}
                onChange={e => {
                  setForm(f => ({ ...f, bonusPercent: e.target.value }));
                  dirty.markDirty();
                }}
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
                checked={form.grantAccess}
                onChange={e => {
                  setForm(f => ({ ...f, grantAccess: e.target.checked }));
                  dirty.markDirty();
                }}
                className="rounded border-border w-4 h-4"
              />
              <span className="text-[13px] font-medium text-foreground">
                Надати доступ до системи
              </span>
            </label>
            {form.grantAccess && (
              <div className="grid grid-cols-2 gap-3 px-4 pb-4 border-t border-border pt-3">
                <Input
                  label="Email для входу (логін)"
                  required
                  type="email"
                  value={form.loginEmail}
                  onChange={e => {
                    setForm(f => ({ ...f, loginEmail: e.target.value }));
                    dirty.markDirty();
                  }}
                  placeholder="ivan@sto.local"
                />
                <Input
                  label="Пароль"
                  required
                  type="password"
                  value={form.password}
                  onChange={e => {
                    setForm(f => ({ ...f, password: e.target.value }));
                    dirty.markDirty();
                  }}
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
