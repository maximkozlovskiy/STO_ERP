'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { toast } from '@/lib/toast';
import { fmtDate } from '@/lib/format';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { usePaginatedList } from '@/hooks/api/usePaginatedList';
import type { WorkOrder } from '@/hooks/api/useWorkOrders';
import { useClaimWarranty, type WarrantyListItem } from '@/hooks/api/useWarranties';
import { woStatusLabel } from '@/i18n/enumLabel';

/** Наряди клієнта для вибору: найновіші першими; більше сотні у клієнта — рідкість. */
const CANDIDATES_LIMIT = 100;

interface Props {
  warranty: WarrantyListItem | null;
  onClose: () => void;
}

/**
 * BR-WAR-004/005: «Звернення» за гарантією — вибір наряду-звернення серед нарядів того самого
 * клієнта, крім скасованих. Сервер сам відмовить, якщо гарантію вже використано чи вона
 * закінчилась (атомарний запис) — текст відмови показуємо у вікні.
 */
export function WarrantyClaimModal({ warranty, onClose }: Props) {
  const { t } = useTranslation('workOrders');
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const claim = useClaimWarranty();
  const [claimWoId, setClaimWoId] = useState('');
  const [error, setError] = useState('');
  // Синхронний сторож: `loading` вимикає кнопку лише після перемальовки — два кліки в одному
  // такті дали б два звернення (клас Bug #630).
  const savingRef = useRef(false);
  const open = !!warranty;

  const {
    data,
    isLoading,
    isPlaceholderData,
    error: loadError,
  } = usePaginatedList<WorkOrder>(
    '/work-orders',
    {
      counterpartyId: warranty?.counterpartyId,
      limit: CANDIDATES_LIMIT,
      sortBy: 'createdAt',
      sortDir: 'desc',
    },
    { queryKey: 'work-orders', enabled: open },
  );
  // `keepPreviousData` у спільному хуку: відкрили вікно для гарантії ІНШОГО клієнта — до відповіді
  // в кеші лежать наряди попереднього, і в перелік потрапив би чужий наряд.
  const loadingCandidates = isLoading || isPlaceholderData;
  const candidates = useMemo(
    () => (data?.items ?? []).filter(wo => wo.status !== 'CANCELLED' && !wo.deletedAt),
    [data],
  );

  useEffect(() => {
    if (!open) return;
    setClaimWoId('');
    setError('');
    dirty.resetDirty();
    savingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warranty?.id]);

  const handleClose = async () => {
    if (savingRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const submit = async () => {
    if (savingRef.current || !warranty || !claimWoId) return;
    savingRef.current = true;
    setError('');
    try {
      await claim.mutateAsync({ id: warranty.id, claimWoId });
      if (features.toastEnabled) toast.success(t('warrantiesTab.claimedToast'));
      dirty.resetDirty();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error && e.message ? e.message : t('warrantiesTab.claimError');
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      savingRef.current = false;
    }
  };

  // Перелік не завантажився — це не «у клієнта немає нарядів» (Bug #858).
  const emptyText = loadError
    ? t('warrantiesTab.claimLoadError')
    : t('warrantiesTab.claimNoWorkOrders');

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleClose()}
        title={t('warrantiesTab.claimTitle')}
        size="sm"
        onSubmit={() => void submit()}
        footer={
          <ModalFooter>
            <Button variant="outline" onClick={() => void handleClose()} disabled={claim.isPending}>
              {t('warrantiesTab.claimCancel')}
            </Button>
            <Button
              onClick={() => void submit()}
              loading={claim.isPending}
              disabled={!claimWoId || claim.isPending}
            >
              {t('warrantiesTab.claimSubmit')}
            </Button>
          </ModalFooter>
        }
      >
        {warranty && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('warrantiesTab.claimFor', {
                number: warranty.workOrderNumber ?? '',
                date: fmtDate(warranty.expiresAt),
              })}
            </p>
            {error && (
              <div
                role="alert"
                className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
              >
                {error}
              </div>
            )}
            {loadingCandidates ? (
              <div className="flex justify-center py-4">
                <Spinner size="md" />
              </div>
            ) : candidates.length === 0 ? (
              <p className="text-[13px] text-muted-foreground" role="status">
                {emptyText}
              </p>
            ) : (
              <Select
                label={t('warrantiesTab.claimWorkOrder')}
                hint={t('warrantiesTab.claimWorkOrderHint')}
                value={claimWoId}
                onChange={e => {
                  setClaimWoId(e.target.value);
                  dirty.markDirty();
                }}
              >
                <option value="">{t('warrantiesTab.claimChoose')}</option>
                {candidates.map(wo => (
                  <option key={wo.id} value={wo.id}>
                    {`${wo.number} · ${woStatusLabel(wo.status)}${wo.vehicleSummary ? ` · ${wo.vehicleSummary}` : ''}`}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
