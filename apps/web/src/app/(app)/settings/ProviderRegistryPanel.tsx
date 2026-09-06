'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { getCached, setCache } from '@/lib/ref-cache';
import { cn } from '@/lib/utils';
import { type BranchInfo } from './shared';

/** Опис поля кредів провайдера (write-only секрет чи звичайне). */
export interface CredField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

/** Метадані провайдера у панелі + схема його полів кредів. */
export interface PanelProviderMeta {
  code: string;
  name: string;
  fields: CredField[];
  /** true → показувати вибір режиму зміни (лише ПРРО). */
  hasShiftMode?: boolean;
}

interface ProviderConfigView {
  provider: string;
  enabled: boolean;
  apiUrl: string | null;
  shiftMode?: string;
  hasCredentials: boolean;
}

interface VerifyResult {
  valid: boolean;
  cashRegisterName?: string;
  error?: string;
}

interface Props {
  /** Заголовок секції. */
  title: string;
  /** Базовий endpoint (напр. 'fiscal-providers' або 'payment-gateways'). */
  endpoint: string;
  /** Провайдери + схеми полів (фронт-константа: бекенд list() дає лише code/name). */
  providers: PanelProviderMeta[];
}

/**
 * Спільна панель вибору активного провайдера (ПРРО / еквайринг) per-branch. Дзеркалить
 * NotificationProvidersPanel: картки провайдерів, Switch ексклюзивної активації, модалка кредів
 * з verify. На відміну від сповіщень — без fallback-ланцюга (активний лише 1, без пріоритетів).
 */
export default function ProviderRegistryPanel({ title, endpoint, providers }: Props) {
  const currentFeatures = useUiFeatures();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [configs, setConfigs] = useState<ProviderConfigView[]>([]);
  const [error, setError] = useState('');

  // Модалка кредів
  const [credsProvider, setCredsProvider] = useState<PanelProviderMeta | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [shiftMode, setShiftMode] = useState('MANUAL');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [savingCreds, setSavingCreds] = useState(false);

  useEffect(() => {
    const cached = getCached<BranchInfo[]>('cache:branches');
    if (cached && cached.length > 0) {
      setBranches(cached);
      setSelectedBranch(prev => prev || cached[0].id);
    }
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
        if (arr.length > 0) setSelectedBranch(prev => prev || arr[0].id);
      })
      .catch((e: unknown) =>
        console.warn(`[${endpoint}] /branches failed:`, e instanceof Error ? e.message : e),
      );
  }, [endpoint]);

  const loadConfigs = useCallback(
    (branchId: string) => {
      apiFetch<ProviderConfigView[]>(`/${endpoint}/branch/${branchId}`)
        .then(setConfigs)
        .catch((e: unknown) =>
          console.warn(`[${endpoint}] configs load failed:`, e instanceof Error ? e.message : e),
        );
    },
    [endpoint],
  );

  useEffect(() => {
    if (selectedBranch) loadConfigs(selectedBranch);
  }, [selectedBranch, loadConfigs]);

  const activeProvider = configs.find(c => c.enabled)?.provider ?? null;

  const openCreds = (provider: PanelProviderMeta) => {
    const existing = configs.find(c => c.provider === provider.code);
    setCredsProvider(provider);
    setApiUrl(existing?.apiUrl ?? '');
    setShiftMode(existing?.shiftMode ?? 'MANUAL');
    setCreds({}); // write-only — не prefill
    setVerifyResult(null);
  };

  const closeCreds = () => setCredsProvider(null);

  // Чи можна зберегти/перевірити: введено хоча б одне поле (порожні мерджаться як «не змінювати»)
  // АБО конфіг уже має збережені креди (оновлюємо apiUrl/режим без повторного вводу секретів).
  const existingHasCreds = (code: string) =>
    configs.find(c => c.provider === code)?.hasCredentials ?? false;
  const credsReady = (() => {
    if (!credsProvider) return false;
    const someFilled = credsProvider.fields.some(f => (creds[f.key] ?? '').trim() !== '');
    return someFilled || existingHasCreds(credsProvider.code);
  })();

  const verify = async () => {
    if (!credsProvider) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await apiFetch<VerifyResult>(`/${endpoint}/${credsProvider.code}/verify`, {
        method: 'POST',
        body: JSON.stringify({ apiUrl: apiUrl || undefined, credentials: creds }),
      });
      setVerifyResult(res);
    } catch (e: unknown) {
      setVerifyResult({
        valid: false,
        error: e instanceof Error ? e.message : 'Помилка перевірки',
      });
    } finally {
      setVerifying(false);
    }
  };

  const saveCreds = async () => {
    if (!credsProvider || !selectedBranch) return;
    setSavingCreds(true);
    try {
      // Лише непорожні креди (write-only merge на беку).
      const nonEmpty: Record<string, string> = {};
      for (const f of credsProvider.fields) {
        const v = (creds[f.key] ?? '').trim();
        if (v) nonEmpty[f.key] = v;
      }
      await apiFetch(`/${endpoint}/branch/${selectedBranch}`, {
        method: 'PATCH',
        body: JSON.stringify({
          provider: credsProvider.code,
          apiUrl: apiUrl || undefined,
          ...(credsProvider.hasShiftMode ? { shiftMode } : {}),
          ...(Object.keys(nonEmpty).length > 0 ? { credentials: nonEmpty } : {}),
        }),
      });
      loadConfigs(selectedBranch);
      if (currentFeatures.toastEnabled) toast.success('Налаштування збережено');
      closeCreds();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSavingCreds(false);
    }
  };

  const activate = async (providerCode: string) => {
    if (!selectedBranch || activeProvider === providerCode) return;
    // Empty-state guard: активація без збережених кредів → бек кине 400. Спершу вимагаємо креди.
    if (!existingHasCreds(providerCode)) {
      const msg = 'Спершу введіть креди провайдера (натисніть назву)';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
      return;
    }
    try {
      await apiFetch(`/${endpoint}/branch/${selectedBranch}/activate`, {
        method: 'POST',
        body: JSON.stringify({ provider: providerCode }),
      });
      loadConfigs(selectedBranch);
      if (currentFeatures.toastEnabled) toast.success('Провайдера активовано');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка активації';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {branches.length > 1 && (
          <Select
            value={selectedBranch}
            onChange={e => setSelectedBranch(e.target.value)}
            className="w-48"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map(p => {
          const isActive = activeProvider === p.code;
          const cfg = configs.find(c => c.provider === p.code);
          return (
            <div
              key={p.code}
              className={cn(
                'flex items-center justify-between gap-2 bg-surface rounded-xl border p-3 transition-colors',
                isActive ? 'border-primary' : 'border-border',
              )}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => openCreds(p)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openCreds(p);
                  }
                }}
                aria-label={`Налаштувати креди ${p.name}`}
                className="flex flex-1 items-center gap-2 text-left cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <div className="text-sm font-medium text-foreground">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {cfg?.hasCredentials ? 'Креди збережено' : 'Не налаштовано'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {isActive ? 'Активний' : 'Вимкнено'}
                </span>
                <Switch
                  checked={isActive}
                  onChange={v => {
                    if (v) void activate(p.code);
                  }}
                  disabled={isActive}
                  ariaLabel={`Активувати провайдера ${p.name}`}
                />
              </div>
            </div>
          );
        })}
        {providers.length === 0 && (
          <p className="text-muted-foreground text-sm">Провайдери не знайдено</p>
        )}
      </div>

      <Modal
        open={credsProvider !== null}
        onClose={closeCreds}
        title={credsProvider ? `${credsProvider.name} — налаштування` : ''}
        size="sm"
        onSubmit={() => void saveCreds()}
        footer={
          <ModalFooter>
            <Button variant="outline" onClick={closeCreds}>
              Скасувати
            </Button>
            <Button onClick={() => void saveCreds()} loading={savingCreds} disabled={!credsReady}>
              Зберегти
            </Button>
          </ModalFooter>
        }
      >
        {credsProvider && (
          <div className="space-y-3">
            {credsProvider.fields.map(f => (
              <Input
                key={f.key}
                label={f.label}
                type={f.secret ? 'password' : 'text'}
                value={creds[f.key] ?? ''}
                onChange={e => setCreds(c => ({ ...c, [f.key]: e.target.value }))}
                placeholder={
                  f.secret && existingHasCreds(credsProvider.code)
                    ? 'Збережено — введіть, щоб змінити'
                    : (f.placeholder ?? '')
                }
                autoComplete="off"
              />
            ))}
            <Input
              label="API URL (необовʼязково)"
              value={apiUrl}
              onChange={e => setApiUrl(e.target.value)}
              placeholder="Залиште порожнім для стандартного"
            />
            {credsProvider.hasShiftMode && (
              <label className="block">
                <span className="text-sm text-foreground">Режим зміни</span>
                <Select
                  value={shiftMode}
                  onChange={e => setShiftMode(e.target.value)}
                  className="mt-1"
                >
                  <option value="MANUAL">Ручний — касир відкриває/закриває зміну</option>
                  <option value="AUTO_OPEN">Авто-відкриття — перед першим чеком</option>
                </Select>
              </label>
            )}
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void verify()}
                loading={verifying}
                disabled={!credsReady}
              >
                Перевірити
              </Button>
              {verifyResult && (
                <span
                  className={cn(
                    'flex items-center gap-1 text-sm',
                    verifyResult.valid ? 'text-success' : 'text-destructive-text',
                  )}
                >
                  {verifyResult.valid ? (
                    <>
                      <Check className="h-4 w-4" />
                      Дійсні креди
                      {verifyResult.cashRegisterName && ` · ${verifyResult.cashRegisterName}`}
                    </>
                  ) : (
                    <>
                      <X className="h-4 w-4" />
                      {verifyResult.error ?? 'Невірні креди'}
                    </>
                  )}
                </span>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
