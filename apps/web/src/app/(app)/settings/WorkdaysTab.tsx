'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getCached, setCache } from '@/lib/ref-cache';
import { cn } from '@/lib/utils';
import { type BranchInfo } from './shared';

// День тижня → номер (1=Пн … 7=Нд); підписи у settings-каталозі (workdays.days.*).
const WORK_DAY_NUMS = [1, 2, 3, 4, 5, 6, 7];

interface BranchSettings {
  workStartTime: string;
  workEndTime: string;
  workDays: number[];
  slotDurationMinutes: number;
}

export default function WorkdaysTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [branchSettings, setBranchSettings] = useState<BranchSettings | null>(null);
  const [savingBranch, setSavingBranch] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const cachedBranches = getCached<BranchInfo[]>('cache:branches');
    if (cachedBranches && cachedBranches.length > 0) {
      setBranches(cachedBranches);
      setSelectedBranch(cachedBranches[0].id);
    }
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
        if (arr.length > 0) setSelectedBranch(prev => prev || arr[0].id);
      })
      .catch((e: unknown) =>
        console.warn('[WorkdaysTab] /branches failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  useEffect(() => {
    if (!selectedBranch) return;
    let cancelled = false;
    apiFetch<BranchSettings>(`/settings/branch/${selectedBranch}`)
      .then(s => {
        if (!cancelled) setBranchSettings(s);
      })
      .catch((e: unknown) =>
        console.warn(
          '[WorkdaysTab] branch settings load failed:',
          e instanceof Error ? e.message : e,
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [selectedBranch]);

  const toggleWorkDay = (day: number) => {
    if (!branchSettings) return;
    const days = branchSettings.workDays.includes(day)
      ? branchSettings.workDays.filter(d => d !== day)
      : [...branchSettings.workDays, day].sort();
    setBranchSettings({ ...branchSettings, workDays: days });
  };

  const saveBranchSettings = async () => {
    if (!branchSettings || !selectedBranch) return;
    setSavingBranch(true);
    try {
      await apiFetch(`/settings/branch/${selectedBranch}`, {
        method: 'PATCH',
        body: JSON.stringify(branchSettings),
      });
      if (currentFeatures.toastEnabled) toast.success(t('workdays.saved'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingBranch(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {branches.length > 1 && (
        <Select
          label={t('workdays.branch')}
          value={selectedBranch}
          onChange={e => setSelectedBranch(e.target.value)}
          className="h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          {branches.map(b => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}

      {branchSettings && (
        <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
          <div>
            <p className="text-[13px] font-medium text-foreground mb-2">{t('workdays.workDays')}</p>
            <div className="flex gap-2">
              {WORK_DAY_NUMS.map(day => (
                <button
                  key={day}
                  onClick={() => toggleWorkDay(day)}
                  className={cn(
                    'w-9 h-9 rounded-full text-sm font-medium transition-colors',
                    branchSettings.workDays.includes(day)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground hover:bg-secondary/80',
                  )}
                >
                  {t(`workdays.days.${day}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                {t('workdays.workStart')}
              </label>
              <Input
                type="time"
                value={branchSettings.workStartTime}
                onChange={e =>
                  setBranchSettings(s => (s ? { ...s, workStartTime: e.target.value } : s))
                }
                className="w-32 h-8 text-[13px]"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                {t('workdays.workEnd')}
              </label>
              <Input
                type="time"
                value={branchSettings.workEndTime}
                onChange={e =>
                  setBranchSettings(s => (s ? { ...s, workEndTime: e.target.value } : s))
                }
                className="w-32 h-8 text-[13px]"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                {t('workdays.slotDuration')}
              </label>
              <Input
                type="number"
                min="15"
                max="240"
                step="15"
                value={branchSettings.slotDurationMinutes}
                onChange={e =>
                  setBranchSettings(s =>
                    s ? { ...s, slotDurationMinutes: Number(e.target.value) } : s,
                  )
                }
                className="w-32 h-8 text-[13px]"
              />
            </div>
          </div>
          <Button onClick={() => void saveBranchSettings()} loading={savingBranch}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
