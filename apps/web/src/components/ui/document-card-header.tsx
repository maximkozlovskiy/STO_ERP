'use client';

import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { CurrencySelect } from '@/components/ui/CurrencySelect';
import { Select } from '@/components/ui/select';
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

/**
 * Валюта документа з форми react-hook-form. Авто-дефолт базової валюти — програмна зміна, не дія
 * користувача: картка пише її через `onAutoDefault` з `shouldDirty: false`, щоб незаймана картка не
 * вважалась брудною (Bug #639/#747-клас).
 */
export function FormCurrencySelect<T extends FieldValues>({
  control,
  name,
  disabled,
  onAutoDefault,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  disabled?: boolean;
  onAutoDefault: (currencyId: string) => void;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <CurrencySelect
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={id => field.onChange(id)}
          onAutoDefault={onAutoDefault}
          disabled={disabled}
        />
      )}
    />
  );
}

/** Склад документа з форми react-hook-form: «Оберіть…», список складів, помилка поля з форми. */
export function FormWarehouseSelect<T extends FieldValues>({
  control,
  name,
  label,
  chooseLabel,
  warehouses,
  disabled,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  chooseLabel: string;
  warehouses: readonly { id: string; name: string }[];
  disabled?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Select
          label={label}
          required
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={field.onChange}
          errorMessage={fieldState.error?.message}
          disabled={disabled}
          className="h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          <option value="">{chooseLabel}</option>
          {warehouses.map(w => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      )}
    />
  );
}

/**
 * Поле шапки, у контролу якого немає власного `errorMessage` (`EntityPickerField`): контрол і під
 * ним текст помилки валідації.
 */
export function FieldWithError({
  error,
  children,
}: {
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      {children}
      {error && <p className="text-[12px] text-destructive leading-tight mt-1">{error}</p>}
    </div>
  );
}

const stepBtn =
  'flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed aria-disabled:opacity-30 aria-disabled:cursor-not-allowed transition-colors';

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
  /**
   * Переходи, яких документ зараз не пройде (рахунок без рядків — BR-INV-023): статус → причина.
   * Стрілка й пункт меню лишаються у фокусі (`aria-disabled`, не `disabled`), причина — підказкою,
   * клік нічого не робить.
   */
  blocked?: Readonly<Partial<Record<string, string>>>;
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
  blocked,
}: DocumentStatusStepperProps) {
  const reason = (status: string | undefined) => (status ? blocked?.[status] : undefined);
  const step = (status: string | undefined) => {
    if (status && !reason(status)) onStep(status);
  };
  const prevBlocked = reason(prev);
  const nextBlocked = reason(next);
  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <div ref={menuRef} className="relative flex items-center gap-1">
        <button
          type="button"
          disabled={busy || !prev || !active}
          aria-disabled={prevBlocked ? true : undefined}
          onClick={() => step(prev)}
          title={prevBlocked ?? (stepTitles && prev ? stepLabel(prev) : undefined)}
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
          aria-disabled={nextBlocked ? true : undefined}
          onClick={() => step(next)}
          title={nextBlocked ?? (stepTitles && next ? stepLabel(next) : undefined)}
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
                aria-disabled={reason(st) ? true : undefined}
                title={reason(st)}
                onClick={() => step(st)}
                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
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
