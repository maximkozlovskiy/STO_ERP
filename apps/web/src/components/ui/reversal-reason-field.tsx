'use client';

import type { UseFormRegisterReturn } from 'react-hook-form';

/**
 * Поле «Причина сторно» з лічильником символів — спільне для вікон сторно (каса, оплата клієнта,
 * оплата постачальнику). Раніше розмітка повторювалась у `CashReversalModal` і `ReversalReasonModal`.
 */
export function ReversalReasonField({
  id,
  label,
  placeholder,
  registration,
  maxLength,
  errorMessage,
  counter,
}: {
  id: string;
  label: string;
  placeholder: string;
  registration: UseFormRegisterReturn;
  maxLength: number | undefined;
  errorMessage: string | undefined;
  /** Текст лічильника («12 / 500»); `undefined` — без лічильника (ліміту немає). */
  counter: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-foreground leading-none">
        {label}
        <span className="ml-0.5 text-destructive">*</span>
      </label>
      <textarea
        id={id}
        {...registration}
        maxLength={maxLength}
        rows={3}
        required
        autoFocus
        aria-invalid={!!errorMessage}
        placeholder={placeholder}
        className="w-full rounded border border-border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition-all duration-150 hover:border-border-hover focus:border-primary focus:ring-3 focus:ring-brand-100 resize-y"
      />
      <div className="flex items-start justify-between gap-3">
        <p role={errorMessage ? 'alert' : undefined} className="text-[12px] text-destructive">
          {errorMessage}
        </p>
        {counter !== undefined && (
          <p className="shrink-0 text-[12px] text-muted-foreground text-right tabular-nums">
            {counter}
          </p>
        )}
      </div>
    </div>
  );
}
