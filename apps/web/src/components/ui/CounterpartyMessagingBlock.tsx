'use client';

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AUTOMATION_CHANNELS, type ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { automationChannelLabel } from '@/lib/automation';
import { counterpartiesKeys } from '@/hooks/api/useCounterparties';
import { useTaskAssignees } from '@/hooks/api/useTasks';
import { Select } from './select';
import { Spinner } from './spinner';
import { Switch } from './switch';
import { TelegramSubscriptionBlock } from './TelegramSubscriptionBlock';

type CounterpartyDetail = ApiSchema<'CounterpartyResponseDto'>;
type ConsentPatch = Pick<
  CounterpartyDetail,
  'noServiceMessages' | 'marketingConsent' | 'preferredChannel'
>;

const EDIT_ROLES = ['OWNER', 'ADMIN', 'RECEPTIONIST'];

const messagingKey = (id: string) => [...counterpartiesKeys.detail(id), 'messaging'] as const;

/**
 * Повідомлення клієнту в картці контрагента (BR-AUT-011, 012, 041, 042; US-AUT-6): «не надсилати
 * службові», «згода на маркетинг» (коли й хто змінив — лише показ, ставить сервер), бажаний канал
 * з поясненням і підписка на Telegram-бот. Кожен перемикач шле PATCH лише свого поля — решта
 * картки (і незбережені правки на ній) не зачіпається.
 */
export function CounterpartyMessagingBlock({ counterpartyId }: { counterpartyId: string }) {
  const { t } = useTranslation('counterparties');
  const { employee } = useAuth();
  const qc = useQueryClient();
  const canEdit = EDIT_ROLES.includes(employee?.role ?? '');
  const employees = useTaskAssignees(employee?.role);

  const detail = useQuery({
    queryKey: messagingKey(counterpartyId),
    queryFn: ({ signal }) =>
      apiFetch<CounterpartyDetail>(`/counterparties/${counterpartyId}`, { signal }),
    staleTime: 0,
  });

  const patch = useMutation({
    mutationFn: (body: Partial<ConsentPatch>) =>
      apiFetch<CounterpartyDetail>(`/counterparties/${counterpartyId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: updated => {
      qc.setQueryData<CounterpartyDetail>(messagingKey(counterpartyId), prev =>
        prev ? { ...prev, ...updated, telegramSubscription: prev.telegramSubscription } : updated,
      );
      toast.success(t('consent.saved'));
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t('common.error')),
  });

  const cp = detail.data;
  if (detail.isLoading)
    return (
      <div className="flex justify-center py-4">
        <Spinner size="sm" />
      </div>
    );
  if (!cp)
    return (
      <p className="text-[12px] text-destructive-text" role="alert">
        {detail.error instanceof Error ? detail.error.message : t('common.error')}
      </p>
    );

  const consentBy = cp.marketingConsentById
    ? employees.data?.items.find(e => e.id === cp.marketingConsentById)
    : undefined;
  const consentByName = consentBy ? `${consentBy.lastName} ${consentBy.firstName}`.trim() : '';
  const busy = patch.isPending;

  return (
    <div className="space-y-3" data-testid="counterparty-messaging">
      <section className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <h3 className="text-[13px] font-semibold text-foreground">{t('consent.title')}</h3>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-foreground">{t('consent.noServiceMessages')}</p>
            <p className="text-[12px] text-muted-foreground">
              {t('consent.noServiceMessagesHint')}
            </p>
          </div>
          <Switch
            checked={!!cp.noServiceMessages}
            disabled={!canEdit || busy}
            onChange={v => patch.mutate({ noServiceMessages: v })}
            ariaLabel={t('consent.noServiceMessages')}
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-foreground">{t('consent.marketing')}</p>
            <p className="text-[12px] text-muted-foreground" data-testid="consent-changed">
              {cp.marketingConsentAt
                ? consentByName
                  ? t('consent.changedBy', {
                      date: fmtDateTime(cp.marketingConsentAt),
                      name: consentByName,
                    })
                  : t('consent.changedAt', { date: fmtDateTime(cp.marketingConsentAt) })
                : t('consent.marketingHint')}
            </p>
          </div>
          <Switch
            checked={!!cp.marketingConsent}
            disabled={!canEdit || busy}
            onChange={v => patch.mutate({ marketingConsent: v })}
            ariaLabel={t('consent.marketing')}
          />
        </div>
        <div className="max-w-72">
          <Select
            id="cp-preferred-channel"
            label={t('consent.preferredChannel')}
            value={cp.preferredChannel ?? ''}
            disabled={!canEdit || busy}
            onChange={e => {
              const next = AUTOMATION_CHANNELS.find(c => c === e.target.value) ?? null;
              patch.mutate({ preferredChannel: next });
            }}
          >
            <option value="">{t('consent.preferredNone')}</option>
            {AUTOMATION_CHANNELS.map(c => (
              <option key={c} value={c}>
                {automationChannelLabel(c)}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-[12px] text-muted-foreground">{t('consent.preferredHint')}</p>
      </section>

      <TelegramSubscriptionBlock
        status={cp.telegramSubscription}
        linkPath={`/counterparties/${counterpartyId}/telegram-link`}
        unsubscribePath={`/counterparties/${counterpartyId}/telegram-subscription`}
        canManage={canEdit}
        onChanged={() => void detail.refetch()}
      />
    </div>
  );
}
