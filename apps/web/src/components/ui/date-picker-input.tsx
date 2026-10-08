'use client';

import { useState, useRef, useEffect, useMemo, type ChangeEvent } from 'react';
import { DayPicker, type Matcher } from 'react-day-picker';
import { uk } from 'date-fns/locale';
import { format, parse, isValid } from 'date-fns';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';

// Module-level class name table — DayPicker `classNames` має бути stable reference,
// інакше внутрішня memoization інвалідовується на кожен ререндер батьківського компоненту.
const DAY_PICKER_CLASS_NAMES = {
  root: 'rdp-root',
  month_caption: 'flex justify-center items-center mb-2 font-medium text-sm text-foreground',
  nav: 'flex items-center gap-1',
  button_previous: 'p-1 rounded hover:bg-secondary text-muted-foreground',
  button_next: 'p-1 rounded hover:bg-secondary text-muted-foreground',
  weeks: 'border-collapse',
  weekdays: '',
  weekday: 'text-[11px] text-muted-foreground font-normal w-8 text-center pb-1',
  week: '',
  day: 'w-8 h-8 text-sm',
  day_button:
    'w-8 h-8 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
  selected: 'bg-primary text-primary-foreground hover:bg-primary rounded-lg',
  today: 'font-bold text-primary',
  outside: 'text-muted-foreground opacity-40',
  disabled: 'opacity-30 cursor-not-allowed',
} as const;

interface DatePickerInputProps {
  value: string; // YYYY-MM-DD для API
  onChange: (value: string) => void;
  label?: string;
  /** Доступна назва поля, коли видимий підпис стоїть поруч, а не в `label`. */
  ariaLabel?: string;
  hint?: string;
  errorMessage?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  min?: string; // YYYY-MM-DD
  max?: string; // YYYY-MM-DD
}

function parseApiDate(value: string): Date | undefined {
  if (!value) return undefined;
  const d = parse(value, 'yyyy-MM-dd', new Date());
  return isValid(d) ? d : undefined;
}

function displayDate(value: string): string {
  const d = parseApiDate(value);
  return d ? format(d, 'dd.MM.yyyy') : '';
}

export function DatePickerInput({
  value,
  onChange,
  label,
  ariaLabel,
  hint,
  errorMessage,
  required,
  disabled,
  placeholder = 'ДД.ММ.РРРР',
  className,
  min,
  max,
}: DatePickerInputProps) {
  const [open, setOpen] = useState(false);
  const [inputText, setInputText] = useState(displayDate(value));
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync external value → display text
  useEffect(() => {
    setInputText(displayDate(value));
  }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Escape закриває ЛИШЕ календар, де б не був фокус: у полі, на кнопці-іконці чи на дні
  // в попапі. Обробник лише на <input> цього не покривав — календар, відкритий кнопкою
  // (фокус на ній), на Escape закривав усю модалку-батька разом із незбереженою формою.
  // Capture + stopImmediatePropagation, як у DateTimePickerInput: <Modal> слухає Escape на
  // document у bubble-фазі, тож перехопити треба раніше за нього.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open]);

  // parse min/max bounds and enforce them in both manual typing and DayPicker.
  // Memoize: parseApiDate створює новий Date об'єкт на кожен виклик. Без useMemo
  // disabledMatchers нижче перебудовується на кожен ререндер → DayPicker втрачає
  // внутрішню memoization і ре-обчислює всі дні щоразу.
  const minDate = useMemo(() => parseApiDate(min ?? ''), [min]);
  const maxDate = useMemo(() => parseApiDate(max ?? ''), [max]);

  const isWithinBounds = (d: Date): boolean => {
    if (minDate && d < minDate) return false;
    if (maxDate && d > maxDate) return false;
    return true;
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setInputText(text);
    // Try to parse DD.MM.YYYY manually typed input
    if (text.length === 10) {
      const parsed = parse(text, 'dd.MM.yyyy', new Date());
      // reject out-of-range dates: onChange does not fire so parent's `value` stays valid;
      // the raw text stays only while the field is focused — onBlur restores the applied value.
      if (isValid(parsed) && isWithinBounds(parsed)) {
        onChange(format(parsed, 'yyyy-MM-dd'));
      }
    }
    if (!text) onChange('');
  };

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) return;
    if (!isWithinBounds(day)) return;
    onChange(format(day, 'yyyy-MM-dd'));
    setOpen(false);
  };

  const selected = useMemo(() => parseApiDate(value), [value]);

  // react-day-picker `disabled` accepts an array of matchers.
  // Memoize: масив-літерал перебудовується на кожен ререндер. DayPicker всередині диф-ить
  // disabled по reference — без useMemo втрачається mеmoization матриці днів.
  const disabledMatchers = useMemo<Matcher[]>(() => {
    const out: Matcher[] = [];
    if (minDate) out.push({ before: minDate });
    if (maxDate) out.push({ after: maxDate });
    return out;
  }, [minDate, maxDate]);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {label && (
        <label className="block text-[13px] font-medium text-foreground mb-1">
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <input
          type="text"
          value={inputText}
          onChange={handleInputChange}
          // Поле показує лише те, що справді застосовано. Недописана дата («10.03») або дата поза
          // межами min/max до батька не доходить, і без цього лишалась у полі назавжди: у відборі
          // «З 09.03 По 09.03» ввід «З 11.03» відхилявся мовчки, далі «По 11.03» — і на екрані
          // стояло «11.03 – 11.03», а список показував 09.03 – 11.03 (Bug #815).
          onBlur={() => setInputText(displayDate(value))}
          onFocus={() => setOpen(true)}
          // Після Enter/Escape фокус лишається в полі, а календар закритий. Без onClick
          // повторний клік по полю нічого не робив (focus не спрацьовує вдруге) — календар
          // відкривався лише кнопкою-іконкою.
          onClick={() => setOpen(true)}
          // Enter після введення дати закриває календар: інакше попап лишався поверх
          // таблиці. Escape обробляється на document (див. ефект вище).
          onKeyDown={e => {
            if (open && e.key === 'Enter') setOpen(false);
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          maxLength={10}
          className={cn(
            'w-full h-9 rounded-lg border bg-input px-3 pr-9 text-sm text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-2 focus:ring-ring transition-colors',
            errorMessage ? 'border-destructive-border focus:ring-destructive/20' : 'border-border',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        />
        <button
          type="button"
          aria-label="Відкрити календар"
          onClick={() => !disabled && setOpen(v => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Calendar className="h-4 w-4" />
        </button>
      </div>
      {errorMessage && <p className="mt-1 text-[12px] text-destructive-text">{errorMessage}</p>}
      {hint && !errorMessage && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}

      {open && (
        <div className="absolute z-50 mt-1 bg-surface border border-border rounded-xl shadow-lg p-3">
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={handleDaySelect}
            locale={uk}
            weekStartsOn={1}
            showOutsideDays
            disabled={disabledMatchers.length > 0 ? disabledMatchers : undefined}
            classNames={DAY_PICKER_CLASS_NAMES}
          />
          <div className="border-t border-border mt-1 pt-2">
            <button
              type="button"
              onClick={() => {
                const today = kyivToday();
                const d = parseApiDate(today);
                if (d && isWithinBounds(d)) {
                  onChange(today);
                  setOpen(false);
                }
              }}
              className="w-full text-center text-[13px] font-medium text-primary hover:bg-primary/10 rounded-lg py-1.5 transition-colors"
            >
              Сьогодні
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
