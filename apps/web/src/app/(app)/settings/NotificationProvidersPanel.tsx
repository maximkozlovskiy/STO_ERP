'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, KeyRound, X } from 'lucide-react';
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

interface ProviderMeta {
  code: string;
  name: string;
  channels: string[];
}

interface ChannelConfig {
  id: string;
  channel: string;
  provider: string;
  enabled: boolean;
  priority: number;
  hasApiKey: boolean;
  senderName: string | null;
  updatedAt: string;
}

interface VerifyResult {
  valid: boolean;
  balance?: number;
  senderNames?: string[];
  error?: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'SMS',
  VIBER: 'Viber',
  EMAIL: 'Email',
  PUSH: 'Push',
};

export default function NotificationProvidersPanel() {
  const currentFeatures = useUiFeatures();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [error, setError] = useState('');

  // Модалка кредів
  const [credsProvider, setCredsProvider] = useState<ProviderMeta | null>(null);
  const [credsChannel, setCredsChannel] = useState<string>('SMS');
  const [apiKey, setApiKey] = useState('');
  const [senderName, setSenderName] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [savingCreds, setSavingCreds] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);

  // Завантаження філій + провайдерів (одноразово).
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
        console.warn('[Providers] /branches failed:', e instanceof Error ? e.message : e),
      );
    apiFetch<ProviderMeta[]>('/notification-providers')
      .then(setProviders)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження провайдерів'),
      );
  }, []);

  const loadChannels = useCallback((branchId: string) => {
    apiFetch<ChannelConfig[]>(`/notification-channels/${branchId}`)
      .then(setChannels)
      .catch((e: unknown) =>
        console.warn('[Providers] channels load failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  useEffect(() => {
    if (selectedBranch) loadChannels(selectedBranch);
  }, [selectedBranch, loadChannels]);

  // Повертає true при успіху — caller (saveCreds) не має показувати «збережено» на помилці.
  const patchChannel = async (dto: {
    channel: string;
    provider: string;
    enabled?: boolean;
    priority?: number;
    apiKey?: string;
    senderName?: string;
  }): Promise<boolean> => {
    if (!selectedBranch) return false;
    try {
      await apiFetch(`/notification-channels/${selectedBranch}`, {
        method: 'PATCH',
        body: JSON.stringify(dto),
      });
      loadChannels(selectedBranch);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
      return false;
    }
  };

  const toggleEnabled = (c: ChannelConfig, enabled: boolean) =>
    void patchChannel({ channel: c.channel, provider: c.provider, enabled });

  // Пріоритет: обмін значеннями priority із сусідом (менший priority = вище у списку).
  // Два послідовні PATCH — щоб перший збій не лишив обидва канали з однаковим priority,
  // другий PATCH виконуємо лише якщо перший успішний (інакше loadChannels уже показав
  // реальний серверний стан + помилку).
  const move = async (index: number, dir: -1 | 1) => {
    if (movingId) return; // блокуємо конкурентні swap-и (уникаємо гонки priority)
    const sorted = [...channels].sort((a, b) => a.priority - b.priority);
    const target = sorted[index + dir];
    const current = sorted[index];
    if (!target || !current) return;
    setMovingId(current.id);
    try {
      const ok = await patchChannel({
        channel: current.channel,
        provider: current.provider,
        priority: target.priority,
      });
      if (!ok) return;
      await patchChannel({
        channel: target.channel,
        provider: target.provider,
        priority: current.priority,
      });
    } finally {
      setMovingId(null);
    }
  };

  const openCreds = (provider: ProviderMeta) => {
    setCredsProvider(provider);
    setCredsChannel(provider.channels[0] ?? 'SMS');
    setApiKey('');
    setSenderName('');
    setVerifyResult(null);
  };

  const closeCreds = () => setCredsProvider(null);

  const verify = async () => {
    if (!credsProvider || !apiKey) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await apiFetch<VerifyResult>(
        `/notification-providers/${credsProvider.code}/verify`,
        {
          method: 'POST',
          body: JSON.stringify({ apiKey, senderName: senderName || undefined }),
        },
      );
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
    if (!credsProvider) return;
    setSavingCreds(true);
    try {
      const ok = await patchChannel({
        channel: credsChannel,
        provider: credsProvider.code,
        apiKey: apiKey || undefined,
        senderName: senderName || undefined,
      });
      if (!ok) return; // помилка вже показана в patchChannel — не закриваємо модалку
      if (currentFeatures.toastEnabled) toast.success('Креди збережено');
      closeCreds();
    } finally {
      setSavingCreds(false);
    }
  };

  const sortedChannels = [...channels].sort((a, b) => a.priority - b.priority);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Провайдери та канали</h3>
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

      {/* Провайдери — клік відкриває модалку кредів */}
      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map(p => (
          <button
            key={p.code}
            type="button"
            onClick={() => openCreds(p)}
            className="flex items-center justify-between gap-2 bg-surface rounded-xl border border-border p-3 text-left hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <div>
              <div className="text-sm font-medium text-foreground">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                {p.channels.map(ch => CHANNEL_LABELS[ch] ?? ch).join(' · ')}
              </div>
            </div>
            <KeyRound className="h-4 w-4 text-muted-foreground" />
          </button>
        ))}
        {providers.length === 0 && (
          <p className="text-muted-foreground text-sm">Провайдери не знайдено</p>
        )}
      </div>

      {/* Пріоритет каналів (fallback: зверху вниз) */}
      {sortedChannels.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Порядок спроб (fallback): зверху вниз. Якщо канал не спрацював — система пробує
            наступний.
          </p>
          <div className="space-y-2">
            {sortedChannels.map((c, i) => (
              <div
                key={c.id}
                className="flex items-center gap-3 bg-surface rounded-xl border border-border p-3"
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => void move(i, -1)}
                    disabled={i === 0 || movingId !== null}
                    aria-label="Підняти пріоритет"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void move(i, 1)}
                    disabled={i === sortedChannels.length - 1 || movingId !== null}
                    aria-label="Знизити пріоритет"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 bg-secondary rounded text-xs font-mono">
                      {CHANNEL_LABELS[c.channel] ?? c.channel}
                    </span>
                    <span className="text-sm text-foreground">{c.provider}</span>
                    {!c.hasApiKey && <span className="text-xs text-warning">без ключа</span>}
                  </div>
                </div>
                <Switch
                  checked={c.enabled}
                  onChange={v => toggleEnabled(c, v)}
                  ariaLabel={`${c.enabled ? 'Вимкнути' : 'Увімкнути'} канал ${CHANNEL_LABELS[c.channel] ?? c.channel}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Модалка кредів + перевірка */}
      <Modal
        open={credsProvider !== null}
        onClose={closeCreds}
        title={credsProvider ? `${credsProvider.name} — креди` : ''}
        size="sm"
        onSubmit={() => void saveCreds()}
        footer={
          <ModalFooter>
            <Button variant="outline" onClick={closeCreds}>
              Скасувати
            </Button>
            <Button onClick={() => void saveCreds()} loading={savingCreds} disabled={!apiKey}>
              Зберегти
            </Button>
          </ModalFooter>
        }
      >
        {credsProvider && (
          <div className="space-y-3">
            {credsProvider.channels.length > 1 && (
              <label className="block">
                <span className="text-sm text-foreground">Канал</span>
                <Select
                  value={credsChannel}
                  onChange={e => setCredsChannel(e.target.value)}
                  className="mt-1"
                >
                  {credsProvider.channels.map(ch => (
                    <option key={ch} value={ch}>
                      {CHANNEL_LABELS[ch] ?? ch}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Input
              label="API-токен"
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Введіть токен провайдера"
              autoComplete="off"
            />
            <Input
              label="Імʼя відправника (sender)"
              value={senderName}
              onChange={e => setSenderName(e.target.value)}
              placeholder="STO ERP"
            />
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void verify()}
                loading={verifying}
                disabled={!apiKey}
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
                      Токен дійсний
                      {typeof verifyResult.balance === 'number' &&
                        ` · баланс: ${verifyResult.balance}`}
                    </>
                  ) : (
                    <>
                      <X className="h-4 w-4" />
                      {verifyResult.error ?? 'Невірний токен'}
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
