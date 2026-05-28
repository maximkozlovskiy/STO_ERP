import { daysUntil } from '@/lib/utils';

interface ExpiryBadgeProps {
  /** Дата завершення (ISO-рядок або Date). */
  date: string | Date | null | undefined;
  /** Поточний час у мс (SSR-safe: передавати з useState/useEffect, не new Date() у render). */
  nowMs: number;
  /** Текст коли вже прострочено (diffDays < 0). */
  expiredLabel: string;
  /** Текст коли наближається термін (0 ≤ diffDays ≤ soonDays). */
  soonLabel?: string;
  /** Поріг "скоро" у днях. За замовчуванням 30. */
  soonDays?: number;
}

/**
 * Бейдж стану терміну: "прострочено" (destructive) або "скоро" (warning).
 * Повертає `null` коли дата відсутня, ще не завантажена або поза порогом.
 *
 * Замінює 4 дубльовані inline-IIFE (страховка/техогляд у vehicles/[id], ТО у crm/[id]).
 */
export function ExpiryBadge({
  date,
  nowMs,
  expiredLabel,
  soonLabel = 'Закінчується',
  soonDays = 30,
}: ExpiryBadgeProps) {
  const diff = daysUntil(date, nowMs);
  if (diff === null) return null;
  if (diff < 0) {
    return (
      <span className="text-[11px] px-1.5 py-0.5 bg-destructive-subtle text-destructive rounded font-medium">
        {expiredLabel}
      </span>
    );
  }
  if (diff <= soonDays) {
    return (
      <span className="text-[11px] px-1.5 py-0.5 bg-warning-subtle text-warning rounded font-medium">
        {soonLabel}
      </span>
    );
  }
  return null;
}
