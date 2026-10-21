'use client';

import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocumentSectionProps {
  /** Іконка секції (lucide) — стоїть у підкладці ліворуч від назви, декоративна. */
  icon: LucideIcon;
  /** Назва секції — заголовок `h3`, ним же підписано `<section>`. */
  title: string;
  /** Лічильник рядків (таблична частина). `undefined` — пігулки немає. */
  count?: number;
  /** Пояснення поруч із назвою, дрібніше й блідіше. */
  subtitle?: ReactNode;
  /** Дії секції праворуч у заголовку («+ Послуга», «Додати»…). */
  actions?: ReactNode;
  children?: ReactNode;
  /** Вміст без відступів — таблиця на всю ширину картки (рамка картки — її рамка). */
  flush?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * Секція картки документа (варіант A «Картки секцій», рішення власника 2026-10-22): біла картка на
 * сірому тілі вікна (`Modal bodyClassName="bg-secondary"`), заголовок — іконка, назва, лічильник
 * рядків і дії праворуч. Перший — наряд; далі на нього переходять рахунок, замовлення, складський
 * документ (там поки `DocLinesHeader`).
 */
export function DocumentSection({
  icon: Icon,
  title,
  count,
  subtitle,
  actions,
  children,
  flush = false,
  className,
  'data-testid': testId,
}: DocumentSectionProps) {
  const headingId = useId();
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn('rounded-xl border border-border bg-surface', className)}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-5 py-3.5">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <h3 id={headingId} className="text-[15px] font-semibold leading-tight text-foreground">
          {title}
        </h3>
        {count !== undefined && (
          <span
            data-testid="document-section-count"
            className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-secondary px-2 text-xs font-semibold tabular-nums text-foreground"
          >
            {count}
          </span>
        )}
        {subtitle && <span className="text-[13px] text-muted-foreground">{subtitle}</span>}
        {actions && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
      {hasBody && <div className={flush ? undefined : 'px-5 pb-4.5'}>{children}</div>}
    </section>
  );
}

type SectionActionVariant = 'outline' | 'accent';

const ACTION_VARIANTS: Record<SectionActionVariant, string> = {
  outline: 'border border-border-hover bg-surface font-medium text-foreground hover:bg-secondary',
  accent: 'bg-primary/10 font-semibold text-primary hover:bg-primary/15',
};

/** Кнопка дії в заголовку `DocumentSection`: «outline» — другорядна, «accent» — основна («Додати»). */
export function SectionActionButton({
  variant = 'outline',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: SectionActionVariant }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] whitespace-nowrap transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-40',
        ACTION_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

/** Порожня таблична частина секції — пунктирна рамка з підказкою замість порожньої таблиці. */
export function DocumentSectionEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="mx-5 mb-4 rounded-lg border border-dashed border-border-hover px-5 py-5 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}
