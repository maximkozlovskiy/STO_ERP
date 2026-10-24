'use client';

// BR-WO-032: панель посилання на кошторис над кнопкою «Поділитись» у картці наряду — адреса, дата
// згорання, «Згенерувати нове» й «Відкликати». Стан і дії — у useWorkOrderActions; Escape — шар
// Escape там само (useEscapeLayer), тут лише розмітка.
import { useTranslation } from 'react-i18next';
import { Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/format';
import { shareUrl, type ShareLinkState } from '@/hooks/useWorkOrderActions';

export interface ShareLinkPanelProps {
  link: NonNullable<ShareLinkState>;
  loading: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onRevoke: () => void;
  onClose: () => void;
}

export function ShareLinkPanel({
  link,
  loading,
  onCopy,
  onRegenerate,
  onRevoke,
  onClose,
}: ShareLinkPanelProps) {
  const { t } = useTranslation('workOrders');
  const url = link.status === 'active' ? shareUrl(link.token) : '';
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} role="presentation" />
      <div
        role="dialog"
        aria-labelledby="wo-share-link-title"
        data-testid="wo-share-link-panel"
        className="absolute bottom-full right-0 z-50 mb-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-3 shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 id="wo-share-link-title" className="text-[13px] font-semibold">
            {t('share.title')}
          </h3>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('share.close')}>
            <X size={14} />
          </Button>
        </div>
        {link.status === 'active' ? (
          <>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={url}
                aria-label={t('share.linkLabel')}
                onFocus={e => e.currentTarget.select()}
                className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 text-[12px] tabular-nums"
              />
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onCopy}
                aria-label={t('share.copy')}
                title={t('share.copy')}
              >
                <Copy size={14} />
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-foreground-muted" data-testid="wo-share-expires">
              {t('share.expiresAt', { date: fmtDateTime(link.expiresAt) })}
            </p>
          </>
        ) : (
          <div className="text-[12px]" role="status">
            <p className="font-medium">{t('share.revoked')}</p>
            <p className="text-foreground-muted">{t('share.revokedHint')}</p>
          </div>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRegenerate}
            disabled={loading}
            title={t('share.regenerateTitle')}
          >
            {t('share.regenerate')}
          </Button>
          {link.status === 'active' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onRevoke}
              disabled={loading}
              title={t('share.revokeTitle')}
            >
              {t('share.revoke')}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
