'use client';

import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { cn } from '@/lib/utils';

/**
 * Поля шапки картки документа (наряд, рахунок, замовлення постачальнику, складський документ):
 * номер, поле з підписом (дата документа, дата оплати…), «Статус ◀ · ▾ · ▶». Розмітка була
 * скопійована в чотири картки (гейт jscpd, 2026-10-26); тексти й значення передає картка.
 */

/** «Номер: …» — номер документа або «присвоюється автоматично» для нового. */
export function DocumentNumberField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground shrink-0">
      <span className="font-medium">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

/** Поле шапки: підпис ліворуч, контрол фіксованої ширини праворуч. */
export function DocumentHeaderField({
  label,
  width = 'w-36',
  children,
}: {
  label: string;
  width?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <div className={width}>{children}</div>
    </div>
  );
}

/** Дата з форми react-hook-form (рядок `YYYY-MM-DD`) у календарі. */
export function FormDateInput<T extends FieldValues>({
  control,
  name,
  disabled,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  disabled?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <DatePickerInput
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={field.onChange}
          disabled={disabled}
        />
      )}
    />
  );
}

const stepBtn =
  'flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors';

export interface DocumentStatusStepperProps {
  /** Назва статусу для стрілок ◀ / ▶. */
  stepLabel: (status: string) => string;
  /** Підпис поля («Статус:»). */
  label: string;
  /** Контейнер меню — картка закриває меню кліком поза ним. */
  menuRef: RefObject<HTMLDivElement | null>;
  /** Документ збережено: стрілки й меню переходів працюють. */
  active: boolean;
  /** Іде перехід статусу. */
  busy: boolean;
  /** Картка лише на перегляд (видалений / незнайдений документ) — меню не відкривається. */
  locked: boolean;
  prev?: string;
  next?: string;
  /** Перехід у статус; закриття меню — справа картки (`doTransition` закриває його першим). */
  onStep: (status: string) => void;
  menuShown: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  transitions: readonly string[];
  transitionLabel: (status: string) => string;
  /** Підказка на стрілках — назва сусіднього статусу. */
  stepTitles?: boolean;
  /** Колір і текст типової пігулки поточного статусу (без `pill`). */
  statusColor?: string;
  statusLabel?: string;
  statusTitle?: string;
  /** Власна пігулка статусу (наряд — з підказкою й крапкою); інакше — типова кнопка. */
  pill?: ReactNode;
}

/** «Статус: ◀ попередній · [поточний ▾] · наступний ▶» з меню переходів у шапці картки. */
export function DocumentStatusStepper({
  stepLabel,
  label,
  menuRef,
  active,
  busy,
  locked,
  prev,
  next,
  onStep,
  menuShown,
  setMenuOpen,
  transitions,
  transitionLabel,
  stepTitles,
  statusColor,
  statusLabel,
  statusTitle,
  pill,
}: DocumentStatusStepperProps) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <div ref={menuRef} className="relative flex items-center gap-1">
        <button
          type="button"
          disabled={busy || !prev || !active}
          onClick={() => prev && onStep(prev)}
          title={stepTitles && prev ? stepLabel(prev) : undefined}
          className={stepBtn}
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-20 truncate">{prev ? stepLabel(prev) : '—'}</span>
        </button>
        {pill ?? (
          <button
            type="button"
            disabled={busy || !active || locked}
            onClick={() => active && setMenuOpen(o => !o)}
            title={statusTitle}
            className={cn(
              'text-sm font-medium px-2.5 py-1 rounded-full transition-colors',
              statusColor,
              active && !busy && 'cursor-pointer hover:opacity-80',
              !active && 'cursor-default',
            )}
          >
            {statusLabel}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !next || !active}
          onClick={() => next && onStep(next)}
          title={stepTitles && next ? stepLabel(next) : undefined}
          className={stepBtn}
        >
          <span className="max-w-20 truncate">{next ? stepLabel(next) : '—'}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        </button>
        {menuShown && (
          <div className="absolute top-full left-0 mt-1 z-50 min-w-40 rounded-lg border border-border bg-surface shadow-lg py-1">
            {transitions.map(st => (
              <button
                key={st}
                type="button"
                disabled={busy}
                onClick={() => onStep(st)}
                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors disabled:opacity-50"
              >
                {transitionLabel(st)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
