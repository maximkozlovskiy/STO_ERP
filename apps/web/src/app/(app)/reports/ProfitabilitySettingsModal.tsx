'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { useUpdateLaborCostRatio } from '@/hooks/api/useReports';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Частка праці, за якою пораховано звіт (`ProfitabilityReportDto.laborCostRatio`, 0…1). */
  laborCostRatio: number;
}

/** Відсотки з поля → частка 0…1; не ціле число від 0 до 100 — `null`. */
export function parseLaborPercent(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n <= 100 ? n / 100 : null;
}

/**
 * «Налаштування звіту» вкладки «Рентабельність» (BR-RPT-035): частка праці в собівартості робіт,
 * 0–100 %, крок 1 — поле `laborCostRatio` у `PATCH /settings/organisation`. Лише OWNER / ADMIN
 * (кнопку показує звіт). Escape і вкладені шари — стандартний `Modal`.
 */
export function ProfitabilitySettingsModal({ open, onClose, laborCostRatio }: Props) {
  const { t } = useTranslation('reports');
  const mut = useUpdateLaborCostRatio();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  // `mut.isPending` — знімок рендера: два кліки в одному кадрі обидва бачать `false`.
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setValue(String(Math.round(laborCostRatio * 100)));
    setError('');
    submittingRef.current = false;
  }, [open, laborCostRatio]);

  const handleSubmit = async () => {
    if (mut.isPending || submittingRef.current) return;
    const ratio = parseLaborPercent(value);
    if (ratio === null) {
      setError(t('page.profitability.settings.range'));
      return;
    }
    submittingRef.current = true;
    setError('');
    try {
      await mut.mutateAsync(ratio);
      toast.success(t('page.profitability.settings.saved'));
      onClose();
    } catch (e: unknown) {
      setError(
        e instanceof Error && e.message ? e.message : t('page.profitability.settings.saveError'),
      );
    } finally {
      submittingRef.current = false;
    }
  };

  const close = () => {
    if (!mut.isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      onSubmit={() => void handleSubmit()}
      title={t('page.profitability.settings.title')}
      size="sm"
      footer={
        <div className="flex gap-2 items-center justify-end w-full">
          <Button variant="outline" size="sm" onClick={close} disabled={mut.isPending}>
            {t('page.profitability.settings.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} loading={mut.isPending}>
            {t('page.profitability.settings.save')}
          </Button>
        </div>
      }
    >
      <div data-testid="profitability-settings-modal">
        <Input
          id="profitability-labor-ratio"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          label={t('page.profitability.settings.laborRatio')}
          hint={t('page.profitability.settings.laborRatioHint')}
          errorMessage={error || undefined}
          value={value}
          onChange={e => setValue(e.target.value)}
          className="w-32"
        />
      </div>
    </Modal>
  );
}
