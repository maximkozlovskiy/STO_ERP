'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, RefreshCw } from 'lucide-react';
import type { SupplierConnectionCreateValues, SupplierConnectionUpdateValues } from '@sto/shared';
import { toast } from '@/lib/toast';
import { fmtDateTime } from '@/lib/format';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useConfirm } from '@/hooks/useConfirm';
import {
  connectionBusy,
  supplierConnectionsApi,
  supplierConnectionsKeys,
  useSupplierConnections,
  useSupplierProviders,
  type SupplierConnection,
  type SupplierQueuedResponse,
} from '@/hooks/api/useSupplierConnections';
import { supplierOffersKeys } from '@/hooks/api/useSupplierOffers';
import { supplierApiOrderKeys } from '@/hooks/api/useSupplierApiOrder';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { ListLoadError } from '@/components/ui/list-load-error';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SupplierConnectionModal } from './SupplierConnectionModal';

type BadgeVariant = 'secondary' | 'success' | 'destructive' | 'info' | 'warning';

/** Стан підключення — результат перевірки, запитаної о `requestedAt` (а не попередньої). */
function isResultOf(c: SupplierConnection, requestedAt: string | null): boolean {
  if (!requestedAt) return true;
  return (c.verifyRequestedAt ?? '') >= requestedAt;
}

const VERIFY_BADGE: Record<SupplierConnection['verifyStatus'], BadgeVariant> = {
  NEVER: 'secondary',
  PENDING: 'info',
  OK: 'success',
  FAILED: 'destructive',
};

/**
 * Підключення до API постачальників (BR-SCON-001…004, 015): картки з перемикачем, станом
 * перевірки й синхронізації каталогу; модалка створення/зміни. Перевірка й синхронізація йдуть
 * через чергу — список опитується, доки вони тривають, а результат перевірки, запущеної тут,
 * повідомляється тостом.
 */
export function SupplierConnectionsPanel() {
  const { t } = useTranslation('supplierApi');
  const qc = useQueryClient();
  const features = useUiFeatures();
  const { confirm, dialogProps } = useConfirm();
  const providers = useSupplierProviders();
  const list = useSupplierConnections();
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const [modal, setModal] = useState<{ connection: SupplierConnection | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Підключення, чию перевірку запустили з цієї вкладки: їхній результат показуємо тостом.
  // id → verifyRequestedAt запиту: відповідь старшого опитування (до запуску перевірки) не рахується.
  const watchedRef = useRef<Map<string, string | null>>(new Map());
  // Перевірка, запущена з модалки: модалка лишається відкритою, доки статус PENDING.
  const [modalVerifyId, setModalVerifyId] = useState<string | null>(null);

  const notify = useCallback(
    (kind: 'success' | 'error' | 'warning', message: string) => {
      if (features.toastEnabled) toast[kind](message);
    },
    [features.toastEnabled],
  );

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: supplierConnectionsKeys.list() });
    // Увімкнене/вимкнене підключення міняє набір пропозицій і стан відправки замовлень.
    void qc.invalidateQueries({ queryKey: supplierOffersKeys.all });
    void qc.invalidateQueries({ queryKey: supplierApiOrderKeys.all });
  }, [qc]);

  useEffect(() => {
    for (const c of items) {
      if (!watchedRef.current.has(c.id) || c.verifyStatus === 'PENDING') continue;
      if (!isResultOf(c, watchedRef.current.get(c.id) ?? null)) continue;
      watchedRef.current.delete(c.id);
      const name = c.name || c.providerName;
      if (c.verifyStatus === 'OK') notify('success', t('connections.toast.verifyOk', { name }));
      else notify('error', t('connections.toast.verifyFailed', { name }));
    }
    if (modalVerifyId) {
      const live = items.find(c => c.id === modalVerifyId);
      if (
        live &&
        live.verifyStatus !== 'PENDING' &&
        isResultOf(live, watchedRef.current.get(live.id) ?? live.verifyRequestedAt)
      ) {
        setModalVerifyId(null);
        if (live.verifyStatus === 'OK') setModal(null);
      }
    }
  }, [items, modalVerifyId, notify, t]);

  // Відповідь «поставлено в чергу» вже несе PENDING — кладемо її в кеш одразу, інакше ефект
  // вище встиг би прочитати старий статус (OK попередньої перевірки) як результат нової.
  const applyConnection = (conn: SupplierConnection) => {
    qc.setQueryData<{ items: SupplierConnection[]; total: number }>(
      supplierConnectionsKeys.list(),
      old => {
        if (!old) return old;
        const exists = old.items.some(i => i.id === conn.id);
        return {
          ...old,
          items: exists ? old.items.map(i => (i.id === conn.id ? conn : i)) : [...old.items, conn],
          total: exists ? old.total : old.total + 1,
        };
      },
    );
  };

  const queuedNotice = (res: SupplierQueuedResponse, message: string) => {
    if (res.queueUnavailable) notify('warning', t('connections.queueUnavailable'));
    else notify('success', message);
  };

  const verify = async (c: SupplierConnection) => {
    setBusyId(c.id);
    try {
      const res = await supplierConnectionsApi.verify(c.id);
      applyConnection(res.connection);
      watchedRef.current.set(c.id, res.connection.verifyRequestedAt);
      queuedNotice(res, t('connections.toast.verifyQueued'));
    } catch (e: unknown) {
      notify('error', e instanceof Error ? e.message : t('connections.loadError'));
    } finally {
      setBusyId(null);
      invalidate();
    }
  };

  const syncCatalog = async (c: SupplierConnection) => {
    setBusyId(c.id);
    try {
      const res = await supplierConnectionsApi.catalogSync(c.id);
      applyConnection(res.connection);
      queuedNotice(res, t('connections.toast.syncQueued'));
    } catch (e: unknown) {
      notify('error', e instanceof Error ? e.message : t('connections.loadError'));
    } finally {
      setBusyId(null);
      invalidate();
    }
  };

  const toggle = async (c: SupplierConnection, enabled: boolean) => {
    setBusyId(c.id);
    try {
      await supplierConnectionsApi.update(c.id, { enabled });
      notify(
        'success',
        t('connections.toast.toggled', {
          state: t(enabled ? 'connections.toast.on' : 'connections.toast.off'),
        }),
      );
    } catch (e: unknown) {
      notify('error', e instanceof Error ? e.message : t('connections.loadError'));
    } finally {
      setBusyId(null);
      invalidate();
    }
  };

  const remove = async (c: SupplierConnection) => {
    const ok = await confirm({
      title: t('connections.deleteConfirm', { name: c.name || c.providerName }),
      message: t('connections.deleteHint'),
      confirmLabel: t('connections.delete'),
      variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(c.id);
    try {
      await supplierConnectionsApi.remove(c.id);
      notify('success', t('connections.toast.deleted'));
    } catch (e: unknown) {
      notify('error', e instanceof Error ? e.message : t('connections.loadError'));
    } finally {
      setBusyId(null);
      invalidate();
    }
  };

  const save = async (
    body: SupplierConnectionCreateValues | SupplierConnectionUpdateValues,
    withVerify: boolean,
  ) => {
    const current = modal?.connection ?? null;
    const saved = current
      ? await supplierConnectionsApi.update(current.id, body)
      : await supplierConnectionsApi.create(body as SupplierConnectionCreateValues);
    // Збережене підключення лишається в модалці (наступне «Зберегти» — уже зміна, не дубль).
    setModal({ connection: saved });
    applyConnection(saved);
    if (!withVerify) {
      notify('success', t('connections.toast.saved'));
      // Скинути й перевірку, запущену раніше з цієї картки: інакше її результат закрив би
      // наступну відкриту картку того самого підключення.
      setModalVerifyId(null);
      setModal(null);
      invalidate();
      return;
    }
    const res = await supplierConnectionsApi.verify(saved.id);
    applyConnection(res.connection);
    setModalVerifyId(saved.id);
    watchedRef.current.set(saved.id, res.connection.verifyRequestedAt);
    if (res.queueUnavailable) notify('warning', t('connections.queueUnavailable'));
    invalidate();
  };

  const modalLive = modal?.connection
    ? (items.find(c => c.id === modal.connection?.id) ?? null)
    : null;

  return (
    <section className="space-y-4" aria-labelledby="supplier-connections-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="supplier-connections-title" className="text-sm font-semibold text-foreground">
            {t('connections.title')}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('connections.description')}</p>
        </div>
        <Button
          onClick={() => setModal({ connection: null })}
          disabled={!providers.data}
          leftIcon={<Plug className="h-4 w-4" aria-hidden="true" />}
        >
          {t('connections.add')}
        </Button>
      </div>

      {providers.error && (
        <ListLoadError error={providers.error} onRetry={() => void providers.refetch()} />
      )}
      {list.error ? (
        <ListLoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-4">
          {t('connections.empty')}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map(c => {
            const caps = providers.data?.find(p => p.provider === c.provider)?.capabilities;
            const name = c.name || c.providerName;
            const busy = busyId === c.id;
            return (
              <li
                key={c.id}
                data-testid="supplier-connection-card"
                className="rounded-xl border border-border bg-surface p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.providerName} · {c.counterpartyName}
                    </p>
                  </div>
                  <Switch
                    checked={c.enabled}
                    disabled={busy}
                    onChange={v => void toggle(c, v)}
                    ariaLabel={t('connections.enabledAria', { name })}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={VERIFY_BADGE[c.verifyStatus]} data-testid="verify-status">
                    {t(`connections.verifyStatus.${c.verifyStatus}`, {
                      at: fmtDateTime(c.lastVerifiedAt),
                    })}
                  </Badge>
                  {c.testMode && <Badge variant="warning">{t('connections.testMode')}</Badge>}
                  <Badge variant="outline">
                    {c.hasCredentials
                      ? t('connections.credentialsSaved')
                      : t('connections.credentialsMissing')}
                  </Badge>
                  <Badge variant="outline">
                    {t('connections.priority', { value: c.priority })}
                  </Badge>
                  {caps?.search === 'mirror' && (
                    <Badge
                      variant={c.catalogSyncStatus === 'FAILED' ? 'destructive' : 'secondary'}
                      data-testid="catalog-status"
                    >
                      {c.catalogSyncStatus
                        ? t(`connections.catalog.${c.catalogSyncStatus}`, {
                            at: fmtDateTime(c.catalogSyncedAt),
                            defaultValue: c.catalogSyncStatus,
                          })
                        : t('connections.catalog.never')}
                    </Badge>
                  )}
                </div>
                {(c.lastError || c.catalogSyncError) && c.verifyStatus !== 'PENDING' && (
                  <p className="text-xs text-destructive-text break-words">
                    {t('connections.lastError', { error: c.lastError ?? c.catalogSyncError })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void verify(c)}
                    disabled={busy || c.verifyStatus === 'PENDING'}
                    loading={c.verifyStatus === 'PENDING'}
                  >
                    {t('connections.verify')}
                  </Button>
                  {caps?.search === 'mirror' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void syncCatalog(c)}
                      disabled={busy || connectionBusy(c)}
                      leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      {t('connections.syncCatalog')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setModal({ connection: c })}
                    disabled={busy || !providers.data}
                  >
                    {t('connections.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                    onClick={() => void remove(c)}
                    disabled={busy}
                  >
                    {t('connections.delete')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <SupplierConnectionModal
        open={modal !== null}
        connection={modal?.connection ?? null}
        providers={providers.data ?? []}
        live={modalLive}
        verifying={!!modalVerifyId && modalLive?.verifyStatus === 'PENDING'}
        onClose={() => {
          setModal(null);
          setModalVerifyId(null);
        }}
        onSave={save}
      />
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
