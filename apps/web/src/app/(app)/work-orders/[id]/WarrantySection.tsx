'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WO_INVOICE_VISIBLE_STATUSES } from '@sto/shared';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import {
  useWarrantiesByWorkOrder,
  useClaimWarranty,
  type Warranty,
} from '@/hooks/api/useWarranties';
import { WarrantyCreateModal } from '@/components/ui/WarrantyCreateModal';

interface Props {
  workOrderId: string;
  counterpartyId: string;
  workOrderStatus: string;
}

/** Стан гарантії з claimedAt+expiresAt (бекенд не має enum). Дзеркалить counterparties tab. */
function StateBadge({ w }: { w: Warranty }) {
  const { t } = useTranslation('workOrders');
  if (w.isActive) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-success/10 text-success">
        {t('warranty.active')}
      </span>
    );
  }
  if (w.claimedAt) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-warning/10 text-warning">
        {t('warranty.claimed')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground">
      {t('warranty.expired')}
    </span>
  );
}

/**
 * Секція гарантій у картці наряду. Показує гарантії наряду (авто-створені при COMPLETED або ручні),
 * дозволяє «Пред'явити» (claim у поточний наряд) активну гарантію + ручне створення. Дзеркалить
 * InvoiceSection: гейт за статусом, обгортка error-boundary — у батьківському PageClient.
 */
export function WarrantySection({ workOrderId, counterpartyId, workOrderStatus }: Props) {
  const { t } = useTranslation('workOrders');
  const features = useUiFeatures();
  const [createOpen, setCreateOpen] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  // Гейт — той самий видимий-статус набір, що для рахунку (COMPLETED/INVOICED/PAID/ARCHIVED):
  // гарантії з'являються від COMPLETED. Не рендеримо секцію на ранніх статусах.
  const visible = WO_INVOICE_VISIBLE_STATUSES.includes(workOrderStatus);
  const { data, isLoading, refetch } = useWarrantiesByWorkOrder(workOrderId, visible);
  const claim = useClaimWarranty();

  if (!visible) return null;

  const items = data?.items ?? [];

  const handleClaim = async (w: Warranty) => {
    setClaimingId(w.id);
    try {
      // Пред'являємо гарантію у ПОТОЧНИЙ наряд (той, який відкрито) — типовий сценарій.
      await claim.mutateAsync({ id: w.id, claimWoId: workOrderId });
      if (features.toastEnabled) toast.success(t('warranty.claimedToast'));
      await refetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('warranty.claimError');
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-border bg-secondary flex items-center justify-between">
        <h3 className="font-medium text-foreground text-sm">{t('warranty.title')}</h3>
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          {t('warranty.add')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size="md" />
        </div>
      ) : items.length === 0 ? (
        <div className="p-4 text-center text-muted-foreground text-[13px]">
          {t('warranty.empty')}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {items.map(w => (
            <div key={w.id} className="px-5 py-3 flex items-center justify-between gap-3 text-sm">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground">
                  {w.description || t('warranty.defaultDescription')}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {t('warranty.until', { date: fmtDate(w.expiresAt) })}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StateBadge w={w} />
                {w.isActive && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={claimingId === w.id}
                    onClick={() => void handleClaim(w)}
                  >
                    {t('warranty.claim')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <WarrantyCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        workOrderId={workOrderId}
        counterpartyId={counterpartyId}
        onCreated={() => void refetch()}
      />
    </div>
  );
}
