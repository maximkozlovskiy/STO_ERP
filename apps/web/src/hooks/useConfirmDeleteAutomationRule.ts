import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useDeleteAutomationRule } from '@/hooks/api/useAutomation';
import type { ConfirmOptions } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';

/**
 * Видалення правила автоматизації з підтвердженням — один сценарій для списку й картки правила.
 * `confirm` — з `useConfirm()` того компонента, що рендерить `ConfirmDialog`. `true` — видалено.
 */
export function useConfirmDeleteAutomationRule(
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
) {
  const { t } = useTranslation('automation');
  const features = useUiFeatures();
  const remove = useDeleteAutomationRule();

  const deleteRule = async (rule: { id: string; name: string }): Promise<boolean> => {
    const ok = await confirm({
      title: t('deleteConfirm.title'),
      message: t('deleteConfirm.message', { name: rule.name }),
      confirmLabel: t('card.delete'),
      variant: 'destructive',
    });
    if (!ok) return false;
    try {
      await remove.mutateAsync(rule.id);
      if (features.toastEnabled) toast.success(t('toast.deleted'));
      return true;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('card.loadError'));
      return false;
    }
  };

  return { deleteRule, isPending: remove.isPending };
}
