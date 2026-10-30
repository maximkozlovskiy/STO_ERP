'use client';

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import {
  buildServiceFromWorkOrder,
  type WorkOrderLineForService,
  type WorkOrderPartForService,
} from '@/lib/work-order-to-service';

/** Скільки id в одному `GET /works?ids=` (межа сервера — 200, як `limit`). */
const WORK_IDS_PER_REQUEST = 200;

/** Норми робіт каталогу за id; видалених робіт сервер не повертає — їх у мапі немає. */
async function catalogNormoHours(workIds: readonly string[]): Promise<Map<string, number>> {
  const wanted = [...new Set(workIds)];
  const map = new Map<string, number>();
  for (let i = 0; i < wanted.length; i += WORK_IDS_PER_REQUEST) {
    const ids = wanted.slice(i, i + WORK_IDS_PER_REQUEST);
    const r = await apiFetch<{ items: { id: string; normoHours: number }[] }>(
      `/works?ids=${ids.map(encodeURIComponent).join(',')}&limit=${WORK_IDS_PER_REQUEST}`,
    );
    for (const w of r.items ?? []) map.set(w.id, Number(w.normoHours) || 0);
  }
  return map;
}

interface SaveAsServiceButtonProps {
  number: string;
  lines: readonly WorkOrderLineForService[];
  parts: readonly WorkOrderPartForService[];
}

/**
 * «Зберегти як послугу» (BR-WO-036): роботи й запчастини наряду стають послугою каталогу, яку
 * потім додає кнопка «Послуга» картки наряду (`applyService`, BR-WO-030). Ціни не зберігаються —
 * при застосуванні їх бере каталог.
 */
export function SaveAsServiceButton({ number, lines, parts }: SaveAsServiceButtonProps) {
  const { t } = useTranslation('workOrders');
  const router = useRouter();
  const features = useUiFeatures();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  // Синхронний замок: подвійний клік / Enter + клік не створюють двох послуг.
  const savingRef = useRef(false);

  const empty = lines.length === 0 && parts.length === 0;

  const openDialog = () => {
    setName(t('detail.saveAsService.defaultName', { number }));
    setNameError('');
    setFormError('');
    setOpen(true);
  };

  const close = () => {
    if (savingRef.current) return;
    setOpen(false);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('detail.saveAsService.nameRequired'));
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFormError('');
    try {
      const norms = lines.length
        ? await catalogNormoHours(lines.map(l => l.workId))
        : new Map<string, number>();
      const draft = buildServiceFromWorkOrder(lines, parts, norms);
      if (draft.works.length === 0 && draft.goods.length === 0) {
        setFormError(t('detail.saveAsService.nothingToSave'));
        return;
      }
      await apiFetch<{ id: string }>('/services', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          description: t('detail.saveAsService.description', { number }),
          works: draft.works,
          goods: draft.goods,
        }),
      });
      setOpen(false);
      const message = draft.skippedWorkIds.length
        ? t('detail.saveAsService.savedSkipped', {
            name: trimmed,
            count: draft.skippedWorkIds.length,
          })
        : t('detail.saveAsService.saved', { name: trimmed });
      if (features.toastEnabled) {
        toast.success(message, 8000, {
          label: t('detail.saveAsService.openInCatalog'),
          onClick: () => router.push(`/catalog?tab=services&q=${encodeURIComponent(trimmed)}`),
        });
      }
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : t('detail.saveAsService.saveError'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={openDialog}
        disabled={empty}
        title={empty ? t('detail.saveAsService.emptyHint') : undefined}
        data-testid="wo-save-as-service"
      >
        {t('detail.saveAsService.button')}
      </Button>
      <Modal
        open={open}
        onClose={close}
        onSubmit={() => void save()}
        title={t('detail.saveAsService.title')}
        description={t('detail.saveAsService.hint')}
        size="md"
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="outline" onClick={close} disabled={saving}>
              {t('detail.saveAsService.cancel')}
            </Button>
            <Button onClick={() => void save()} loading={saving} disabled={saving}>
              {t('detail.saveAsService.submit')}
            </Button>
          </div>
        }
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            label={t('detail.saveAsService.nameLabel')}
            value={name}
            maxLength={200}
            autoFocus
            onChange={e => {
              setName(e.target.value);
              if (nameError) setNameError('');
            }}
            errorMessage={nameError || undefined}
          />
          {formError && (
            <p role="alert" className="mt-3 text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
