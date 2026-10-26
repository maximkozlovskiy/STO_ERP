'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupplierConnectionCreateValues, SupplierConnectionUpdateValues } from '@sto/shared';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useWarehouses } from '@/hooks/api/useInfrastructure';
import type { SupplierOption } from '@/hooks/api/useCounterparties';
import {
  type SupplierConnection,
  type SupplierFieldSpec,
  type SupplierProviderInfo,
} from '@/hooks/api/useSupplierConnections';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SupplierOptionsSelect } from '@/components/ui/SupplierOptionsSelect';
import { Switch } from '@/components/ui/switch';

type OptionValue = string | boolean;

interface FormState {
  provider: string;
  counterpartyId: string;
  name: string;
  apiUrl: string;
  enabled: boolean;
  testMode: boolean;
  priority: string;
  defaultDeliveryDays: string;
  credentials: Record<string, string>;
  options: Record<string, OptionValue>;
  warehouses: Record<string, Record<string, string>>;
}

const EMPTY: FormState = {
  provider: '',
  counterpartyId: '',
  name: '',
  apiUrl: '',
  enabled: true,
  testMode: false,
  priority: '100',
  defaultDeliveryDays: '',
  credentials: {},
  options: {},
  warehouses: {},
};

function fromConnection(c: SupplierConnection): FormState {
  const { warehouses: rawWh, ...rest } = c.options as Record<string, unknown>;
  const options: Record<string, OptionValue> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === 'boolean' || typeof v === 'string') options[k] = v;
    else if (typeof v === 'number') options[k] = String(v);
  }
  const warehouses: Record<string, Record<string, string>> = {};
  if (rawWh && typeof rawWh === 'object' && !Array.isArray(rawWh)) {
    for (const [whId, entry] of Object.entries(rawWh as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      warehouses[whId] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === 'string' || typeof v === 'number' ? String(v) : '',
        ]),
      );
    }
  }
  return {
    provider: c.provider,
    counterpartyId: c.counterpartyId,
    name: c.name ?? '',
    apiUrl: c.apiUrl ?? '',
    enabled: c.enabled,
    testMode: c.testMode,
    priority: String(c.priority),
    defaultDeliveryDays: c.defaultDeliveryDays === null ? '' : String(c.defaultDeliveryDays),
    credentials: {},
    options,
    warehouses,
  };
}

const isBlank = (v: OptionValue | undefined) => v === undefined || v === '' || v === false;

export interface SupplierConnectionSaveResult {
  connection: SupplierConnection;
  verify: boolean;
}

interface Props {
  open: boolean;
  /** null — нове підключення. */
  connection: SupplierConnection | null;
  providers: SupplierProviderInfo[];
  /** Стан перевірки підключення, відкритого в модалці (з опитуваного списку). */
  live: SupplierConnection | null;
  verifying: boolean;
  onClose: () => void;
  onSave: (
    body: SupplierConnectionCreateValues | SupplierConnectionUpdateValues,
    verify: boolean,
  ) => Promise<void>;
}

/**
 * Картка підключення до API постачальника (BR-SCON-001…003): постачальник API, контрагент,
 * креди лише на запис (порожнє не змінює збережене), опції й мапа «наш склад → параметри
 * постачальника» — з опису провайдера (`GET /supplier-providers`). «Зберегти і перевірити» лишає
 * картку відкритою, доки перевірка не завершиться.
 */
export function SupplierConnectionModal({
  open,
  connection,
  providers,
  live,
  verifying,
  onClose,
  onSave,
}: Props) {
  const { t } = useTranslation('supplierApi');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Обраний контрагент (поточний у підключення чи обраний до пошуку) завжди серед варіантів:
  // інакше картка з контрагентом поза першими 200 відкривалась із порожнім полем (Bug #894).
  const [pickedSupplier, setPickedSupplier] = useState<SupplierOption | null>(null);
  const ownSupplier = useMemo<SupplierOption | null>(
    () =>
      connection ? { id: connection.counterpartyId, name: connection.counterpartyName } : null,
    [connection],
  );
  const { data: warehouses } = useWarehouses();

  useEffect(() => {
    if (!open) return;
    setForm(connection ? fromConnection(connection) : EMPTY);
    setPickedSupplier(null);
    setError('');
    dirty.resetDirty();
    // dirty — стабільні колбеки; синхронізуємо форму лише при відкритті / іншому підключенні.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection?.id]);

  const provider = useMemo(
    () => providers.find(p => p.provider === form.provider) ?? null,
    [providers, form.provider],
  );
  const savedKeys = useMemo(() => new Set(connection?.credentialKeys ?? []), [connection]);
  // Підписи полів з реєстру адаптерів — українською; перекладаємо за (провайдер, поле), підпис
  // сервера — запасний для поля, якого ще немає в каталозі (Bug #892).
  const fieldLabel = (f: SupplierFieldSpec): string =>
    t(`fieldLabels.${form.provider}.${f.key}`, { defaultValue: f.label });

  const patch = (p: Partial<FormState>) => {
    setForm(f => ({ ...f, ...p }));
    dirty.markDirty();
  };

  const validate = (): string | null => {
    if (!form.provider) return t('form.required', { field: t('form.provider') });
    if (!form.counterpartyId) return t('form.required', { field: t('form.counterparty') });
    const priority = Number(form.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000)
      return t('form.priorityRange');
    if (form.defaultDeliveryDays.trim()) {
      const d = Number(form.defaultDeliveryDays);
      if (!Number.isInteger(d) || d < 0 || d > 365) return t('form.daysRange');
    }
    for (const f of provider?.credentialFields ?? []) {
      if (f.required && !form.credentials[f.key]?.trim() && !savedKeys.has(f.key))
        return t('form.required', { field: fieldLabel(f) });
    }
    for (const f of provider?.optionFields ?? []) {
      if (f.required && isBlank(form.options[f.key]))
        return t('form.required', { field: fieldLabel(f) });
    }
    for (const w of warehouses ?? []) {
      const entry = form.warehouses[w.id] ?? {};
      if (!Object.values(entry).some(v => v.trim())) continue;
      const missing = (provider?.warehouseFields ?? []).find(
        f => f.required && !entry[f.key]?.trim(),
      );
      if (missing)
        return t('form.warehouseIncomplete', { warehouse: w.name, field: fieldLabel(missing) });
    }
    return null;
  };

  const buildOptions = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of provider?.optionFields ?? []) {
      const v = form.options[f.key];
      if (!isBlank(v) || (f.type === 'boolean' && v === false)) out[f.key] = v;
    }
    const wh: Record<string, Record<string, string>> = {};
    // Склад, якого вже немає (видалений), не надсилаємо — сервер відхилив би всю картку.
    const known = new Set((warehouses ?? []).map(w => w.id));
    for (const [id, entry] of Object.entries(form.warehouses)) {
      if (warehouses && !known.has(id)) continue;
      const clean = Object.fromEntries(
        Object.entries(entry)
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([, v]) => v),
      );
      if (Object.keys(clean).length) wh[id] = clean;
    }
    if (provider?.warehouseFields.length) out.warehouses = wh;
    return out;
  };

  const submit = async (verify: boolean) => {
    // Ctrl+Enter під час перевірки — не повторювати збереження.
    if (savingRef.current || verifying) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const credentials = Object.fromEntries(
      Object.entries(form.credentials)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v),
    );
    const common = {
      name: form.name.trim() || undefined,
      enabled: form.enabled,
      testMode: form.testMode,
      priority: Number(form.priority),
      ...(Object.keys(credentials).length ? { credentials } : {}),
      options: buildOptions(),
    };
    const body: SupplierConnectionCreateValues | SupplierConnectionUpdateValues = connection
      ? {
          ...common,
          // Стерта назва очищається (null), а не лишається попередньою (Bug #891).
          name: form.name.trim() || null,
          counterpartyId: form.counterpartyId,
          apiUrl: form.apiUrl.trim() || null,
          defaultDeliveryDays: form.defaultDeliveryDays.trim()
            ? Number(form.defaultDeliveryDays)
            : null,
        }
      : {
          ...common,
          counterpartyId: form.counterpartyId,
          provider: form.provider as SupplierConnectionCreateValues['provider'],
          ...(form.apiUrl.trim() ? { apiUrl: form.apiUrl.trim() } : {}),
          ...(form.defaultDeliveryDays.trim()
            ? { defaultDeliveryDays: Number(form.defaultDeliveryDays) }
            : {}),
        };
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(body, verify);
      // Збережене — нова «чиста» база; креди не показуються, тож поля кредів очищаються.
      setForm(f => ({ ...f, credentials: {} }));
      dirty.resetDirty();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('connections.loadError'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleClose = async () => {
    if (savingRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const fieldInput = (
    f: SupplierFieldSpec,
    value: OptionValue | undefined,
    onChange: (v: OptionValue) => void,
    id: string,
    placeholder?: string,
  ) => {
    if (f.type === 'boolean') {
      return (
        <div className="flex items-center justify-between gap-3 py-1" key={id}>
          <span className="text-[13px] text-foreground">{fieldLabel(f)}</span>
          <Switch checked={value === true} onChange={onChange} ariaLabel={fieldLabel(f)} />
        </div>
      );
    }
    if (f.type === 'select') {
      return (
        <Select
          key={id}
          id={id}
          label={fieldLabel(f)}
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)}
          hint={f.hint}
        >
          <option value="">{t('form.notSet')}</option>
          {(f.options ?? []).map(o => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    }
    return (
      <Input
        key={id}
        id={id}
        label={fieldLabel(f)}
        type={f.secret ? 'password' : 'text'}
        autoComplete={f.secret ? 'new-password' : 'off'}
        value={typeof value === 'string' ? value : ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        hint={f.hint}
        maxLength={2000}
      />
    );
  };

  const verifyLine = verifying
    ? t('form.verifying')
    : live && live.verifyStatus === 'FAILED'
      ? t('connections.lastError', { error: live.lastError ?? '' })
      : null;

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleClose()}
        onSubmit={() => void submit(true)}
        title={
          connection
            ? t('form.editTitle', { name: connection.name || connection.providerName })
            : t('form.createTitle')
        }
        size="lg"
        footer={
          <ModalFooter>
            <Button variant="outline" onClick={() => void handleClose()} disabled={saving}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={() => void submit(false)}
              loading={saving}
              disabled={verifying}
            >
              {t('form.save')}
            </Button>
            <Button onClick={() => void submit(true)} loading={saving || verifying}>
              {t('form.saveAndVerify')}
            </Button>
          </ModalFooter>
        }
      >
        {/* Поки йде перевірка, поля заблоковано: успіх закриває картку сам, і правка, внесена
            в цей час, зникла б повз dirty-guard. */}
        <fieldset disabled={verifying} className="min-w-0 border-0 p-0 m-0">
          <div className="space-y-4" data-testid="supplier-connection-form">
            <div className="grid grid-cols-2 gap-3">
              <Select
                id="scon-provider"
                label={t('form.provider')}
                required
                value={form.provider}
                disabled={!!connection}
                onChange={e =>
                  // Поля кредів і опцій — від провайдера: чужі ключі сервер відхилив би (BR-SCON-003).
                  patch({ provider: e.target.value, credentials: {}, options: {}, warehouses: {} })
                }
              >
                <option value="">{t('form.providerPlaceholder')}</option>
                {providers.map(p => (
                  <option key={p.provider} value={p.provider}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <SupplierOptionsSelect
                // Пошук живе в компоненті: інше підключення — порожній пошук.
                key={connection?.id ?? 'new'}
                id="scon-counterparty"
                label={t('form.counterparty')}
                required
                value={form.counterpartyId}
                selected={pickedSupplier}
                extraSelected={ownSupplier}
                onChange={(id, option) => {
                  setPickedSupplier(option);
                  patch({ counterpartyId: id });
                }}
                noneHint={t('form.noSuppliers')}
                enabled={open}
                leading={<option value="">{t('form.counterpartyPlaceholder')}</option>}
              />
              <Input
                id="scon-name"
                label={t('form.name')}
                value={form.name}
                maxLength={120}
                onChange={e => patch({ name: e.target.value })}
              />
              <Input
                id="scon-api-url"
                label={t('form.apiUrl')}
                value={form.apiUrl}
                maxLength={500}
                hint={t('form.apiUrlHint')}
                onChange={e => patch({ apiUrl: e.target.value })}
              />
              <Input
                id="scon-priority"
                label={t('form.priority')}
                type="number"
                min={0}
                max={1000}
                step={1}
                value={form.priority}
                hint={t('form.priorityHint')}
                onChange={e => patch({ priority: e.target.value })}
              />
              <Input
                id="scon-days"
                label={t('form.defaultDeliveryDays')}
                type="number"
                min={0}
                max={365}
                step={1}
                value={form.defaultDeliveryDays}
                hint={t('form.defaultDeliveryDaysHint')}
                onChange={e => patch({ defaultDeliveryDays: e.target.value })}
              />
            </div>

            <div className="flex flex-wrap gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.enabled}
                  onChange={v => patch({ enabled: v })}
                  ariaLabel={t('form.enabled')}
                />
                <span className="text-[13px]">{t('form.enabled')}</span>
              </div>
              <div className="flex items-center gap-2" title={t('form.testModeHint')}>
                <Switch
                  checked={form.testMode}
                  onChange={v => patch({ testMode: v })}
                  ariaLabel={t('form.testMode')}
                />
                <span className="text-[13px]">{t('form.testMode')}</span>
              </div>
            </div>

            {provider && (
              <>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">{t('form.credentials')}</h3>
                  <p className="text-xs text-muted-foreground">{t('form.credentialsHint')}</p>
                  <div className="grid grid-cols-2 gap-3">
                    {provider.credentialFields.map(f =>
                      fieldInput(
                        f,
                        form.credentials[f.key] ?? '',
                        v => patch({ credentials: { ...form.credentials, [f.key]: String(v) } }),
                        `scon-cred-${f.key}`,
                        savedKeys.has(f.key) ? t('form.savedPlaceholder') : undefined,
                      ),
                    )}
                  </div>
                </section>

                {provider.optionFields.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-foreground">{t('form.options')}</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {provider.optionFields.map(f =>
                        fieldInput(
                          f,
                          form.options[f.key],
                          v => patch({ options: { ...form.options, [f.key]: v } }),
                          `scon-opt-${f.key}`,
                        ),
                      )}
                    </div>
                  </section>
                )}

                {provider.warehouseFields.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('form.warehouses')}
                    </h3>
                    <p className="text-xs text-muted-foreground">{t('form.warehousesHint')}</p>
                    {(warehouses ?? []).map(w => (
                      <fieldset
                        key={w.id}
                        className="rounded-lg border border-border p-3 space-y-2"
                        aria-label={w.name}
                      >
                        <legend className="px-1 text-[13px] font-medium">{w.name}</legend>
                        <div className="grid grid-cols-2 gap-3">
                          {provider.warehouseFields.map(f =>
                            fieldInput(
                              f,
                              form.warehouses[w.id]?.[f.key] ?? '',
                              v =>
                                patch({
                                  warehouses: {
                                    ...form.warehouses,
                                    [w.id]: {
                                      ...(form.warehouses[w.id] ?? {}),
                                      [f.key]: String(v),
                                    },
                                  },
                                }),
                              `scon-wh-${w.id}-${f.key}`,
                            ),
                          )}
                        </div>
                      </fieldset>
                    ))}
                  </section>
                )}
              </>
            )}

            {verifyLine && (
              <p
                className={
                  verifying
                    ? 'text-[13px] text-muted-foreground'
                    : 'text-[13px] text-destructive-text'
                }
                role="status"
              >
                {verifyLine}
              </p>
            )}
            {error && (
              <div
                role="alert"
                className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
              >
                {error}
              </div>
            )}
          </div>
        </fieldset>
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
