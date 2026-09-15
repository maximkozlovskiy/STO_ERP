'use client';

// Панель «Планові та фактичні показники» наряду (TD3-декомпозиція CreateWorkOrderModal).
// Винесено без зміни поведінки — cohesive суб-форма (дати/нормогодини). Фактична колонка
// read-only (заповнюється з ліній): дати завжди disabled+NOOP, нормогодини = liveActualHours
// (обчислені з ліній) або form.actualHours, disabled коли live-значення присутнє.
import type { ChangeEvent } from 'react';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';

const NOOP_DT_CHANGE: (v: string) => void = () => {};

export interface PlannedActualMetricsProps {
  canEdit: boolean;
  plannedStartAt: string;
  plannedEndAt: string;
  plannedHours: string;
  actualHours: string;
  liveActualHours: number | null;
  onPlannedStartChange: (v: string) => void;
  onPlannedEndChange: (v: string) => void;
  onPlannedHoursChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onActualHoursChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

export function PlannedActualMetrics({
  canEdit,
  plannedStartAt,
  plannedEndAt,
  plannedHours,
  actualHours,
  liveActualHours,
  onPlannedStartChange,
  onPlannedEndChange,
  onPlannedHoursChange,
  onActualHoursChange,
}: PlannedActualMetricsProps) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-border">
        <div className="px-3 py-1.5 bg-secondary/50 text-xs font-medium text-muted-foreground">
          Планові показники
        </div>
        <div className="px-3 py-1.5 bg-secondary/50 text-xs font-medium text-muted-foreground">
          Фактичні показники
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-3 p-3">
          <DateTimePickerInput
            label="Дата та час початку"
            value={plannedStartAt}
            onChange={onPlannedStartChange}
            disabled={!canEdit}
            inputClassName="h-8 text-[13px]"
          />
          <DateTimePickerInput
            label="Дата та час завершення"
            value={plannedEndAt}
            onChange={onPlannedEndChange}
            disabled={!canEdit}
            inputClassName="h-8 text-[13px]"
          />
          <div className="flex flex-col gap-1 min-w-20">
            <label className="text-[11px] text-muted-foreground font-medium">Нормогодин</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={plannedHours}
              onChange={onPlannedHoursChange}
              disabled={!canEdit}
              placeholder="0"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] tabular-nums disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-3 p-3">
          <DateTimePickerInput
            label="Дата та час початку"
            value=""
            onChange={NOOP_DT_CHANGE}
            disabled
            inputClassName="h-8 text-[13px]"
          />
          <DateTimePickerInput
            label="Дата та час завершення"
            value=""
            onChange={NOOP_DT_CHANGE}
            disabled
            inputClassName="h-8 text-[13px]"
          />
          <div className="flex flex-col gap-1 min-w-20">
            <label className="text-[11px] text-muted-foreground font-medium">Нормогодин</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={liveActualHours != null ? liveActualHours : actualHours}
              onChange={onActualHoursChange}
              disabled={!canEdit || liveActualHours != null}
              placeholder="0"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] tabular-nums disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
