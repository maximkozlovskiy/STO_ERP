'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  SUPPLIER_ANALOG_POLICIES,
  SUPPLIER_ORDER_SEND_MODES,
  SUPPLIER_STRATEGIES,
  type ApiSchema,
  type SupplierStrategyCode,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { supplierOffersKeys } from '@/hooks/api/useSupplierOffers';
import { supplierApiOrderKeys } from '@/hooks/api/useSupplierApiOrder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SupplierConnectionsPanel } from './SupplierConnectionsPanel';

type SendMode = (typeof SUPPLIER_ORDER_SEND_MODES)[number];
type AnalogPolicy = (typeof SUPPLIER_ANALOG_POLICIES)[number];

/** Поля `OrganisationSettings.supplier*` (BR-SCON-009, BR-SOFR-003, 005, 007, 008, 015) — з контракту. */
type SupplierSettings = Pick<
  ApiSchema<'OrganisationSettingsResponseDto'>,
  | 'supplierOrderSendMode'
  | 'supplierAnalogPolicy'
  | 'supplierDefaultStrategy'
  | 'supplierOptimalPriceWeight'
  | 'supplierAllowSplit'
  | 'supplierAllowAnalogsInAuto'
  | 'supplierOfferTtlMinutes'
  | 'supplierOfferRetentionDays'
  | 'supplierOrderPollIntervalMinutes'
  | 'supplierCatalogSyncIntervalMinutes'
  | 'supplierUnknownDeliveryDays'
>;

type IntKey =
  | 'supplierOfferTtlMinutes'
  | 'supplierOfferRetentionDays'
  | 'supplierOrderPollIntervalMinutes'
  | 'supplierCatalogSyncIntervalMinutes'
  | 'supplierUnknownDeliveryDays';

/** Межі — дзеркало `UpdateOrganisationSettingsDto` (сервер повторює перевірку). */
const INT_FIELDS: Array<{ key: IntKey; label: string; min: number; max: number }> = [
  { key: 'supplierOfferTtlMinutes', label: 'procurement.offerTtl', min: 5, max: 1440 },
  { key: 'supplierOfferRetentionDays', label: 'procurement.retention', min: 1, max: 90 },
  { key: 'supplierOrderPollIntervalMinutes', label: 'procurement.pollInterval', min: 5, max: 1440 },
  {
    key: 'supplierCatalogSyncIntervalMinutes',
    label: 'procurement.catalogInterval',
    min: 60,
    max: 1440,
  },
  { key: 'supplierUnknownDeliveryDays', label: 'procurement.unknownDays', min: 1, max: 90 },
];

interface FormState {
  sendMode: SendMode;
  analogPolicy: AnalogPolicy;
  strategy: SupplierStrategyCode;
  /** Вага ціни у відсотках (0…100); у налаштуваннях — частка 0…1. */
  weightPct: string;
  allowSplit: boolean;
  allowAnalogsInAuto: boolean;
  ints: Record<IntKey, string>;
}

function toForm(s: SupplierSettings): FormState {
  return {
    sendMode: s.supplierOrderSendMode,
    analogPolicy: s.supplierAnalogPolicy,
    strategy: s.supplierDefaultStrategy,
    weightPct: String(Math.round(s.supplierOptimalPriceWeight * 100)),
    allowSplit: s.supplierAllowSplit,
    allowAnalogsInAuto: s.supplierAllowAnalogsInAuto,
    ints: Object.fromEntries(INT_FIELDS.map(f => [f.key, String(s[f.key])])) as Record<
      IntKey,
      string
    >,
  };
}

/**
 * Вкладка «Постачальники API»: підключення (SupplierConnectionsPanel) і розділ «Закупівля через
 * API» — режим відправки, політика аналогів, стратегія й вага, ділення, аналоги в автопідборі,
 * TTL та інтервали. Зберігає лише змінені поля (`PATCH /settings/organisation`).
 */
export default function SupplierApiTab() {
  const { t } = useTranslation('supplierApi');
  const features = useUiFeatures();
  const qc = useQueryClient();
  // Сторінка налаштувань — OWNER/ADMIN; іншій ролі (до переходу на /403) запит не шлемо — 403.
  const { employee } = useAuth();
  const isAdmin = employee?.role === 'OWNER' || employee?.role === 'ADMIN';
  const [saved, setSaved] = useState<SupplierSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  // null — помилки немає; '' — помилка без тексту (підпис перекладається при рендері, тож зміна
  // мови не перезапускає завантаження й не затирає незбережену форму).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    apiFetch<SupplierSettings>('/settings/organisation')
      .then(s => {
        if (cancelled) return;
        setSaved(s);
        setForm(toForm(s));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '');
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const buildPatch = (f: FormState, s: SupplierSettings): Partial<SupplierSettings> | string => {
    const out: Partial<SupplierSettings> = {};
    if (f.sendMode !== s.supplierOrderSendMode) out.supplierOrderSendMode = f.sendMode;
    if (f.analogPolicy !== s.supplierAnalogPolicy) out.supplierAnalogPolicy = f.analogPolicy;
    if (f.strategy !== s.supplierDefaultStrategy) out.supplierDefaultStrategy = f.strategy;
    const pct = Number(f.weightPct);
    if (f.weightPct.trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100)
      return t('procurement.weightRange');
    const weight = Math.round(pct) / 100;
    if (weight !== s.supplierOptimalPriceWeight) out.supplierOptimalPriceWeight = weight;
    if (f.allowSplit !== s.supplierAllowSplit) out.supplierAllowSplit = f.allowSplit;
    if (f.allowAnalogsInAuto !== s.supplierAllowAnalogsInAuto)
      out.supplierAllowAnalogsInAuto = f.allowAnalogsInAuto;
    for (const field of INT_FIELDS) {
      const n = Number(f.ints[field.key]);
      if (!Number.isInteger(n) || n < field.min || n > field.max) {
        return t('procurement.range', { field: t(field.label), min: field.min, max: field.max });
      }
      if (n !== s[field.key]) out[field.key] = n;
    }
    return out;
  };

  const save = async () => {
    if (!form || !saved || savingRef.current) return;
    const patch = buildPatch(form, saved);
    if (typeof patch === 'string') {
      setError(patch);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const updated =
        Object.keys(patch).length === 0
          ? saved
          : await apiFetch<SupplierSettings>('/settings/organisation', {
              method: 'PATCH',
              body: JSON.stringify(patch),
            });
      setSaved(updated);
      setForm(toForm(updated));
      // Стратегія, TTL і політика аналогів живуть у діалогах пропозицій (вибірність), режим
      // відправки — у стані передачі замовлення в API: скидаємо обидва простори ключів.
      void qc.invalidateQueries({ queryKey: supplierOffersKeys.all });
      void qc.invalidateQueries({ queryKey: supplierApiOrderKeys.all });
      if (features.toastEnabled) toast.success(t('procurement.saved'));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('procurement.loadError');
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const set = (p: Partial<FormState>) => setForm(f => (f ? { ...f, ...p } : f));
  const weightPct = Number(form?.weightPct);
  const daysPct = Number.isFinite(weightPct) ? Math.max(0, 100 - Math.round(weightPct)) : 0;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="bg-surface rounded-xl border border-border p-6">
        <SupplierConnectionsPanel />
      </div>

      <section
        className="bg-surface rounded-xl border border-border p-6 space-y-4"
        aria-labelledby="supplier-procurement-title"
      >
        <div>
          <h2 id="supplier-procurement-title" className="text-sm font-semibold text-foreground">
            {t('procurement.title')}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('procurement.description')}</p>
        </div>
        {loadError !== null && (
          <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
            {loadError || t('procurement.loadError')}
          </div>
        )}
        {form && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <Select
                id="supplier-send-mode"
                label={t('procurement.sendMode')}
                hint={t('procurement.sendModeHint')}
                value={form.sendMode}
                onChange={e => set({ sendMode: e.target.value as SendMode })}
              >
                {SUPPLIER_ORDER_SEND_MODES.map(m => (
                  <option key={m} value={m}>
                    {t(`procurement.sendModes.${m}`)}
                  </option>
                ))}
              </Select>
              <Select
                id="supplier-analog-policy"
                label={t('procurement.analogPolicy')}
                hint={t('procurement.analogPolicyHint')}
                value={form.analogPolicy}
                onChange={e => set({ analogPolicy: e.target.value as AnalogPolicy })}
              >
                {SUPPLIER_ANALOG_POLICIES.map(p => (
                  <option key={p} value={p}>
                    {t(`procurement.analogPolicies.${p}`)}
                  </option>
                ))}
              </Select>
              <Select
                id="supplier-default-strategy"
                label={t('procurement.defaultStrategy')}
                hint={t(`strategyHint.${form.strategy}`)}
                value={form.strategy}
                onChange={e => set({ strategy: e.target.value as SupplierStrategyCode })}
              >
                {SUPPLIER_STRATEGIES.map(s => (
                  <option key={s} value={s}>
                    {t(`strategy.${s}`)}
                  </option>
                ))}
              </Select>
              <Input
                id="supplier-price-weight"
                label={t('procurement.priceWeight')}
                hint={t('procurement.priceWeightHint', { days: daysPct })}
                type="number"
                min={0}
                max={100}
                step={5}
                value={form.weightPct}
                onChange={e => set({ weightPct: e.target.value })}
              />
            </div>

            <div className="divide-y divide-border border-y border-border">
              {(
                [
                  ['allowSplit', 'procurement.allowSplit', 'procurement.allowSplitHint'],
                  [
                    'allowAnalogsInAuto',
                    'procurement.allowAnalogsInAuto',
                    'procurement.allowAnalogsInAutoHint',
                  ],
                ] as const
              ).map(([key, label, hint]) => (
                <div key={key} className="flex items-center justify-between gap-4 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t(label)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t(hint)}</p>
                  </div>
                  <Switch
                    checked={form[key]}
                    onChange={v => set({ [key]: v })}
                    ariaLabel={t(label)}
                  />
                </div>
              ))}
            </div>

            <div className="grid gap-4 grid-cols-2 md:grid-cols-3">
              {INT_FIELDS.map(f => (
                <Input
                  key={f.key}
                  id={`supplier-${f.key}`}
                  label={t(f.label)}
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={1}
                  value={form.ints[f.key]}
                  onChange={e => set({ ints: { ...form.ints, [f.key]: e.target.value } })}
                />
              ))}
            </div>

            {error && (
              <div
                role="alert"
                className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3"
              >
                {error}
              </div>
            )}
            <div>
              <Button onClick={() => void save()} loading={saving}>
                {t('common:save')}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
