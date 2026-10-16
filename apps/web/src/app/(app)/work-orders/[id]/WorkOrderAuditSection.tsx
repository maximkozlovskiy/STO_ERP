'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AUDIT_VIEW_ROLES } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';

interface AuditEventItem {
  id: string;
  action: string;
  diff: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string };
}

interface WorkOrderAuditSectionProps {
  woId: string;
}

/**
 * «Журнал змін» наряду. Лише ролям із доступом до `GET /audit` (`AUDIT_VIEW_ROLES`: власник,
 * адміністратор, бухгалтер): для приймальні й механіка — ні запиту (інакше 403 у консолі), ні
 * блоку (рішення власника 2026-10-16). Порожній журнал — блок не показується.
 */
export function WorkOrderAuditSection({ woId }: WorkOrderAuditSectionProps) {
  const { t } = useTranslation('workOrders');
  const { employee } = useAuth();
  const canView = AUDIT_VIEW_ROLES.includes(employee?.role ?? '');
  const [auditEvents, setAuditEvents] = useState<AuditEventItem[]>([]);

  useEffect(() => {
    if (!canView) {
      setAuditEvents([]);
      return;
    }
    let cancelled = false;
    // Вторинний блок: збій журналу не ламає сторінку — блок просто не показується.
    apiFetch<{ items: AuditEventItem[] }>(`/audit?entityType=WorkOrder&entityId=${woId}`)
      .then(res => {
        if (!cancelled) setAuditEvents(res.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setAuditEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canView, woId]);

  if (!canView || auditEvents.length === 0) return null;

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
            .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
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
