'use client';

import { useTranslation } from 'react-i18next';
import { fmtDateTime } from '@/lib/format';

interface AuditEventItem {
  id: string;
  action: string;
  diff: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string };
}

interface WorkOrderAuditSectionProps {
  auditEvents: AuditEventItem[];
}

export function WorkOrderAuditSection({ auditEvents }: WorkOrderAuditSectionProps) {
  const { t } = useTranslation('workOrders');
  if (auditEvents.length === 0) return null;

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-secondary">
        <h3 className="font-medium text-foreground text-sm">{t('audit.title')}</h3>
      </div>
      <div className="divide-y divide-border max-h-64 overflow-y-auto">
        {auditEvents.map(ev => {
          const who = `${ev.user.lastName} ${ev.user.firstName}`;
          const when = fmtDateTime(ev.createdAt);
          const diff = ev.diff as Record<string, { from: unknown; to: unknown }>;
          const changes = Object.entries(diff)
            .filter(([, v]) => v && typeof v === 'object' && 'from' in v)
            .map(
              ([k, v]) =>
                `${k}: ${(v as { from: unknown; to: unknown }).from} → ${(v as { from: unknown; to: unknown }).to}`,
            )
            .join(', ');
          return (
            <div key={ev.id} className="px-5 py-2.5 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">{who}</span>{' '}
              {ev.action === 'CREATE'
                ? t('audit.created')
                : ev.action === 'DELETE'
                  ? t('audit.deleted')
                  : t('audit.changed')}{' '}
              {changes && <span className="text-foreground-muted">({changes})</span>}{' '}
              <span className="ml-1">{when}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
